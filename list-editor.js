(function () {
  'use strict';

  /* 列表视图编辑器:编辑态生命周期(body.list-editing)、行选择与卡片设置抽屉、
   * 拖拽排序(阶段整块 / 单场重排与跨阶段)。数据与编辑核心(选择/历史/面板/删除)
   * 全部经 CanvasEditor 共享——本模块只做列表侧 DOM 交互,不直接改 record:
   * 排序经 CanvasModel.listGroups/applyListOrder + CanvasEditor.commitListChange。 */

  const DRAG_THRESHOLD = 4;   /* 超过此位移才算拖拽,否则纯点击 */
  const EDGE_SCROLL_ZONE = 48;

  let drag = null;        /* 进行中的拖拽(见 beginDrag) */
  let downInfo = null;    /* pointerdown 记录,过阈值升格为拖拽 */
  let lastPointer = { x: 0, y: 0 };
  let scrollRaf = 0;

  function body() { return document.getElementById('list-body'); }
  function main() { return document.getElementById('main-content'); }
  function isEditing() { return document.body.classList.contains('list-editing'); }

  /* ---------- 生命周期 ---------- */

  function enter() {
    document.body.classList.add('list-editing');
    window.ListView.render();
    syncSelection();
  }

  function exit() {
    cancelDrag();
    document.body.classList.remove('list-editing');
    window.ListView.render();
  }

  /* 渲染会重建行 DOM:重挂选中高亮(ts:list-render 由 ListView.render 结束派发) */
  function syncSelection() {
    const el = body();
    if (!el) return;
    const ids = window.CanvasEditor.getSelectedIds();
    el.querySelectorAll('.list-row').forEach((row) => {
      row.classList.toggle('selected', ids.includes(row.dataset.match));
    });
  }

  /* ---------- 选择(与画布语义对齐) ---------- */

  function onPointerDown(event) {
    if (!isEditing() || event.button !== 0) return;
    if (event.target.closest('input, textarea, select, button')) return;
    /* 编辑态点职业图标 = 选中该卡开设置(画布 class-slot 同语义),不跳链接 */
    const link = event.target.closest('a.list-class');
    if (link) {
      const row = link.closest('.list-row');
      if (row) {
        event.preventDefault();
        window.CanvasEditor.selectCard(row.dataset.match);
      }
      return;
    }
    const row = event.target.closest('.list-row');
    const header = event.target.closest('.list-group h2');
    if (!row && !header) return;
    /* 触屏只认手柄(data-drag-handle),整行/整头拖拽仅鼠标——否则列表无法滚动 */
    if (event.pointerType === 'touch' && !event.target.closest('[data-drag-handle]')) return;
    downInfo = {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      kind: row ? 'row' : 'block',
      rowEl: row || null,
      groupEl: (row ? row.closest('.list-group') : header.closest('.list-group'))
    };
    if (row && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      /* 按下 = 静默选中(拖拽意图),纯点击松手才开抽屉——画布同语义 */
      window.CanvasEditor.setSelection([row.dataset.match], { silent: true });
    }
    /* 注意:此处不做 setPointerCapture——捕获会把后续 click 的 target 重定向到容器,
     * 误触发"点空白清空选择";指针捕获改为拖拽真正开始时(beginDrag)再抓 */
  }

  function onPointerMove(event) {
    if (!downInfo || event.pointerId !== downInfo.pointerId) return;
    lastPointer = { x: event.clientX, y: event.clientY };
    if (!drag && Math.hypot(event.clientX - downInfo.x, event.clientY - downInfo.y) >= DRAG_THRESHOLD) {
      beginDrag(event);
    }
    if (drag) {
      moveGhost(event);
      updateDrop(event);
      autoScroll();
    }
  }

  function onPointerUp(event) {
    if (!downInfo || event.pointerId !== downInfo.pointerId) return;
    if (drag) {
      finishDrag();
    } else {
      /* 纯点击(无位移):解除静默,补开设置抽屉 */
      window.CanvasEditor.confirmClickSelection();
    }
    downInfo = null;
  }

  function onPointerCancel() {
    cancelDrag();
    downInfo = null;
  }

  /* 拖拽结束(pointerup 后浏览器还会补一个合成 click,target 可能是被捕获的容器):
   * 抑制一次,防误判为点空白清空选择 */
  let suppressClick = false;

  /* 修饰键多选在 click 层处理(pointerup 已覆盖普通点击) */
  function onClick(event) {
    if (!isEditing()) return;
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (event.target.closest('a, button, input, select, textarea')) return;
    const row = event.target.closest('.list-row');
    if (row && (event.shiftKey || event.metaKey || event.ctrlKey)) {
      const cur = window.CanvasEditor.getSelectedIds();
      const id = row.dataset.match;
      window.CanvasEditor.setSelection(
        cur.includes(id) ? cur.filter((x) => x !== id) : cur.concat([id])
      );
    } else if (!row && !event.target.closest('.list-group h2')) {
      window.CanvasEditor.setSelection([]);
    }
  }

  /* ---------- 拖拽(Task 6 覆写为真实现,先占位保证本步可运行) ---------- */

  function beginDrag() { drag = null; }
  function moveGhost() {}
  function updateDrop() {}
  function autoScroll() {}
  function finishDrag() { suppressClick = true; }
  function cancelDrag() { suppressClick = true; }

  /* ---------- 绑定 ---------- */

  function bind() {
    const el = body();
    if (!el) return;
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerCancel);
    el.addEventListener('click', onClick);
  }

  document.addEventListener('ts:ready', () => bind());
  document.addEventListener('ts:list-render', () => { if (isEditing()) syncSelection(); });
  /* 外部数据变更(切届/后台恢复)打断拖拽并按现存卡收敛 */
  document.addEventListener('ts:changed', () => { if (drag) cancelDrag(); });

  window.ListEditor = {
    enter,
    exit,
    cancelDrag: () => cancelDrag()
  };
})();
