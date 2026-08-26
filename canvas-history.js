(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CanvasHistory = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 画布编辑撤销/重做:经典两栈模型,纯数据、无 DOM 依赖。
   * 快照由调用方(canvas-editor)克隆交入;undo/redo 时调用方交出"当前状态"
   * 换取目标快照,由调用方写回数据并保存——本模块只管栈语义。 */

  const DEFAULT_LIMIT = 10;

  function cloneSnapshot(snapshot) {
    return JSON.parse(JSON.stringify(snapshot));
  }

  function createHistory(limit) {
    const cap = Math.max(1, Number(limit) || DEFAULT_LIMIT);
    const undoStack = [];
    const redoStack = [];

    return {
      /* 记录一次改动前的状态(调用方在改数据前调用) */
      push(snapshot) {
        undoStack.push(cloneSnapshot(snapshot));
        if (undoStack.length > cap) undoStack.shift();
        redoStack.length = 0;
      },
      /* 撤销:交出当前状态,返回要恢复的上一状态;到底返回 null */
      undo(current) {
        if (!undoStack.length) return null;
        redoStack.push(cloneSnapshot(current));
        return undoStack.pop();
      },
      /* 重做:交出当前状态,返回要恢复的下一状态;到底返回 null */
      redo(current) {
        if (!redoStack.length) return null;
        undoStack.push(cloneSnapshot(current));
        return redoStack.pop();
      },
      canUndo() {
        return undoStack.length > 0;
      },
      canRedo() {
        return redoStack.length > 0;
      },
      size() {
        return undoStack.length;
      },
      clear() {
        undoStack.length = 0;
        redoStack.length = 0;
      }
    };
  }

  return { createHistory, DEFAULT_LIMIT };
});
