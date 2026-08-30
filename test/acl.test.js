'use strict';
/* acl 资源归属判定 + 整库写守卫:createdBy 服务端盖章防篡改 */
const assert = require('node:assert');
const { canManageResource, workspacePutGuard } = require('../api/acl');

assert.strictEqual(canManageResource('super', 'u1', { createdBy: 'u2' }), true);
assert.strictEqual(canManageResource('admin', 'u1', { createdBy: 'u1' }), true);
assert.strictEqual(canManageResource('admin', 'u1', { createdBy: 'u2' }), false);
assert.strictEqual(canManageResource('admin', 'u1', { createdBy: null }), false);   /* 系统资源 */
assert.strictEqual(canManageResource('player', 'u1', { createdBy: 'u1' }), false);

const U = { id: 'uA', role: 'admin' };
const S = { id: 'uS', role: 'super' };
const cur = () => ({
  series: [{ id: 's1', name: '系列一', createdBy: 'uA', createdAt: 't' },
           { id: 's2', name: '系统系列', createdBy: null, createdAt: 't' }],
  tournaments: [{ id: 't1', name: '我的届', seriesId: 's1', createdBy: 'uA', updatedAt: 1, canvas: { cards: [1] } },
                { id: 't2', name: '别人的届', seriesId: 's2', createdBy: 'uB', updatedAt: 1 }],
  players: [], activeId: 't1'
});

/* admin 改自己的届(updatedAt 也变)+ 保留他人届原样 → 过,且他人届 createdBy 回填 */
let r = workspacePutGuard(U, cur(), {
  series: cur().series,
  tournaments: [{ id: 't1', name: '我的届改', seriesId: 's1', createdBy: 'uA', updatedAt: 9, canvas: { cards: [2] } },
                cur().tournaments[1]],
  players: [], activeId: 't1'
});
assert.strictEqual(r.ok, true);
assert.strictEqual(r.workspace.tournaments[0].name, '我的届改');

/* admin 改他人届内容 → 403 */
r = workspacePutGuard(U, cur(), { series: cur().series,
  tournaments: [{ id: 't2', name: '偷改', seriesId: 's2', createdBy: 'uB', updatedAt: 9 }, cur().tournaments[0]],
  players: [], activeId: 't1' });
assert.strictEqual(r.ok, false);
assert.strictEqual(r.status, 403);
assert.match(r.error, /别人的届/);

/* admin 删他人届 → 403;删系统系列 → 403 */
r = workspacePutGuard(U, cur(), { series: cur().series, tournaments: [cur().tournaments[0]], players: [], activeId: 't1' });
assert.strictEqual(r.status, 403);
r = workspacePutGuard(U, cur(), { series: [cur().series[0]], tournaments: cur().tournaments, players: [], activeId: 't1' });
assert.strictEqual(r.status, 403);

/* admin 新建届/系列 → 盖章 requester;客户端伪造 createdBy 也被盖掉 */
r = workspacePutGuard(U, cur(), { series: [...cur().series, { id: 's9', name: '新系列', createdBy: 'uB' }],
  tournaments: [...cur().tournaments, { id: 't9', name: '新届', seriesId: 's9' }], players: [], activeId: 't1' });
assert.strictEqual(r.ok, true);
assert.strictEqual(r.workspace.series[2].createdBy, 'uA');
assert.strictEqual(r.workspace.tournaments[2].createdBy, 'uA');

/* super:改他人届过;篡改他人届归属被回填 current 值 */
r = workspacePutGuard(S, cur(), { series: cur().series,
  tournaments: [{ id: 't2', name: '超管改', seriesId: 's2', createdBy: 'uS', updatedAt: 3 }, cur().tournaments[0]],
  players: [], activeId: 't1' });
assert.strictEqual(r.ok, true);
assert.strictEqual(r.workspace.tournaments[0].createdBy, 'uB');

