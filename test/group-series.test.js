'use strict';

/* groupTournamentsBySeries 纯函数单测(系列-届分组,主页总览与页头届切换共用)。
 * common.js 是浏览器 IIFE(顶层挂 window.TournamentAppInit),无法 require;
 * 用 node:vm 沙箱执行真实源码再从 window.TournamentUtils 取出被测函数——
 * 测的是线上那份实现,不是复制品。common.js 顶层不触碰 document/localStorage,
 * 仅注册函数与 window 出口,故最小宿主 stub 即可加载。 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadUtils() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'common.js'), 'utf8');
  const sandbox = { console, setTimeout, clearTimeout };
  sandbox.window = sandbox; /* 源码经 window.TournamentUtils 出口 */
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'common.js' });
  const utils = sandbox.window.TournamentUtils;
  assert.ok(utils && typeof utils.groupTournamentsBySeries === 'function',
    'common.js 应在 window.TournamentUtils 暴露 groupTournamentsBySeries');
  return utils;
}

const utils = loadUtils();
const group = utils.groupTournamentsBySeries;

/* 造届记录:seriesId 缺参=无 seriesId 字段值 null */
const t = (id, seriesId) => ({ id, name: '届' + id, seriesId: seriesId === undefined ? null : seriesId });
/* 沙箱对象的原型属于 vm realm,host 的 deepStrictEqual 按原型严格比对会误判;
 * JSON 往返一次归一到 host realm 再断言 */
const shape = (groups) => JSON.parse(JSON.stringify(groups.map((g) => [g.id, g.label, g.count, g.items.map((x) => x.id)])));

/* 1. 基本分组:系列顺序=series 数组序;组内届行保持传入顺序 */
assert.deepStrictEqual(
  shape(group([t('t1', 's1'), t('t2', 's2'), t('t3', 's1')], [{ id: 's2', name: 'B' }, { id: 's1', name: 'A' }])),
  [['s2', 'B', 1, ['t2']], ['s1', 'A', 2, ['t1', 't3']]],
  '系列数组序分组 + 组内传入序'
);

/* 2. 归「未分组」:无 seriesId / seriesId 指向不存在的系列(孤儿)/ 系列名为空 */
assert.deepStrictEqual(
  shape(group([t('t1'), t('t2', 'ghost'), t('t3', 's-noname'), t('t4', 's1')],
    [{ id: 's1', name: 'A' }, { id: 's-noname', name: '' }])),
  [['s1', 'A', 1, ['t4']], [null, '未分组', 3, ['t1', 't2', 't3']]],
  '孤儿/无名系列/未指定 → 末尾「未分组」'
);

/* 3. 没有任何届的系列不产出空组 */
assert.deepStrictEqual(
  shape(group([t('t1', 's1')], [{ id: 's-empty', name: '空' }, { id: 's1', name: 'A' }])),
  [['s1', 'A', 1, ['t1']]],
  '空系列被过滤'
);

/* 4. 全空/缺参容忍:无届 → [];无系列 → 全部未分组;两侧 null/undefined 不抛 */
assert.deepStrictEqual(shape(group([], [{ id: 's1', name: 'A' }])), [], '无届无组');
assert.deepStrictEqual(
  shape(group([t('t1'), t('t2')], [])),
  [[null, '未分组', 2, ['t1', 't2']]],
  '无系列全部归未分组'
);
assert.deepStrictEqual(shape(group(null, null)), [], 'null 入参不抛');
assert.deepStrictEqual(shape(group(undefined, undefined)), [], 'undefined 入参不抛');

/* 5. 脏条目过滤:series/tournaments 里的 null 与无 id 届不参与分组 */
assert.deepStrictEqual(
  shape(group([null, { id: '', name: '坏行' }, t('t1', 's1')], [null, { id: 's1', name: 'A' }])),
  [['s1', 'A', 1, ['t1']]],
  '脏 series/届条目跳过'
);

/* 6. 重复系列 id:届只绑第一个(byId 首见优先);第二组无届,
 *    与其他空系列一样被 count>0 过滤,不产出重复组 */
assert.deepStrictEqual(
  shape(group([t('t1', 'dup')], [{ id: 'dup', name: '一' }, { id: 'dup', name: '二' }])),
  [['dup', '一', 1, ['t1']]],
  '重复 id 首见优先,空副本组被过滤'
);

/* 7. id 为 0 的系列是合法 id(!= null 判定),不得落未分组 */
assert.deepStrictEqual(
  shape(group([t('t1', 0)], [{ id: 0, name: '零' }])),
  [[0, '零', 1, ['t1']]],
  'id=0 视为有效系列 id'
);

/* 8. keepEmpty(系列编辑态):无届系列保留为空组;无届的「未分组」仍不出现 */
assert.deepStrictEqual(
  shape(group([t('t1', 's1')], [{ id: 's-empty', name: '空' }, { id: 's1', name: 'A' }], { keepEmpty: true })),
  [['s-empty', '空', 0, []], ['s1', 'A', 1, ['t1']]],
  'keepEmpty 保留空系列组(系列数组序)'
);
assert.deepStrictEqual(
  shape(group([], [{ id: 's1', name: 'A' }], { keepEmpty: true })),
  [['s1', 'A', 0, []]],
  'keepEmpty 下无届未分组仍不出现'
);
assert.deepStrictEqual(
  shape(group([t('t1', 's1')], [{ id: 's-empty', name: '空' }, { id: 's1', name: 'A' }], {})),
  [['s1', 'A', 1, ['t1']]],
  '默认(opts 空对象)仍过滤空系列'
);

/* 9. applySeriesOrder:系列守卫式重排(编辑器组块拖拽的写回口径) */
const order = utils.applySeriesOrder;
assert.ok(typeof order === 'function', 'common.js 应导出 applySeriesOrder');
const srcSeries = [{ id: 's1', name: '一' }, { id: 's2', name: '二' }, { id: 's3', name: '三' }];
/* 完整置换 → 新数组按 orderedIds 序 */
assert.deepStrictEqual(order(srcSeries, ['s3', 's1', 's2']).map((s) => s.id), ['s3', 's1', 's2'], '完整重排');
/* 部分提及 → 未提及者按原序追加尾部(无空名系列在编辑态不可见,重排不可因它失败) */
assert.deepStrictEqual(order(srcSeries, ['s2', 's1']).map((s) => s.id), ['s2', 's1', 's3'], 'leftover 原序追加');
/* 空 orderedIds → 原序拷贝 */
assert.deepStrictEqual(order(srcSeries, []).map((s) => s.id), ['s1', 's2', 's3'], '空序=identity');
/* 重复/未知 id → null 且数据不动 */
assert.strictEqual(order(srcSeries, ['s1', 's1', 's2']), null, '重复 id 拒绝');
assert.strictEqual(order(srcSeries, ['s1', 'ghost']), null, '未知 id 拒绝');
assert.strictEqual(order(srcSeries, 's1'), null, '非数组拒绝');
assert.deepStrictEqual(srcSeries.map((s) => s.id), ['s1', 's2', 's3'], '入参永不被改');
/* 返回的是浅拷贝新数组:调用方 ws.series = 结果 直接替换 */
assert.notStrictEqual(order(srcSeries, ['s1', 's2', 's3']), srcSeries, '返回新数组');

console.log('✓ group-series: 系列-届分组与系列重排纯函数(顺序/未分组/空组/keepEmpty/applySeriesOrder)');
