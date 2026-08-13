'use strict';

const assert = require('node:assert/strict');
const {
  MATCHES,
  isScoreValid,
  isBestOfFive,
  getScoreOptions,
  getDeckCount,
  ensureMatchDecks,
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

// 3. 赛制与比分合法性
assert.equal(isBestOfFive('wb_final'), true);
assert.equal(isBestOfFive('lb_final'), true);
assert.equal(isBestOfFive('grand_final'), true);
assert.equal(isBestOfFive('wb_r1_1'), false);
assert.equal(getDeckCount('wb_r1_1'), 2);
assert.equal(getDeckCount('grand_final'), 3);
assert.deepEqual(getScoreOptions('wb_r1_1'), [[2, 0], [2, 1], [1, 2], [0, 2]]);
assert.deepEqual(getScoreOptions('wb_final'), [[3, 0], [3, 1], [3, 2], [2, 3], [1, 3], [0, 3]]);
assert.equal(isScoreValid('wb_r1_1', 2, 0), true);
assert.equal(isScoreValid('wb_r1_1', 2, 1), true);
assert.equal(isScoreValid('wb_r1_1', 1, 2), true);
assert.equal(isScoreValid('wb_r1_1', 0, 2), true);
assert.equal(isScoreValid('wb_r1_1', 1, 1), false);
assert.equal(isScoreValid('wb_r1_1', 3, 2), false);
assert.equal(isScoreValid('wb_final', 3, 0), true);
assert.equal(isScoreValid('wb_final', 3, 2), true);
assert.equal(isScoreValid('wb_final', 2, 3), true);
assert.equal(isScoreValid('wb_final', 2, 1), false);

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
  ['wb_final', 3, 0]
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
  ['wb_final', 3, 0],
  ['lb_r1_1', 2, 1],
  ['lb_r1_2', 2, 1],
  ['lb_r2_1', 0, 2],
  ['lb_r2_2', 2, 0],
  ['lb_r3', 2, 0],
  ['lb_final', 1, 3],
  ['grand_final', 3, 2]
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
const p2Wins = { ...full, grand_final: { a: 2, b: 3 } };
assert.equal(deriveStandings(seeds, p2Wins).champion, 'P2');
assert.equal(deriveStandings(seeds, p2Wins).runnerUp, 'P1');
assert.equal(deriveStandings(seeds, p2Wins).thirdPlace, 'P5');

// 8. 按对局补齐卡组：旧版选手卡组迁移到各对局，BO5 补第三套
const legacyRecord = {
  players: [
    { id: 'P1', name: 'P1', decks: [{ id: 'd1', name: '主卡组', images: ['img-a'] }, { id: 'd2', name: '备卡组', images: [] }] },
    { id: 'P2', name: 'P2', decks: [] },
    { id: 'P3', name: 'P3' },
    { id: 'P4', name: 'P4' },
    { id: 'P5', name: 'P5' },
    { id: 'P6', name: 'P6' },
    { id: 'P7', name: 'P7' },
    { id: 'P8', name: 'P8' }
  ],
  scores: {},
  matchDecks: {}
};
ensureMatchDecks(legacyRecord);
const r1P1 = legacyRecord.matchDecks.wb_r1_1.P1;
assert.equal(r1P1.length, 2, 'BO3 每名选手应有两套卡组');
assert.equal(r1P1[0].name, '主卡组');
assert.deepEqual(r1P1[0].images, ['img-a'], '旧卡组图片应迁移');
assert.equal(legacyRecord.matchDecks.wb_r1_1.P2[0].name, '卡组 1', '无旧卡组时生成默认卡组');

// BO5 对局：先用完整赛程让 P1 进入胜者组决赛
const migrated = ensureMatchDecks({
  players: legacyRecord.players,
  scores: full,
  matchDecks: {}
});
const finalP1 = migrated.matchDecks.wb_final.P1;
assert.equal(finalP1.length, 3, 'BO5 每名选手应有三套卡组');
assert.equal(finalP1[0].name, '主卡组');
assert.equal(finalP1[2].name, '卡组 3', '第三套应为空卡组');
assert.deepEqual(finalP1[2].images, []);

// 已存在的对局卡组不应被覆盖
const preserved = ensureMatchDecks({
  players: legacyRecord.players,
  scores: full,
  matchDecks: {
    wb_r1_1: {
      P1: [{ id: 'custom', name: '自定卡组', images: ['x'] }]
    }
  }
});
assert.equal(preserved.matchDecks.wb_r1_1.P1[0].name, '自定卡组', '已有条目不应被覆盖');

// 9. 旧数据迁移/修复后，所有对局的卡组 id 必须全局唯一
const duplicateRecord = {
  players: legacyRecord.players,
  scores: full,
  matchDecks: {
    wb_r1_1: {
      P1: [{ id: 'd1', name: '主卡组', images: [] }, { id: 'd2', name: '备卡组', images: [] }]
    },
    wb_r2_1: {
      P1: [{ id: 'd1', name: '主卡组', images: [] }, { id: 'd2', name: '备卡组', images: [] }]
    },
    wb_final: {
      P1: [
        { id: 'd1', name: '主卡组', images: [] },
        { id: 'd2', name: '备卡组', images: [] },
        { id: 'd3', name: '卡组 3', images: [] }
      ]
    }
  }
};
ensureMatchDecks(duplicateRecord);
const allDeckIds = [];
for (const matchId of Object.keys(duplicateRecord.matchDecks)) {
  for (const playerId of Object.keys(duplicateRecord.matchDecks[matchId])) {
    for (const deck of duplicateRecord.matchDecks[matchId][playerId]) {
      allDeckIds.push(deck.id);
    }
  }
}
assert.equal(new Set(allDeckIds).size, allDeckIds.length, '迁移后卡组 id 应全局唯一');
assert.equal(duplicateRecord.matchDecks.wb_r1_1.P1[0].id, 'd1', '第一次出现的 id 应保留');
assert.notEqual(duplicateRecord.matchDecks.wb_r2_1.P1[0].id, 'd1', '重复的 id 应被替换');

// 10. 修复幂等：再次补齐不会改变已经唯一的 id
const repairedSnapshot = JSON.stringify(duplicateRecord.matchDecks);
ensureMatchDecks(duplicateRecord);
assert.equal(JSON.stringify(duplicateRecord.matchDecks), repairedSnapshot, '重复调用不应改变卡组 id');

// 11. 头像占位色：确定性 + 在色板范围内
const { AVATAR_COLORS, avatarColor } = require('../bracket-model.js');
assert.equal(avatarColor('P1'), avatarColor('P1'), '同一选手颜色应稳定');
assert.ok(AVATAR_COLORS.includes(avatarColor('P1')), '颜色应来自色板');
assert.equal(AVATAR_COLORS.length, 8, '色板应有 8 色');

console.log('bracket-model 全部 11 组测试通过 ✓');
