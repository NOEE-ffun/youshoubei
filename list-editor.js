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
    /* 阻断默认行为(与画布编辑器同模式):否则行内/组头 img 触发浏览器原生
     * 图片拖拽(pointercancel 掐断指针流,拖拽必死)、文本划选污染拖拽画面 */
    event.preventDefault();
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

  /* ---------- 拖拽排序 ----------
   * 自研指针拖拽:幽灵元素固定定位跟随,原行/原组 display:none 让空,落点由
   * 间隙条(.list-drop-gap)在 DOM 中占位;间隙移动/落定重排均经 FLIP 平滑过渡
   * (先测旧位→DOM 变更→倒放 transform→恢复过渡),reduced-motion 由 CSS 退化。 */

  function beginDrag(event) {
    const info = downInfo;
    if (!info || !info.groupEl) { drag = null; return; }
    document.body.classList.add('list-dragging');
    /* 拖拽真正开始才抓指针:快速拖出列表边界也不丢 move/up 事件 */
    try { body().setPointerCapture(info.pointerId); } catch (error) { /* 忽略 */ }
    if (info.kind === 'row') {
      const rect = info.rowEl.getBoundingClientRect();
      const ghost = document.createElement('div');
      ghost.className = 'list-ghost';
      ghost.style.width = rect.width + 'px';
      const inner = info.rowEl.cloneNode(true);
      inner.classList.add('ghost-inner');
      ghost.appendChild(inner);
      document.body.appendChild(ghost);
      drag = {
        kind: 'row',
        ghostEl: ghost,
        originEl: info.rowEl,
        sourceKey: info.groupEl.dataset.key,
        cardId: info.rowEl.dataset.match,
        targetKey: info.groupEl.dataset.key,
        targetIndex: -1,
        grabDx: event.clientX - rect.left,
        grabDy: event.clientY - rect.top
      };
    } else {
      const key = info.groupEl.dataset.key;
      const count = info.groupEl.querySelectorAll('.list-row').length;
      const ghost = document.createElement('div');
      ghost.className = 'list-ghost list-ghost-chip';
      ghost.textContent = (key === '__other__' ? '其他' : key) + ' · ' + count + ' 场';
      document.body.appendChild(ghost);
      /* 锚 = 指针抓取点:芯片中心贴指针。勿测自身 rect 当锚(新元素未定位,
       * rect 在视口左上角,会把幽灵钉死在角落完全脱离光标) */
      const rect = ghost.getBoundingClientRect();
      drag = {
        kind: 'block',
        ghostEl: ghost,
        originEl: info.groupEl,
        sourceKey: key,
        targetIndex: -1,
        grabDx: rect.width / 2,
        grabDy: rect.height / 2
      };
    }
    drag.originEl.classList.add('dragging-origin');
    moveGhost(event);
    updateDrop(event);
  }

  function moveGhost(event) {
    if (!drag) return;
    drag.ghostEl.style.translate =
      (event.clientX - drag.grabDx) + 'px ' + (event.clientY - drag.grabDy) + 'px';
  }

  /* FLIP:DOM 变更前测全体行/组位置,变更后倒放 transform,过渡回零 */

  /* 逻辑位置 = 视口矩形减去过渡中的 translateY:让位动画播放期间
   * getBoundingClientRect 读到的是中间态,命中判定必须用无动画的落位值 */
  function logicalTop(el) {
    const rect = el.getBoundingClientRect();
    try {
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return rect.top - m.m42;
    } catch (error) {
      return rect.top;
    }
  }

  function logicalHeight(el) {
    return el.offsetHeight; /* transform 不影响 offset 高度 */
  }

  function withFlip(mutate) {
    const els = [...body().querySelectorAll('.list-row, .list-group')];
    const first = els.map((el) => el.getBoundingClientRect().top);
    mutate();
    els.forEach((el, i) => {
      if (!el.isConnected) return;
      const dy = first[i] - el.getBoundingClientRect().top;
      if (!dy) return;
      el.style.transition = 'none';
      el.style.transform = 'translateY(' + dy + 'px)';
      void el.offsetHeight; /* 钉住倒放起点再恢复过渡 */
      el.style.transition = '';
      el.style.transform = '';
    });
  }

  /* 行拖拽落点:指针所在组(组头到末行底的纵向范围,出界就近归属)+ 组内中点计数;
   * 下标口径 = 剔除拖拽行后的插入位;全部用逻辑位置(见 logicalTop) */
  function computeRowTarget(y) {
    const groups = [...body().querySelectorAll('.list-group')];
    let best = null;
    let bestDist = Infinity;
    for (const g of groups) {
      const rowEls = [...g.querySelectorAll('.list-row')].filter((el) => el !== drag.originEl);
      const head = g.querySelector('h2');
      const headTop = logicalTop(head);
      const bottom = rowEls.length ? logicalTop(rowEls[rowEls.length - 1]) + logicalHeight(rowEls[rowEls.length - 1]) : headTop + logicalHeight(head);
      if (y >= headTop && y <= bottom) {
        best = { g, rowEls };
        break;
      }
      const dist = y < headTop ? headTop - y : y - bottom;
      if (dist < bestDist) {
        bestDist = dist;
        best = { g, rowEls };
      }
    }
    if (!best) return null;
    let index = 0;
    for (const r of best.rowEls) {
      if (y > logicalTop(r) + logicalHeight(r) / 2) index += 1;
    }
    return { key: best.g.dataset.key, index };
  }

  function computeBlockTarget(y) {
    const groups = [...body().querySelectorAll('.list-group')].filter((g) => g !== drag.originEl);
    let index = 0;
    for (const g of groups) {
      if (y > logicalTop(g) + logicalHeight(g) / 2) index += 1;
    }
    return index;
  }

  function clearGapDom() {
    body().querySelectorAll('.list-drop-gap').forEach((el) => el.remove());
    body().querySelectorAll('.list-group.drop-target').forEach((el) => el.classList.remove('drop-target'));
  }

  function updateDrop(event) {
    if (!drag) return;
    if (drag.kind === 'row') {
      const target = computeRowTarget(event.clientY) || { key: drag.sourceKey, index: 0 };
      if (target.key !== drag.targetKey || target.index !== drag.targetIndex) {
        drag.targetKey = target.key;
        drag.targetIndex = target.index;
        withFlip(() => {
          clearGapDom();
          if (!drag.gapEl) {
            drag.gapEl = document.createElement('div');
            drag.gapEl.className = 'list-drop-gap row';
          }
          const group = [...body().querySelectorAll('.list-group')].find((g) => g.dataset.key === drag.targetKey);
          if (!group) return;
          const rowEls = [...group.querySelectorAll('.list-row')].filter((el) => el !== drag.originEl);
          if (drag.targetIndex >= rowEls.length) group.appendChild(drag.gapEl);
          else group.insertBefore(drag.gapEl, rowEls[drag.targetIndex]);
          if (drag.targetKey !== drag.sourceKey) group.classList.add('drop-target');
        });
      }
    } else {
      const index = computeBlockTarget(event.clientY);
      if (index !== drag.targetIndex) {
        drag.targetIndex = index;
        withFlip(() => {
          clearGapDom();
          if (!drag.gapEl) {
            drag.gapEl = document.createElement('div');
            drag.gapEl.className = 'list-drop-gap block';
          }
          const groups = [...body().querySelectorAll('.list-group')].filter((g) => g !== drag.originEl);
          if (drag.targetIndex >= groups.length) body().appendChild(drag.gapEl);
          else body().insertBefore(drag.gapEl, groups[drag.targetIndex]);
        });
      }
    }
  }

  /* 拖拽中近视口上下边缘按距离加速滚动 */
  function autoScroll() {
    cancelAnimationFrame(scrollRaf);
    const step = () => {
      if (!drag) return;
      const rect = main().getBoundingClientRect();
      let dy = 0;
      if (lastPointer.y < rect.top + EDGE_SCROLL_ZONE) {
        dy = -Math.ceil((rect.top + EDGE_SCROLL_ZONE - lastPointer.y) / 5);
      } else if (lastPointer.y > rect.bottom - EDGE_SCROLL_ZONE) {
        dy = Math.ceil((lastPointer.y - (rect.bottom - EDGE_SCROLL_ZONE)) / 5);
      }
      if (dy) {
        main().scrollTop += dy;
        updateDrop({ clientY: lastPointer.y });
        scrollRaf = requestAnimationFrame(step);
      }
    };
    scrollRaf = requestAnimationFrame(step);
  }

  /* 落定:数据层重排(组序/组内序/phase)→ 一步历史 + 落盘;
   * 先乐观重渲染(带 settle FLIP),落盘回调再全量刷一次 */
  function finishDrag() {
    const d = drag;
    drag = null;
    downInfo = null;
    cancelAnimationFrame(scrollRaf);
    document.body.classList.remove('list-dragging');
    suppressClick = true;
    if (d) {
      if (d.ghostEl) d.ghostEl.remove();
      if (d.gapEl) d.gapEl.remove();
      clearGapDom();
      /* 原位放下(no-op)也必须还原:漏摘 dragging-origin 会让整组/整行
       * 保持 display:none"消失",且无落盘重渲染,直到退出编辑才恢复 */
      d.originEl.classList.remove('dragging-origin');
    }
    if (!d) return;
    const record = window.TournamentApp.current;
    if (!record || !record.canvas) return;
    const groups = CanvasModel.listGroups(record.canvas.cards);
    let applied = false;
    if (d.kind === 'row') {
      const src = groups.find((g) => g.key === d.sourceKey);
      const idx = src ? src.cards.findIndex((c) => c.id === d.cardId) : -1;
      if (src && idx >= 0 && !(d.targetKey === d.sourceKey && d.targetIndex === idx)) {
        const [card] = src.cards.splice(idx, 1);
        if (d.targetKey !== d.sourceKey) {
          /* 跨阶段落下:阶段字段同步(拖入「其他」= 清空),卡片设置抽屉随之同源 */
          card.phase = d.targetKey === '__other__' ? '' : d.targetKey;
        }
        const dst = d.targetKey === d.sourceKey ? src : groups.find((g) => g.key === d.targetKey);
        if (dst) {
          dst.cards.splice(Math.min(d.targetIndex, dst.cards.length), 0, card);
          applied = true;
        }
      }
    } else {
      const from = groups.findIndex((g) => g.key === d.sourceKey);
      /* targetIndex 按"剔除拖拽组后"的组序计数(computeBlockTarget 已滤 origin),
       * splice 移除后直接按它插入;无操作仅当恰好等于原位 from——
       * 勿加 from+1 判断(那是全量索引口径,会把拖到中间位置的合法移动误判成 no-op) */
      if (from >= 0 && d.targetIndex >= 0 && d.targetIndex !== from) {
        const [group] = groups.splice(from, 1);
        groups.splice(d.targetIndex, 0, group);
        applied = true;
      }
    }
    if (!applied) return; /* 原地放下:无需提交 */
    const preRects = [...body().querySelectorAll('.list-row, .list-group')]
      .map((el) => [el, el.getBoundingClientRect().top]);
    window.CanvasEditor.commitListChange(() => CanvasModel.applyListOrder(record.canvas, groups));
    window.ListView.render(); /* 乐观重渲染 */
    document.body.classList.add('list-settling');
    for (const [el, top] of preRects) {
      if (!el.isConnected) continue;
      const dy = top - el.getBoundingClientRect().top;
      if (!dy) continue;
      el.style.transition = 'none';
      el.style.transform = 'translateY(' + dy + 'px)';
      void el.offsetWidth;
      el.style.transition = '';
      el.style.transform = '';
    }
    setTimeout(() => document.body.classList.remove('list-settling'), 220);
    syncSelection();
  }

  /* 取消(Esc/pointercancel/外部数据变更):撤幽灵与间隙,原位还原 */
  function cancelDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    downInfo = null;
    cancelAnimationFrame(scrollRaf);
    document.body.classList.remove('list-dragging');
    suppressClick = true;
    if (d.ghostEl) d.ghostEl.remove();
    if (d.gapEl) d.gapEl.remove();
    clearGapDom();
    d.originEl.classList.remove('dragging-origin');
  }

  /* ---------- 绑定 ---------- */

  function bind() {
    const el = body();
    if (!el) return;
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerCancel);
    el.addEventListener('click', onClick);
    /* 原生拖拽兜底:个别浏览器路径(Firefox 的 img 默认可拖)不认 pointerdown 预防 */
    el.addEventListener('dragstart', (event) => event.preventDefault());
  }

  document.addEventListener('ts:ready', () => bind());
  document.addEventListener('ts:list-render', () => { if (isEditing()) syncSelection(); });
  /* 外部数据变更(切届/后台恢复)打断拖拽并按现存卡收敛 */
  document.addEventListener('ts:changed', () => { if (drag) cancelDrag(); });
  /* 拖拽中的 Esc:捕获阶段抢占(canvas-editor 的 Esc 清选择不叠加触发) */
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drag) {
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelDrag();
    }
  }, true);

  window.ListEditor = {
    enter,
    exit,
    cancelDrag: () => cancelDrag()
  };
})();
