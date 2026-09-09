(function () {
  'use strict';

  /* 主页总览系列编辑器(2026-09-09 批):编辑态生命周期(body.series-editing)、
   * 系列行内新建/改名/删除、组尾就地产届、行删除、拖拽(届跨系列改挂+组内排序/
   * 系列整块重排)。交互契约移植自 list-editor.js:位移阈值区分点击/拖拽、
   * 延迟指针捕获、幽灵跟随、间隙条落点、FLIP、logicalTop 命中、suppressClick、
   * Esc 取消。数据一律经 TournamentApp 的工作区事务助手(applyWorkspaceEdit 精确流)
   * 与 createTournament/deleteTournament——本模块不直接碰 workspace。 */

  const DRAG_THRESHOLD = 4;   /* 超过此位移才算拖拽,否则纯点击 */
  const EDGE_SCROLL_ZONE = 48;
  const NAME_MAX = 32;        /* 与退役系列弹窗 maxlength 一致 */

  let drag = null;
  let downInfo = null;
  let lastPointer = { x: 0, y: 0 };
  let scrollRaf = 0;
  let suppressClick = false;
  let bound = false;

  function root() { return document.getElementById('ov-tournaments'); }
  function main() { return document.getElementById('main-content'); }
  function isEditing() { return document.body.classList.contains('series-editing'); }
  function utils() { return window.TournamentUtils; }
  function app() { return window.TournamentApp; }
  function esc(value) { return utils().escapeHtml(String(value == null ? '' : value)); }

  /* 未分组虚拟组:data-series 恒为字符串,'' 即未分组(dataset 序列化口径) */
  function seriesKey(group) { return group.id == null ? '' : String(group.id); }

  function editGroups() {
    return utils().groupTournamentsBySeries(
      (app().list || []).filter((t) => t && t.id),
      app().series || [],
      { keepEmpty: true }
    );
  }

  /* ---------- 渲染 ---------- */

  const STATUS_TEXT = { upcoming: '未开始', ongoing: '进行中', finished: '已结束' };

  function handleHtml() {
    return '<span class="list-handle ov-t-handle" data-drag-handle title="拖拽排序" aria-hidden="true">' +
      '<img class="icon" src="icons/drag_indicator.svg" alt=""></span>';
  }

  function rowHtml(t) {
    const manage = utils().canManage(t);
    const delBtn = manage
      ? '<button type="button" class="ov-t-row-del" data-del-tournament="' + esc(t.id) + '" aria-label="删除比赛 ' + esc(t.name || t.id) + '" title="删除比赛">' +
        '<img class="icon" src="icons/delete.svg" alt="" aria-hidden="true"></button>'
      : '';
    return '<div class="ov-t-row' + (manage ? ' is-movable' : '') + '" data-id="' + esc(t.id) + '"' +
      (manage ? ' title="拖拽移动到其他系列"' : ' title="仅创建者或超管可移动"') + '>' +
      (manage ? handleHtml() : '') +
      '<span class="ov-t-name">' + esc(t.name || t.id) + '</span>' +
      '<span class="status-badge status-' + esc(t.status || 'upcoming') + '">' +
      esc(STATUS_TEXT[t.status] || STATUS_TEXT.upcoming) + '</span>' +
      delBtn +
      '</div>';
  }

  function groupHtml(g) {
    const real = g.id != null; /* 未分组=虚拟组:无手柄/不可改名/不可删除 */
    const series = real ? (app().series || []).find((s) => s && s.id === g.id) : null;
    const manage = Boolean(real && series && utils().canManage(series));
    /* 删除预判:属下有管不了的届 → 删除必 403(届 seriesId 清空属内容变化) */
    const hasForeign = real && g.items.some((t) => !utils().canManage(t));
    const namePart = manage
      ? '<button type="button" class="ov-t-name-btn" data-rename="' + esc(g.id) + '" title="重命名系列">' + esc(g.label) + '</button>'
      : '<span class="ov-t-name-label">' + esc(g.label) + '</span>';
    const delBtn = manage
      ? '<button type="button" class="btn btn-ghost btn-sm ov-t-del" data-del="' + esc(g.id) + '" aria-label="删除系列 ' + esc(g.label) + '"' +
        (hasForeign ? ' disabled title="系列内有他人创建的届，仅超管可删除"' : ' title="删除系列"') + '>' +
        '<img class="icon" src="icons/delete.svg" alt="" aria-hidden="true"></button>'
      : '';
    return '<section class="ov-t-group' + (real ? '' : ' ov-t-group-ungrouped') + '" data-series="' + esc(seriesKey(g)) + '">' +
      '<h3 class="ov-t-group-title">' +
      (real ? handleHtml() : '') + namePart +
      '<span class="ov-t-group-count">' + g.count + ' 届</span>' + delBtn +
      '</h3>' +
      g.items.map(rowHtml).join('') +
      '<button type="button" class="ov-t-add-t" data-add-tournament="' + esc(seriesKey(g)) + '" title="在该系列新建比赛">' +
      '<img class="icon" src="icons/add.svg" alt="" aria-hidden="true">新建比赛</button>' +
      '</section>';
  }

  function renderEdit() {
    const box = root();
    if (!box || !isEditing()) return;
    box.innerHTML =
      '<div class="ov-t-head"><h2>比赛总览</h2>' +
      '<button type="button" class="btn btn-secondary btn-sm" id="ov-t-done-btn">完成</button></div>' +
      editGroups().map(groupHtml).join('') +
      '<button type="button" class="ov-t-add" id="ov-t-add-btn">' +
      '<img class="icon" src="icons/add.svg" alt="" aria-hidden="true">新建系列</button>';
    box.hidden = false;
  }

  /* ---------- 生命周期 ---------- */

  function enter() {
    if (!app() || !app().isAdmin()) return;
    document.body.classList.add('series-editing');
    bind();
    renderEdit();
  }

  function exit() {
    cancelDrag();
    document.body.classList.remove('series-editing');
    /* 走 home.js 渲染管线回视图态(ts:changed → renderTournaments) */
    document.dispatchEvent(new CustomEvent('ts:changed'));
  }

  /* ---------- 行内编辑(新建/改名) ---------- */

  /* 把目标元素替换为行内输入框;commit(value) 由调用方给定,Esc 还原 */
  function inlineInput(target, initial, commit) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ov-t-name-input';
    input.maxLength = NAME_MAX;
    input.value = initial || '';
    input.setAttribute('aria-label', '系列名称');
    let done = false;
    const finish = (apply) => {
      if (done) return;
      done = true;
      const value = input.value;
      if (apply && value.trim()) commit(value);
      else renderEdit();
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') finish(true);
      else if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    target.replaceWith(input);
    input.focus();
    input.select();
  }

  function beginRename(btn) {
    const seriesId = btn.dataset.rename;
    const series = (app().series || []).find((s) => s && s.id === seriesId);
    if (!series) return;
    inlineInput(btn, series.name || '', async (value) => {
      const name = value.trim().slice(0, NAME_MAX);
      if (!name) { utils().notify('系列名称不能为空'); renderEdit(); return; }
      if (name === series.name) { renderEdit(); return; }
      try {
        await app().applyWorkspaceEdit((ws) => {
          const target = ws.series.find((s) => s && s.id === seriesId);
          if (target) target.name = name;
        });
        utils().notify('系列已重命名');
      } catch (error) {
        utils().notify('重命名失败：' + utils().errMsg(error), 'danger');
      }
    });
  }

  function beginCreate() {
    const btn = document.getElementById('ov-t-add-btn');
    if (!btn) return;
    inlineInput(btn, '', async (value) => {
      const name = value.trim().slice(0, NAME_MAX);
      if (!name) { renderEdit(); return; }
      try {
        await app().applyWorkspaceEdit((ws) => {
          ws.series.push({ id: utils().uid('s'), name: name, desc: '', createdAt: Date.now() });
        });
        utils().notify('系列已创建');
      } catch (error) {
        utils().notify('新建系列失败：' + utils().errMsg(error), 'danger');
      }
    });
  }

  /* 组尾就地产届:空白画布,所属系列=所在组(未分组=null);确认弹窗在
   * common.js deleteTournament 内部,这里只管建。 */
  function beginCreateTournament(chip) {
    const seriesId = chip.dataset.addTournament || '';
    inlineInput(chip, '', async (value) => {
      const name = value.trim();
      if (!name) { renderEdit(); return; }
      try {
        await app().createTournament(name, seriesId || null);
        utils().notify('比赛已创建');
      } catch (error) {
        utils().notify('新建比赛失败：' + utils().errMsg(error), 'danger');
      }
    });
  }

  /* ---------- 删除 ---------- */

  async function removeSeries(seriesId) {
    const g = editGroups().find((x) => x.id != null && String(x.id) === String(seriesId));
    if (!g) return;
    const ok = await utils().uiConfirm('删除系列「' + g.label + '」？其中 ' + g.count + ' 届将归入未分组。');
    if (!ok) return;
    try {
      await app().applyWorkspaceEdit((ws) => {
        ws.series = ws.series.filter((s) => s && s.id !== seriesId);
        for (const t of ws.tournaments) {
          if (t && t.seriesId === seriesId) t.seriesId = null;
        }
      });
      utils().notify('系列已删除');
    } catch (error) {
      utils().notify('删除失败：' + utils().errMsg(error), 'danger');
    }
  }

  /* ---------- 点击委托(行内编辑入口/完成/删除) ---------- */

  function onClick(event) {
    if (!isEditing()) return;
    if (suppressClick) { suppressClick = false; return; }
    const renameBtn = event.target.closest('[data-rename]');
    if (renameBtn) { beginRename(renameBtn); return; }
    const delBtn = event.target.closest('[data-del]');
    if (delBtn && !delBtn.disabled) { removeSeries(delBtn.dataset.del); return; }
    const addT = event.target.closest('[data-add-tournament]');
    if (addT) { beginCreateTournament(addT); return; }
    const delT = event.target.closest('[data-del-tournament]');
    if (delT) {
      /* 确认弹窗/删光兜底/当前届切换全在 common.js deleteTournament 内 */
      app().deleteTournament(delT.dataset.delTournament);
      return;
    }
    if (event.target.closest('#ov-t-add-btn')) { beginCreate(); return; }
    if (event.target.closest('#ov-t-done-btn')) { exit(); return; }
  }

  function bind() {
    if (bound) return;
    bound = true;
    const el = root();
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerCancel);
    el.addEventListener('click', onClick);
    /* 原生拖拽兜底:防行内 img(Firefox 默认可拖)掐断指针流 */
    el.addEventListener('dragstart', (event) => event.preventDefault());
  }

  /* ---------- 拖拽(契约移植自 list-editor.js) ----------
   * 幽灵 fixed 跟随,原行/原组 display:none 让空,落点由间隙条(.list-drop-gap)
   * 占位;让位/落定经 FLIP(logicalTop 避开过渡中间态)。 */

  /* 真实系列组(未分组虚拟组不参与组块排序,恒最后) */
  function blockCandidates() {
    return [...root().querySelectorAll('.ov-t-group')].filter((g) => g.dataset.series !== '');
  }

  function onPointerDown(event) {
    if (!isEditing() || event.button !== 0) return;
    if (event.target.closest('input, textarea, select, button')) return;
    const row = event.target.closest('.ov-t-row');
    const header = event.target.closest('.ov-t-group-title');
    if (!row && !header) return;
    const groupEl = row ? row.closest('.ov-t-group') : header.closest('.ov-t-group');
    if (!groupEl) return;
    /* 行:仅可移动届(有手柄)可拖;组:仅真实系列组可拖 */
    if (row && !row.classList.contains('is-movable')) return;
    if (!row && groupEl.dataset.series === '') return;
    /* 触屏只认手柄(data-drag-handle),整行/整头拖拽仅鼠标——否则页面无法滚动 */
    if (event.pointerType === 'touch' && !event.target.closest('[data-drag-handle]')) return;
    downInfo = {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      kind: row ? 'row' : 'block',
      rowEl: row || null,
      groupEl
    };
    /* 阻断默认:防行内 img 触发浏览器原生拖拽掐断指针流、防文本划选污染画面 */
    event.preventDefault();
    /* 此处不 setPointerCapture——捕获会重定向后续 click 的 target,
     * 指针捕获延迟到拖拽真正开始(beginDrag)再抓(list-editor 同款坑规避) */
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
    if (drag) finishDrag();
    downInfo = null;
    /* 纯点击在编辑态无动作(行不切届、无选中模型) */
  }

  function onPointerCancel() {
    cancelDrag();
    downInfo = null;
  }

  function beginDrag(event) {
    const info = downInfo;
    if (!info || !info.groupEl) { drag = null; return; }
    document.body.classList.add('list-dragging');
    try { root().setPointerCapture(info.pointerId); } catch (error) { /* 忽略 */ }
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
        sourceKey: info.groupEl.dataset.series,
        cardId: info.rowEl.dataset.id,
        targetKey: info.groupEl.dataset.series,
        targetIndex: -1,
        grabDx: event.clientX - rect.left,
        grabDy: event.clientY - rect.top
      };
    } else {
      const label = info.groupEl.querySelector('.ov-t-name-btn, .ov-t-name-label');
      const count = info.groupEl.querySelectorAll('.ov-t-row').length;
      const ghost = document.createElement('div');
      ghost.className = 'list-ghost list-ghost-chip';
      ghost.textContent = ((label && label.textContent) || '') + ' · ' + count + ' 届';
      document.body.appendChild(ghost);
      /* 锚 = 芯片中心贴指针;勿测新元素自身 rect 当锚(会钉死视口左上角) */
      const rect = ghost.getBoundingClientRect();
      drag = {
        kind: 'block',
        ghostEl: ghost,
        originEl: info.groupEl,
        sourceKey: info.groupEl.dataset.series,
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

  /* 逻辑位置 = 视口矩形减去过渡中的 translateY(让位动画中间态会翻转落点判定) */
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
    return el.offsetHeight;
  }

  function withFlip(mutate) {
    const els = [...root().querySelectorAll('.ov-t-row, .ov-t-group')];
    const first = els.map((el) => el.getBoundingClientRect().top);
    mutate();
    els.forEach((el, i) => {
      if (!el.isConnected) return;
      const dy = first[i] - el.getBoundingClientRect().top;
      if (!dy) return;
      el.style.transition = 'none';
      el.style.transform = 'translateY(' + dy + 'px)';
      void el.offsetHeight;
      el.style.transition = '';
      el.style.transform = '';
    });
  }

  /* 行拖拽落点:指针所在组(组头到末行底纵向范围,出界就近归属)+ 组内中点计数;
   * 下标口径 = 剔除拖拽行后的插入位(本编辑器无组内重排,仅用于间隙条位置) */
  function computeRowTarget(y) {
    const groups = [...root().querySelectorAll('.ov-t-group')];
    let best = null;
    let bestDist = Infinity;
    for (const g of groups) {
      const rowEls = [...g.querySelectorAll('.ov-t-row')].filter((el) => el !== drag.originEl);
      const head = g.querySelector('.ov-t-group-title');
      const headTop = logicalTop(head);
      const bottom = rowEls.length
        ? logicalTop(rowEls[rowEls.length - 1]) + logicalHeight(rowEls[rowEls.length - 1])
        : headTop + logicalHeight(head);
      if (y >= headTop && y <= bottom) { best = { g, rowEls }; break; }
      const dist = y < headTop ? headTop - y : y - bottom;
      if (dist < bestDist) { bestDist = dist; best = { g, rowEls }; }
    }
    if (!best) return null;
    let index = 0;
    for (const r of best.rowEls) {
      if (y > logicalTop(r) + logicalHeight(r) / 2) index += 1;
    }
    return { key: best.g.dataset.series, index };
  }

  /* 组块落点:其他真实系列组按中点计数(未分组恒最后,不参与) */
  function computeBlockTarget(y) {
    const groups = blockCandidates().filter((g) => g !== drag.originEl);
    let index = 0;
    for (const g of groups) {
      if (y > logicalTop(g) + logicalHeight(g) / 2) index += 1;
    }
    return index;
  }

  function clearGapDom() {
    root().querySelectorAll('.list-drop-gap').forEach((el) => el.remove());
    root().querySelectorAll('.ov-t-group.drop-target').forEach((el) => el.classList.remove('drop-target'));
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
          const group = [...root().querySelectorAll('.ov-t-group')].find((g) => g.dataset.series === drag.targetKey);
          if (!group) return;
          const rowEls = [...group.querySelectorAll('.ov-t-row')].filter((el) => el !== drag.originEl);
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
          const groups = blockCandidates().filter((g) => g !== drag.originEl);
          if (drag.targetIndex >= groups.length) {
            /* 末位 = 最后一个真实系列组之后;有未分组时须插在它之前 */
            const ungrouped = root().querySelector('.ov-t-group-ungrouped');
            if (ungrouped) root().insertBefore(drag.gapEl, ungrouped);
            else root().appendChild(drag.gapEl);
          } else {
            root().insertBefore(drag.gapEl, groups[drag.targetIndex]);
          }
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

  /* 落定:行=落位(placeTournamentInGroup:改挂+组内序,同组同位无操作);
   * 组=重排(applySeriesOrder 守卫)。都走 applyWorkspaceEdit 精确流,
   * 写完由 ts:changed 管线统一重渲染。 */
  async function finishDrag() {
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
      /* 原位放下也必须还原:漏摘 dragging-origin 会让行/组保持 display:none */
      d.originEl.classList.remove('dragging-origin');
    }
    if (!d) return;
    try {
      if (d.kind === 'row') {
        /* 落位 = 改挂 + 组内序(组内显示序是全局数组序的投影,一并写回;
         * 同组同位纯函数返回 null=no-op,先用本地摘要预检免掉无谓的服务器往返) */
        if (!utils().placeTournamentInGroup(app().list || [], d.cardId, d.targetKey || null, d.targetIndex)) return;
        await app().applyWorkspaceEdit((ws) => {
          const placed = utils().placeTournamentInGroup(ws.tournaments, d.cardId, d.targetKey || null, d.targetIndex);
          if (placed) ws.tournaments = placed;
        });
      } else {
        const ordered = blockCandidates().map((g) => g.dataset.series);
        const from = ordered.indexOf(d.sourceKey);
        if (from < 0) return;
        /* targetIndex 已按剔除拖拽组计数,splice 移除后直接按它插入;
         * no-op 仅当恰好等于原位,勿加 from+1 判断(list-editor 差一坑) */
        if (d.targetIndex === from) return;
        ordered.splice(from, 1);
        ordered.splice(d.targetIndex, 0, d.sourceKey);
        const applied = utils().applySeriesOrder(app().series || [], ordered);
        if (!applied) return;
        await app().applyWorkspaceEdit((ws) => { ws.series = applied; });
      }
    } catch (error) {
      utils().notify('移动失败：' + utils().errMsg(error), 'danger');
    }
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

  document.addEventListener('ts:ready', () => { if (root()) bind(); });
  /* 外部数据变更(切届/后台恢复)打断进行中的拖拽 */
  document.addEventListener('ts:changed', () => { if (drag) cancelDrag(); });
  /* 拖拽中的 Esc:捕获阶段抢占 */
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drag) {
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelDrag();
    }
  }, true);

  window.SeriesEditor = { enter, exit, renderEdit, cancelDrag };
})();
