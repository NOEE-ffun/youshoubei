'use strict';

/* 画布编辑历史栈(撤销/重做)单元测试:纯数据双栈模型,上限 10 步。
 * 快照本体(canvas.cards/scores/matchDecks 的克隆)由 canvas-editor 负责,
 * 本模块只管栈语义。 */

const assert = require('node:assert/strict');
const { createHistory } = require('../canvas-history.js');

// 1. 新建栈不可撤销/不可重做,undo/redo 返回 null 且不抛错
{
  const h = createHistory(10);
  assert.equal(h.canUndo(), false, '空栈不可撤销');
  assert.equal(h.canRedo(), false, '空栈不可重做');
  assert.equal(h.undo({ cards: 1 }), null, '空栈 undo 返回 null');
  assert.equal(h.redo({ cards: 1 }), null, '空栈 redo 返回 null');
}

// 2. push 后 undo 返回上一状态,当前状态入重做栈
{
  const h = createHistory(10);
  h.push({ label: 'A' });          // 改动前的状态 A
  // ...  mutations 把数据改成 B ...
  const restored = h.undo({ label: 'B' }); // 调用方交出当前状态 B
  assert.deepEqual(restored, { label: 'A' }, 'undo 应返回改动前的快照');
  assert.equal(h.canUndo(), false, '撤销到底');
  assert.equal(h.canRedo(), true, 'B 进入重做栈');
  const again = h.redo({ label: 'A' });
  assert.deepEqual(again, { label: 'B' }, 'redo 应返回 B');
  assert.equal(h.canUndo(), true, '重做后 A 回到撤销栈');
}

// 3. 新 push 清空重做栈(经典两栈语义)
{
  const h = createHistory(10);
  h.push({ n: 1 });
  h.undo({ n: 2 });
  assert.equal(h.canRedo(), true);
  h.push({ n: 1 }); // 撤销后又有新改动
  assert.equal(h.canRedo(), false, '新改动应清空重做栈');
  assert.equal(h.redo({ n: 3 }), null);
}

// 4. 栈上限:超过 10 步丢弃最旧快照
{
  const h = createHistory(10);
  for (let i = 0; i < 12; i += 1) h.push({ n: i });
  let cur = { n: 12 };
  let undone = 0;
  let snap;
  while ((snap = h.undo(cur)) !== null) {
    cur = snap;
    undone += 1;
  }
  assert.equal(undone, 10, '最多撤销 10 步(12 步里最旧 2 步被丢弃)');
  assert.deepEqual(cur, { n: 2 }, '最早可回到的状态是第 2 次 push 前的快照');
}

// 5. clear 清空两栈(切比赛等场景)
{
  const h = createHistory(10);
  h.push({ n: 1 });
  h.undo({ n: 2 });
  h.clear();
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), false);
}

// 6. 快照按值隔离:push 后修改原对象不影响栈内快照(调用方可能复用对象)
{
  const h = createHistory(10);
  const state = { cards: [{ id: 'c1' }] };
  h.push(state);
  state.cards.push({ id: 'c2' });
  const restored = h.undo({ cards: [] });
  assert.deepEqual(restored.cards, [{ id: 'c1' }], '栈内快照不应随原对象变化');
}

// 7. size 反映撤销栈深度
{
  const h = createHistory(10);
  assert.equal(h.size(), 0);
  h.push({ n: 1 });
  h.push({ n: 1 });
  assert.equal(h.size(), 2);
}

console.log('canvas-history: 全部断言通过');
