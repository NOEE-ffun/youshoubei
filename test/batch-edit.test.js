'use strict';
const assert = require('node:assert/strict');
const M = require('../canvas-model.js');

/* renderBatchTitle */
assert.equal(M.renderBatchTitle('胜者组 R1-{i}', 2, '第 3 场'), '胜者组 R1-3');
assert.equal(M.renderBatchTitle('胜者组 {old}', 0, '第 3 场'), '胜者组 第 3 场');
assert.equal(M.renderBatchTitle('{i}-{i}-{old}-{old}', 1, 'X'), '2-2-X-X', '全部出现替换');
assert.equal(M.renderBatchTitle('无变量', 0, 'Y'), '无变量');
assert.equal(M.renderBatchTitle('{old}', 0, null), '', '空 old 安全');

/* applyBatchEdit:缺省键不动 */
const mk = (over) => Object.assign({ id: 'c1', kind: 'match', label: '第 1 场', phase: '', format: 'BO3', slots: [{ type: 'empty' }, { type: 'empty' }], exitRanks: {} }, over);
const a = mk({ id: 'a' }); const b = mk({ id: 'b', kind: 'rollPool', w: 10, h: 7, ports: { lr: 2, tb: 2 }, mode: 'manual', seed: 's', assignments: null, slots: [], classLinks: [], format: undefined, exitRanks: undefined });
M.applyBatchEdit([a], {});
assert.equal(a.phase, '', '空 config 不动');
assert.equal(a.label, '第 1 场');

/* 阶段+赛制:trim、空 phase 清空、空 format 写 BO3、roll 池跳过 format */
M.applyBatchEdit([a, b], { phase: '  胜者组 ', format: '' });
assert.equal(a.phase, '胜者组'); assert.equal(a.format, 'BO3', '空 format 落 BO3');
assert.equal(b.phase, '胜者组', '阶段对 roll 池生效');
assert.equal(b.format, undefined, 'roll 池无 format 字段不被创建');

/* 出口名次:仅 match;null 清除;exitRanks 惰性建 */
const c = mk({ id: 'c' });
M.applyBatchEdit([c, b], { rankWinner: 1, rankLoser: 3 });
assert.deepEqual(c.exitRanks, { winner: 1, loser: 3 });
assert.equal(b.exitRanks, undefined, 'roll 池无 exitRanks');
M.applyBatchEdit([c], { rankWinner: null });
assert.equal(c.exitRanks.winner, null, 'null 清除');

/* 禁卡表:替换/归一去重/空数组解绑 */
const d = mk({ id: 'd', banListIds: ['old'] });
M.applyBatchEdit([d], { banListIds: ['x', 'x', 'y'] });
assert.deepEqual(d.banListIds, ['x', 'y']);
M.applyBatchEdit([d], { banListIds: [] });
assert.equal(d.banListIds, undefined, '空数组 delete 解绑');

/* 标题:按数组序 1..N;{old};缺省不动 */
const e1 = mk({ id: 'e1', label: '第 1 场' }); const e2 = mk({ id: 'e2', label: '第 2 场' });
M.applyBatchEdit([e1, e2], { titleTemplate: 'R1-{i}({old})' });
assert.equal(e1.label, 'R1-1(第 1 场)');
assert.equal(e2.label, 'R1-2(第 2 场)');
console.log('batch-edit task2 ok');
