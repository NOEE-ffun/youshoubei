'use strict';

/* 模板 API——个人库 GET/PUT(handler 直测)。
 * storage 按 api/helpers.js createStorage 的真实注入契约 mock:
 * readJson/writeJson(对象级,同 test/codes-api.test.js memoryStorage),
 * 任务书草稿的 get/put 文本契约与仓库不符,已按实际核对改写。
 * now/appendAudit 注入:审计三分支(save/cover/delete)与 maskUser 在此断言。
 * 权限(HTTP 层匿名 401/越权 403)由 requireRole+session 兜底,e2e 匿名打真服务覆盖,
 * 单测不重复造会话——第 1 组留注释占位,handler 直测从第 2 组起。 */

const assert = require('node:assert/strict');
const { createHandler } = require('../api/templates.js');

function boot() {
  const map = new Map();
  const storage = {
    readJson: async (key) => (map.has(key) ? map.get(key) : null),
    writeJson: async (key, value) => { map.set(key, value); }
  };
  const audits = [];
  const h = createHandler(storage, { now: () => 123, appendAudit: (a, d) => audits.push([a, d]) });
  return { h, audits, map };
}

/* 用户字段对齐真实契约:requireRole→currentUser 返回对象键是 id(safeUser,
 * account.js:60),uid 只在 session 载荷里——mock 照真实形状造 */
const ADMIN = { username: 'admin1', id: 'u1', role: 'admin' };
/* 手机号形态 username:验审计 detail 里 maskUser 只留末 4 位 */
const USER = { username: '13900000002', id: 'u2', role: 'player' };
const tpl = (name, id) => ({
  id: id || 'tpl_x', name,
  cards: [{ kind: 'match', x: 0, y: 0 }],
  meta: { w: 10, h: 7 }, createdAt: 1, updatedAt: 1
});

