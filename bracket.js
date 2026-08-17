(function () {
  'use strict';

  /* 共享工具统一来自 common.js */
  const { escapeHtml, debounce, canEdit, save, medalMap, avatarMarkup, notify, uiConfirm } =
    window.TournamentUtils;

  const CARD_WIDTH = 280;
  const CARD_HEIGHT = 176;
  const COL_GAP = 320;
  const ROW_GAP = 210;

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

  async function savePlayers() {
    try {
      await window.TournamentApp.storagePutPlayers(window.TournamentApp.players);
    } catch (error) {
      notify(window.TournamentUtils.errMsg(error), 'danger');
    }
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
    if (window.CanvasEditor && window.CanvasEditor.enter) window.CanvasEditor.enter();
    syncEditUI();
  }

  function exitEditMode() {
    if (!editMode) return;
    editMode = false;
    if (window.CanvasEditor && window.CanvasEditor.exit) window.CanvasEditor.exit();
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

  function toggleEdit() {
    requestEdit();
  }

  function syncEditUI() {
    if (editMode && !canEdit()) {
      editMode = false;
      if (window.CanvasEditor && window.CanvasEditor.exit) window.CanvasEditor.exit();
      hideEditLock();
    } else if (canEdit()) {
      hideEditLock();
    }
    const layout = document.getElementById('canvas-layout');
    const toolbar = document.getElementById('edit-toolbar');
    if (layout) layout.classList.toggle('has-toolbar', editMode);
    if (toolbar) toolbar.hidden = !editMode;
    const hint = document.getElementById('canvas-hint');
    if (hint) hint.textContent = editMode ? '编辑模式' : '查看模式 · Ctrl/⌘+滚轮缩放';
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
    if (typeof CanvasModel !== 'undefined' && CanvasModel.ensureCanvasDecks) {
      CanvasModel.ensureCanvasDecks(record);
    }
    if (!record.scores) record.scores = {};
    if (!record.canvas) record.canvas = { cards: [] };
    if (typeof CanvasModel !== 'undefined' && CanvasModel.deriveRoster && record.canvas) {
      const known = new Set((window.TournamentApp.players || []).map((p) => p.id));
      record.roster = CanvasModel.deriveRoster(record.canvas).filter((id) => known.has(id));
    }
    renderChampion();
    renderCanvas();
    renderEditToolbar();
  }

  /* ---------- 侧边栏 ---------- */

  function renderSidebar() {
    const app = window.TournamentApp;
    const record = app.current;
    const sidebar = document.getElementById('rules-sidebar');
    const wrap = document.getElementById('page-wrap');
    const toggle = document.getElementById('rules-toggle');
    const showBtn = document.getElementById('show-rules-btn');
    const hidden = app.sidebarHidden();

    document.getElementById('rules-text').textContent = record.rules || '';
    sidebar.hidden = hidden;
    wrap.classList.toggle('sidebar-hidden', hidden);
    toggle.textContent = hidden ? '展开' : '收起';
    toggle.setAttribute('aria-expanded', String(!hidden));
    showBtn.hidden = !hidden;
  }

  function bindSidebar() {
    document.getElementById('rules-toggle').addEventListener('click', () => {
      window.TournamentApp.setSidebarHidden(!window.TournamentApp.sidebarHidden());
      renderSidebar();
    });
    document.getElementById('show-rules-btn').addEventListener('click', () => {
      window.TournamentApp.setSidebarHidden(false);
      renderSidebar();
    });
    document.getElementById('rules-edit').addEventListener('click', () => {
      window.TournamentApp.openSettings(true);
    });
  }

  /* ---------- 冠军横幅 ---------- */

  function renderChampion() {
    const app = window.TournamentApp;
    const record = app.current;
    const names = new Map((app.players || []).map((p) => [p.id, p.name]));
    const standings = (typeof CanvasModel !== 'undefined' && CanvasModel.deriveStandings)
      ? CanvasModel.deriveStandings(record)
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

  /* ---------- 参赛名单（来自全局选手库，roster 决定出场） ---------- */

  function renderRoster() {
    const app = window.TournamentApp;
    const record = app.current;
    const grid = document.getElementById('roster-grid');
    const editable = canEdit();
    const medalOf = medalMap(record);
    const players = (record.roster || [])
      .map((id) => playerById(id))
      .filter(Boolean);

    grid.innerHTML = players.map((player, index) => {
      const medal = medalOf.get(player.id);
      return (
        '<div class="roster-item' + (medal ? ' medal-' + medal.type : '') + '">' +
        '<span class="roster-index">' + (index + 1) + '</span>' +
        (medal ? '<span class="medal-badge">' + medal.emoji + '</span>' : '') +
        '<div class="roster-avatar" data-avatar="' + player.id + '">' +
        avatarMarkup(player, 'avatar-lg') +
        (editable ? avatarActions(player) : '') +
        '</div>' +
        '<label class="visually-hidden" for="roster-name-' + player.id + '">选手 ' + (index + 1) + ' 姓名</label>' +
        '<input id="roster-name-' + player.id + '" value="' + escapeHtml(player.name) + '" autocomplete="off"' +
        (editable ? '' : ' disabled') + '>' +
        '</div>'
      );
    }).join('');

    grid.querySelectorAll('.roster-item input').forEach((input) => {
      const player = playerById(input.id.replace('roster-name-', ''));
      if (!player) return;
      const commit = () => {
        const next = input.value.trim();
        if (next) player.name = next;
        else input.value = player.name;
        player.updatedAt = Date.now();
        savePlayers();
      };
      input.addEventListener('input', debounce(commit, 500));
    });
    bindRosterAvatars();
  }

  function avatarActions(player) {
    const has = Boolean(player.avatar);
    return (
      '<span class="avatar-actions">' +
      '<button type="button" class="avatar-action" data-avatar-upload="' + player.id + '">' +
      (has ? '更换' : '上传') + '</button>' +
      (has
        ? '<button type="button" class="avatar-action danger" data-avatar-delete="' + player.id + '">删除</button>'
        : '') +
      '</span>'
    );
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

  function playerRow(match, side, card) {
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

  function cardHtml(match, card) {
    const played = match.played;
    const ready = Boolean(match.a && match.b);
    const editable = canEdit();
    const current = (currentRecord().scores || {})[match.id];
    const stateText = match.invalid ? '无效' : match.draw ? '平局' : match.played ? '已结束' : ready ? '未开始' : '待定';
    const stateClass = match.invalid ? ' invalid' : match.draw ? ' draw' : match.played ? ' done' : '';

    return (
      '<article class="match-card canvas-card' + (played ? ' played' : '') + (match.cycle ? ' cycle' : '') + '"' +
      ' data-match="' + match.id + '" style="left:' + cardLeft(card) + 'px;top:' + cardTop(card) + 'px">' +
      '<header class="match-head">' +
      '<h3 class="match-title">' + escapeHtml(match.label || match.id) + '</h3>' +
      '<span class="match-format">' + escapeHtml(match.format || 'BO3') + '</span>' +
      '<span class="match-state' + stateClass + '">' + stateText + '</span>' +
      '</header>' +
      (match.phase ? '<div class="match-phase">' + escapeHtml(match.phase) + '</div>' : '') +
      playerRow(match, 0, card) +
      playerRow(match, 1, card) +
      '<div class="score-actions">' +
      '<button type="button" class="btn btn-secondary btn-sm score-open"' +
      (editable && ready ? '' : ' disabled') + ' data-score-open="' + match.id + '">' +
      (current ? '比分 ' + formatScore(current.a) + ':' + formatScore(current.b) : '填写比分') +
      '</button>' +
      '<button type="button" class="btn btn-secondary btn-sm" data-view-decks="' + match.id + '">查看卡组</button>' +
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
        const y1 = cardTop(source) + (slot.outcome === 'winner' ? 70 : 108);
        const x2 = cardLeft(target);
        const y2 = cardTop(target) + (slotIndex === 0 ? 70 : 108);
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
    if (record && record.canvas && typeof CanvasModel !== 'undefined' && CanvasModel.deriveRoster) {
      const known = new Set((window.TournamentApp.players || []).map((p) => p.id));
      record.roster = CanvasModel.deriveRoster(record.canvas).filter((id) => known.has(id));
    }
    const canvas = record.canvas || { cards: [] };
    const resolved = (typeof CanvasModel !== 'undefined' && CanvasModel.resolveCanvas)
      ? CanvasModel.resolveCanvas(canvas, record.roster || [], record.scores || {})
      : { cards: (canvas.cards || []).map((c) => ({ ...c, a: null, b: null, played: false })) };
    const names = new Map((window.TournamentApp.players || []).map((p) => [p.id, p.name]));
    const cardsHtml = resolved.cards.map((match) => cardHtml(match, canvas.cards.find((c) => c.id === match.id) || match)).join('');
    const size = (typeof CanvasModel !== 'undefined' && CanvasModel.getCanvasSize)
      ? CanvasModel.getCanvasSize(canvas)
      : { cols: 40, rows: 24 };
    const cardMaxX = Math.max(0, ...(canvas.cards || []).map((c) => (Number(c.x) || 0) * COL_GAP + CARD_WIDTH + 40));
    const cardMaxY = Math.max(0, ...(canvas.cards || []).map((c) => (Number(c.y) || 0) * ROW_GAP + CARD_HEIGHT + 40));
    const maxX = Math.max(cardMaxX, size.cols * COL_GAP + 80);
    const maxY = Math.max(cardMaxY, size.rows * ROW_GAP + 80);
    board.style.width = maxX + 'px';
    board.style.height = maxY + 'px';
    board.classList.toggle('editing', editMode);
    board.innerHTML = '';
    const boundary = document.createElement('div');
    boundary.className = 'canvas-boundary';
    boundary.style.width = (size.cols * COL_GAP) + 'px';
    boundary.style.height = (size.rows * ROW_GAP) + 'px';
    board.appendChild(boundary);
    const resolvedById = new Map(resolved.cards.map((c) => [c.id, c]));
    renderEdges(canvas, resolvedById, board);
    const wrap = document.createElement('div');
    wrap.className = 'canvas-cards';
    wrap.innerHTML = cardsHtml;
    board.appendChild(wrap);
    if (window.CanvasEditor && window.CanvasEditor.syncZoom) window.CanvasEditor.syncZoom();
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
    updateToolbarState();
  }

  function updateToolbarState() {
    if (!window.CanvasEditor) return;
    const toolbar = document.getElementById('edit-toolbar');
    if (!toolbar) return;
    const tool = window.CanvasEditor.getTool ? window.CanvasEditor.getTool() : 'select';
    const zoomMode = window.CanvasEditor.isZoomMode ? window.CanvasEditor.isZoomMode() : false;
    toolbar.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
      const kind = btn.dataset.tool;
      btn.classList.toggle('is-active', kind === tool || (kind === 'zoom' && zoomMode));
    });
    const deleteBtn = document.getElementById('edit-delete-selected-btn');
    if (deleteBtn) {
      const count = window.CanvasEditor.getSelectedCount ? window.CanvasEditor.getSelectedCount() : 0;
      deleteBtn.hidden = !(tool === 'delete' && count > 0);
    }
  }

  /* ---------- 画布大小弹窗 ---------- */

  let canvasSizeDialog = null;

  function buildCanvasSizeDialog() {
    if (canvasSizeDialog) return;
    canvasSizeDialog = document.createElement('dialog');
    canvasSizeDialog.id = 'canvas-size-dialog';
    canvasSizeDialog.setAttribute('aria-labelledby', 'canvas-size-title');
    canvasSizeDialog.innerHTML =
      '<div class="dialog-head">' +
      '  <h2 id="canvas-size-title">画布大小</h2>' +
      '  <button type="button" class="btn btn-ghost btn-sm" data-size-close>关闭</button>' +
      '</div>' +
      '<div class="dialog-body">' +
      '  <div class="score-form">' +
      '    <label>宽（比赛卡片）<input type="number" id="canvas-size-cols" min="1" max="200" step="1"></label>' +
      '    <span class="score-colon">×</span>' +
      '    <label>高（比赛卡片）<input type="number" id="canvas-size-rows" min="1" max="200" step="1"></label>' +
      '  </div>' +
      '  <p class="hint">默认 40 × 24，最大 200 × 200。缩小画布不会删除卡片，只会缩小可编辑区域。</p>' +
      '  <div class="dialog-actions">' +
      '    <button type="button" class="btn btn-secondary" data-size-close>取消</button>' +
      '    <button type="button" class="btn btn-primary" data-size-save>保存</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(canvasSizeDialog);
    canvasSizeDialog.querySelectorAll('[data-size-close]').forEach((btn) => btn.addEventListener('click', () => canvasSizeDialog.close()));
    canvasSizeDialog.querySelector('[data-size-save]').addEventListener('click', saveCanvasSizeDialog);
  }

  function openCanvasSizeDialog() {
    const record = currentRecord();
    if (!record || !record.canvas) return;
    buildCanvasSizeDialog();
    const size = (typeof CanvasModel !== 'undefined' && CanvasModel.getCanvasSize)
      ? CanvasModel.getCanvasSize(record.canvas)
      : { cols: 40, rows: 24 };
    canvasSizeDialog.querySelector('#canvas-size-cols').value = size.cols;
    canvasSizeDialog.querySelector('#canvas-size-rows').value = size.rows;
    canvasSizeDialog.showModal();
  }

  function saveCanvasSizeDialog() {
    const record = currentRecord();
    if (!record || !record.canvas) return;
    const cols = Number(canvasSizeDialog.querySelector('#canvas-size-cols').value);
    const rows = Number(canvasSizeDialog.querySelector('#canvas-size-rows').value);
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      notify('请输入有效的画布大小', 'danger');
      return;
    }
    const size = (typeof CanvasModel !== 'undefined' && CanvasModel.clampCanvasSize)
      ? CanvasModel.clampCanvasSize(cols, rows)
      : { cols: Math.max(1, Math.min(200, Math.round(cols))), rows: Math.max(1, Math.min(200, Math.round(rows))) };
    record.canvas.size = size;
    canvasSizeDialog.close();
    save().then(() => {
      renderAll();
      notify('画布大小已保存');
    });
  }

  /* ---------- 比分弹窗 ---------- */

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
      '    <label><span class="score-player-label" id="score-label-a">A 选手</span> <input type="number" id="score-a" step="any"></label>' +
      '    <span class="score-colon">:</span>' +
      '    <label><span class="score-player-label" id="score-label-b">B 选手</span> <input type="number" id="score-b" step="any"></label>' +
      '  </div>' +
      '  <p class="hint">支持任意数字；负数显示为“弃权”；相等为平局。</p>' +
      '  <div class="dialog-actions">' +
      '    <button type="button" class="btn btn-danger btn-sm" data-score-clear>清除比分</button>' +
      '    <button type="button" class="btn btn-secondary" data-score-close>取消</button>' +
      '    <button type="button" class="btn btn-primary" data-score-save>保存</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(scoreDialog);

    scoreDialog.querySelector('[data-score-close]').addEventListener('click', () => scoreDialog.close());
    scoreDialog.querySelectorAll('[data-score-close]').forEach((btn) => {
      btn.addEventListener('click', () => scoreDialog.close());
    });
    scoreDialog.querySelector('[data-score-clear]').addEventListener('click', () => {
      if (!currentScoreCardId) return;
      delete currentRecord().scores[currentScoreCardId];
      save().then(() => {
        scoreDialog.close();
        renderAll();
      });
    });
    scoreDialog.querySelector('[data-score-save]').addEventListener('click', () => {
      if (!currentScoreCardId) return;
      const a = Number(scoreDialog.querySelector('#score-a').value);
      const b = Number(scoreDialog.querySelector('#score-b').value);
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        notify('请输入有效数字', 'danger');
        return;
      }
      currentRecord().scores[currentScoreCardId] = { a, b };
      save().then(() => {
        scoreDialog.close();
        renderAll();
      });
    });
  }

  function openScoreDialog(cardId) {
    buildScoreDialog();
    const record = currentRecord();
    const resolved = (typeof CanvasModel !== 'undefined' && CanvasModel.resolveCanvas)
      ? CanvasModel.resolveCanvas(record.canvas, record.roster || [], record.scores || {})
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
    currentScoreCardId = cardId;
    scoreDialog.showModal();
  }

  /* ---------- 事件绑定 ---------- */

  function bindCanvas() {
    const board = document.getElementById('canvas-board');
    board.addEventListener('click', (event) => {
      const scoreBtn = event.target.closest('[data-score-open]');
      if (scoreBtn && !scoreBtn.disabled) {
        openScoreDialog(scoreBtn.dataset.scoreOpen);
        return;
      }
      const deckBtn = event.target.closest('[data-view-decks]');
      if (deckBtn) {
        if (window.DeckModal && window.DeckModal.open) window.DeckModal.open(deckBtn.dataset.viewDecks);
        return;
      }
    });
  }

  function toggleEdit() {
    if (!canEdit()) {
      notify('需要管理员密码', 'danger');
      return;
    }
    editMode = !editMode;
    renderAll();
    if (editMode && window.CanvasEditor && window.CanvasEditor.enter) {
      window.CanvasEditor.enter();
    } else if (!editMode && window.CanvasEditor && window.CanvasEditor.exit) {
      window.CanvasEditor.exit();
    }
  }

  async function resetScores() {
    if (!canEdit()) {
      notify('需要管理员密码', 'danger');
      return;
    }
    const record = currentRecord();
    if (!record.scores || !Object.keys(record.scores).length) return;
    if (!(await uiConfirm('确定清空所有比分吗？选手与卡组会保留。'))) return;
    record.scores = {};
    await save();
    renderAll();
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
        if (btn.id === 'edit-delete-selected-btn' && window.CanvasEditor && window.CanvasEditor.deleteSelected) {
          window.CanvasEditor.deleteSelected();
        }
        return;
      }
      if (!canEdit()) return;
      const editor = window.CanvasEditor;
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
      else if (kind === 'format-size') openCanvasSizeDialog();
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
    if (window.CanvasEditor && window.CanvasEditor.fitCanvas) window.CanvasEditor.fitCanvas();
  }

  function bindZoomDock() {
    const dock = document.getElementById('zoom-dock');
    if (!dock) return;
    dock.addEventListener('click', (event) => {
      const btn = event.target.closest('.zoom-btn');
      if (!btn) return;
      const editor = window.CanvasEditor;
      if (!editor) return;
      const kind = btn.dataset.zoom;
      if (kind === 'in') {
        userZoomed = true;
        editor.zoomIn();
      } else if (kind === 'out') {
        userZoomed = true;
        editor.zoomOut();
      } else if (kind === 'reset') {
        if (!editor.setZoom) return;
        userZoomed = true;
        editor.setZoom(1);
      } else if (kind === 'fit') {
        userZoomed = false;
        editor.fitCanvas();
      }
    });
    window.addEventListener('resize', debounce(autoFitCanvas, 200));
  }

  /* 头像上传（与 roster 联动，写全局选手库） */
  let avatarFileInput = null;
  let pendingAvatarId = null;

  function ensureAvatarFileInput() {
    if (avatarFileInput) return;
    avatarFileInput = document.createElement('input');
    avatarFileInput.type = 'file';
    avatarFileInput.accept = 'image/*';
    avatarFileInput.hidden = true;
    document.body.appendChild(avatarFileInput);
    avatarFileInput.addEventListener('change', async () => {
      const file = avatarFileInput.files && avatarFileInput.files[0];
      avatarFileInput.value = '';
      const playerId = pendingAvatarId;
      pendingAvatarId = null;
      if (!file || !playerId) return;
      const player = playerById(playerId);
      if (!player) return;
      try {
        const blob = await window.TournamentApp.compressAvatar(file);
        player.avatar = window.TournamentApp.mode === 'cloud'
          ? await window.TournamentApp.uploadImage(blob)
          : blob;
        player.updatedAt = Date.now();
        await savePlayers();
        renderAll();
      } catch (error) {
        notify(window.TournamentUtils.errMsg(error), 'danger');
      }
    });
  }

  function bindRosterAvatars() {
    ensureAvatarFileInput();
    const grid = document.getElementById('roster-grid');
    grid.querySelectorAll('[data-avatar-upload]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!canEdit()) return;
        pendingAvatarId = btn.dataset.avatarUpload;
        avatarFileInput.click();
      });
    });
    grid.querySelectorAll('[data-avatar-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!canEdit()) return;
        const player = playerById(btn.dataset.avatarDelete);
        if (!player) return;
        player.avatar = null;
        player.updatedAt = Date.now();
        await savePlayers();
        renderAll();
      });
    });
  }

  window.BracketRender = {
    renderAll,
    renderCanvas,
    updateToolbar: updateToolbarState
  };

  window.BracketActions = {
    requestEdit,
    toggleEdit,
    resetScores,
    openRoster,
    openRules
  };

  document.addEventListener('ts:ready', () => {
    renderAll();
    autoFitCanvas();
    syncEditUI();
    hideEditLock();
    bindCanvasLock();
    bindEditToolbar();
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
