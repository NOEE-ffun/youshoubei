'use strict';

const assert = require('node:assert/strict');
const {
  createDefaultCanvas,
  createBlankTournament,
  getResult,
  getDeckCount,
  resolveCanvas,
  deriveStandings,
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

// 7. 旧数据迁移：内嵌 players 转为 roster + canvas + 全局选手
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

// 10. 卡片样式与染色归一化
const model = require('../canvas-model.js');
{
  const styled = model.normalizeCanvas({
    cards: [{ id: 'c1', color: '#FF8800' }, { id: 'c2', color: 'red' }],
    style: { opacity: 0.5, blur: 12 }
  });
  assert.deepEqual(styled.style, { opacity: 0.5, blur: 12 }, '合法样式应保留');
  assert.equal(styled.cards[0].color, '#FF8800', '合法染色应保留');
  assert.equal(styled.cards[1].color, null, '非法染色应归 null');

  const clamped = model.normalizeCanvas({ cards: [], style: { opacity: 2, blur: 99 } });
  assert.deepEqual(clamped.style, { opacity: 1, blur: 24 }, '越界样式应夹紧');

  const defaults = model.normalizeCanvas({ cards: [] });
  assert.deepEqual(defaults.style, { opacity: 0.7, blur: 8 }, '缺省样式应回默认');
}

// 11. 职业卡组链接(classLinks)归一化:A/B 两组
{
  const linked = model.normalizeCanvas({
    cards: [{
      id: 'c1',
      classLinks: {
        a: [
          { cls: '法师', url: 'https://sv.example/deck', text: '提速法师' },
          { cls: '不存在', url: 'x' },
          { cls: '精灵' },
          '垃圾'
        ],
        b: [{ cls: '皇家', url: 'https://sv.example/d2', text: '皇家' }]
      }
    }]
  });
  assert.equal(model.CLASS_LIST.length, 7, '应有 7 个职业');
  assert.deepEqual(linked.cards[0].classLinks.a, [{ cls: '法师', url: 'https://sv.example/deck', text: '提速法师' }],
    '非法职业/无内容项应被丢弃');
  assert.deepEqual(linked.cards[0].classLinks.b, [{ cls: '皇家', url: 'https://sv.example/d2', text: '皇家' }]);

  // 旧扁平数组整体迁入 a 组
  const legacy = model.normalizeCanvas({ cards: [{ id: 'c2', classLinks: [{ cls: '龙族', url: 'https://x', text: 't' }] }] });
  assert.equal(legacy.cards[0].classLinks.a.length, 1, '旧扁平数组应迁入 a 组');
  assert.equal(legacy.cards[0].classLinks.b.length, 0);

  const empty = model.normalizeCanvas({ cards: [{ id: 'c3' }] });
  assert.deepEqual(empty.cards[0].classLinks, { a: [], b: [] }, '缺省应为空双组');
}

// 12. 卡组继承(有效链接 = 自己填的,否则沿连线继承来源卡中该选手一侧)
{
  const P = i => 'P' + i;
  const deck = (cls, text) => [{ cls, url: 'https://sv/' + cls, text }];
  // c1: P1(a) vs P2(b),P1 胜 → c2 的 a 槽(flow winner)应继承 c1.a 的卡组
  // c3: a 槽也是 flow(winner of c2),未开赛 → 继承不到;连线成环 → 空
  const canvas = {
    cards: [
      { id: 'c1', slots: [{ type: 'player', playerId: P(1) }, { type: 'player', playerId: P(2) }], classLinks: { a: deck('法师', '提速'), b: [] } },
      { id: 'c2', slots: [{ type: 'flow', cardId: 'c1', outcome: 'winner' }, { type: 'player', playerId: P(3) }] },
      { id: 'c3', slots: [{ type: 'flow', cardId: 'c2', outcome: 'winner' }, { type: 'player', playerId: P(4) }] },
      { id: 'c4', slots: [{ type: 'flow', cardId: 'c1', outcome: 'winner' }, { type: 'player', playerId: P(5) }], classLinks: { a: deck('龙族', '自填'), b: [] } },
      { id: 'cx', slots: [{ type: 'flow', cardId: 'cy', outcome: 'winner' }, { type: 'player', playerId: P(6) }] },
      { id: 'cy', slots: [{ type: 'flow', cardId: 'cx', outcome: 'winner' }, { type: 'player', playerId: P(7) }] }
    ]
  };
  const scores = { c1: { a: 2, b: 0 } }; // P1 胜 c1;c2 未赛
  const eff = model.resolveEffectiveClassLinks(canvas, scores);
  assert.deepEqual(eff.get('c1').a, deck('法师', '提速'), '自己填的用自己的');
  assert.deepEqual(eff.get('c2').a, deck('法师', '提速'), 'c2.a 应继承 c1.a(P1 胜)');
  assert.deepEqual(eff.get('c3').a, [], 'c2 未开赛,c3 继承不到');
  assert.deepEqual(eff.get('c4').a, deck('龙族', '自填'), '自己填写覆盖继承');
  assert.deepEqual(eff.get('cx').a, [], '连线成环安全返回空');
  assert.deepEqual(eff.get('cy').a, [], '环另一侧同样为空');
}

console.log('canvas-model 全部 11 组测试通过 ✓');