(async () => {
  /* 1) 权限(匿名 401 / 越权 403):requireRole 依赖 session cookie,
   *    HTTP 层链路由 e2e 兜底;handler 单测用注入 user 覆盖校验/配额/隔离/审计(第 2 组起)。 */

  /* 2) PUT:合法落库、只写自己块、updatedAt 走注入 now、审计三分支 + by= 脱敏 */
  {
    const { h, audits, map } = boot();
    await h.__putLibrary(ADMIN, { templates: [tpl('八强赛')] });
    let file = map.get('templates.json');
    assert.ok(file.libraries.u1 && file.libraries.u1.templates.length === 1, 'u1 落库');
    assert.equal(file.libraries.u2, undefined, '只写自己块');
    assert.equal(file.libraries.u1.templates[0].name, '八强赛', '名字保留');
    assert.equal(file.libraries.u1.templates[0].updatedAt, 123, 'updatedAt 走注入 now');

    await h.__putLibrary(USER, { templates: [tpl('我的模板', 'tpl_y')] });
    file = map.get('templates.json');
    assert.ok(file.libraries.u2 && file.libraries.u2.templates.length === 1, 'u2 落库');
    assert.equal(file.libraries.u1.templates.length, 1, '他人提交不动 u1 块');

    /* 同 id 保留=覆盖更新(cover);清空=delete */
    await h.__putLibrary(ADMIN, { templates: [tpl('八强赛v2')] });
    await h.__putLibrary(ADMIN, { templates: [] });
    assert.deepEqual(audits.map((a) => a[0]), ['tpl.save', 'tpl.save', 'tpl.cover', 'tpl.delete'],
      '审计三分支:save→save→cover→delete');
    assert.match(audits[0][1], /^模板「八强赛」1 卡 by=admin1$/, 'save detail 带卡数与 by=');
    assert.match(audits[1][1], /by=\*\*\*0002$/, '手机号形态 username 走 maskUser 脱敏');
    assert.match(audits[2][1], /^模板「八强赛v2」覆盖更新 by=admin1$/, 'cover detail');
    assert.match(audits[3][1], /^模板「八强赛v2」by=admin1$/, 'delete 记删除前名字');
    file = map.get('templates.json');
    assert.equal(file.libraries.u1.templates.length, 0, '清空后 u1 块为空');
    assert.equal(file.libraries.u2.templates.length, 1, '清空自己不碰别人');
  }

  /* 3) 校验:非对象 400 / 同名 409 / 超 50 模板 400 / 名字空或超 20 字 400 / 单模板超 50 卡 400 */
  {
    const { h } = boot();
    assert.equal(h.__validateLibrary(null).code, 400, 'body 非对象 400');
    assert.equal(h.__validateLibrary({}).code, 400, '缺 templates 数组 400');
    assert.equal(h.__validateLibrary({ templates: [tpl('A'), tpl('A')] }).code, 409, '同名两条 409');
    assert.equal(
      h.__validateLibrary({ templates: Array.from({ length: 51 }, (_, i) => tpl('T' + i, 'tpl_' + i)) }).code,
      400, '超 50 模板 400');
    assert.equal(h.__validateLibrary({ templates: [tpl('  ')] }).code, 400, '名字 trim 后空 400');
    assert.equal(h.__validateLibrary({ templates: [tpl('x'.repeat(21))] }).code, 400, '名字超 20 字 400');
    const big = tpl('大');
    big.cards = Array.from({ length: 51 }, () => ({ kind: 'match' }));
    assert.equal(h.__validateLibrary({ templates: [big] }).code, 400, '单模板超 50 卡 400');
    assert.ok(h.__validateLibrary({ templates: [tpl('好')] }).ok, '合法库通过');
  }

  /* 4) GET:空库返回 [] ;本人库回读、他人块不可见 */
  {
    const { h } = boot();
    assert.deepEqual(await h.__getLibrary('u9'), [], '空库返回空数组');
    await h.__putLibrary(ADMIN, { templates: [tpl('甲'), tpl('乙', 'tpl_y')] });
    assert.equal((await h.__getLibrary('u1')).length, 2, '回读本人库');
    assert.deepEqual(await h.__getLibrary('u2'), [], '他人块不可见');
  }

  /* 5) 双用户隔离:A、B 两个 admin 先后落库,各占独立块,B 的 PUT 不删 A 的 */
  {
    const { h, map } = boot();
    const A = { username: 'adminA', id: 'uA', role: 'admin' };
    const B = { username: 'adminB', id: 'uB', role: 'admin' };
    await h.__putLibrary(A, { templates: [tpl('A1', 'tpl_a1')] });
    await h.__putLibrary(B, { templates: [tpl('B1', 'tpl_b1'), tpl('B2', 'tpl_b2')] });
    await h.__putLibrary(A, { templates: [tpl('A1', 'tpl_a1'), tpl('A2', 'tpl_a2')] });
    const file = map.get('templates.json');
    assert.deepEqual(file.libraries.uA.templates.map((t) => t.name), ['A1', 'A2'], 'A 块=自己最后一次提交');
    assert.deepEqual(file.libraries.uB.templates.map((t) => t.name), ['B1', 'B2'], 'B 块不被 A 的提交覆盖');
    assert.equal((await h.__getLibrary('uA')).length, 2, 'A 回读不空(B 的 PUT 不删 A 的)');
    assert.equal((await h.__getLibrary('uB')).length, 2, 'B 回读完整');
    assert.ok(file.libraries.uA && file.libraries.uB, '两个独立块并存(非 libraries["undefined"] 合写)');
  }

  /* 6) write 抛错:错误原样上抛不吞(HTTP 层 500 由 server.js handleApi catch 兜底),
   *    且 workspace-lock 链尾吞错设计保证失败不断链——恢复后同 handler 可继续写 */
  {
    const map = new Map();
    let fail = true;
    const storage = {
      readJson: async (key) => (map.has(key) ? map.get(key) : null),
      writeJson: async (key, value) => { if (fail) throw new Error('oss down'); map.set(key, value); }
    };
    const h = createHandler(storage, { now: () => 123, appendAudit: () => {} });
    await assert.rejects(() => h.__putLibrary(ADMIN, { templates: [tpl('X')] }), /oss down/,
      'write 失败原样 reject(吞错会变假 200)');
    fail = false;
    const ok = await h.__putLibrary(ADMIN, { templates: [tpl('X')] });
    assert.ok(Array.isArray(ok.templates), '锁链未断,恢复后可写');
    assert.equal(map.get('templates.json').libraries.u1.templates.length, 1, '恢复后落库成功');
  }

  console.log('✓ templates-api(personal): 6 组断言通过');
})().catch((e) => { console.error(e); process.exit(1); });
