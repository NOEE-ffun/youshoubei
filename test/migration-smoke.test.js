'use strict';

const assert = require('node:assert/strict');
const model = require('../canvas-model.js');

const globalPlayers = new Map();

// 1. 旧版数据：players + 固定 scores/matchDecks，没有 canvas
const legacy = {
  id: 't1',
  name: '旧比赛',
  players: [
    { id: 'p1', name: 'A', decks: [{ id: 'd1', name: '主卡组', images: ['img'] }, { id: 'd2', name: '副卡组', images: [] }] },
    { id: 'p2', name: 'B' }
  ],
  scores: { wb_r1_1: { a: 2, b: 0 } },
  matchDecks: {}
};
model.migrateLegacyTournament(legacy, globalPlayers);
assert.ok(legacy.canvas, '旧数据应生成 canvas');
assert.deepEqual(legacy.canvas.size, { cols: 40, rows: 24 }, '旧数据应获得默认画布大小');
assert.equal(legacy.roster.length, 2, '旧数据应生成 roster');
assert.equal(globalPlayers.size, 2, '旧选手应进入全局选手库');
assert.equal(legacy.matchDecks.wb_r1_1.p1[0].name, '主卡组', '旧卡组应迁移');

// 2. 中间版本：已有 canvas/roster，但没有 canvas.size
const intermediate = {
  id: 't2',
  name: '中间版本',
  canvas: { cards: [{ id: 'c1', label: 'x', slots: [{ type: 'player', playerId: 'p1' }, { type: 'empty' }] }] },
  roster: [],
  scores: {},
  matchDecks: {}
};
model.migrateLegacyTournament(intermediate, globalPlayers);
assert.deepEqual(intermediate.canvas.size, { cols: 40, rows: 24 }, '中间版本应补齐画布大小');
assert.deepEqual(model.deriveRoster(intermediate.canvas), ['p1'], 'roster 应从画布推导');

// 3. 新版数据：参赛名单自动继承
const canvas = model.createDefaultCanvas(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);
const full = Object.fromEntries([
  ['wb_r1_1', 2, 0], ['wb_r1_2', 2, 0], ['wb_r1_3', 2, 0], ['wb_r1_4', 2, 0],
  ['wb_r2_1', 2, 0], ['wb_r2_2', 2, 0], ['wb_final', 3, 0],
  ['lb_r1_1', 2, 1], ['lb_r1_2', 2, 1], ['lb_r2_1', 0, 2], ['lb_r2_2', 2, 0],
  ['lb_r3', 2, 0], ['lb_final', 1, 3], ['grand_final', 3, 2]
].map(([id, a, b]) => [id, { a, b }]));
const record = {
  canvas,
  roster: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'],
  scores: full,
  matchDecks: {}
};
model.ensureCanvasDecks(record);
assert.equal(record.matchDecks.wb_r1_1.p1[0], record.matchDecks.grand_final.p1[0], '选手卡组应在卡片间继承');

console.log('migration-smoke 全部 3 组测试通过 ✓');
