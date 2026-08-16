'use strict';

const assert = require('node:assert/strict');
const {
  createDefaultCanvas,
  createBlankTournament,
  getResult,
  getDeckCount,
  resolveCanvas,
  deriveStandings,
  ensureCanvasDecks,
  migrateLegacyTournament
} = require('../canvas-model.js');

const seeds = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'];

function score(entries) {
  return Object.fromEntries(entries.map(([id, a, b]) => [id, { a, b }]));
}

// 1. 默认画布：14 张卡，种子卡直接显示选手
const canvas = createDefaultCanvas(seeds);
assert.equal(canvas.cards.length, 14, '默认画布应为 14 场');
const empty = resolveCanvas(canvas, seeds, {});
assert.equal(empty.cards.find((c) => c.id === 'wb_r1_1').a, 'P1');
assert.equal(empty.cards.find((c) => c.id === 'wb_r1_1').b, 'P2');
assert.equal(empty.cards.find((c) => c.id === 'wb_r2_1').a, null);
assert.equal(empty.cards.find((c) => c.id === 'wb_r2_1').b, null);

// 2. 部分赛程：P1 胜 P2 后，胜者/败者分别推进
const partial = score([['wb_r1_1', 2, 0]]);
const partialResolved = resolveCanvas(canvas, seeds, partial);
assert.equal(partialResolved.cards.find((c) => c.id === 'wb_r2_1').a, 'P1');
assert.equal(partialResolved.cards.find((c) => c.id === 'lb_r1_1').a, 'P2');

// 3. 完整赛程后自动排名
const full = score([
  ['wb_r1_1', 2, 0], ['wb_r1_2', 2, 0], ['wb_r1_3', 2, 0], ['wb_r1_4', 2, 0],
  ['wb_r2_1', 2, 0], ['wb_r2_2', 2, 0], ['wb_final', 3, 0],
  ['lb_r1_1', 2, 1], ['lb_r1_2', 2, 1], ['lb_r2_1', 0, 2], ['lb_r2_2', 2, 0],
  ['lb_r3', 2, 0], ['lb_final', 1, 3], ['grand_final', 3, 2]
]);
const fullResolved = resolveCanvas(canvas, seeds, full);
const byId = Object.fromEntries(fullResolved.cards.map((c) => [c.id, c]));
assert.equal(byId.wb_r2_1.a, 'P1');
assert.equal(byId.lb_r1_1.a, 'P2');
assert.equal(byId.lb_final.a, 'P5');
assert.equal(byId.lb_final.b, 'P2');
assert.equal(byId.grand_final.a, 'P1');
assert.equal(byId.grand_final.b, 'P2');
const standings = fullResolved.standings;
assert.deepEqual(standings.standings.map((s) => [s.rank, s.playerId]), [[1, 'P1'], [2, 'P2'], [3, 'P5']]);
assert.equal(fullResolved.standings.champion, 'P1');
assert.equal(fullResolved.standings.runnerUp, 'P2');
assert.equal(fullResolved.standings.thirdPlace, 'P5');

// 4. 比分语义：平局、弃权、双方弃权
assert.equal(getResult({ a: 1, b: 1 }).draw, true);
assert.equal(getResult({ a: -1, b: 2 }).winnerSide, 1);
assert.equal(getResult({ a: -1, b: 2 }).forfeit, true);
assert.equal(getResult({ a: -1, b: -1 }).valid, false);
assert.equal(getResult({ a: 2, b: 1 }).winnerSide, 0);

// 5. 格式文本只影响卡组数量，不影响比分合法性
assert.equal(getDeckCount({ format: 'BO3' }), 2);
assert.equal(getDeckCount({ format: 'BO5' }), 3);
assert.equal(getDeckCount({ format: 'BO7' }), 4);
assert.equal(getDeckCount({ format: '自定义' }), 2);

// 6. 环检测：A→B→A 的环应被标记
const cycleCanvas = {
  cards: [
    { id: 'c1', label: 'C1', format: 'BO3', x: 0, y: 0, slots: [
      { type: 'flow', cardId: 'c2', outcome: 'winner' },
      { type: 'player', playerId: 'P1' }
    ] },
    { id: 'c2', label: 'C2', format: 'BO3', x: 1, y: 0, slots: [
      { type: 'flow', cardId: 'c1', outcome: 'winner' },
      { type: 'player', playerId: 'P2' }
    ] }
  ]
};
const cycleResolved = resolveCanvas(cycleCanvas, seeds, {});
assert.ok(cycleResolved.cycleIds.length > 0, '应检测到环');
assert.ok(cycleResolved.cards.some((c) => c.cycle), '环上的卡片应标记 cycle');

// 7. 卡组补齐：默认画布为每场参赛者生成卡组
const record = {
  canvas,
  roster: seeds,
  scores: full,
  matchDecks: {}
};
ensureCanvasDecks(record);
assert.ok(record.matchDecks.wb_r1_1.P1.length === 2);
assert.ok(record.matchDecks.grand_final.P1.length === 3);
assert.equal(record.matchDecks.grand_final.P1[0], record.matchDecks.wb_r1_1.P1[0], '选手卡组应在卡片间自动继承');

// 8. 旧数据迁移：内嵌 players 转为 roster + canvas + 全局选手
const globalPlayers = new Map();
const legacy = {
  id: 't_old',
  name: '旧比赛',
  players: [
    { id: 'P1', name: 'P1', decks: [{ id: 'd1', name: '主卡组', images: ['img'] }] },
    { id: 'P2', name: 'P2' },
    { id: 'P3', name: 'P3' }, { id: 'P4', name: 'P4' },
    { id: 'P5', name: 'P5' }, { id: 'P6', name: 'P6' },
    { id: 'P7', name: 'P7' }, { id: 'P8', name: 'P8' }
  ],
  scores: {},
  matchDecks: {}
};
migrateLegacyTournament(legacy, globalPlayers);
assert.equal(legacy.players, undefined, '旧 players 字段应删除');
assert.equal(legacy.roster.length, 8);
assert.equal(legacy.canvas.cards.length, 14);
assert.equal(globalPlayers.size, 8);
assert.equal(legacy.matchDecks.wb_r1_1.P1[0].name, '主卡组', '旧卡组应迁移');

// 9. 空白比赛
const blank = createBlankTournament('空白');
assert.equal(blank.canvas.cards.length, 0);
assert.equal(blank.roster.length, 0);

console.log('canvas-model 全部 9 组测试通过 ✓');
