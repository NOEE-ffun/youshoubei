'use strict';

const assert = require('node:assert/strict');
const M = require('../canvas-model.js');

/* ---- Task 1: 归一与几何 ---- */

// roll 池卡归一:新字段全保留,缺省值正确
const pool = M.normalizeCard({ kind: 'rollPool', id: 'p1', x: 3, y: 5 });
assert.equal(pool.kind, 'rollPool', 'kind 保留');
assert.equal(pool.w, 10, '默认宽 10 点');
assert.equal(pool.h, 7, '默认高 7 点');
assert.deepEqual(pool.ports, { lr: 2, tb: 2 }, '默认口数 2+2');
assert.equal(pool.mode, 'manual', '默认手动模式');
assert.ok(typeof pool.seed === 'string' && pool.seed.length > 0, 'seed 自动生成');
assert.equal(pool.assignments, null, 'assignments 默认 null');
assert.ok(Array.isArray(pool.slots), 'slots 数组');
assert.ok(Array.isArray(pool.classLinks), 'classLinks 数组形态');
assert.ok(!('format' in pool) && !('deckCount' in pool) && !('exitRanks' in pool), '无比分域字段');

// 比赛卡归一补 kind 且行为不变
const match = M.normalizeCard({ id: 'm1', label: 'X', slots: [{ type: 'player', playerId: 'P1' }, { type: 'empty' }] });
assert.equal(match.kind, 'match', '比赛卡缺省 kind=match');
assert.equal(match.format, 'BO3', '比赛卡 format 默认仍在');
assert.equal(match.slots.length, 2, '比赛卡槽仍为 2');

// 形状钳制
assert.deepEqual(M.clampPoolShape(999, 7, 999, 3), { w: 40, h: 7, lr: 5, tb: 3 }, '宽/口数超限钳制(lr≤h-2=5)');
assert.deepEqual(M.clampPoolShape(1, 1, 0, 0), { w: 2, h: 2, lr: 0, tb: 0 }, '下限钳制');

// 出口全序
assert.deepEqual(M.outletList({ lr: 2, tb: 1 }), ['L1', 'L2', 'T1', 'R1', 'R2', 'B1'], '全序 L→T→R→B');

// 尺寸与端口几何
assert.deepEqual(M.cardSize(pool), { width: 280, height: 196 }, 'roll 池尺寸 w·DOT/h·DOT');
assert.deepEqual(M.cardSize(match), { width: M.CARD_WIDTH, height: M.CARD_HEIGHT }, '比赛卡尺寸不变');
const big = M.normalizeCard({ kind: 'rollPool', w: 12, h: 10, ports: { lr: 4, tb: 4 } });
// 左 1 口:中线居中,第 1 口 y = h/2 - (lr-1)/2·DOT
assert.deepEqual(M.portOffsetForCard(big, 'L1'), { x: 0, y: 5 * 28 - 1.5 * 28 });
assert.deepEqual(M.portOffsetForCard(big, 'R4'), { x: 12 * 28, y: 5 * 28 + 1.5 * 28 });
assert.deepEqual(M.portOffsetForCard(big, 'T2'), { x: 6 * 28 - 0.5 * 28, y: 0 });
// 比赛卡旧端口名走旧逻辑
assert.deepEqual(M.portOffsetForCard(match, 'topLeft'), M.portOffset('topLeft'));
assert.deepEqual(M.portNormalForCard(big, 'L1'), [-1, 0]);
assert.deepEqual(M.portNormalForCard(match, 'rightTop'), [1, 0]);

// flow 槽两形态归一(normalizeSlot 不导出,经 normalizeCard 间接验证)
const viaCard = M.normalizeCard({ kind: 'rollPool', slots: [{ type: 'flow', cardId: 'p1', outlet: 'R3' }, { type: 'flow', cardId: 'm1', outcome: 'winner', inlet: 'L2' }, { type: 'flow', cardId: 'm1', outcome: 'winner', outlet: 'bad!' }] });
assert.deepEqual(viaCard.slots[0], { type: 'flow', cardId: 'p1', outlet: 'R3' }, 'outlet 形态保留');
assert.equal(viaCard.slots[1].inlet, 'L2');
assert.equal(viaCard.slots[1].outcome, 'winner');
assert.equal(viaCard.slots[2].outlet, undefined, '非法 outlet 丢弃');

// 建卡工厂
const created = M.createRollPoolCard(4, 6);
assert.equal(created.kind, 'rollPool');
assert.equal(created.x, 4);
assert.equal(created.slots.length, 4, '默认 4 空池位');

console.log('roll-pool task1 ok');
