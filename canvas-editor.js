(function () {
  'use strict';

  const { escapeHtml, save, notify, uiConfirm, debounce } = window.TournamentUtils;
  /* 画布几何唯一真源在 canvas-model.js */
  const { DOT, PORT_NORMALS, edgePath, arrowDefs } = window.CanvasModel;

  const MIN_SCALE = 0.05;
  const FIT_MIN_SCALE = 0.28;
  const MAX_SCALE = 3;

  let active = false;
  let tool = 'select';
  let zoomMode = false;
  let scale = 1;
  let baseWidth = 600;
  let baseHeight = 400;
  /* 视口相机(Obsidian 白板模式):外壳 overflow:hidden 不用原生滚动,
   * 平移=内容层 translate(tx,ty),缩放=scale(s),四向天然无限 */
  let tx = 0;
  let ty = 0;
  let selectedCardId = null;
  let batchSelected = new Set();
  let dragState = null;
  let connectState = null;
  let marqueeState = null;
  let copiedCards = [];
  let cardDialog = null;
  let editingCardId = null;
  let wheelBound = false;

  /* ---------- 撤销/重做(编辑安全感) ----------
   * 栈语义在 canvas-history.js(纯数据,可单测);此处负责快照/写回/落盘时机。
   * 覆盖卡片级改动(增删/属性/连线/拖动/微调);比分录入自带确认与连锁重算,不进历史。 */
  const history = window.CanvasHistory.createHistory(10);
  let historyRecordId = null;
  /* 有未落盘的改动:保存完成前关页会被 beforeunload 拦截 */
  let dirty = false;
  let dragBeforeSnapshot = null;
  let nudgeBeforeSnapshot = null;
  let dialogBeforeSnapshot = null;

  function currentRecord() {
    return window.TournamentApp.current;
  }

  function findCard(id) {
    return (currentRecord().canvas.cards || []).find((c) => c.id === id) || null;
  }

  function saveCanvas() {
    currentRecord().updatedAt = Date.now();
    return save().then(
      (result) => {
        markClean();
        return result;
      },
      (error) => {
        dirty = true;
        refreshToolbarUI();
        throw error;
      }
    );
  }

  function markClean() {
    if (!dirty) return;
    dirty = false;
    refreshToolbarUI();
  }

  function isDirty() {
    return dirty;
  }

  /* 快照 = 卡片 + 比分 + 每场卡组(删除卡片会连带清理后两者,撤销须整体还原) */
  function snapshotState() {
    const record = currentRecord();
    return {
      cards: JSON.parse(JSON.stringify((record.canvas && record.canvas.cards) || [])),
      scores: JSON.parse(JSON.stringify(record.scores || {})),
      matchDecks: JSON.parse(JSON.stringify(record.matchDecks || {}))
    };
  }

  function applySnapshot(snap) {
    const record = currentRecord();
    record.canvas = record.canvas || { cards: [] };
    record.canvas.cards = JSON.parse(JSON.stringify(snap.cards));
    record.scores = JSON.parse(JSON.stringify(snap.scores));
    record.matchDecks = JSON.parse(JSON.stringify(snap.matchDecks));
  }

  /* 切换比赛后历史不再属于当前数据:清栈,按钮随之禁用 */
  function syncHistoryOwner() {
    const record = currentRecord();
    const id = record && record.id;
    if (id !== historyRecordId) {
      historyRecordId = id;
      history.clear();
    }
  }

  /* 改动入栈:pre 为改动前快照(拖拽/弹窗这类"发起与落盘分离"的操作在发起时捕获),
   * 缺省取当前状态(调用点须紧贴改动之前) */
  function commitHistory(pre) {
    syncHistoryOwner();
    history.push(pre || snapshotState());
    dirty = true;
    refreshToolbarUI();
  }

  function restoreHistory(direction) {
    syncHistoryOwner();
    const current = snapshotState();
    const snap = direction === 'undo' ? history.undo(current) : history.redo(current);
    if (!snap) return false;
    applySnapshot(snap);
    /* 还原后的卡片集可能不含当前选择:先清选择再重绘 */
    batchSelected.clear();
    selectedCardId = null;
    dirty = true;
    refreshToolbarUI();
    saveCanvas().then(() => {
      requestRender();
      refreshToolbarUI();
    });
    notify(direction === 'undo' ? '已撤销' : '已重做');
    return true;
  }

  function undo() {
    return restoreHistory('undo');
  }

  function redo() {
    return restoreHistory('redo');
  }

  function canUndo() {
    syncHistoryOwner();
    return history.canUndo();
  }

  function canRedo() {
    syncHistoryOwner();
    return history.canRedo();
  }

  function board() {
    return document.getElementById('canvas-board');
  }

  function scrollEl() {
    return document.getElementById('canvas-scroll');
  }

  function cardElement(id) {
    const b = board();
    return b ? b.querySelector('.canvas-card[data-match="' + id + '"]') : null;
  }

  /* 统一选择模型:batchSelected 是唯一多选集合(全工具生效,对齐 Figma);
   * selectedCardId 是最近操作锚(卡片弹窗等单卡场景用) */
  function selectedIds() {
    return [...batchSelected];
  }

  /* bracket.js 经 connect() 注入的回调,使依赖单向化:editor 不再反向引用 BracketRender。
   * renderCanvas 在编辑操作落盘后重绘画布;updateToolbar 刷新编辑工具栏按钮状态 */
  let renderHook = null;
  let toolbarHook = null;

  function requestRender() {
    if (renderHook) renderHook();
  }

  function setSelection(ids) {
    batchSelected = new Set(ids || []);
    selectedCardId = [...batchSelected][0] || null;
    highlightSelected();
    refreshToolbarUI();
  }

  function refreshToolbarUI() {
    if (toolbarHook) toolbarHook();
  }

  /* ---------- 编辑模式生命周期 ---------- */

  /* 提示文案由 bracket.js syncEditUI 统一维护(enter/exit 之后必经 syncEditUI),
   * editing class 是本编辑器的自身状态,由 enter/exit 增删 */
  function enter() {
    active = true;
    const b = board();
    if (b) {
      b.classList.add('editing');
      syncToolClasses();
    }
    bindBoardEvents();
    bindWheel();
    syncZoom();
    refreshToolbarUI();
  }

  function exit() {
    active = false;
    tool = 'select';
    zoomMode = false;
    selectedCardId = null;
    batchSelected.clear();
    dragState = null;
    connectState = null;
    marqueeState = null;
    removeTempLine();
    removeMarqueeRect();
    const b = board();
    if (b) {
      b.classList.remove('editing');
      b.classList.remove('tool-link', 'tool-delete', 'tool-select', 'zoom-mode');
    }
    if (cardDialog && cardDialog.open) cardDialog.close();
    refreshToolbarUI();
  }

  /* ---------- 工具模式 ---------- */

  function setTool(next) {
    tool = next;
    /* 切换工具保留选择(Figma 语义);Esc / 空白单击才会清空 */
    syncToolClasses();
    highlightSelected();
    refreshToolbarUI();
  }

  /* 工具类统一同步:setTool 和 enter(退出编辑再进入)都走这里,
   * 避免默认 select 工具重新进入编辑时丢失 crosshair 光标提示 */
  function syncToolClasses() {
    const b = board();
    if (!b) return;
    b.classList.toggle('tool-link', tool === 'link');
    b.classList.toggle('tool-delete', tool === 'delete');
    b.classList.toggle('tool-select', tool === 'select');
  }

  function getTool() {
    return tool;
  }

  function toggleZoomMode() {
    zoomMode = !zoomMode;
    const b = board();
    if (b) b.classList.toggle('zoom-mode', zoomMode);
    refreshToolbarUI();
    notify(zoomMode ? '缩放模式已开启：滚轮直接缩放' : '缩放模式已关闭，滚轮滚动，Ctrl/Cmd+滚轮缩放');
  }

  function isZoomMode() {
    return zoomMode;
  }

  function getSelectedCount() {
    return selectedIds().length;
  }

  /* ---------- 缩放 ---------- */

  /* 相机落点(轻量):平移/缩放高频调用,只写样式不读布局 */
  let hqTimer = null;
  let rasterScale = 1;

  /* 缩放落定后按当前比例重新光栅化。will-change 合成层的纹理分辨率固定在
   * 上次绘制时的缩放比,之后仅改 transform 会一直放大/缩小旧纹理——
   * 在小比例时重绘过一次,放大后卡片就永久模糊。这里在缩放停止 ~200ms 后
   * 把层降级一帧再提升,强制浏览器以新 scale 重画内容,任何缩放下都最精细 */
  function scheduleHqRaster() {
    if (hqTimer) clearTimeout(hqTimer);
    hqTimer = setTimeout(function () {
      hqTimer = null;
      const b = board();
      if (!b) return;
      rasterScale = scale;
      b.style.willChange = 'auto';
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { b.style.willChange = 'transform'; });
      });
    }, 200);
  }

  function applyCamera() {
    const b = board();
    if (!b) return;
    b.style.transformOrigin = '0 0';
    b.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + scale + ')';
    if (Math.abs(scale - rasterScale) > 0.001) scheduleHqRaster();
    /* 右下角常驻缩放控件的百分比读数（仅赛程页存在该元素） */
    const label = document.getElementById('zoom-level');
    if (label) label.textContent = Math.round(scale * 100) + '%';
  }

  function syncZoom() {
    const b = board();
    if (!b) return;
    baseWidth = parseFloat(b.style.width) || 600;
    baseHeight = parseFloat(b.style.height) || 400;
    applyCamera();
  }

  function setZoom(next) {
    scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
    syncZoom();
    refreshToolbarUI();
    saveZoomPreference(true);
  }

  /* 缩放持久化:记住用户选择的缩放级别(不记平移,平移随视口/赛事变化),
   * 「适应画布」清回自动;刷新后由 restoreSavedZoom 按记忆级别居中恢复 */
  const LS_ZOOM = 'ts:canvasZoom';
  let zoomSaveTimer = null;

  function saveZoomPreference(user) {
    /* 捏合/滚轮逐帧调用,同步写 localStorage 会卡主线程:合并为停止 300ms 后一次 */
    if (zoomSaveTimer) clearTimeout(zoomSaveTimer);
    const snapshot = { scale: Math.round(scale * 1000) / 1000, user: !!user };
    zoomSaveTimer = setTimeout(() => {
      zoomSaveTimer = null;
      try {
        localStorage.setItem(LS_ZOOM, JSON.stringify(snapshot));
      } catch (error) { /* 存储不可用:仅本次会话生效 */ }
    }, 300);
  }

  /* 恢复记忆的用户缩放:按该级别对当前内容包围盒居中;无记忆返回 false */
  function restoreSavedZoom() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(LS_ZOOM) || 'null');
    } catch (error) {
      saved = null;
    }
    if (!saved || !saved.user || !Number.isFinite(saved.scale)) return false;
    const sc = scrollEl();
    if (!sc) return false;
    const extent = contentExtent() || { width: baseWidth, height: baseHeight };
    scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, saved.scale));
    const rect = sc.getBoundingClientRect();
    tx = (rect.width - extent.width * scale) / 2;
    ty = (rect.height - extent.height * scale) / 2;
    syncZoom();
    return true;
  }

  /* 以屏幕坐标 (cx, cy) 为锚点缩放:锚下的内容点缩放前后不动 */
  function zoomAtPoint(cx, cy, factor) {
    const sc = scrollEl();
    const b = board();
    if (!sc || !b) return;
    const rect = sc.getBoundingClientRect();
    const px = (cx - rect.left - tx) / scale;
    const py = (cy - rect.top - ty) / scale;
    scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
    tx = cx - rect.left - px * scale;
    ty = cy - rect.top - py * scale;
    syncZoom();
    refreshToolbarUI();
    saveZoomPreference(true);
  }

  function zoomAtCenter(factor) {
    const sc = scrollEl();
    if (!sc) return;
    const rect = sc.getBoundingClientRect();
    zoomAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  function zoomIn() { zoomAtCenter(1.15); }
  function zoomOut() { zoomAtCenter(1 / 1.15); }

  /* 内容实际范围：适配应以卡片为准，而不是 40×24 的编辑边界（否则缩到 ~10% 卡片不可读） */
  function contentExtent() {
    const b = board();
    if (!b) return null;
    let maxX = 0;
    let maxY = 0;
    b.querySelectorAll('.canvas-card').forEach((el) => {
      maxX = Math.max(maxX, el.offsetLeft + el.offsetWidth);
      maxY = Math.max(maxY, el.offsetTop + el.offsetHeight);
    });
    if (!maxX || !maxY) return null;
    return { width: maxX, height: maxY };
  }

  function fitCanvas() {
    const sc = scrollEl();
    if (!sc) return;
    const extent = contentExtent() || { width: baseWidth, height: baseHeight };
    const rect = sc.getBoundingClientRect();
    scale = Math.max(FIT_MIN_SCALE, Math.min(1, Math.min(
      (rect.width - 24) / extent.width,
      (rect.height - 24) / extent.height
    )));
    /* 内容从(0,0)起,整体居中到视口 */
    tx = (rect.width - extent.width * scale) / 2;
    ty = (rect.height - extent.height * scale) / 2;
    syncZoom();
    refreshToolbarUI();
    saveZoomPreference(false);
  }

  /* 查找定位:缩放适配到给定卡片集合并把包围盒居中 */
  function focusCards(ids) {
    const sc = scrollEl();
    const b = board();
    if (!sc || !b || !ids || !ids.length) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of ids) {
      const el = b.querySelector('.canvas-card[data-match="' + id + '"]');
      if (!el) continue;
      minX = Math.min(minX, el.offsetLeft);
      minY = Math.min(minY, el.offsetTop);
      maxX = Math.max(maxX, el.offsetLeft + el.offsetWidth);
      maxY = Math.max(maxY, el.offsetTop + el.offsetHeight);
    }
    if (!Number.isFinite(minX)) return;
    const pad = 80;
    scale = Math.max(FIT_MIN_SCALE, Math.min(1, Math.min(
      (sc.clientWidth - pad) / (maxX - minX + pad),
      (sc.clientHeight - pad) / (maxY - minY + pad)
    )));
    const rect = sc.getBoundingClientRect();
    tx = rect.width / 2 - ((minX + maxX) / 2) * scale;
    ty = rect.height / 2 - ((minY + maxY) / 2) * scale;
    syncZoom();
    refreshToolbarUI();
  }

  /* 查找跳转:不动缩放,仅把单卡居中 */
  function centerCard(id) {
    const sc = scrollEl();
    const b = board();
    const el = b && b.querySelector('.canvas-card[data-match="' + id + '"]');
    if (!sc || !el) return;
    const rect = sc.getBoundingClientRect();
    tx = rect.width / 2 - (el.offsetLeft + el.offsetWidth / 2) * scale;
    ty = rect.height / 2 - (el.offsetTop + el.offsetHeight / 2) * scale;
    syncZoom();
  }

  function onWheel(event) {
    // Obsidian 白板语义:Ctrl/Cmd+滚轮(含 Mac 捏合)以光标为锚缩放;普通滚轮平移(Shift 转横向)
    event.preventDefault();
    if (event.ctrlKey || event.metaKey || zoomMode) {
      const lineDelta = event.deltaY / (event.deltaMode === 1 ? 33.3 : event.deltaMode === 2 ? 100 : 1);
      zoomAtPoint(event.clientX, event.clientY, Math.exp(-lineDelta * 0.0036));
      return;
    }
    if (event.shiftKey) {
      panBy(-(event.deltaX || event.deltaY), 0);
    } else {
      panBy(-event.deltaX, -event.deltaY);
    }
  }

  /* ---------- 空手平移(无限画布) ---------- */

  let panState = null;
  let spaceHeld = false;

  /* ---------- 双指捏合(触屏缩放/平移画布) ---------- */
  const activeTouches = new Map(); /* pointerId -> {x, y} */
  let pinchState = null; /* { lastDist, lastMid: {x, y} } */

  function touchDist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function touchMid(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function onTouchDown(event) {
    if (event.pointerType !== 'touch') return false;
    activeTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activeTouches.size !== 2) return false;
    /* 第二指落下即切捏合:中断单指平移;拖拽/连线/框选进行中则不打扰 */
    if (dragState || connectState || marqueeState) return false;
    if (panState) {
      panState = null;
      const sc = scrollEl();
      if (sc) sc.classList.remove('panning');
    }
    const pts = [...activeTouches.values()];
    pinchState = { lastDist: touchDist(pts[0], pts[1]), lastMid: touchMid(pts[0], pts[1]) };
    return true;
  }

  function onTouchMove(event) {
    if (event.pointerType !== 'touch' || !activeTouches.has(event.pointerId)) return false;
    activeTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!pinchState || activeTouches.size < 2) return false;
    const pts = [...activeTouches.values()];
    const dist = touchDist(pts[0], pts[1]);
    const mid = touchMid(pts[0], pts[1]);
    /* 中点位移 = 双指整体平移;距离变化 = 缩放(增量式,避免漂移) */
    panBy(mid.x - pinchState.lastMid.x, mid.y - pinchState.lastMid.y);
    if (dist > 0 && pinchState.lastDist > 0) {
      zoomAtPoint(mid.x, mid.y, dist / pinchState.lastDist);
    }
    pinchState.lastDist = dist;
    pinchState.lastMid = mid;
    return true;
  }

  function onTouchEnd(event) {
    if (event.pointerType !== 'touch') return;
    activeTouches.delete(event.pointerId);
    if (activeTouches.size < 2) pinchState = null;
  }

  function onSpaceDown(event) {
    if (event.code !== 'Space') return;
    if (event.target && event.target.closest && event.target.closest('input, textarea, select')) return;
    spaceHeld = true;
  }

  function onSpaceUp(event) {
    if (event.code !== 'Space') return;
    spaceHeld = false;
  }

  /* 查看态:左键拖动即平移(卡片查看态不可拖,从卡片上也允许);
   * 编辑态:空白处空格+左键或中键平移(Figma 语义) */
  function isPanGesture(event) {
    if (panState) return true;
    if (event.target.closest && event.target.closest('button, input, select, a, .port')) return false;
    if (event.button === 1) return true;
    if (event.button !== 0) return false;
    if (active) return spaceHeld && !event.target.closest('.canvas-card');
    return true;
  }

  /* 平移:直接改相机偏移,无边界、无滚动,天然四向无限 */
  function panBy(dx, dy) {
    tx += dx;
    ty += dy;
    syncZoom();
  }

  function bindWheel() {
    if (wheelBound) return;
    wheelBound = true;
    const sc = scrollEl();
    if (sc) sc.addEventListener('wheel', onWheel, { passive: false });
  }

  /* ---------- 事件绑定 ---------- */

  let bound = false;

  function bindBoardEvents() {
    if (bound) return;
    bound = true;
    /* 绑在滚动容器上(含 board 外空白):查看态画布常小于视口,
     * 平移要从任意空白处发起;board 的事件会冒泡到此处,不会漏 */
    const sc = scrollEl();
    if (!sc) return;
    sc.addEventListener('pointerdown', onPointerDown);
    sc.addEventListener('pointermove', onPointerMove);
    sc.addEventListener('pointerup', onPointerUp);
    sc.addEventListener('pointercancel', onPointerCancel);
    sc.addEventListener('dblclick', onDblClick);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keydown', onSpaceDown);
    document.addEventListener('keyup', onSpaceUp);
    window.addEventListener('blur', onSpaceUp);
  }

  function onPointerDown(event) {
    if (onTouchDown(event)) {
      event.preventDefault();
      return;
    }
    if (isPanGesture(event)) {
      event.preventDefault();
      const sc = scrollEl();
      if (!sc) return;
      panState = { lastX: event.clientX, lastY: event.clientY };
      sc.classList.add('panning');
      /* 捕获指针:快速拖出画布边界也不丢 move/up 事件 */
      try { sc.setPointerCapture(event.pointerId); } catch (error) { /* 忽略 */ }
      return;
    }
    if (!active) return;
    const node = event.target.closest('.port-node');
    if (node && tool !== 'delete') {
      /* 白板连接点:上排拖出=胜者,下排拖出=败者;入侧落点再定 A/B 位 */
      event.preventDefault();
      connectState = {
        sourceCardId: node.dataset.card,
        outcome: node.dataset.band === 'lower' ? 'loser' : 'winner',
        sourcePortEl: node
      };
      ensureTempLine();
      updateTempLine(event.clientX, event.clientY);
      return;
    }
    const cardEl = event.target.closest('.canvas-card');
    if (!cardEl) {
      /* 空白按下:select 工具启动框选(Shift 为加选,保留既有选择);其余工具不响应 */
      if (tool !== 'select' || event.button !== 0) return;
      if (event.target.closest('button, input, select, a, .port')) return;
      event.preventDefault();
      const base = event.shiftKey ? new Set(batchSelected) : new Set();
      if (!event.shiftKey && batchSelected.size) setSelection([]);
      marqueeState = {
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        base
      };
      ensureMarqueeRect();
      return;
    }
    if (tool === 'delete') {
      /* 职业槽/比分按钮归 bracket 委托管(开弹窗),不进删除选择 */
      if (event.target.closest('button.class-slot, button.score-open')) return;
      event.preventDefault();
      toggleBatchSelected(cardEl.dataset.match);
      return;
    }
    if (tool === 'link') {
      if (event.target.closest('button.class-slot, button.score-open')) return;
      setSelection([cardEl.dataset.match]);
      return;
    }
    if (tool === 'select' && !event.target.closest('button, input, select, a, .port')) {
      const id = cardEl.dataset.match;
      /* Shift+点卡 = 切换选中,不进入拖拽(Figma 语义) */
      if (event.shiftKey) {
        event.preventDefault();
        toggleBatchSelected(id);
        return;
      }
      /* 点已选中的卡 = 整组拖拽;点未选中卡 = 先单选再拖 */
      if (!batchSelected.has(id)) setSelection([id]);
      dragState = {
        cards: [...batchSelected].map((cid) => {
          const c = findCard(cid);
          return c ? { id: cid, originX: Number(c.x) || 0, originY: Number(c.y) || 0 } : null;
        }).filter(Boolean),
        startX: event.clientX,
        startY: event.clientY,
        moved: false
      };
      /* 拖拽真正移动才入历史:先抓改动前快照,落盘时提交 */
      dragBeforeSnapshot = snapshotState();
      event.preventDefault();
    }
  }

  function onPointerMove(event) {
    if (onTouchMove(event)) {
      event.preventDefault();
      return;
    }
    if (panState) {
      panBy(event.clientX - panState.lastX, event.clientY - panState.lastY);
      panState.lastX = event.clientX;
      panState.lastY = event.clientY;
      return;
    }
    if (connectState) {
      updateTempLine(event.clientX, event.clientY);
      return;
    }
    if (marqueeState) {
      marqueeState.lastX = event.clientX;
      marqueeState.lastY = event.clientY;
      updateMarqueeRect();
      return;
    }
    if (!dragState) return;
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    /* 点阵步进(1 点吸附):整组统一用同一偏移量,保持相对位置 */
    const stepX = Math.round(dx / (DOT * scale));
    const stepY = Math.round(dy / (DOT * scale));
    for (const entry of dragState.cards) {
      const card = findCard(entry.id);
      if (!card) continue;
      /* 无限画布:正方向不设上限,但坐标不为负 */
      const nextX = Math.max(0, entry.originX + stepX);
      const nextY = Math.max(0, entry.originY + stepY);
      if (nextX !== card.x || nextY !== card.y) {
        card.x = nextX;
        card.y = nextY;
        dragState.moved = true;
        const el = cardElement(entry.id);
        if (el) {
          el.style.left = (nextX * DOT) + 'px';
          el.style.top = (nextY * DOT) + 'px';
        }
      }
    }
  }

  function onPointerUp(event) {
    onTouchEnd(event);
    if (panState) {
      panState = null;
      const sc = scrollEl();
      if (sc) sc.classList.remove('panning');
      return;
    }
    if (connectState) {
      const node = event.target.closest('.port-node');
      if (node && node.dataset.card) {
        const targetCard = findCard(node.dataset.card);
        if (targetCard) {
          /* 落点上排 → A 位(slot0),下排 → B 位(slot1) */
          const slotIndex = node.dataset.band === 'lower' ? 1 : 0;
          commitHistory();
          targetCard.slots[slotIndex] = {
            type: 'flow',
            cardId: connectState.sourceCardId,
            outcome: connectState.outcome
          };
          saveCanvas().then(() => {
            requestRender();
          });
        }
      }
      removeTempLine();
      connectState = null;
      return;
    }
    if (marqueeState) {
      const dragged = Math.abs(marqueeState.lastX - marqueeState.startX) >= 4
        || Math.abs(marqueeState.lastY - marqueeState.startY) >= 4;
      /* 空白单击(位移 <4px)且非加选 = 退出选择 */
      if (!dragged && !marqueeState.base.size) setSelection([]);
      removeMarqueeRect();
      marqueeState = null;
      refreshToolbarUI();
      return;
    }
    if (dragState) {
      if (dragState.moved) {
        commitHistory(dragBeforeSnapshot);
        saveCanvas().then(() => {
          requestRender();
          highlightSelected();
        });
      }
      dragBeforeSnapshot = null;
      dragState = null;
    }
  }

  function onDblClick(event) {
    if (!active) return;
    const cardEl = event.target.closest('.canvas-card');
    if (cardEl) {
      if (tool !== 'delete') openCardDialog(cardEl.dataset.match);
      return;
    }
    if (tool === 'delete') return;
    const rect = board().getBoundingClientRect();
    const x = Math.round((event.clientX - rect.left) / (DOT * scale));
    const y = Math.round((event.clientY - rect.top) / (DOT * scale));
    addCard(x, y);
  }

  function onKeyDown(event) {
    if (!active) return;
    if (event.target && event.target.closest && event.target.closest('input, textarea, select')) return;
    /* 模态弹窗打开时不响应画布快捷键:撤销/删除会在弹窗底下改数据,
     * 弹窗里再点保存会把旧值写回,造成静默数据错乱 */
    if (document.querySelector('dialog[open]')) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && (event.key === 'z' || event.key === 'Z')) {
      /* Ctrl/Cmd+Z 撤销,Shift 组合重做;文本输入框里的原生撤销被上方输入守卫放行 */
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && (event.key === 'c' || event.key === 'C')) {
      copySelection();
      return;
    }
    if (mod && (event.key === 'x' || event.key === 'X')) {
      /* 剪切免确认:副本已入剪贴板可粘贴找回(CAD/Photoshop 惯例) */
      const ids = selectedIds();
      if (copySelection()) removeCardsSilent(ids);
      return;
    }
    if (mod && (event.key === 'v' || event.key === 'V')) {
      if (copiedCards.length) pasteCards(copiedCards);
      return;
    }
    if (mod && (event.key === 'd' || event.key === 'D')) {
      /* Ctrl+D 原位副本;浏览器把 Ctrl+D 当书签,必须拦截 */
      event.preventDefault();
      const sources = selectedIds().map(findCard).filter(Boolean);
      if (sources.length) pasteCards(sources);
      return;
    }
    if (event.key === 'Escape') {
      cancelActiveGesture();
      setSelection([]);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const ids = selectedIds();
      if (ids.length) {
        event.preventDefault();
        deleteCards(ids);
      }
      return;
    }
    /* 方向键点阵微调:±1 点,Shift ±3 点(兼作 WCAG 2.2 拖拽替代) */
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[event.key] && batchSelected.size) {
      event.preventDefault();
      const step = event.shiftKey ? 3 : 1;
      nudgeSelection(arrows[event.key][0] * step, arrows[event.key][1] * step);
    }
  }

  function copySelection() {
    const sources = selectedIds().map(findCard).filter(Boolean);
    if (!sources.length) return false;
    copiedCards = JSON.parse(JSON.stringify(sources));
    notify(copiedCards.length > 1 ? '已复制 ' + copiedCards.length + ' 张卡片' : '已复制卡片');
    return true;
  }

  let nudgeCommit = null;

  function nudgeSelection(dx, dy) {
    /* 连按方向键是一串微调:首键抓快照并立刻置脏(防抖窗口内保存钮亮圆点),
     * 防抖落盘时合并为一步撤销 */
    if (!nudgeBeforeSnapshot) {
      nudgeBeforeSnapshot = snapshotState();
      dirty = true;
      refreshToolbarUI();
    }
    for (const id of batchSelected) {
      const card = findCard(id);
      if (!card) continue;
      card.x = Math.max(0, (Number(card.x) || 0) + dx);
      card.y = Math.max(0, (Number(card.y) || 0) + dy);
      const el = cardElement(id);
      if (el) {
        el.style.left = (card.x * DOT) + 'px';
        el.style.top = (card.y * DOT) + 'px';
      }
    }
    if (!nudgeCommit) {
      nudgeCommit = debounce(() => {
        if (nudgeBeforeSnapshot) {
          commitHistory(nudgeBeforeSnapshot);
          nudgeBeforeSnapshot = null;
        }
        saveCanvas().then(() => {
          requestRender();
          highlightSelected();
        });
      }, 500);
    }
    nudgeCommit();
  }

  /* Esc:取消进行中的框选/拖拽并还原原位,再清空选择 */
  function cancelActiveGesture() {
    if (marqueeState) {
      batchSelected = marqueeState.base;
      selectedCardId = [...batchSelected][0] || null;
      marqueeState = null;
      removeMarqueeRect();
    }
    if (dragState) {
      for (const entry of dragState.cards) {
        const card = findCard(entry.id);
        if (!card) continue;
        card.x = entry.originX;
        card.y = entry.originY;
        const el = cardElement(entry.id);
        if (el) {
          el.style.left = (card.x * DOT) + 'px';
          el.style.top = (card.y * DOT) + 'px';
        }
      }
      /* 拖拽被取消:还原原位,快照作废 */
      dragState = null;
      dragBeforeSnapshot = null;
    }
    highlightSelected();
  }

  /* ---------- 选择 ---------- */

  function toggleBatchSelected(id) {
    if (batchSelected.has(id)) batchSelected.delete(id);
    else batchSelected.add(id);
    selectedCardId = batchSelected.size ? [...batchSelected][0] : null;
    highlightSelected();
    refreshToolbarUI();
  }

  function highlightSelected() {
    const b = board();
    if (!b) return;
    const ids = selectedIds();
    b.querySelectorAll('.canvas-card').forEach((el) => {
      el.classList.toggle('selected', ids.includes(el.dataset.match));
    });
  }

  /* ---------- 编辑操作 ---------- */

  function addCard(x, y) {
    const record = currentRecord();
    const canvas = record.canvas || (record.canvas = { cards: [] });
    commitHistory();
    const card = {
      id: CanvasModel.uid('c'),
      label: '新对局',
      phase: '',
      format: 'BO3',
      x: Math.max(0, x || 0),
      y: Math.max(0, y || 0),
      slots: [{ type: 'empty' }, { type: 'empty' }],
      exitRanks: {}
    };
    canvas.cards.push(card);
    if (tool === 'delete') setTool('select');
    batchSelected = new Set([card.id]);
    selectedCardId = card.id;
    refreshToolbarUI();
    saveCanvas().then(() => {
      requestRender();
      highlightSelected();
      openCardDialog(card.id);
    });
  }

  /* 连线槽清理 + 删除本体 + 比分/卡组清理;是否确认由调用方决定 */
  function performRemoval(ids) {
    commitHistory();
    const record = currentRecord();
    const canvas = record.canvas || { cards: [] };
    const idSet = new Set(ids);
    for (const card of canvas.cards) {
      for (const slot of card.slots || []) {
        if (slot && slot.type === 'flow' && idSet.has(slot.cardId)) {
          slot.type = 'empty';
          delete slot.cardId;
          delete slot.outcome;
        }
      }
    }
    for (let i = canvas.cards.length - 1; i >= 0; i -= 1) {
      if (idSet.has(canvas.cards[i].id)) {
        const id = canvas.cards[i].id;
        if (record.scores && record.scores[id]) delete record.scores[id];
        if (record.matchDecks && record.matchDecks[id]) delete record.matchDecks[id];
        canvas.cards.splice(i, 1);
      }
    }
    batchSelected.clear();
    selectedCardId = null;
    return saveCanvas().then(() => {
      requestRender();
      refreshToolbarUI();
    });
  }

  async function deleteCards(ids) {
    if (!ids || !ids.length) return;
    const canvas = currentRecord().canvas || { cards: [] };
    const cards = ids.map((id) => canvas.cards.find((c) => c.id === id)).filter(Boolean);
    if (!cards.length) return;
    const names = cards.map((c) => c.label || c.id).join('、');
    if (!(await uiConfirm('确定删除卡片：' + names + ' 吗？'))) return;
    return performRemoval(ids);
  }

  function deleteSelected() {
    return deleteCards(selectedIds());
  }

  /* 剪切用静默删除:副本已在剪贴板 */
  function removeCardsSilent(ids) {
    if (!ids || !ids.length) return;
    const canvas = currentRecord().canvas || { cards: [] };
    const valid = ids.filter((id) => canvas.cards.some((c) => c.id === id));
    if (!valid.length) return;
    return performRemoval(valid).then(() => {
      notify('已剪切 ' + valid.length + ' 张卡片');
    });
  }

  /* 多卡粘贴:整体平移一个卡位(12×8 点)保持相对位置,集内连线跟随重映射;
   * 自动选中新集合,不弹设置窗(多卡连续弹窗不合理) */
  function pasteCards(sources) {
    const record = currentRecord();
    const canvas = record.canvas || (record.canvas = { cards: [] });
    const clones = CanvasModel.cloneCardsForPaste(sources, 12, 8);
    if (!clones.length) return;
    commitHistory();
    for (const clone of clones) canvas.cards.push(clone);
    if (tool === 'delete') setTool('select');
    batchSelected = new Set(clones.map((c) => c.id));
    selectedCardId = clones[0].id;
    saveCanvas().then(() => {
      requestRender();
      highlightSelected();
      refreshToolbarUI();
    });
    notify('已粘贴 ' + clones.length + ' 张卡片');
  }

  /* ---------- 卡片属性弹窗 ---------- */

  function buildCardDialog() {
    if (cardDialog) return;
    cardDialog = document.createElement('dialog');
    cardDialog.id = 'card-edit-dialog';
    cardDialog.setAttribute('aria-labelledby', 'card-edit-title');
    cardDialog.innerHTML =
      '<div class="dialog-head">' +
      '  <h2 id="card-edit-title">卡片设置</h2>' +
      '  <button type="button" class="btn btn-ghost btn-sm" data-card-close>关闭</button>' +
      '</div>' +
      '<div class="dialog-body">' +
      '  <div class="form-field"><label for="card-label">标题</label><input type="text" id="card-label"></div>' +
      '  <div class="form-field"><label for="card-phase">阶段</label><input type="text" id="card-phase" placeholder="如：胜者组决赛"></div>' +
      '  <div class="form-field"><label for="card-format">赛制文本</label><input type="text" id="card-format" placeholder="BO3 / BO5 / 自定义"></div>' +
      '  <div class="form-field"><label for="card-deck-count">卡组数量（留空自动）</label><input type="number" id="card-deck-count" min="1" step="1"></div>' +
      '  <div class="form-field"><label for="card-slot-a">A 位选手</label><select id="card-slot-a"></select><select id="card-flow-outcome-a" class="flow-outcome" hidden aria-label="A 位连线取哪个出口"><option value="winner">取其胜者</option><option value="loser">取其败者</option></select></div>' +
      '  <div class="form-field"><label for="card-slot-b">B 位选手</label><select id="card-slot-b"></select><select id="card-flow-outcome-b" class="flow-outcome" hidden aria-label="B 位连线取哪个出口"><option value="winner">取其胜者</option><option value="loser">取其败者</option></select></div>' +
      '  <div class="form-field"><label for="card-rank-winner">胜者出口名次</label><input type="number" id="card-rank-winner" placeholder="如 1"></div>' +
      '  <div class="form-field"><label for="card-rank-loser">败者出口名次</label><input type="number" id="card-rank-loser" placeholder="如 2"></div>' +
      '  <div class="form-field">' +
      '    <label>职业卡组 · A 位选手(查看模式点击图标跳转)</label>' +
      '    <div class="cl-list" id="card-cl-a"></div>' +
      '  </div>' +
      '  <div class="form-field">' +
      '    <label>职业卡组 · B 位选手</label>' +
      '    <div class="cl-list" id="card-cl-b"></div>' +
      '  </div>' +
      '  <p class="hint">连线:从连接点拖出箭头,拖到目标卡片连接点松手。上排连接点默认输出胜者、接入 A 位,下排默认输出败者、接入 B 位,均可在上面下拉中自定义。</p>' +
      '  <div class="dialog-actions">' +
      '    <button type="button" class="btn btn-secondary" data-card-close>取消</button>' +
      '    <button type="button" class="btn btn-primary" data-card-save>保存</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(cardDialog);
    cardDialog.querySelectorAll('[data-card-close]').forEach((btn) => btn.addEventListener('click', () => cardDialog.close()));
    cardDialog.querySelector('[data-card-save]').addEventListener('click', saveCardDialog);
    /* 弹窗无论保存还是取消,关闭时都清掉开窗快照(保存路径已先行消费) */
    cardDialog.addEventListener('close', () => {
      dialogBeforeSnapshot = null;
    });
    /* 行删除走事件委托:renderClassLinkRows 重建行不需要重复绑定 */
    for (const listId of ['#card-cl-a', '#card-cl-b']) {
      cardDialog.querySelector(listId).addEventListener('click', (event) => {
        const del = event.target.closest('[data-cl-del]');
        if (del) del.closest('.cl-row').remove();
      });
    }
  }

  /* ---------- 职业卡组链接列表编辑(A/B 两组) ---------- */

  function classOptions(selected) {
    let html = '<option value="">未选择</option>';
    for (const cls of CanvasModel.CLASS_LIST) {
      html += '<option value="' + escapeHtml(cls) + '"' + (cls === selected ? ' selected' : '') + '>' +
        escapeHtml(cls) + '</option>';
    }
    return html;
  }

  function clRowHtml(entry) {
    const e = entry || {};
    return (
      '<div class="cl-row">' +
      '<select class="cl-cls" aria-label="职业">' + classOptions(e.cls) + '</select>' +
      '<input type="url" class="cl-url" placeholder="卡组链接 https://" value="' + escapeHtml(e.url || '') + '">' +
      '<input type="text" class="cl-text" placeholder="悬停文字" value="' + escapeHtml(e.text || '') + '">' +
      '<button type="button" class="btn btn-ghost btn-sm cl-del" data-cl-del title="删除此行" aria-label="删除此行">×</button>' +
      '</div>'
    );
  }

  /* 每组末尾永远有一行空行供新增。
   * 预填:own 模式(该侧已填过,含显式清空 null)回显自己的;
   * 未填过的侧回显继承值。保存时:
   * - own 模式:行内容原样写入;清空到零行写 null(显式阻断继承)
   * - inherited 模式:未改动则不动原值(继续继承),有改动写入固化 */
  function renderClassLinkRows(card) {
    const record = currentRecord();
    const eff = (record && CanvasModel.resolveEffectiveClassLinks(record.canvas, record.scores || {}).get(card.id)) || {};
    const cl = card.classLinks || {};
    for (const [groupId, listId] of [['a', '#card-cl-a'], ['b', '#card-cl-b']]) {
      const own = cl[groupId];
      const list = cardDialog.querySelector(listId);
      if (own === null || (Array.isArray(own) && own.length)) {
        list.dataset.fill = 'own';
        list.innerHTML = (own || []).map(clRowHtml).join('') + clRowHtml(null);
      } else {
        list.dataset.fill = 'inherited';
        const effRows = (eff[groupId] || []);
        list.dataset.effSig = JSON.stringify(effRows);
        list.innerHTML = effRows.map(clRowHtml).join('') + clRowHtml(null);
      }
    }
  }

  function readClassLinkGroup(listId) {
    const list = cardDialog.querySelector(listId);
    const out = [];
    let invalid = 0;
    list.querySelectorAll('.cl-row').forEach((row) => {
      const cls = row.querySelector('.cl-cls').value;
      const url = row.querySelector('.cl-url').value.trim().slice(0, 500);
      const text = row.querySelector('.cl-text').value.trim().slice(0, 60);
      if (cls && (url || text)) {
        out.push({ cls, url, text });
      } else if (cls || url || text) {
        /* 选了职业没内容,或填了内容没选职业:不完整行 */
        invalid += 1;
      }
    });
    const unchangedInherited = list.dataset.fill === 'inherited' &&
      JSON.stringify(out) === list.dataset.effSig;
    return { links: out, invalid, fill: list.dataset.fill, unchangedInherited };
  }

  function playerOptions(selectedId) {
    const players = window.TournamentApp.players || [];
    let html = '<option value="">空</option>';
    for (const p of players) {
      html += '<option value="' + p.id + '"' + (p.id === selectedId ? ' selected' : '') + '>' +
        escapeHtml(p.name) + '</option>';
    }
    return html;
  }

  /* 连线来源卡片的可读名称：优先 label（如 胜者组 1/4 决赛 1） */
  function flowSourceLabel(cardId) {
    const source = findCard(cardId);
    return source ? (source.label || source.id) : cardId;
  }

  function openCardDialog(cardId) {
    const card = findCard(cardId);
    if (!card) return;
    buildCardDialog();
    editingCardId = cardId;
    dialogBeforeSnapshot = snapshotState();
    cardDialog.querySelector('#card-label').value = card.label || '';
    cardDialog.querySelector('#card-phase').value = card.phase || '';
    cardDialog.querySelector('#card-format').value = card.format || 'BO3';
    cardDialog.querySelector('#card-deck-count').value = card.deckCount || '';
    const slotA = card.slots && card.slots[0];
    const slotB = card.slots && card.slots[1];
    cardDialog.querySelector('#card-slot-a').innerHTML = playerOptions(slotA && slotA.type === 'player' ? slotA.playerId : '');
    cardDialog.querySelector('#card-slot-b').innerHTML = playerOptions(slotB && slotB.type === 'player' ? slotB.playerId : '');
    /* 连线位的出口切换:显示并回填当前 outcome(拖拽侧默认之外的自定义入口) */
    const flowOutcomeA = cardDialog.querySelector('#card-flow-outcome-a');
    const flowOutcomeB = cardDialog.querySelector('#card-flow-outcome-b');
    flowOutcomeA.hidden = !(slotA && slotA.type === 'flow');
    flowOutcomeB.hidden = !(slotB && slotB.type === 'flow');
    if (slotA && slotA.type === 'flow') {
      flowOutcomeA.value = slotA.outcome === 'loser' ? 'loser' : 'winner';
      cardDialog.querySelector('#card-slot-a').insertAdjacentHTML('beforeend',
        '<option value="__flow" selected>来自 ' + escapeHtml(flowSourceLabel(slotA.cardId)) + '</option>');
    }
    if (slotB && slotB.type === 'flow') {
      flowOutcomeB.value = slotB.outcome === 'loser' ? 'loser' : 'winner';
      cardDialog.querySelector('#card-slot-b').insertAdjacentHTML('beforeend',
        '<option value="__flow" selected>来自 ' + escapeHtml(flowSourceLabel(slotB.cardId)) + '</option>');
    }
    cardDialog.querySelector('#card-rank-winner').value = card.exitRanks && card.exitRanks.winner != null ? card.exitRanks.winner : '';
    cardDialog.querySelector('#card-rank-loser').value = card.exitRanks && card.exitRanks.loser != null ? card.exitRanks.loser : '';
    renderClassLinkRows(card);
    cardDialog.showModal();
  }

  /* 保存时一侧的最终值:own 模式清空到零行 → null(显式阻断继承);
   * inherited 模式未改动 → 不动原值(继续继承);其余写入行内容 */
  function resolveGroup(currentLinks, groupId, result) {
    if (result.fill === 'own') {
      return result.links.length ? result.links : null;
    }
    if (result.unchangedInherited) {
      return (currentLinks && currentLinks[groupId] !== undefined) ? currentLinks[groupId] : [];
    }
    return result.links;
  }

  function saveCardDialog() {
    const card = findCard(editingCardId);
    if (!card) return;
    card.label = cardDialog.querySelector('#card-label').value.trim() || '未命名对局';
    card.phase = cardDialog.querySelector('#card-phase').value.trim();
    card.format = cardDialog.querySelector('#card-format').value.trim() || 'BO3';
    const deckCount = Number(cardDialog.querySelector('#card-deck-count').value);
    card.deckCount = Number.isFinite(deckCount) && deckCount > 0 ? deckCount : null;
    const slotAValue = cardDialog.querySelector('#card-slot-a').value;
    const slotBValue = cardDialog.querySelector('#card-slot-b').value;
    if (slotAValue === '') {
      card.slots[0] = { type: 'empty' };
    } else if (slotAValue && slotAValue !== '__flow') {
      card.slots[0] = { type: 'player', playerId: slotAValue };
    } else if (slotAValue === '__flow' && card.slots[0] && card.slots[0].type === 'flow') {
      card.slots[0].outcome = cardDialog.querySelector('#card-flow-outcome-a').value === 'loser' ? 'loser' : 'winner';
    }
    if (slotBValue === '') {
      card.slots[1] = { type: 'empty' };
    } else if (slotBValue && slotBValue !== '__flow') {
      card.slots[1] = { type: 'player', playerId: slotBValue };
    } else if (slotBValue === '__flow' && card.slots[1] && card.slots[1].type === 'flow') {
      card.slots[1].outcome = cardDialog.querySelector('#card-flow-outcome-b').value === 'loser' ? 'loser' : 'winner';
    }
    card.exitRanks = card.exitRanks || {};
    const rw = Number(cardDialog.querySelector('#card-rank-winner').value);
    const rl = Number(cardDialog.querySelector('#card-rank-loser').value);
    card.exitRanks.winner = Number.isFinite(rw) ? rw : null;
    card.exitRanks.loser = Number.isFinite(rl) ? rl : null;
    /* 职业链接:不完整行(选职业没内容/填内容没选职业)提示且不关弹窗 */
    const ga = readClassLinkGroup('#card-cl-a');
    const gb = readClassLinkGroup('#card-cl-b');
    const invalid = ga.invalid + gb.invalid;
    if (invalid > 0) {
      window.TournamentUtils.notify('有 ' + invalid + ' 行职业链接不完整(职业与链接/悬停文字需成对填写),请补全或清空该行', 'danger');
      return;
    }
    card.classLinks = {
      a: resolveGroup(card.classLinks, 'a', ga),
      b: resolveGroup(card.classLinks, 'b', gb)
    };
    /* 真有改动才入历史(打开又原样保存不产生空撤销步) */
    if (dialogBeforeSnapshot) {
      if (JSON.stringify(snapshotState()) !== JSON.stringify(dialogBeforeSnapshot)) {
        commitHistory(dialogBeforeSnapshot);
      }
      dialogBeforeSnapshot = null;
    }
    cardDialog.close();
    saveCanvas().then(() => {
      requestRender();
    });
  }

  /* 系统打断触摸(来电/手势导航):只清触摸轨迹,不打断可恢复的其它手势 */
  function onPointerCancel(event) {
    onTouchEnd(event);
  }

  /* ---------- 框选矩形(挂 body,renderCanvas 重建 board 不会销毁它) ---------- */

  function ensureMarqueeRect() {
    let rect = document.getElementById('canvas-marquee-rect');
    if (!rect) {
      rect = document.createElement('div');
      rect.id = 'canvas-marquee-rect';
      rect.className = 'marquee-rect';
      rect.setAttribute('aria-hidden', 'true');
      document.body.appendChild(rect);
    }
    return rect;
  }

  function removeMarqueeRect() {
    const rect = document.getElementById('canvas-marquee-rect');
    if (rect) rect.remove();
  }

  /* 屏幕坐标矩形 → board 内部像素(除以 scale),与卡片 offsetLeft/Top 做交叉命中;
   * 命中集合 = 框选起始时的基础集合(Shift 加选) ∪ 矩形碰到(交叉)的卡片 */
  function updateMarqueeRect() {
    const state = marqueeState;
    const rectEl = ensureMarqueeRect();
    const b = board();
    if (!state || !rectEl || !b) return;
    const left = Math.min(state.startX, state.lastX);
    const top = Math.min(state.startY, state.lastY);
    const width = Math.abs(state.lastX - state.startX);
    const height = Math.abs(state.lastY - state.startY);
    rectEl.style.left = left + 'px';
    rectEl.style.top = top + 'px';
    rectEl.style.width = width + 'px';
    rectEl.style.height = height + 'px';

    const boardRect = b.getBoundingClientRect();
    const localLeft = (left - boardRect.left) / scale;
    const localTop = (top - boardRect.top) / scale;
    const localRight = localLeft + width / scale;
    const localBottom = localTop + height / scale;
    const hits = new Set(state.base);
    b.querySelectorAll('.canvas-card').forEach((el) => {
      const x1 = el.offsetLeft;
      const y1 = el.offsetTop;
      const x2 = x1 + el.offsetWidth;
      const y2 = y1 + el.offsetHeight;
      if (x2 >= localLeft && x1 <= localRight && y2 >= localTop && y1 <= localBottom) {
        hits.add(el.dataset.match);
      }
    });
    batchSelected = hits;
    selectedCardId = [...hits][0] || null;
    highlightSelected();
  }

  /* ---------- 临时连线 ---------- */

  function ensureTempLine() {
    let line = document.getElementById('canvas-temp-line');
    if (!line) {
      line = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      line.id = 'canvas-temp-line';
      line.classList.add('canvas-temp-line');
      document.body.appendChild(line);
    }
  }

  function updateTempLine(x, y) {
    const line = document.getElementById('canvas-temp-line');
    if (!line || !connectState) return;
    const el = connectState.sourcePortEl;
    if (!el || !el.isConnected) return;
    const b = board();
    if (!b) return;
    const rect = b.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const p1 = { x: r.left - rect.left + r.width / 2, y: r.top - rect.top + r.height / 2 };
    const p2 = { x: x - rect.left, y: y - rect.top };
    /* 源端法线 = 出发连接点方位;末端尚无连接点,取 start→end 主轴方向作进入方向 */
    const n1 = PORT_NORMALS[el.dataset.port] || [1, 0];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const n2 = Math.abs(dx) >= Math.abs(dy) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dy) || 1];
    const cls = connectState.outcome === 'loser' ? 'loser' : 'winner';
    line.style.left = rect.left + 'px';
    line.style.top = rect.top + 'px';
    line.setAttribute('width', rect.width || 1000);
    line.setAttribute('height', rect.height || 800);
    line.innerHTML = arrowDefs('temp') +
      '<path d="' + edgePath(p1, n1, p2, n2) +
      '" class="canvas-edge temp ' + cls + '" marker-end="url(#temp-arrow-' + cls + ')"></path>';
  }

  function removeTempLine() {
    const line = document.getElementById('canvas-temp-line');
    if (line) line.remove();
  }

  /* 平移手势查看态也要用,事件绑定放在模块初始化而非仅进入编辑时 */
  bindBoardEvents();
  bindWheel();
  /* 触摸轨迹清理挂 window:手指在画布外抬起时 pointerup 目标不是画布,
   * 靠冒泡兜底,防止 activeTouches 残留让后续捏合永久失灵 */
  window.addEventListener('pointerup', onTouchEnd);
  window.addEventListener('pointercancel', onTouchEnd);
  /* 编辑改动未落盘就关页/刷新:浏览器原生确认框兜底 */
  window.addEventListener('beforeunload', (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  /* ---------- 暴露接口 ---------- */

  /* bracket.js 启动时注入渲染回调;canvas-editor 只经此回调请求重绘,不引用上层全局 */
  function connect(handlers) {
    renderHook = handlers && typeof handlers.renderCanvas === 'function' ? handlers.renderCanvas : null;
    toolbarHook = handlers && typeof handlers.updateToolbar === 'function' ? handlers.updateToolbar : null;
  }

  window.CanvasEditor = {
    connect,
    enter,
    exit,
    addCard,
    deleteSelected,
    getSelectedIds: selectedIds,
    editCard: openCardDialog,
    setTool,
    getTool,
    isZoomMode,
    toggleZoomMode,
    zoomIn,
    zoomOut,
    setZoom,
    fitCanvas,
    focusCards,
    centerCard,
    syncZoom,
    getSelectedCount,
    undo,
    redo,
    canUndo,
    canRedo,
    isDirty,
    saveCanvas,
    restoreSavedZoom
  };
})();
