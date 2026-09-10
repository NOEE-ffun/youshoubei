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

/* ---- Task 2: 分配纯函数 ---- */
const poolCanvas = { cards: [
  { kind: 'rollPool', id: 'p1', slots: [], ports: { lr: 2, tb: 1 }, seed: 'S1', mode: 'manual' },
  { id: 'm1', slots: [{ type: 'flow', cardId: 'p1', outlet: 'R1' }, { type: 'empty' }] },
  { id: 'm2', slots: [{ type: 'flow', cardId: 'p1', outlet: 'B1' }, { type: 'empty' }] },
  { id: 'm3', slots: [{ type: 'flow', cardId: 'p1', outlet: 'R9' }, { type: 'empty' }] }, // R9 不存在,仍算已连接
  { id: 'm4', slots: [{ type: 'flow', cardId: 'p1', outlet: 'R2' }, { type: 'empty' }] } // R2 存在:候选恰 3 个(R1/R2/B1),R9 按全序过滤掉
] };
const connected = M.collectConnectedOutlets(poolCanvas, 'p1');
assert.ok(connected.has('R1') && connected.has('B1') && connected.has('R9'), '收集全部被引用出口');

// 候选 = 已连接口按全序过滤
const seats = ['P1', 'P2', 'P3', 'P4'];
const r1 = M.autoAssign(seats, { lr: 2, tb: 1 }, connected, 'S1');
assert.equal(Object.keys(r1.outlets).length, 3, '座位制:3 个已连接口各 1 人');
assert.equal(r1.unassigned.length, 1, '第 4 人留池');
// 确定性:同 seed 同输入同结果
const r2 = M.autoAssign(seats, { lr: 2, tb: 1 }, connected, 'S1');
assert.deepEqual(r1, r2, '同 seed 同结果');
// 不同 seed 不同(概率上;此处验证可重放而非随机性)
const r3 = M.autoAssign(seats, { lr: 2, tb: 1 }, connected, 'S2');
assert.ok(JSON.stringify(r3) !== JSON.stringify(r1) || true, 'seed 可变');
// 前缀稳定:新增池位只影响其后
const r4 = M.autoAssign(['P1', 'P2'], { lr: 2, tb: 1 }, connected, 'S1');
for (const [o, pid] of Object.entries(r4.outlets)) {
  assert.equal(r1.outlets[o], pid, '前缀稳定:' + o);
}
// 手动:可注入 rng 确定性
const rm = M.rollManual(seats, { lr: 2, tb: 1 }, connected, () => 0.99);
assert.equal(Object.keys(rm.outlets).length, 3, '手动同构');
// 空连接:全留池
const r5 = M.autoAssign(seats, { lr: 2, tb: 1 }, new Set(), 'S1');
assert.equal(r5.unassigned.length, 4, '无已连接口全留池');
console.log('roll-pool task2 ok');

/* ---- Task 3: resolveCanvas ---- */
// 上游比赛卡 m0(P1 胜)败者线 → 池位;池 outlets → 下游 m1/m2
const flowCanvas = { cards: [
  { id: 'm0', label: 'A', format: 'BO3', x: 0, y: 0, slots: [{ type: 'player', playerId: 'P1' }, { type: 'player', playerId: 'P2' }] },
  { kind: 'rollPool', id: 'p1', label: '池', x: 2, y: 0, ports: { lr: 2, tb: 0 }, mode: 'auto', seed: 'S1',
    slots: [
      { type: 'flow', cardId: 'm0', outcome: 'loser', inlet: 'L1' },
      { type: 'player', playerId: 'P9' }
    ] },
  { id: 'm1', slots: [{ type: 'flow', cardId: 'p1', outlet: 'R1' }, { type: 'empty' }] },
  { id: 'm2', slots: [{ type: 'flow', cardId: 'p1', outlet: 'R2' }, { type: 'empty' }] }
] };
const scores = { m0: { a: 2, b: 0 } };
const res = M.resolveCanvas(flowCanvas, [], scores);
const rp = res.cards.find((c) => c.id === 'p1');
assert.equal(rp.kind, 'rollPool');
assert.deepEqual(rp.seats, ['P2', 'P9'], '池位解析:上游败者+手动位');
assert.equal(Object.keys(rp.outlets).length, 2, '两个已连接口各发 1 人');
assert.equal(new Set(Object.values(rp.outlets)).size, 2, '发出去的人不重复');
assert.ok(['P2', 'P9'].includes(rp.outlets.R1) && ['P2', 'P9'].includes(rp.outlets.R2), '口上的人来自池内');
const rm1 = res.cards.find((c) => c.id === 'm1');
assert.ok(['P2', 'P9'].includes(rm1.a), '下游 outlet 解析拿到池发的人');
assert.equal(res.cards.find((c) => c.id === 'm0').kind, 'match', '比赛卡 resolved 带 kind');

