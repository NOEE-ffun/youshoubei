(function () {
  'use strict';

  /* 共享工具统一来自 common.js;画布几何来自 canvas-model.js(唯一真源) */
  const {
    escapeHtml, canEdit, save, avatarMarkup, notify, uiConfirm, iconMarkup,
    formatStartTime, bindZoomDock: bindZoomDockControls, bindZoomFitOnResize
  } = window.TournamentUtils;
  const { CARD_WIDTH, CARD_HEIGHT, COL_GAP, ROW_GAP, PORT_Y, DEFAULT_CANVAS_COLS, DEFAULT_CANVAS_ROWS } = window.CanvasModel;

  let editMode = false;
  let scoreDialog = null;
  let currentScoreCardId = null;
  let rosterDropdown = null;
  let rulesDropdown = null;

  function currentRecord() {
    return window.TournamentApp.current;
  }

  function playerById(id) {
    return (window.TournamentApp.players || []).find((p) => p.id === id) || null;
  }

  function playerName(id) {
    const p = playerById(id);
    return p ? p.name : '待定';
  }

  /* ---------- 查看 / 编辑模式与管理员锁 ---------- */

  function showEditLock() {
    const lock = document.getElementById('canvas-lock');
    const wrap = document.querySelector('.canvas-wrap-full');
    if (lock) lock.hidden = false;
    if (wrap) wrap.classList.add('canvas-locked');
    const input = document.getElementById('canvas-lock-password');
    if (input) setTimeout(() => input.focus(), 0);
  }

  function hideEditLock() {
    const lock = document.getElementById('canvas-lock');
    const wrap = document.querySelector('.canvas-wrap-full');
    if (lock) lock.hidden = true;
    if (wrap) wrap.classList.remove('canvas-locked');
  }

  function enterEditMode() {
    if (editMode) return;
    editMode = true;
    renderAll();
    CanvasEditor.enter();
    syncEditUI();
  }

  function exitEditMode() {
    if (!editMode) return;
    editMode = false;
    CanvasEditor.exit();
    renderAll();
    syncEditUI();
  }

  function requestEdit() {
    if (!canEdit()) {
      showEditLock();
      return;
    }
    if (editMode) exitEditMode();
    else enterEditMode();
  }

  function syncEditUI() {
    if (editMode && !canEdit()) {
      editMode = false;
      CanvasEditor.exit();
      hideEditLock();
    } else if (canEdit()) {
      hideEditLock();
    }
    const layout = document.getElementById('canvas-layout');
    const toolbar = document.getElementById('edit-toolbar');
    if (layout) layout.classList.toggle('has-toolbar', editMode);
    if (toolbar) toolbar.hidden = !editMode;
    renderEditToolbar();
  }

  function bindCanvasLock() {
    const submit = document.getElementById('canvas-lock-submit');
    const input = document.getElementById('canvas-lock-password');
    if (!submit || !input) return;
    const cancel = document.getElementById('canvas-lock-cancel');
    if (cancel) cancel.addEventListener('click', () => {
      input.value = '';
      hideEditLock();
    });
    const tryUnlock = async () => {
      const token = input.value.trim();
      if (!token) return;
      window.TournamentApp.setAdminToken(token);
      try {
        // 通过一次真实写入验证口令（云端模式会校验 Authorization）
        await window.TournamentApp.storagePutPlayers(window.TournamentApp.players);
        input.value = '';
        hideEditLock();
        if (window.TournamentApp.renderHeader) window.TournamentApp.renderHeader();
        if (window.TournamentApp.renderSidebar) window.TournamentApp.renderSidebar();
        enterEditMode();
      } catch (error) {
        window.TournamentApp.setAdminToken('');
        input.value = '';
        notify(window.TournamentUtils.errMsg(error), 'danger');
      }
    };
    submit.addEventListener('click', tryUnlock);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') tryUnlock();
    });
  }

  function renderAll() {
    const app = window.TournamentApp;
    if (!app || !app.current) return;
    closeRosterDropdown();
    closeRulesDropdown();
    const record = app.current;
    if (CanvasModel.ensureCanvasDecks) {
      CanvasModel.ensureCanvasDecks(record);
    }
    if (!record.scores) record.scores = {};
    if (!record.canvas) record.canvas = { cards: [] };
    if (CanvasModel.deriveRoster && record.canvas) {
      const known = new Set((window.TournamentApp.players || []).map((p) => p.id));
      record.roster = CanvasModel.deriveRoster(record.canvas).filter((id) => known.has(id));
    }
    renderChampion();
    renderScheduleMeta();
    renderCanvas();
    renderEditToolbar();
    /* 重绘会清掉查找高亮,搜索激活时重挂(不重新聚焦,避免滚动跳动) */
    if (searchQuery.trim()) applySearch();
  }

  /* ---------- 查找定位(场次 / 选手 / 阶段) ---------- */

  let searchQuery = '';
  let searchHitIds = [];
  let searchCurrentIndex = -1;
  let searchDebounce = null;

  function computeSearchHits(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const record = currentRecord();
    if (!record || !record.canvas) return [];
    const resolved = CanvasModel.resolveCanvas(record.canvas, record.roster || [], record.scores || {});
    const names = new Map((window.TournamentApp.players || []).map((p) => [p.id, String(p.name || '').toLowerCase()]));
    const ids = [];
    for (const m of resolved.cards) {
      const label = String(m.label || m.id).toLowerCase();
      const phase = String(m.phase || '').toLowerCase();
      const aName = m.a ? (names.get(m.a) || '') : '';
      const bName = m.b ? (names.get(m.b) || '') : '';
      if (label.includes(q) || phase.includes(q) || aName.includes(q) || bName.includes(q)) ids.push(m.id);
    }
    return ids;
  }

  function applySearch(options) {
    const board = document.getElementById('canvas-board');
    const countEl = document.getElementById('match-search-count');
    if (!board) return;
    searchHitIds = computeSearchHits(searchQuery);
    searchCurrentIndex = -1;
    board.querySelectorAll('.search-hit').forEach((el) => el.classList.remove('search-hit'));
    board.querySelectorAll('.search-current').forEach((el) => el.classList.remove('search-current'));
    if (!searchQuery.trim()) {
      board.classList.remove('searching');
      if (countEl) countEl.hidden = true;
      return;
    }
    board.classList.add('searching');
    for (const id of searchHitIds) {
      const el = board.querySelector('.canvas-card[data-match="' + id + '"]');
      if (el) el.classList.add('search-hit');
    }
    if (countEl) {
      const total = (currentRecord().canvas && currentRecord().canvas.cards || []).length;
      countEl.textContent = searchHitIds.length + ' / ' + total;
      countEl.hidden = false;
    }
    if (options && options.focus && searchHitIds.length) {
      /* 用户显式查找后接管缩放,防止 autoFit 把视口抢回去 */
      userZoomed = true;
      CanvasEditor.focusCards(searchHitIds);
    }
  }

  /* Enter 在命中间循环跳转(环绕),当前项加强高亮 */
  function searchStep() {
    if (!searchHitIds.length) return;
    searchCurrentIndex = (searchCurrentIndex + 1) % searchHitIds.length;
    const board = document.getElementById('canvas-board');
    board.querySelectorAll('.search-current').forEach((el) => el.classList.remove('search-current'));
    const id = searchHitIds[searchCurrentIndex];
    const el = board.querySelector('.canvas-card[data-match="' + id + '"]');
    if (el) el.classList.add('search-current');
    CanvasEditor.centerCard(id);
    const countEl = document.getElementById('match-search-count');
    if (countEl) countEl.textContent = (searchCurrentIndex + 1) + ' / ' + searchHitIds.length;
  }

  function clearSearch() {
    const input = document.getElementById('match-search');
    if (input) input.value = '';
    searchQuery = '';
    applySearch();
  }

  function bindMatchSearch() {
    const input = document.getElementById('match-search');
    if (!input) return;
    input.addEventListener('input', () => {
      searchQuery = input.value;
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => applySearch({ focus: true }), 250);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!searchHitIds.length) applySearch({ focus: true });
        else searchStep();
      } else if (event.key === 'Escape') {
        clearSearch();
      }
    });
  }

  /* ---------- 开赛时间（赛程页浮层） ---------- */

  function renderScheduleMeta() {
    const el = document.getElementById('canvas-meta');
    if (!el) return;
    const time = formatStartTime(currentRecord().startTime);
    el.hidden = !time;
    if (time) el.textContent = '开赛 ' + time;
  }

  /* ---------- 冠军横幅 ---------- */

  function renderChampion() {
    const app = window.TournamentApp;
    const record = app.current;
    const names = new Map((app.players || []).map((p) => [p.id, p.name]));
    const standings = CanvasModel.deriveStandings      ? CanvasModel.deriveStandings(record)
      : { champion: null, runnerUp: null, thirdPlace: null };
    const banner = document.getElementById('champion-banner');
    const text = document.getElementById('champion-text');
    if (standings.champion) {
      text.textContent = '冠军：' + (names.get(standings.champion) || '待定') +
        '　·　亚军：' + (names.get(standings.runnerUp) || '待定') +
        '　·　季军：' + (names.get(standings.thirdPlace) || '待定');
      banner.hidden = false;
    } else {
      banner.hidden = true;
      text.textContent = '';
    }
  }

  /* ---------- 画布渲染 ---------- */

  function formatScore(value) {
    const n = Number(value);
    if (Number.isFinite(n) && n < 0) return '弃权';
    return n;
  }

  function cardLeft(card) {
    return (Number(card.x) || 0) * COL_GAP;
  }

  function cardTop(card) {
    return (Number(card.y) || 0) * ROW_GAP;
  }

  function playerRow(match, side) {
    const participant = side === 0 ? match.a : match.b;
    const name = participant ? playerName(participant) : '待定';
    const score = side === 0 ? match.scoreA : match.scoreB;
    const avatarPlayer = participant ? playerById(participant) : null;
    let className = 'match-player';
    if (!participant) className += ' tbd';
    if (match.played) {
      if (match.winner === participant) className += ' winner';
      if (match.loser === participant) className += ' loser';
    }
    if (match.draw) className += ' draw';
    if (match.invalid) className += ' invalid';
    return (
      '<div class="' + className + '">' +
      avatarMarkup(avatarPlayer, 'avatar-sm') +
      '<span class="player-name">' + escapeHtml(name) + '</span>' +
      '<span class="player-score">' + (score == null ? '' : formatScore(score)) + '</span>' +
      '</div>'
    );
  }

  /* 职业卡组槽:A/B 两组,组内槽并排,两组之间"对"分隔;
   * 编辑模式每组末尾永远有"+"空槽 */
  function classSlotHtml(card, group, entry, idx) {
    const title = entry.text || entry.cls;
    return (
      '<button type="button" class="class-slot" data-cl-card="' + card.id + '" data-cl-group="' + group + '" data-cl-idx="' + idx + '"' +
      ' data-url="' + escapeHtml(entry.url) + '"' +
      ' title="' + escapeHtml(title) + '" aria-label="' + escapeHtml(title) + '">' +
      '<img class="icon" src="icons/classes/' + escapeHtml(entry.cls) + '.svg" alt="' + escapeHtml(entry.cls) + '">' +
      '</button>'
    );
  }

  function classGroupHtml(card, group, effLinks) {
    /* 有效链接 = 自己填的,否则沿连线继承来源卡中该选手一侧的卡组 */
    const links = ((effLinks || card.classLinks || {})[group]) || [];
    let html = links.map((entry, idx) => classSlotHtml(card, group, entry, idx)).join('');
    if (editMode) {
      html += '<button type="button" class="class-slot empty" data-cl-card="' + card.id + '" data-cl-group="' + group + '" data-cl-idx="new"' +
        ' title="添加职业卡组" aria-label="添加职业卡组">+</button>';
    }
    return html;
  }

  function classRowHtml(card, effLinks) {
    const a = classGroupHtml(card, 'a', effLinks);
    const b = classGroupHtml(card, 'b', effLinks);
    if (!a && !b) return '';
    let html = a;
    if (a && b) html += '<span class="vs-sep">对</span>';
    html += b;
    return '<div class="deck-class-row">' + html + '</div>';
  }

  function cardHtml(match, card, effLinksMap) {
    const played = match.played;
    const ready = Boolean(match.a && match.b);
    const current = (currentRecord().scores || {})[match.id];
    const cycle = Boolean(match.cycle);
    const live = !played && ready && !match.invalid && !cycle && currentRecord().status === 'ongoing';
    const stateText = match.invalid ? '无效' : match.draw ? '平局' : cycle ? '连线成环' : live ? '进行中' : played ? '已结束' : ready ? '未开始' : '待定';
    const stateClass = match.invalid ? ' invalid' : match.draw ? ' draw' : cycle ? ' cycle' : live ? ' live' : played ? ' done' : '';

    const styleAttr = 'left:' + cardLeft(card) + 'px;top:' + cardTop(card) + 'px' +
      (card.color ? ';--card-tint:' + card.color : '');
    /* 填写比分按钮仅编辑模式渲染,图标化省空间;查看卡组按钮已删除 */
    const scoreBtn = editMode
      ? '<button type="button" class="btn btn-secondary btn-sm icon-btn score-open"' +
        (ready ? '' : ' disabled') + ' data-score-open="' + match.id + '"' +
        ' title="' + (current ? '比分 ' + formatScore(current.a) + ':' + formatScore(current.b) : '填写比分') + '"' +
        ' aria-label="填写比分">' +
        iconMarkup('edit', current ? '比分 ' + formatScore(current.a) + ':' + formatScore(current.b) : '填写比分') +
        '</button>'
      : '';
    return (
      '<article class="match-card canvas-card' + (played ? ' played' : '') + (cycle ? ' cycle' : '') + (live ? ' match-live' : '') + '"' +
      ' data-match="' + match.id + '"' + (card.color ? ' data-tint' : '') +
      ' style="' + styleAttr + '">' +
      '<header class="match-head">' +
      '<h2 class="match-title">' + escapeHtml(match.label || match.id) + '</h2>' +
      '<span class="match-format">' + escapeHtml(match.format || 'BO3') + '</span>' +
      '<span class="match-state' + stateClass + '">' + stateText + '</span>' +
      '</header>' +
      (match.phase ? '<div class="match-phase">' + escapeHtml(match.phase) + '</div>' : '') +
      playerRow(match, 0) +
      playerRow(match, 1) +
      '<div class="score-actions">' +
      scoreBtn +
      classRowHtml(card, effLinksMap && effLinksMap.get(card.id)) +
      '</div>' +
      '</article>'
    );
  }

  function renderEdges(canvas, resolvedById, container) {
    let svg = container.querySelector('.canvas-edges');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.classList.add('canvas-edges');
      container.insertBefore(svg, container.firstChild);
    }
    const paths = [];
    for (const card of canvas.cards || []) {
      for (let slotIndex = 0; slotIndex < (card.slots || []).length; slotIndex += 1) {
        const slot = card.slots[slotIndex];
        if (!slot || slot.type !== 'flow') continue;
        const source = resolvedById.get(slot.cardId);
        const target = resolvedById.get(card.id);
        if (!source || !target) continue;
        const x1 = cardLeft(source) + CARD_WIDTH;
        const y1 = cardTop(source) + (slot.outcome === 'winner' ? PORT_Y.winner : PORT_Y.loser);
        const x2 = cardLeft(target);
        const y2 = cardTop(target) + (slotIndex === 0 ? PORT_Y.winner : PORT_Y.loser);
        const mid = (x1 + x2) / 2;
        paths.push(
          '<path d="M ' + x1 + ' ' + y1 +
          ' C ' + mid + ' ' + y1 + ', ' + mid + ' ' + y2 + ', ' + x2 + ' ' + y2 +
          '" class="canvas-edge ' + (slot.outcome === 'loser' ? 'loser' : 'winner') + '"></path>'
        );
      }
    }
    svg.setAttribute('width', container.scrollWidth || 1000);
    svg.setAttribute('height', container.scrollHeight || 800);
    svg.innerHTML = paths.join('');
  }

  function renderCanvas() {
    const record = currentRecord();
    const board = document.getElementById('canvas-board');
    if (!board) return;
    if (record && record.canvas && CanvasModel.deriveRoster) {
      const known = new Set((window.TournamentApp.players || []).map((p) => p.id));
      record.roster = CanvasModel.deriveRoster(record.canvas).filter((id) => known.has(id));
    }
    const canvas = record.canvas || { cards: [] };
    const resolved = CanvasModel.resolveCanvas(canvas, record.roster || [], record.scores || {});
    const names = new Map((window.TournamentApp.players || []).map((p) => [p.id, p.name]));
    const effLinksMap = CanvasModel.resolveEffectiveClassLinks(canvas, record.scores || {});
    const cardsHtml = resolved.cards.map((match) => cardHtml(match, canvas.cards.find((c) => c.id === match.id) || match, effLinksMap)).join('');
    /* 无限画布:board 尺寸纯由卡片范围决定,无边界框;无卡时保留最小底 */
    const cardMaxX = Math.max(600, ...(canvas.cards || []).map((c) => (Number(c.x) || 0) * COL_GAP + CARD_WIDTH + 40));
    const cardMaxY = Math.max(400, ...(canvas.cards || []).map((c) => (Number(c.y) || 0) * ROW_GAP + CARD_HEIGHT + 40));
    board.style.width = cardMaxX + 'px';
    board.style.height = cardMaxY + 'px';
    /* 玻璃样式:写在内联变量上,卡片 CSS 消费 */
    const cardStyle = cardStyleOf(canvas);
    board.style.setProperty('--card-glass', cardStyle.opacity);
    board.style.setProperty('--card-blur', cardStyle.blur + 'px');
    /* editing class 由 CanvasEditor.enter/exit 维护(编辑器自身状态) */
    board.innerHTML = '';
    const resolvedById = new Map(resolved.cards.map((c) => [c.id, c]));
    renderEdges(canvas, resolvedById, board);
    const wrap = document.createElement('div');
    wrap.className = 'canvas-cards';
    wrap.innerHTML = cardsHtml;
    board.appendChild(wrap);
    CanvasEditor.syncZoom();
    if (editMode) {
      // 编辑模式额外显示端口（连线交互在 canvas-editor.js 中实现）
      board.querySelectorAll('.canvas-card').forEach((el) => {
        const cardId = el.dataset.match;
        el.insertAdjacentHTML('beforeend',
          '<div class="card-ports">' +
          '<span class="port port-input" data-port="input" data-card="' + cardId + '" data-slot="0" title="A 位输入"></span>' +
          '<span class="port port-input" data-port="input" data-card="' + cardId + '" data-slot="1" title="B 位输入"></span>' +
          '<span class="port port-output" data-port="output" data-card="' + cardId + '" data-outcome="winner" title="胜者输出"></span>' +
          '<span class="port port-output" data-port="output" data-card="' + cardId + '" data-outcome="loser" title="败者输出"></span>' +
          '</div>'
        );
      });
    }
  }

  /* ---------- 编辑工具栏 ---------- */

  function renderEditToolbar() {
    const btn = document.getElementById('header-edit-btn');
    if (btn) {
      btn.title = editMode ? '完成编辑' : '编辑';
      btn.classList.toggle('btn-primary', editMode);
      btn.classList.toggle('btn-secondary', !editMode);
    }
    if (!editMode) closeStyleDrawer();
    updateToolbarState();
  }

  /* ---------- 卡片样式抽屉(毛玻璃可调 + 染色) ---------- */

  const CARD_STYLE_DEFAULT = { opacity: 0.7, blur: 8 };

  /* 画布级玻璃样式;旧数据无 style 字段时回默认,读取侧与 normalize 同口径 */
  function cardStyleOf(canvas) {
    const s = (canvas && canvas.style) || {};
    const opacity = Number(s.opacity);
    const blur = Number(s.blur);
    return {
      opacity: Number.isFinite(opacity) ? Math.min(1, Math.max(0.3, opacity)) : CARD_STYLE_DEFAULT.opacity,
      blur: Number.isFinite(blur) ? Math.min(24, Math.max(0, blur)) : CARD_STYLE_DEFAULT.blur
    };
  }

  function fillCardStyleInputs() {
    const record = currentRecord();
    if (!record) return;
    const style = cardStyleOf(record.canvas);
    const opacityInput = document.getElementById('glass-opacity');
    const blurInput = document.getElementById('glass-blur');
    if (!opacityInput || !blurInput) return;
    opacityInput.value = style.opacity;
    blurInput.value = style.blur;
    document.getElementById('glass-opacity-val').textContent = Math.round(style.opacity * 100) + '%';
    document.getElementById('glass-blur-val').textContent = style.blur + 'px';
  }

  function toggleStyleDrawer() {
    const drawer = document.getElementById('card-style-drawer');
    if (!drawer) return;
    if (drawer.hidden) {
      fillCardStyleInputs();
      drawer.hidden = false;
    } else {
      closeStyleDrawer();
    }
  }

  function closeStyleDrawer() {
    const drawer = document.getElementById('card-style-drawer');
    if (drawer) drawer.hidden = true;
  }

  /* 滑杆实时改内联变量(不重绘画布),停手后防抖落盘 */
  let styleSaveTimer = null;
  function onStyleInput() {
    const record = currentRecord();
    const board = document.getElementById('canvas-board');
    if (!record || !board) return;
    const opacity = Number(document.getElementById('glass-opacity').value);
    const blur = Number(document.getElementById('glass-blur').value);
    document.getElementById('glass-opacity-val').textContent = Math.round(opacity * 100) + '%';
    document.getElementById('glass-blur-val').textContent = blur + 'px';
    if (!record.canvas) record.canvas = { cards: [], size: {} };
    record.canvas.style = { opacity, blur };
    board.style.setProperty('--card-glass', opacity);
    board.style.setProperty('--card-blur', blur + 'px');
    clearTimeout(styleSaveTimer);
    styleSaveTimer = setTimeout(() => { save(); }, 400);
  }

  /* 染色:input 拖动只做 DOM 实时预览(不重绘不落盘不提示),
   * change(松手/选定)才写数据并保存一次 */
  function tintSelection(color, commit) {
    const record = currentRecord();
    if (!record || !record.canvas) return;
    const ids = CanvasEditor.getSelectedIds();
    if (!ids.length) {
      if (commit) notify('先选中要染色的卡片(可框选或 Shift 多选)', 'danger');
      return;
    }
    const idSet = new Set(ids);
    const board = document.getElementById('canvas-board');
    for (const card of record.canvas.cards || []) {
      if (!idSet.has(card.id)) continue;
      card.color = commit ? color : (color || card.color);
      if (!commit && !color) continue;
      const el = board && board.querySelector('.canvas-card[data-match="' + card.id + '"]');
      if (el) {
        if (color) {
          el.setAttribute('data-tint', '');
          el.style.setProperty('--card-tint', color);
        } else {
          el.removeAttribute('data-tint');
          el.style.removeProperty('--card-tint');
        }
      }
    }
    if (commit) {
      save();
      notify(color ? '已染色 ' + ids.length + ' 张卡片' : '已清除 ' + ids.length + ' 张卡片的染色');
    }
  }

  function bindCardStylePanel() {
    const opacityInput = document.getElementById('glass-opacity');
    const blurInput = document.getElementById('glass-blur');
    if (opacityInput) opacityInput.addEventListener('input', onStyleInput);
    if (blurInput) blurInput.addEventListener('input', onStyleInput);
    const tintInput = document.getElementById('card-tint-input');
    if (tintInput) {
      tintInput.addEventListener('input', () => tintSelection(tintInput.value, false));
      tintInput.addEventListener('change', () => tintSelection(tintInput.value, true));
    }
    const clearBtn = document.getElementById('card-tint-clear');
    if (clearBtn) clearBtn.addEventListener('click', () => tintSelection(null, true));
  }

  function updateToolbarState() {
    const toolbar = document.getElementById('edit-toolbar');
    if (!toolbar) return;
    const tool = CanvasEditor.getTool();
    const zoomMode = CanvasEditor.isZoomMode();
    toolbar.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
      const kind = btn.dataset.tool;
      btn.classList.toggle('is-active', kind === tool || (kind === 'zoom' && zoomMode));
    });
    const deleteBtn = document.getElementById('edit-delete-selected-btn');
    if (deleteBtn) {
      const count = CanvasEditor.getSelectedCount();
      /* 框选/多选后任何工具下都可删除选中,不再限定批量删除模式 */
      deleteBtn.hidden = count <= 0;
      const label = count > 0 ? '删除选中 ' + count + ' 张卡片' : '删除选中卡片';
      deleteBtn.title = label;
      deleteBtn.setAttribute('aria-label', label);
    }
    /* 染色目标计数与删除按钮同源 */
    const tintTarget = document.getElementById('tint-target');
    if (tintTarget) {
      const count = CanvasEditor.getSelectedCount();
      tintTarget.textContent = count > 0 ? count + ' 张' : '未选中';
    }
  }

  /* ---------- 比分弹窗 ---------- */

  function presetsForFormat(format) {
    const fmt = String(format || '').toUpperCase();
    if (fmt.includes('BO5') || fmt === '5') {
      return [[3, 0], [3, 1], [3, 2], [2, 3], [1, 3], [0, 3]];
    }
    if (fmt.includes('BO3') || fmt === '3') {
      return [[2, 0], [2, 1], [1, 2], [0, 2]];
    }
    return null;
  }

  function showScoreError(message) {
    const error = scoreDialog && scoreDialog.querySelector('#score-error');
    const a = scoreDialog && scoreDialog.querySelector('#score-a');
    const b = scoreDialog && scoreDialog.querySelector('#score-b');
    if (error) {
      error.hidden = !message;
      if (message) error.textContent = message;
    }
    if (a) a.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (b) b.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function validateScoreInput(raw) {
    if (String(raw).trim() === '') return { ok: false, message: '请输入双方比分' };
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, message: '请输入有效数字' };
    if (!Number.isInteger(n)) return { ok: false, message: '比分必须是整数' };
    if (n < -1 || n > 9) return { ok: false, message: '比分范围为 -1（弃权）到 9' };
    return { ok: true, value: n };
  }

  function saveScoreFromDialog() {
    if (!currentScoreCardId || !scoreDialog) return;
    const a = validateScoreInput(scoreDialog.querySelector('#score-a').value);
    const b = validateScoreInput(scoreDialog.querySelector('#score-b').value);
    const bad = !a.ok ? a : !b.ok ? b : null;
    if (bad) {
      showScoreError(bad.message);
      const input = !a.ok ? scoreDialog.querySelector('#score-a') : scoreDialog.querySelector('#score-b');
      if (input) input.focus();
      return;
    }
    showScoreError('');
    currentRecord().scores[currentScoreCardId] = { a: a.value, b: b.value };
    save().then(() => {
      scoreDialog.close();
      renderAll();
    });
  }

  function syncScorePresetActive() {
    const a = scoreDialog && scoreDialog.querySelector('#score-a');
    const b = scoreDialog && scoreDialog.querySelector('#score-b');
    const box = scoreDialog && scoreDialog.querySelector('#score-presets');
    if (!a || !b || !box) return;
    const key = a.value + ':' + b.value;
    box.querySelectorAll('[data-score-preset]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.scorePreset === key);
    });
  }

  function renderScorePresets(match) {
    const box = scoreDialog && scoreDialog.querySelector('#score-presets');
    if (!box) return;
    const presets = match ? presetsForFormat(match.format) : null;
    box.hidden = !presets;
    if (!presets) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML = presets.map((pair) =>
      '<button type="button" class="score-btn" data-score-preset="' + pair.join(':') + '" aria-label="预设比分 ' + pair.join(' 比 ') + '">' +
      pair.join(':') + '</button>'
    ).join('');
    box.querySelectorAll('[data-score-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pair = btn.dataset.scorePreset.split(':').map(Number);
        scoreDialog.querySelector('#score-a').value = pair[0];
        scoreDialog.querySelector('#score-b').value = pair[1];
        showScoreError('');
        syncScorePresetActive();
      });
    });
  }

  function buildScoreDialog() {
    if (scoreDialog) return;
    scoreDialog = document.createElement('dialog');
    scoreDialog.id = 'score-dialog';
    scoreDialog.setAttribute('aria-labelledby', 'score-dialog-title');
    scoreDialog.innerHTML =
      '<div class="dialog-head">' +
      '  <h2 id="score-dialog-title">填写比分</h2>' +
      '  <button type="button" class="btn btn-ghost btn-sm" data-score-close>关闭</button>' +
      '</div>' +
      '<div class="dialog-body">' +
      '  <div class="score-form">' +
      '    <label><span class="score-player-label" id="score-label-a">A 选手</span> <input type="number" id="score-a" step="1" min="-1" max="9" inputmode="numeric"></label>' +
      '    <span class="score-colon">:</span>' +
      '    <label><span class="score-player-label" id="score-label-b">B 选手</span> <input type="number" id="score-b" step="1" min="-1" max="9" inputmode="numeric"></label>' +
      '  </div>' +
      '  <div class="score-presets" id="score-presets" role="group" aria-label="常用比分预设" hidden></div>' +
      '  <p class="form-error" id="score-error" role="alert" hidden></p>' +
      '  <p class="hint">预设按赛制自动生成；自定义输入保留 -1 弃权、相等为平局。</p>' +
      '  <div class="dialog-actions">' +
      '    <button type="button" class="btn btn-danger btn-sm" data-score-clear>清除比分</button>' +
      '    <button type="button" class="btn btn-secondary" data-score-close>取消</button>' +
      '    <button type="button" class="btn btn-primary" data-score-save>保存</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(scoreDialog);

    scoreDialog.querySelectorAll('[data-score-close]').forEach((btn) => {
      btn.addEventListener('click', () => scoreDialog.close());
    });
    scoreDialog.querySelector('[data-score-clear]').addEventListener('click', async () => {
      if (!currentScoreCardId) return;
      if (!(await uiConfirm('确定清除这场比分吗？'))) return;
      delete currentRecord().scores[currentScoreCardId];
      save().then(() => {
        scoreDialog.close();
        renderAll();
      });
    });
    scoreDialog.querySelector('[data-score-save]').addEventListener('click', saveScoreFromDialog);
    scoreDialog.querySelectorAll('#score-a, #score-b').forEach((input) => {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          saveScoreFromDialog();
        }
      });
    });
  }

  function openScoreDialog(cardId) {
    buildScoreDialog();
    const record = currentRecord();
    const resolved = CanvasModel.resolveCanvas      ? CanvasModel.resolveCanvas(record.canvas, record.roster || [], record.scores || {})
      : null;
    const match = resolved && resolved.cards.find((c) => c.id === cardId);
    const title = match ? (match.label || cardId) : cardId;
    scoreDialog.querySelector('#score-dialog-title').textContent = title + ' · 比分';
    const labelA = scoreDialog.querySelector('#score-label-a');
    const labelB = scoreDialog.querySelector('#score-label-b');
    if (labelA) labelA.textContent = match && match.a ? playerName(match.a) : 'A 选手';
    if (labelB) labelB.textContent = match && match.b ? playerName(match.b) : 'B 选手';
    const current = record.scores[cardId];
    scoreDialog.querySelector('#score-a').value = current ? current.a : '';
    scoreDialog.querySelector('#score-b').value = current ? current.b : '';
    showScoreError('');
    renderScorePresets(match);
    syncScorePresetActive();
    currentScoreCardId = cardId;
    scoreDialog.showModal();
  }

  function bindCanvas() {
    const board = document.getElementById('canvas-board');
    board.addEventListener('click', (event) => {
      const scoreBtn = event.target.closest('[data-score-open]');
      if (scoreBtn && !scoreBtn.disabled) {
        openScoreDialog(scoreBtn.dataset.scoreOpen);
        return;
      }
      const classSlot = event.target.closest('[data-cl-card]');
      if (classSlot) {
        if (editMode) {
          CanvasEditor.editCard(classSlot.dataset.clCard);
        } else {
          const url = classSlot.dataset.url || '';
          if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener');
        }
      }
    });
  }

  function openRoster() {
    toggleRosterDropdown();
  }

  function toggleRosterDropdown() {
    closeRulesDropdown();
    if (rosterDropdown && rosterDropdown.parentNode) {
      closeRosterDropdown();
      return;
    }
    const app = window.TournamentApp;
    const record = app && app.current;
    if (!record) return;
    const players = (record.roster || [])
      .map((id) => (app.players || []).find((p) => p.id === id))
      .filter(Boolean);
    rosterDropdown = document.createElement('div');
    rosterDropdown.className = 'roster-dropdown';
    rosterDropdown.innerHTML =
      '<div class="roster-dropdown-head">选手名单</div>' +
      '<div class="roster-dropdown-list">' +
      players.map((p) =>
        '<div class="roster-dropdown-item">' +
        avatarMarkup(p, 'avatar-sm') +
        '<span>' + escapeHtml(p.name) + '</span>' +
        '</div>'
      ).join('') +
      '</div>';
    document.body.appendChild(rosterDropdown);
    const header = document.getElementById('app-header');
    const rect = header ? header.getBoundingClientRect() : { bottom: 0, right: 0 };
    rosterDropdown.style.top = (rect.bottom + 6) + 'px';
    rosterDropdown.style.right = '1rem';
    document.addEventListener('click', closeRosterDropdownOutside);
  }

  function closeRosterDropdown() {
    if (rosterDropdown && rosterDropdown.parentNode) rosterDropdown.remove();
    rosterDropdown = null;
    document.removeEventListener('click', closeRosterDropdownOutside);
  }

  function closeRosterDropdownOutside(event) {
    if (!rosterDropdown) return;
    const target = event.target;
    if (!target || !target.closest) return;
    if (!rosterDropdown.contains(target) && !target.closest('#header-roster-btn')) {
      closeRosterDropdown();
    }
  }

  /* ---------- 赛制规则下拉 ---------- */

  function openRules() {
    toggleRulesDropdown();
  }

  function toggleRulesDropdown() {
    if (rulesDropdown && rulesDropdown.parentNode) {
      closeRulesDropdown();
      return;
    }
    const app = window.TournamentApp;
    const record = app && app.current;
    if (!record) return;
    closeRosterDropdown();
    rulesDropdown = document.createElement('div');
    rulesDropdown.className = 'rules-dropdown';
    rulesDropdown.innerHTML =
      '<div class="rules-dropdown-head">赛制规则</div>' +
      '<div class="rules-dropdown-body"></div>';
    rulesDropdown.querySelector('.rules-dropdown-body').textContent = record.rules || '暂无赛制规则';
    document.body.appendChild(rulesDropdown);
    const header = document.getElementById('app-header');
    const rect = header ? header.getBoundingClientRect() : { bottom: 0, right: 0 };
    rulesDropdown.style.top = (rect.bottom + 6) + 'px';
    rulesDropdown.style.right = '1rem';
    document.addEventListener('click', closeRulesDropdownOutside);
  }

  function closeRulesDropdown() {
    if (rulesDropdown && rulesDropdown.parentNode) rulesDropdown.remove();
    rulesDropdown = null;
    document.removeEventListener('click', closeRulesDropdownOutside);
  }

  function closeRulesDropdownOutside(event) {
    if (!rulesDropdown) return;
    const target = event.target;
    if (!target || !target.closest) return;
    if (!rulesDropdown.contains(target) && !target.closest('#header-rules-btn')) {
      closeRulesDropdown();
    }
  }

  function bindEditToolbar() {
    const toolbar = document.getElementById('edit-toolbar');
    if (!toolbar) return;

    toolbar.addEventListener('click', (event) => {
      const btn = event.target.closest('.tool-btn');
      if (!btn) return;
      const kind = btn.dataset.tool;
      if (!kind) {
        if (btn.id === 'edit-delete-selected-btn') {
          CanvasEditor.deleteSelected();
        }
        return;
      }
      if (!canEdit()) return;
      const editor = CanvasEditor;
      if (!editor) return;
      if (kind === 'select') editor.setTool('select');
      else if (kind === 'link') editor.setTool('link');
      else if (kind === 'add') {
        const cards = (currentRecord().canvas && currentRecord().canvas.cards) || [];
        let x = 2;
        let y = 2;
        while (cards.some((c) => (Number(c.x) || 0) === x && (Number(c.y) || 0) === y)) {
          x += 2;
          if (x > 14) { x = 0; y += 2; }
        }
        editor.addCard(x, y);
      } else if (kind === 'zoom') editor.toggleZoomMode();
      else if (kind === 'zoom-in') editor.zoomIn();
      else if (kind === 'zoom-out') editor.zoomOut();
      else if (kind === 'fit') editor.fitCanvas();
      else if (kind === 'style') toggleStyleDrawer();
      else if (kind === 'delete') editor.setTool('delete');
      else if (kind === 'save') {
        save().then(() => notify('已保存'));
      }
      updateToolbarState();
    });
  }

  /* ---------- 查看态自适应与常驻缩放控件 ---------- */

  let userZoomed = false;

  /* 查看态且用户未手动缩放时贴合视口，让双败图首屏可见（总决赛不再在视口外） */
  function autoFitCanvas() {
    if (editMode || userZoomed) return;
    CanvasEditor.fitCanvas();
  }

  function bindZoomDock() {
    const editor = CanvasEditor;
    bindZoomDockControls({
      onZoomIn: () => { userZoomed = true; editor.zoomIn(); },
      onZoomOut: () => { userZoomed = true; editor.zoomOut(); },
      onReset: () => { userZoomed = true; editor.setZoom(1); },
      onFit: () => { userZoomed = false; editor.fitCanvas(); }
    });
    bindZoomFitOnResize(() => !editMode && !userZoomed, () => editor.fitCanvas());
  }

  window.BracketActions = {
    requestEdit,
    openRoster,
    openRules
  };

  document.addEventListener('ts:ready', () => {
    /* 依赖单向化:把重绘/工具栏刷新注入编辑器,编辑器经回调请求重绘 */
    CanvasEditor.connect({ renderCanvas, updateToolbar: updateToolbarState });
    renderAll();
    autoFitCanvas();
    syncEditUI();
    hideEditLock();
    bindCanvasLock();
    bindEditToolbar();
    bindCardStylePanel();
    bindMatchSearch();
    bindZoomDock();
  });
  document.addEventListener('ts:changed', () => {
    renderAll();
    autoFitCanvas();
    syncEditUI();
  });
  bindCanvas();
  window.TournamentAppInit('schedule').catch((error) => {
    if (window.TournamentApp) window.TournamentApp.fatalError(error);
  });
})();