/* updatedAt 不同但内容相同不误伤(纯时间戳变化放行) */
r = workspacePutGuard(U, cur(), { series: cur().series,
  tournaments: [{ ...cur().tournaments[1], updatedAt: 99 }, cur().tournaments[0]], players: [], activeId: 't1' });
assert.strictEqual(r.ok, true);

/* ---- 附加边界:结构防御/角色门槛/series 缺省/无副作用不变式 ---- */
const { comparableResource } = require('../api/acl');

/* comparableResource:剥 updatedAt;键序无关(含嵌套),嵌套内容变必须不等,数组保序 */
assert.strictEqual(
  comparableResource({ id: 'a', updatedAt: 1, canvas: { cards: [1], nested: { z: 1, a: 2 } } }),
  comparableResource({ canvas: { nested: { a: 2, z: 1 }, cards: [1] }, id: 'a', updatedAt: 99 }));
assert.notStrictEqual(
  comparableResource({ id: 'a', canvas: { cards: [1] } }),
  comparableResource({ id: 'a', canvas: { cards: [7] } }));   /* 仅嵌套内容变 → 不等 */
assert.notStrictEqual(
  comparableResource({ id: 'a', v: [1, 2] }),
  comparableResource({ id: 'a', v: [2, 1] }));                /* 数组保序 */

/* admin 仅改他人届嵌套内容(canvas.cards)→ 403(比较序列化不得对嵌套失明) */
const curNested = () => ({
  series: [],
  tournaments: [{ id: 't2', name: '别人的届', seriesId: null, createdBy: 'uB', updatedAt: 1, canvas: { cards: [1] } }],
  players: [], activeId: 't2'
});
r = workspacePutGuard(U, curNested(), { series: [],
  tournaments: [{ id: 't2', name: '别人的届', seriesId: null, createdBy: 'uB', updatedAt: 1, canvas: { cards: [7] } }],
  players: [], activeId: 't2' });
assert.strictEqual(r.ok, false);
assert.strictEqual(r.status, 403);
assert.match(r.error, /别人的届/);

/* 结构防御:tournaments/series 非数组 → 400(与 data.js 现有校验同语义) */
assert.strictEqual(workspacePutGuard(U, cur(), { series: 'x', tournaments: 'y' }).status, 400);
assert.strictEqual(workspacePutGuard(U, cur(), { tournaments: [], series: 'x' }).status, 400);
assert.strictEqual(workspacePutGuard(U, cur(), null).status, 400);

/* 条目缺 id / id 非字符串 → 400:无 id 条目会绕过盖章,客户端伪造 createdBy 原样落库 */
assert.strictEqual(workspacePutGuard(U, cur(), { series: cur().series,
  tournaments: [...cur().tournaments, { name: '无 id 届', createdBy: 'uB' }], players: [], activeId: 't1' }).status, 400);
assert.strictEqual(workspacePutGuard(U, cur(), { series: [...cur().series, { name: '无 id 系列', createdBy: 'uB' }],
  tournaments: cur().tournaments, players: [], activeId: 't1' }).status, 400);
assert.strictEqual(workspacePutGuard(U, cur(), { series: cur().series,
  tournaments: [...cur().tournaments, { id: 42, name: '数字 id', createdBy: 'uB' }], players: [], activeId: 't1' }).status, 400);
assert.strictEqual(workspacePutGuard(U, cur(), { series: cur().series,
  tournaments: [...cur().tournaments, null], players: [], activeId: 't1' }).status, 400);

/* 非管理角色(player)即使带合法数据也拒写 → 403 */
assert.strictEqual(workspacePutGuard({ id: 'uP', role: 'player' }, cur(), cur()).status, 403);

/* incoming.series 缺失(undefined)按 [] 处理——不崩、语义等同空列表:
 * 旧库存无 series(legacy)时 admin 整体 PUT 不带 series 可过,输出补 [];
 * 但库里存在系统系列时,缺失=删除系统资源 → 403;super 删光也过 */
