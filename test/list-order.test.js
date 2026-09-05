'use strict';

/* 列表排序纯函数单测:分组派生 + 序写回(设计 §3)。
 * 列表顺序唯一真源 = canvas.cards 数组序:阶段按首次出现分组、组内按数组序。 */

const assert = require('node:assert/strict');
const CanvasModel = require('../canvas-model.js');

function card(id, phase) {
  return CanvasModel.normalizeCard({ id, label: id, phase, format: 'BO3', x: 1, y: 1, slots: [] });
}

// 1. 分组:按首次出现顺序;空 phase 归 __other__;不改入参顺序
{
  const cards = [card('a', '胜者组'), card('b', ''), card('c', '胜者组'), card('d', '败者组')];
  const groups = CanvasModel.listGroups(cards);
  assert.deepEqual(groups.map((g) => g.key), ['胜者组', '__other__', '败者组']);
  assert.deepEqual(groups[0].cards.map((c) => c.id), ['a', 'c']);
  assert.equal(groups[1].phase, '');
  assert.equal(cards.length, 4, '不修改入参');
}

// 2. 重排组序写回:卡片对象引用原样,x/y/color 等字段不动
{
  const canvas = { cards: [card('a', '胜者组'), card('b', '胜者组'), card('c', '败者组')] };
  const groups = CanvasModel.listGroups(canvas.cards).reverse();
  assert.equal(CanvasModel.applyListOrder(canvas, groups), true);
  assert.deepEqual(canvas.cards.map((c) => c.id), ['c', 'a', 'b']);
  assert.equal(canvas.cards[1].phase, '胜者组');
}

// 3. 组内重排 + 跨组移动(phase 由调用方改,函数只管序)
{
  const canvas = { cards: [card('a', '胜者组'), card('b', '胜者组'), card('c', '败者组')] };
  const groups = CanvasModel.listGroups(canvas.cards);
  const [b] = groups[0].cards.splice(1, 1);
  b.phase = '败者组';
  groups[1].cards.push(b);
  assert.equal(CanvasModel.applyListOrder(canvas, groups), true);
  assert.deepEqual(canvas.cards.map((c) => c.id), ['a', 'c', 'b']);
  assert.equal(canvas.cards[2].phase, '败者组');
}

// 4. 一致性守卫:多卡/少卡/重复/换卡 → false 且数据不动
{
  const canvas = { cards: [card('a', '胜者组'), card('b', '败者组')] };
  const groups = CanvasModel.listGroups(canvas.cards);
  groups[0].cards.push(card('x', '胜者组'));
  assert.equal(CanvasModel.applyListOrder(canvas, groups), false);
  assert.deepEqual(canvas.cards.map((c) => c.id), ['a', 'b'], '失败不动数据');
  const groups2 = CanvasModel.listGroups(canvas.cards);
  groups2[1].cards.splice(0, 1);
  assert.equal(CanvasModel.applyListOrder(canvas, groups2), false);
}

// 5. 空数组与空组:空组自然消失(重拼后无其卡片)
{
  const canvas = { cards: [card('a', '胜者组')] };
  const groups = CanvasModel.listGroups(canvas.cards);
  const [a] = groups[0].cards.splice(0, 1);
  a.phase = '新组';
  groups.push({ key: '新组', phase: '新组', cards: [a] });
  assert.equal(CanvasModel.applyListOrder(canvas, groups), true);
  assert.equal(canvas.cards[0].phase, '新组');
  assert.deepEqual(CanvasModel.listGroups([]), []);
}

console.log('list-order: 全部通过');
