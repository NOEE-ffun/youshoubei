'use strict';
/* 模板捕获/落子纯函数——canvas-model 侧,node 直跑 */
const assert = require('node:assert/strict');
const model = require('../canvas-model.js');

function flow(cardId, outcome) { return { type: 'flow', cardId, outcome }; }

const CARDS = [
  { id: 'a', kind: 'match', label: '胜者决赛', x: 2, y: 1, w: 10, h: 7, color: '#FF8800',
    phase: '胜者组', format: 'BO3', exitRanks: { winner: 1 },
    slots: [flow('b', 'winner'), { type: 'player', playerId: 'p1' }], futureField: 'x' },
  { id: 'b', kind: 'match', label: '半决赛', x: 0, y: 0, w: 10, h: 7,
    slots: [flow('OUTSIDE', 'winner'), { type: 'empty' }] },
  { id: 'p', kind: 'rollPool', x: 5, y: 9, w: 10, h: 7, seed: 'sabc',
    entryCapacity: 4, slots: [{ type: 'empty' }, { type: 'empty' }] }
];

// 1) 捕获:白名单/相对坐标/slots 处理/集外 flow 丢弃
{
  const tpl = model.captureTemplate(CARDS);
  assert.equal(tpl.cards.length, 3);
  const a = tpl.cards[0], b = tpl.cards[1];
  assert.equal(a.label, '胜者决赛'); assert.equal(a.color, '#FF8800');
  assert.equal('futureField' in a, false, '未知字段不得进模板');
  assert.equal(a.id, undefined, '模板卡不含 id');
  assert.equal(a.x, 2); assert.equal(a.y, 1);           // bbox 左上=(0,0)=b
  assert.equal(b.x, 0); assert.equal(b.y, 0);
  assert.deepEqual(a.slots[0], { type: 'flow', cardId: '1', outcome: 'winner' }, '集内 flow→下标');
  assert.deepEqual(a.slots[1], { type: 'empty' }, '选手分配置空');
  assert.deepEqual(b.slots[0], { type: 'empty' }, '集外 flow 丢弃');
  assert.equal(tpl.cards[2].seed, 'sabc', '池卡 seed 随模板保留');
  assert.equal(tpl.cards[2].entryCapacity, 4);
}

// 2) 落子:新 id/flow 重映射/中心对齐取整/两次落子互相独立
{
  const tpl = model.captureTemplate(CARDS);
  let n = 0; const mk = () => 'n' + (++n);
  const out = model.materializeTemplate(tpl, 30, 20, mk);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(c => c.id).sort(), ['n1', 'n2', 'n3']);
  const byLabel = Object.fromEntries(out.map(c => [c.label, c]));
  const a = byLabel['胜者决赛'], b = byLabel['半决赛'];
  assert.equal(a.slots[0].cardId, b.id, 'flow 下标→新 id');
  assert.deepEqual(a.slots[1], { type: 'empty' });
  // bbox 宽=15 高=16(含 p 卡),中心(30,20)→左上应=(22.5,12)→取整(23,12),b(原点卡)=(23,12)
  assert.equal(b.x, 23); assert.equal(b.y, 12);
  assert.ok(Number.isInteger(a.x) && Number.isInteger(a.y));
  const out2 = model.materializeTemplate(tpl, 0, 0, mk);
  assert.notEqual(out[0].id, out2[0].id, '两次落子 id 独立');
}

// 3) 空集/全非法输入
assert.deepEqual(model.captureTemplate([]), { cards: [], meta: { w: 0, h: 0 } });
assert.deepEqual(model.materializeTemplate({ cards: [] }, 5, 5), []);

console.log('templates(model): 3 组断言通过 ✓');
