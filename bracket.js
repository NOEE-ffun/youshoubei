(function () {
  'use strict';

  /* 画布/列表双视图:窄屏默认列表(双败画布自适应到 ~28% 后文字不可读,
   * 手机用户要的是"下一场打谁"),桌面默认画布;顶栏按钮可切,选择记入会话。
   * 判定用 CSS 同一断点 48rem;data-view 写在 body,defer 阶段同步执行无首帧闪烁 */
  const VIEW_KEY = 'ts:preferCanvas';

  function initialView() {
    try {
      const prefer = sessionStorage.getItem(VIEW_KEY);
      if (prefer === '1') return 'canvas';
      if (prefer === '0') return 'list';
      return window.matchMedia('(max-width: 48rem)').matches ? 'list' : 'canvas';
    } catch (error) { return 'canvas'; }
  }

  function currentView() {
    return document.body.dataset.view === 'list' ? 'list' : 'canvas';
  }

  function syncViewToggle() {
    const btn = document.getElementById('view-toggle');
    if (!btn) return;
    const toList = currentView() === 'canvas';
    const label = toList ? '切换到列表视图' : '切换到画布视图';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', String(!toList));
  }

  function setView(view, remember) {
    document.body.dataset.view = view;
    if (remember) {
      try { sessionStorage.setItem(VIEW_KEY, view === 'canvas' ? '1' : '0'); } catch (error) { /* 忽略 */ }
    }
    syncViewToggle();
  }

  function bindViewToggle() {
    const btn = document.getElementById('view-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => setView(currentView() === 'canvas' ? 'list' : 'canvas', true));
    syncViewToggle();
  }

  setView(initialView(), false);

  /* 共享工具统一来自 common.js;画布几何来自 canvas-model.js(唯一真源) */
  const {
    escapeHtml, canEdit, save, avatarMarkup, notify, uiConfirm, iconMarkup,
    formatStartTime, bindZoomDock: bindZoomDockControls, bindZoomFitOnResize
  } = window.TournamentUtils;
  const {
    DOT, CARD_WIDTH, CARD_HEIGHT, PORT_NORMALS, portOffset, pickPort, edgePath, arrowDefs,
    DEFAULT_CANVAS_COLS, DEFAULT_CANVAS_ROWS
  } = window.CanvasModel;

  let editMode = false;
  let scoreDialog = null;
  let currentScoreCardId = null;

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

  /* ---------- 查看 / 编辑模式 ---------- */

  function enterEditMode() {
    if (editMode) return;
    setView('canvas', false); /* 编辑只在画布上进行 */
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
      /* 登录墙下人人有会话:非管理员即账号角色不足,提示后不进入编辑 */
      notify('编辑需要管理员账号', 'danger');
      return;
    }
    if (editMode) exitEditMode();
    else enterEditMode();
  }

  function syncEditUI() {
    if (editMode && !canEdit()) {
      editMode = false;
      CanvasEditor.exit();
    }
    const layout = document.getElementById('canvas-layout');
    const toolbar = document.getElementById('edit-toolbar');
    if (layout) layout.classList.toggle('has-toolbar', editMode);
    if (toolbar) toolbar.hidden = !editMode;
    renderEditToolbar();
  }

  function renderAll() {
    const app = window.TournamentApp;
    if (!app || !app.current) return;
    for (const d of topDropdowns) d.close();
    const record = app.current;
    if (!record.scores) record.scores = {};
    if (!record.canvas) record.canvas = { cards: [] };
    if (record.canvas) {
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
    const standings = CanvasModel.deriveStandings(record);
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
    return (Number(card.x) || 0) * DOT;
  }

  function cardTop(card) {
    return (Number(card.y) || 0) * DOT;
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

  /* 卡组公示锁:开关开启 + 该卡未打 + 该侧选手已定 + 观看者非该侧选手/非管理员。
   * 数据侧服务端已剥离 own 条目,这里补占位避免"看起来没交卡"。
   * 窗口判定与 api/decks.js 共用 canvas-model.js isWindowOpen */
  function sideDeckHidden(match, side) {
    if (editMode) return false;
    if (!CanvasModel.isWindowOpen(currentRecord())) return false;
    if (match.played || !match[side]) return false;
    const app = window.TournamentApp;
    if (app && app.isAdmin && app.isAdmin()) return false;
    const s = app && app.getSession ? app.getSession() : null;
    const viewerId = (s && s.player && s.player.id) || null;
    return match[side] !== viewerId;
  }

  const DECK_LOCK_HTML = '<span class="cl-locked" title="卡组提交中,公示后可见" aria-label="卡组待公示">🔒</span>';

  function classRowHtml(card, match, effLinks) {
    const lockA = match ? sideDeckHidden(match, 'a') : false;
    const lockB = match ? sideDeckHidden(match, 'b') : false;
    const a = lockA ? DECK_LOCK_HTML : classGroupHtml(card, 'a', effLinks);
    const b = lockB ? DECK_LOCK_HTML : classGroupHtml(card, 'b', effLinks);
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
      classRowHtml(card, match, effLinksMap && effLinksMap.get(card.id)) +
      '</div>' +
      '</article>'
    );
  }

  /* 连线箭头 marker(与编辑器临时线共用同一模板,canvas-model.js 唯一真源) */
  const EDGE_ARROW_DEFS = arrowDefs('edge');

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
        /* 端点按两卡方位自动选连接点:胜者线从源卡上排出,A 位入上排;败者/B 位走下排 */
        const band = slot.outcome === 'winner' ? 'upper' : 'lower';
        const srcPort = pickPort(source, target, band);
        const dstPort = pickPort(target, source, slotIndex === 0 ? 'upper' : 'lower');
        const o1 = portOffset(srcPort);
        const o2 = portOffset(dstPort);
        const p1 = { x: cardLeft(source) + o1.x, y: cardTop(source) + o1.y };
        const p2 = { x: cardLeft(target) + o2.x, y: cardTop(target) + o2.y };
        const cls = slot.outcome === 'loser' ? 'loser' : 'winner';
        paths.push(
          '<path d="' + edgePath(p1, PORT_NORMALS[srcPort], p2, PORT_NORMALS[dstPort]) +
          '" class="canvas-edge ' + cls + '" marker-end="url(#edge-arrow-' + cls + ')"></path>'
        );
      }
    }
    svg.setAttribute('width', container.scrollWidth || 1000);
    svg.setAttribute('height', container.scrollHeight || 800);
    svg.innerHTML = EDGE_ARROW_DEFS + paths.join('');
  }

  function renderCanvas() {
    const record = currentRecord();
    const board = document.getElementById('canvas-board');
    if (!board) return;
    if (record && record.canvas) {
      const known = new Set((window.TournamentApp.players || []).map((p) => p.id));
      record.roster = CanvasModel.deriveRoster(record.canvas).filter((id) => known.has(id));
    }
    const canvas = record.canvas || { cards: [] };
    const resolved = CanvasModel.resolveCanvas(canvas, record.roster || [], record.scores || {});
    const names = new Map((window.TournamentApp.players || []).map((p) => [p.id, p.name]));
    const effLinksMap = CanvasModel.resolveEffectiveClassLinks(canvas, record.scores || {});
    const cardsHtml = resolved.cards.map((match) => cardHtml(match, canvas.cards.find((c) => c.id === match.id) || match, effLinksMap)).join('');
    /* 无限画布:board 尺寸纯由卡片范围决定,无边界框;无卡时保留最小底 */
    const cardMaxX = Math.max(600, ...(canvas.cards || []).map((c) => (Number(c.x) || 0) * DOT + CARD_WIDTH + 40));
    const cardMaxY = Math.max(400, ...(canvas.cards || []).map((c) => (Number(c.y) || 0) * DOT + CARD_HEIGHT + 40));
    board.style.width = cardMaxX + 'px';
    board.style.height = cardMaxY + 'px';
    /* 玻璃样式:写在内联变量上,卡片 CSS 消费;点阵层在 scroll 上由相机同步 */
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
      // 编辑模式额外显示六连接点(连线交互在 canvas-editor.js 中实现):
      // 上排三点 = 胜者输出 / A 位输入,下排三点 = 败者输出 / B 位输入
      board.querySelectorAll('.canvas-card').forEach((el) => {
        const cardId = el.dataset.match;
        const ports = [
          ['top', 'upper', '上连接点:拖出胜者 / 拖入 A 位'],
          ['leftTop', 'upper', '左上连接点:拖出胜者 / 拖入 A 位'],
          ['rightTop', 'upper', '右上连接点:拖出胜者 / 拖入 A 位'],
          ['bottom', 'lower', '下连接点:拖出败者 / 拖入 B 位'],
          ['leftBottom', 'lower', '左下连接点:拖出败者 / 拖入 B 位'],
          ['rightBottom', 'lower', '右下连接点:拖出败者 / 拖入 B 位']
        ];
        el.insertAdjacentHTML('beforeend',
          '<div class="card-ports">' +
          ports.map((p) =>
            '<span class="port port-node" data-port="' + p[0] + '" data-card="' + cardId + '" data-band="' + p[1] + '" title="' + p[2] + '"></span>'
          ).join('') +
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
    /* 撤销/重做随历史栈启用;保存钮未保存时亮圆点 */
    const undoBtn = toolbar.querySelector('[data-tool="undo"]');
    if (undoBtn) undoBtn.disabled = !CanvasEditor.canUndo();
    const redoBtn = toolbar.querySelector('[data-tool="redo"]');
    if (redoBtn) redoBtn.disabled = !CanvasEditor.canRedo();
    const saveBtn = toolbar.querySelector('[data-tool="save"]');
    if (saveBtn) {
      const unsaved = CanvasEditor.isDirty();
      saveBtn.classList.toggle('has-unsaved', !!unsaved);
      saveBtn.title = unsaved ? '保存(有未保存更改)' : '保存';
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

  async function saveScoreFromDialog() {
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
    /* 修改已有比分会连锁重算下游对阵,确认防误触 */
    const existing = currentRecord().scores[currentScoreCardId];
    if (existing && (existing.a !== a.value || existing.b !== b.value)) {
      if (!(await uiConfirm('修改已有比分会连锁重算后续对阵，确定保存吗？'))) return;
    }
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
    const resolved = CanvasModel.resolveCanvas(record.canvas, record.roster || [], record.scores || {});
    const match = resolved.cards.find((c) => c.id === cardId);
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

  /* ---------- 顶栏下拉(选手名单/赛制规则共用一个实现) ----------
   * fill 返回下拉 innerHTML;返回 null(无数据)不展开。
   * 互斥:开一个自动关另一个;点外部/再点按钮关闭。
   * close(byUser):byUser=用户主动关(按钮/点外部/切别的下拉),
   * 触发可选的 onCloseByUser 回调;渲染导致的批量关闭不传,不算用户意愿 */
  const topDropdowns = [];

  function createTopDropdown(btnId, className, fill, onCloseByUser) {
    let el = null;
    function close(byUser) {
      if (el) el.remove();
      el = null;
      document.removeEventListener('click', onOutside);
      if (byUser && typeof onCloseByUser === 'function') onCloseByUser();
    }
    function onOutside(event) {
      const target = event.target;
      if (!target || !target.closest || !el) return;
      if (!el.contains(target) && !target.closest('#' + btnId)) close(true);
    }
    function toggle() {
      if (el) {
        close(true);
        return;
      }
      const html = fill();
      if (!html) return;
      for (const other of topDropdowns) other.close(true);
      el = document.createElement('div');
      el.className = className;
      el.innerHTML = html;
      document.body.appendChild(el);
      const header = document.getElementById('app-header');
      const rect = header ? header.getBoundingClientRect() : { bottom: 0, right: 0 };
      el.style.top = (rect.bottom + 6) + 'px';
      el.style.right = '1rem';
      document.addEventListener('click', onOutside);
    }
    const api = { toggle, close, open: () => { if (!el) toggle(); }, isOpen: () => Boolean(el) };
    topDropdowns.push(api);
    return api;
  }

  const rosterDropdown = createTopDropdown('header-roster-btn', 'roster-dropdown', () => {
    const app = window.TournamentApp;
    const record = app && app.current;
    if (!record) return null;
    /* 名单 = 报名池(按先后编号排前)∪ 画布派生 roster;
     * 编号即报名顺序,超出取前 N 的是候补(弱化);"已报名"标记只在开放期间显示 */
    const onCanvas = new Set(record.roster || []);
    const signup = record.signup || {};
    const pool = Array.isArray(signup.players) ? signup.players : [];
    const takeN = Number(signup.slots) > 0 ? Number(signup.slots) : 0;
    const byId = new Map((app.players || []).map((p) => [p.id, p]));
    const rows = [];
    const shown = new Set();
    pool.forEach((id, i) => {
      const p = byId.get(id);
      if (!p || shown.has(id)) return;
      shown.add(id);
      rows.push(
        '<div class="roster-dropdown-item">' +
        '<em class="roster-sign-num' + (takeN > 0 && i >= takeN ? ' reserve' : '') + '">' + (i + 1) + '</em>' +
        avatarMarkup(p, 'avatar-sm') +
        '<span>' + escapeHtml(p.name) + '</span>' +
        (signup.open && !onCanvas.has(id) ? '<em class="roster-signed-only">已报名</em>' : '') +
        '</div>'
      );
    });
    for (const id of record.roster || []) {
      if (shown.has(id)) continue;
      const p = byId.get(id);
      if (!p) continue;
      shown.add(id);
      rows.push(
        '<div class="roster-dropdown-item">' +
        avatarMarkup(p, 'avatar-sm') +
        '<span>' + escapeHtml(p.name) + '</span>' +
        '</div>'
      );
    }
    return (
      '<div class="roster-dropdown-head">选手名单</div>' +
      '<div class="roster-dropdown-list">' +
      (rows.length ? rows.join('') : '<div class="roster-dropdown-item"><span class="hint">暂无选手</span></div>') +
      '</div>'
    );
  }, () => { if (rosterAutoState) rosterAutoState.manualClosed = true; });

  /* 报名开放期间,名单下拉默认弹开:进页/切届自动展开,
   * 重绘(renderAll 会批量关下拉)后自动恢复;用户主动关闭后不强开,切届重置 */
  let rosterAutoState = null;
  function maybeAutoOpenRoster() {
    const app = window.TournamentApp;
    const record = app && app.current;
    if (!record || !(record.signup && record.signup.open)) return;
    if (!rosterAutoState || rosterAutoState.id !== record.id) {
      rosterAutoState = { id: record.id, manualClosed: false };
    }
    if (rosterAutoState.manualClosed) return;
    rosterDropdown.open();
  }

  const rulesDropdown = createTopDropdown('header-rules-btn', 'rules-dropdown', () => {
    const record = window.TournamentApp && window.TournamentApp.current;
    if (!record) return null;
    return (
      '<div class="rules-dropdown-head">赛制规则</div>' +
      '<div class="rules-dropdown-body">' + escapeHtml(record.rules || '暂无赛制规则') + '</div>'
    );
  });

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
        /* 点阵制找空位:步进 = 卡宽 10 点 + 2 点缝,换行步进 = 卡高 6 点 + 2 点缝 */
        let x = 2;
        let y = 2;
        while (cards.some((c) => (Number(c.x) || 0) === x && (Number(c.y) || 0) === y)) {
          x += 12;
          if (x > 100) { x = 0; y += 8; }
        }
        editor.addCard(x, y);
      } else if (kind === 'undo') editor.undo();
      else if (kind === 'redo') editor.redo();
      else if (kind === 'zoom') editor.toggleZoomMode();
      else if (kind === 'zoom-in') editor.zoomIn();
      else if (kind === 'zoom-out') editor.zoomOut();
      else if (kind === 'fit') editor.fitCanvas();
      else if (kind === 'style') toggleStyleDrawer();
      else if (kind === 'delete') editor.setTool('delete');
      else if (kind === 'save') {
        editor.saveCanvas().then(() => notify('已保存'));
      }
      updateToolbarState();
    });
  }

  /* ---------- 查看态自适应与常驻缩放控件 ---------- */

  let userZoomed = false;

  /* 查看态且用户未手动缩放时贴合视口，让双败图首屏可见（总决赛不再在视口外）;
   * 有记忆的缩放级别则按记忆恢复(刷新/换机不再归零),并视为用户已接管。
   * force(数据变更:切届/刷新)时即使已接管也重新按记忆级别居中——
   * 否则相机永远停在旧内容的平移位置,新内容可能在视口外 */
  function autoFitCanvas(force) {
    if (editMode) return;
    if (!force && userZoomed) return;
    if (CanvasEditor.restoreSavedZoom()) {
      userZoomed = true;
      return;
    }
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
    openRoster: () => rosterDropdown.toggle(),
    openRules: () => rulesDropdown.toggle()
  };

  document.addEventListener('ts:ready', () => {
    /* 依赖单向化:把重绘/工具栏刷新注入编辑器,编辑器经回调请求重绘 */
    CanvasEditor.connect({ renderCanvas, updateToolbar: updateToolbarState });
    renderAll();
    autoFitCanvas();
    maybeAutoOpenRoster();
    syncEditUI();
    bindEditToolbar();
    bindCardStylePanel();
    bindMatchSearch();
    bindZoomDock();
    bindViewToggle();
  });
  document.addEventListener('ts:changed', () => {
    renderAll();
    autoFitCanvas(true); /* 数据变更(切届/刷新):按记忆级别重新居中 */
    maybeAutoOpenRoster();
    syncEditUI();
  });
  /* 会话身份就绪(晚于首渲)后重绘:公示锁/图标按"本人视角"重新判定 */
  document.addEventListener('ts:session', () => {
    renderAll();
    maybeAutoOpenRoster(); /* 会话重绘会关下拉,开放报名的名单须恢复 */
    syncEditUI();
  });
  bindCanvas();
  window.TournamentAppInit('schedule').catch((error) => {
    if (window.TournamentApp) window.TournamentApp.fatalError(error);
  });
})();