const legacy = { tournaments: cur().tournaments, players: [], activeId: 't1' };
r = workspacePutGuard(U, legacy, { tournaments: cur().tournaments, players: [], activeId: 't1' });
assert.strictEqual(r.ok, true);
assert.deepStrictEqual(r.workspace.series, []);
assert.strictEqual(workspacePutGuard(U, cur(), { tournaments: cur().tournaments, players: [], activeId: 't1' }).status, 403);
r = workspacePutGuard(S, cur(), { tournaments: [cur().tournaments[0]], players: [], activeId: 't1' });
assert.strictEqual(r.ok, true);
assert.deepStrictEqual(r.workspace.series, []);

/* 无副作用:不改 current、不改调用方传入的 incoming(返回深拷贝) */
const curWs = cur();
const inWs = { series: curWs.series,
  tournaments: [{ ...curWs.tournaments[1], createdBy: 'uS', updatedAt: 2 }, curWs.tournaments[0]],
  players: [], activeId: 't1' };
r = workspacePutGuard(S, curWs, inWs);
assert.strictEqual(r.ok, true);
assert.strictEqual(r.workspace.tournaments[0].createdBy, 'uB');   /* 回填 current 值 */
assert.strictEqual(curWs.tournaments[1].createdBy, 'uB');         /* current 未被改 */
assert.strictEqual(inWs.tournaments[0].createdBy, 'uS');          /* 调用方 incoming 未被改 */

/* ---- 迁移脚本纯函数 planMigration:存量届挂默认系列「历届比赛」(幂等) ---- */
const { planMigration } = require('../scripts/migrate-series');

/* 空库(无 series、存量届无 createdBy 无 seriesId)→ 建默认系列并把届挂进去 */
let m = planMigration({ tournaments: [{ id: 't1', name: '一届' }], players: [] }, 'uNOEE');
assert.strictEqual(m.changed, true);
assert.strictEqual(m.workspace.series[0].key, 'default');
assert.strictEqual(m.workspace.series[0].name, '历届比赛');
assert.strictEqual(m.workspace.series[0].createdBy, 'uNOEE');
assert.strictEqual(m.workspace.tournaments[0].seriesId, m.workspace.series[0].id);
assert.strictEqual(m.workspace.tournaments[0].createdBy, 'uNOEE');
/* 幂等:再跑零变更;新届(有 createdBy 无 seriesId)不卷入 */
m = planMigration(m.workspace, 'uNOEE');
assert.strictEqual(m.changed, false);
m = planMigration({ series: [], tournaments: [{ id: 't9', createdBy: 'uA' }], players: [] }, 'uNOEE');
assert.strictEqual(m.changed, false);
/* superUserId 为 null:默认系列与届的 createdBy 均保持 null(系统资源,仅 env 超管可管) */
m = planMigration({ tournaments: [{ id: 't2' }], players: [] }, null);
assert.strictEqual(m.changed, true);
assert.strictEqual(m.workspace.series[0].createdBy, null);
assert.strictEqual(m.workspace.tournaments[0].createdBy, null);
/* 「无 createdBy 但有 seriesId」的届不动(已有归属系列,不重挂) */
m = planMigration({ series: [], tournaments: [{ id: 't3', seriesId: 'sX' }], players: [] }, 'uNOEE');
assert.strictEqual(m.changed, false);
/* 复用已存在的默认系列(key:'default'),不重复建 */
const reuse = { series: [{ id: 'sD', key: 'default', name: '历届比赛', createdBy: 'uNOEE' }],
  tournaments: [{ id: 't4' }], players: [] };
m = planMigration(reuse, 'uNOEE');
assert.strictEqual(m.changed, true);
assert.strictEqual(m.workspace.series.length, 1);
assert.strictEqual(m.workspace.tournaments[0].seriesId, 'sD');

console.log('✓ acl: 归属判定与整库写守卫通过');
