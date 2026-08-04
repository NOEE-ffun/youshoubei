'use strict';

const assert = require('node:assert/strict');
const {
  MATCHES,
  isScoreValid,
  resolveAll,
  deriveStandings,
  groupByPhase
} = require('../bracket-model.js');

const seeds = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'];

function scores(entries) {
  return Object.fromEntries(entries.map(([id, a, b]) => [id, { a, b }]));
}

// 1. 拓扑完整性：14 场，各组轮次数量正确
assert.equal(MATCHES.length, 14, '应为 14 场比赛');
const byPhase = groupByPhase(MATCHES);
assert.deepEqual(
  Object.fromEntries(Object.entries(byPhase).map(([k, v]) => [k, v.length])),
  { wb: 7, lb: 6, gf: 1 }
);
assert.deepEqual(
  byPhase.wb.reduce((acc, m) => ((acc[m.round] = (acc[m.round] || 0) + 1), acc), {}),
  { 1: 4, 2: 2, 3: 1 },
  '胜者组应为 4→2→1'
);
assert.deepEqual(
  byPhase.lb.reduce((acc, m) => ((acc[m.round] = (acc[m.round] || 0) + 1), acc), {}),
  { 1: 2, 2: 2, 3: 1, 4: 1 },
  '败者组应为 2→2→1→1'
);

// 2. 未赛对位：种子场显示选手，非种子场显示待定
const empty = resolveAll(seeds, {});
assert.equal(empty.find((m) => m.id === 'wb_r1_1').a, 'P1');
assert.equal(empty.find((m) => m.id === 'wb_r1_1').b, 'P2');
for (const id of ['wb_r2_1', 'lb_r1_1', 'lb_r3', 'lb_final', 'grand_final']) {
  const m = empty.find((x) => x.id === id);
  assert.equal(m.a, null, `${id} 的 A 位应为待定`);
  assert.equal(m.b, null, `${id} 的 B 位应为待定`);
  assert.equal(m.played, false);
}

// 3. 比分合法性
assert.equal(isScoreValid(2, 0), true);
assert.equal(isScoreValid(2, 1), true);
assert.equal(isScoreValid(1, 2), true);
assert.equal(isScoreValid(0, 2), true);
assert.equal(isScoreValid(1, 1), false);
assert.equal(isScoreValid(2, 2), false);
assert.equal(isScoreValid(0, 0), false);

// 4. 部分赛程：R1 第一场 P1 胜 P2，下游只推进该分支
const partial = scores([
  ['wb_r1_1', 2, 0]
]);
const partialResolved = resolveAll(seeds, partial);
const wbR2_1 = partialResolved.find((m) => m.id === 'wb_r2_1');
assert.equal(wbR2_1.a, 'P1');
assert.equal(wbR2_1.b, null);
const lbR1_1 = partialResolved.find((m) => m.id === 'lb_r1_1');
assert.equal(lbR1_1.a, 'P2');
assert.equal(lbR1_1.b, null);

// 5. 修改旧比分后下游重算：把 R1 第一场改为 P2 胜
const flipped = scores([
  ['wb_r1_1', 1, 2]
]);
const flippedResolved = resolveAll(seeds, flipped);
assert.equal(flippedResolved.find((m) => m.id === 'wb_r2_1').a, 'P2');
assert.equal(flippedResolved.find((m) => m.id === 'lb_r1_1').a, 'P1');

// 5. 胜者组决赛败者不应被淘汰：打完胜者组后，败者应进入败者组决赛 A 位
const wbOnly = scores([
  ['wb_r1_1', 2, 0],
  ['wb_r1_2', 2, 0],
  ['wb_r1_3', 2, 0],
  ['wb_r1_4', 2, 0],
  ['wb_r2_1', 2, 0],
  ['wb_r2_2', 2, 0],
  ['wb_final', 2, 0]
]);
const wbOnlyResolved = resolveAll(seeds, wbOnly);
const wbOnlyLbFinal = wbOnlyResolved.find((m) => m.id === 'lb_final');
assert.equal(wbOnlyLbFinal.a, 'P5', '胜者组决赛败者应进入败者组决赛');
assert.equal(wbOnlyLbFinal.b, null, '败者组半决赛未赛时，B 位应为待定');

// 6. 完整赛程：P1 最终夺冠，P2 为亚军，P5 为季军
const full = scores([
  ['wb_r1_1', 2, 0],
  ['wb_r1_2', 2, 0],
  ['wb_r1_3', 2, 0],
  ['wb_r1_4', 2, 0],
  ['wb_r2_1', 2, 0],
  ['wb_r2_2', 2, 0],
  ['wb_final', 2, 0],
  ['lb_r1_1', 2, 1],
  ['lb_r1_2', 2, 1],
  ['lb_r2_1', 0, 2],
  ['lb_r2_2', 2, 0],
  ['lb_r3', 2, 0],
  ['lb_final', 0, 2],
  ['grand_final', 2, 1]
]);
const fullResolved = resolveAll(seeds, full);
const byId = Object.fromEntries(fullResolved.map((m) => [m.id, m]));
assert.equal(byId.wb_r2_1.a, 'P1');
assert.equal(byId.wb_r2_1.b, 'P3');
assert.equal(byId.lb_r1_1.a, 'P2');
assert.equal(byId.lb_r1_1.b, 'P4');
assert.equal(byId.lb_r2_1.a, 'P3');
assert.equal(byId.lb_r2_1.b, 'P2');
assert.equal(byId.lb_r3.a, 'P2');
assert.equal(byId.lb_r3.b, 'P7');
assert.equal(byId.lb_final.a, 'P5');
assert.equal(byId.lb_final.b, 'P2');
assert.equal(byId.grand_final.a, 'P1');
assert.equal(byId.grand_final.b, 'P2');
const standings = deriveStandings(seeds, full);
assert.equal(standings.champion, 'P1');
assert.equal(standings.runnerUp, 'P2');
assert.equal(standings.thirdPlace, 'P5');

// 7. 反向结果：总决赛 P2 获胜，P2 夺冠、P1 亚军、P5 季军
const p2Wins = { ...full, grand_final: { a: 1, b: 2 } };
assert.equal(deriveStandings(seeds, p2Wins).champion, 'P2');
assert.equal(deriveStandings(seeds, p2Wins).runnerUp, 'P1');
assert.equal(deriveStandings(seeds, p2Wins).thirdPlace, 'P5');

console.log('bracket-model 全部 7 组测试通过 ✓');