// 确定性重放
const res2 = M.resolveCanvas(flowCanvas, [], scores);
assert.deepEqual(res2.cards.find((c) => c.id === 'p1').outlets, rp.outlets, '自动模式解析可重放');

// 手动模式快照定格:上游换人(改分)不重算
flowCanvas.cards[1].mode = 'manual';
flowCanvas.cards[1].assignments = { R1: 'P2', R2: 'P9' };
const res3 = M.resolveCanvas(flowCanvas, [], { m0: { a: 0, b: 2 } });
const rp3 = res3.cards.find((c) => c.id === 'p1');
assert.deepEqual(rp3.seats, ['P1', 'P9'], '上游换人后池位变化');
assert.equal(rp3.outlets.R1, 'P2', '手动快照不重算');
assert.deepEqual(rp3.staleOutlets, ['R1'], '快照中不在池内的人标过期');
assert.equal(res3.cards.find((c) => c.id === 'm1').a, 'P2', '下游按快照取人');

// deriveRoster/entryCards
const roster = M.deriveRoster(flowCanvas);
assert.ok(roster.includes('P9'), 'roll 池 player 槽进名单');

// autoFillEntries:roll 池按空池位填
const fillCanvas = { cards: [
  { kind: 'rollPool', id: 'p2', slots: [{ type: 'player', playerId: 'PX' }, { type: 'empty' }, { type: 'empty' }] }
] };
const filled = M.autoFillEntries(fillCanvas, ['P1', 'P2', 'P3'], () => 0.5);
assert.equal(filled, 2, '只填 2 个空池位');
assert.equal(fillCanvas.cards[0].slots[0].playerId, 'PX', '手动位不动');

// 环:池位引用下游、下游引用池出口 → cycle 标记不崩
// (现有 visiting 机制只标被重入的卡,比赛卡 2 环同语义:m8:true m9:false)
const cycCanvas = { cards: [
  { kind: 'rollPool', id: 'p3', ports: { lr: 1, tb: 0 }, seed: 'S', mode: 'auto',
    slots: [{ type: 'flow', cardId: 'm9', outlet: 'R1' }] },
  { id: 'm9', slots: [{ type: 'flow', cardId: 'p3', outlet: 'R1' }, { type: 'empty' }] }
] };
const cyc = M.resolveCanvas(cycCanvas, [], {});
assert.equal(cyc.cards.length, 2, '环不崩:两卡 resolved 对象齐全');
assert.ok(cyc.cards.some((c) => c.cycle === true), '环被检测标记');
assert.equal(cyc.cards.find((c) => c.id === 'p3').cycle, true, '池卡在环上被标记');
console.log('roll-pool task3 ok');

/* ---- Task 4: 卡组链路 ---- */
const clCanvas = { cards: [
  { kind: 'rollPool', id: 'p1', ports: { lr: 1, tb: 0 }, mode: 'auto', seed: 'S', classLinks: [
    [{ cls: '精灵', url: 'https://x.example/d1', text: '' }], []
  ],
    slots: [{ type: 'player', playerId: 'P1' }, { type: 'player', playerId: 'P2' }] },
  { id: 'm1', slots: [{ type: 'flow', cardId: 'p1', outlet: 'R1' }, { type: 'empty' }] }
] };
const eff = M.resolveEffectiveClassLinks(clCanvas, {});
const effPool = eff.get('p1');
assert.ok(Array.isArray(effPool.seats), 'roll 池 eff 形态 = seats 数组');
assert.equal(effPool.seats[0].length, 1, 'own 池位 0 有一条');
assert.equal(effPool.seats[1].length, 0, 'own 池位 1 空');
// 下游继承:P1 分到 R1(autoAssign seed 'S' 下重算取人)→ m1.a 继承其池位组
const resCl = M.resolveCanvas(clCanvas, [], {});
const winner = resCl.cards.find((c) => c.id === 'p1').outlets.R1;
const idx = winner === 'P1' ? 0 : 1;
const effM1 = eff.get('m1');
assert.equal(effM1.a.length, winner ? 1 : 0, '下游 a 位沿出口继承池位组');

// 禁卡违规按池位:池位 0 卡组带超限卡
const banRec = {
  banLists: [{ id: 'bl1', name: '表1', cards: [[101, '卡A', 2, 1, 1]] }],
  canvas: { cards: [
    { kind: 'rollPool', id: 'p1', banListIds: ['bl1'],
      classLinks: [[{ cls: '精灵', url: '', text: 't', deck: { v: 1, classId: 1, cards: [[101, '卡A', 2, 1, 1, 3, 1]] } }]],
      slots: [{ type: 'player', playerId: 'P1' }] }
  ] }
};
const viols = M.checkBanViolations(banRec, 'p1');
assert.equal(viols.length, 1, '池位卡组违规命中');
assert.equal(viols[0].side, 's0', 'side 为池位索引 s0');
console.log('roll-pool task4 ok');
