'use strict';

/* cloneCardsForPaste 纯函数测试(不依赖 DOM/网络):
 * 集内连线引用跟随重映射、集外引用保留、id 全新、位置平移、深拷贝隔离。 */

const assert = require('node:assert');
const { cloneCardsForPaste } = require('../canvas-model.js');

let seq = 0;
const deterministicId = () => 'new_' + (++seq);

function card(id, x, y, slots) {
  return { id, label: '卡' + id, phase: '', format: 'BO3', x, y, slots: slots || [{ type: 'empty' }, { type: 'empty' }], exitRanks: {} };
}

function main() {
  /* 1. 集内引用重映射:A→B 的连线在副本中变为 A'→B' */
  seq = 0;
  const source = [
    card('a', 1, 1),
    card('b', 2, 1, [{ type: 'flow', cardId: 'a', outcome: 'winner' }, { type: 'empty' }])
  ];
  const copies = cloneCardsForPaste(source, 1, 2, deterministicId);
  assert.strictEqual(copies.length, 2);
  assert.strictEqual(copies[0].id, 'new_1');
  assert.strictEqual(copies[1].id, 'new_2');
  assert.strictEqual(copies[1].slots[0].cardId, 'new_1');
  assert.strictEqual(copies[1].slots[0].outcome, 'winner');

  /* 2. 集外引用保留:指向未复制卡的连线原样 */
  seq = 100;
  const withExternal = [card('c', 0, 0, [{ type: 'flow', cardId: 'outside', outcome: 'loser' }, { type: 'empty' }])];
  const copies2 = cloneCardsForPaste(withExternal, 0, 0, deterministicId);
  assert.strictEqual(copies2[0].slots[0].cardId, 'outside');

  /* 3. 位置平移 + label 副本后缀 + 深拷贝隔离 */
  seq = 200;
  const one = card('d', 3, 4);
  const copies3 = cloneCardsForPaste([one], 1, 1, deterministicId);
  assert.strictEqual(copies3[0].x, 4);
  assert.strictEqual(copies3[0].y, 5);
  assert.strictEqual(copies3[0].label, '卡d 副本');
  one.label = '被改';
  one.x = 99;
  assert.strictEqual(copies3[0].label, '卡d 副本');
  assert.strictEqual(copies3[0].x, 4);

  /* 4. 多卡相对位置保持 + 空输入 */
  seq = 300;
  const pair = [card('e', 2, 2), card('f', 5, 6)];
  const copies4 = cloneCardsForPaste(pair, 1, 1, deterministicId);
  assert.strictEqual(copies4[0].x - copies4[1].x, pair[0].x - pair[1].x);
  assert.strictEqual(copies4[0].y - copies4[1].y, pair[0].y - pair[1].y);
  assert.deepStrictEqual(cloneCardsForPaste([], 1, 1, deterministicId), []);
  assert.deepStrictEqual(cloneCardsForPaste(null, 1, 1, deterministicId), []);

  console.log('clipboard-remap 全部 4 组测试通过 ✓');
}

main();
