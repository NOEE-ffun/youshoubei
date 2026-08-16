(function () {
  'use strict';

  const { escapeHtml, avatarMarkup, safeUrl, cssUrl } = window.TournamentUtils;

  const CARD_WIDTH = 280;
  const CARD_HEIGHT = 176;
  const COL_GAP = 320;
  const ROW_GAP = 210;

  function playerById(id) {
    return (window.TournamentApp.players || []).find((p) => p.id === id) || null;
  }

  function formatScore(value) {
    const n = Number(value);
    return Number.isFinite(n) && n < 0 ? '弃权' : n;
  }

  function cardLeft(card) { return (Number(card.x) || 0) * COL_GAP; }
  function cardTop(card) { return (Number(card.y) || 0) * ROW_GAP; }

  function renderSelect() {
    const select = document.getElementById('library-tournament-select');
    if (!select) return;
    const app = window.TournamentApp;
    select.innerHTML = app.list.map((t) =>
      '<option value="' + t.id + '"' + (t.id === app.current.id ? ' selected' : '') + '>' +
      escapeHtml(t.name) + '</option>'
    ).join('');
    select.addEventListener('change', async () => {
      await window.TournamentApp.setActiveId(select.value);
      render();
    });
  }

  function syncSelect() {
    const select = document.getElementById('library-tournament-select');
    const app = window.TournamentApp;
    if (select && app && app.current) select.value = app.current.id;
  }

  function playerRow(match, side) {
    const pid = side === 0 ? match.a : match.b;
    const p = pid ? playerById(pid) : null;
    const score = side === 0 ? match.scoreA : match.scoreB;
    let cls = 'match-player' + (pid ? '' : ' tbd');
    if (match.played && pid) {
      if (match.winner === pid) cls += ' winner';
      if (match.loser === pid) cls += ' loser';
    }
    return '<div class="' + cls + '">' +
      avatarMarkup(p, 'avatar-sm') +
      '<span class="player-name">' + escapeHtml(p ? p.name : '待定') + '</span>' +
      '<span class="player-score">' + (score == null ? '' : formatScore(score)) + '</span>' +
      '</div>';
  }

  function cardHtml(match) {
    const stateText = match.invalid ? '无效' : match.draw ? '平局' : match.played ? '已结束' : (match.a && match.b ? '未开始' : '待定');
    return (
      '<article class="match-card canvas-card' + (match.played ? ' played' : '') + '" data-match="' + match.id + '"' +
      ' style="left:' + cardLeft(match) + 'px;top:' + cardTop(match) + 'px">' +
      '<header class="match-head">' +
      '<h3 class="match-title">' + escapeHtml(match.label || match.id) + '</h3>' +
      '<span class="match-format">' + escapeHtml(match.format || 'BO3') + '</span>' +
      '<span class="match-state' + (match.played ? ' done' : '') + '">' + stateText + '</span>' +
      '</header>' +
      (match.phase ? '<div class="match-phase">' + escapeHtml(match.phase) + '</div>' : '') +
      playerRow(match, 0) +
      playerRow(match, 1) +
      '<div class="card-actions">' +
      '<button type="button" class="btn btn-secondary btn-sm" data-view-decks="' + match.id + '">查看卡组</button>' +
      '</div>' +
      '</article>'
    );
  }

  function renderEdges(canvas, resolvedById, board) {
    let svg = board.querySelector('.canvas-edges');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.classList.add('canvas-edges');
      board.insertBefore(svg, board.firstChild);
    }
    const paths = [];
    for (const card of canvas.cards || []) {
      for (let i = 0; i < (card.slots || []).length; i += 1) {
        const slot = card.slots[i];
        if (!slot || slot.type !== 'flow') continue;
        const source = resolvedById.get(slot.cardId);
        const target = resolvedById.get(card.id);
        if (!source || !target) continue;
        const x1 = cardLeft(source) + CARD_WIDTH;
        const y1 = cardTop(source) + (slot.outcome === 'winner' ? 70 : 108);
        const x2 = cardLeft(target);
        const y2 = cardTop(target) + (i === 0 ? 70 : 108);
        const mid = (x1 + x2) / 2;
        paths.push('<path d="M ' + x1 + ' ' + y1 + ' C ' + mid + ' ' + y1 + ', ' + mid + ' ' + y2 + ', ' + x2 + ' ' + y2 + '" class="canvas-edge ' + (slot.outcome === 'loser' ? 'loser' : 'winner') + '"></path>');
      }
    }
    svg.setAttribute('width', board.scrollWidth || 1000);
    svg.setAttribute('height', board.scrollHeight || 800);
    svg.innerHTML = paths.join('');
  }

  function render() {
    const app = window.TournamentApp;
    const record = app.current;
    syncSelect();
    const board = document.getElementById('library-board');
    if (!board || !record) return;
    const canvas = record.canvas || { cards: [] };
    const resolved = CanvasModel.resolveCanvas(canvas, record.roster || [], record.scores || {});
    const size = (typeof CanvasModel.getCanvasSize === 'function')
      ? CanvasModel.getCanvasSize(canvas)
      : { cols: 40, rows: 24 };
    const cardMaxX = Math.max(0, ...(canvas.cards || []).map((c) => (Number(c.x) || 0) * COL_GAP + CARD_WIDTH + 40));
    const cardMaxY = Math.max(0, ...(canvas.cards || []).map((c) => (Number(c.y) || 0) * ROW_GAP + CARD_HEIGHT + 40));
    const maxX = Math.max(cardMaxX, size.cols * COL_GAP + 80);
    const maxY = Math.max(cardMaxY, size.rows * ROW_GAP + 80);
    board.style.width = maxX + 'px';
    board.style.height = maxY + 'px';
    board.innerHTML = '';
    const boundary = document.createElement('div');
    boundary.className = 'canvas-boundary';
    boundary.style.width = (size.cols * COL_GAP) + 'px';
    boundary.style.height = (size.rows * ROW_GAP) + 'px';
    board.appendChild(boundary);
    renderEdges(canvas, new Map(resolved.cards.map((c) => [c.id, c])), board);
    const wrap = document.createElement('div');
    wrap.className = 'canvas-cards';
    wrap.innerHTML = resolved.cards.map(cardHtml).join('');
    board.appendChild(wrap);
  }

  function bind() {
    const board = document.getElementById('library-board');
    board.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-view-decks]');
      if (btn && window.DeckModal && window.DeckModal.open) {
        window.DeckModal.open(btn.dataset.viewDecks, { readOnly: true });
      }
    });
  }

  document.addEventListener('ts:ready', () => {
    renderSelect();
    render();
    bind();
    document.addEventListener('ts:changed', render);
  });

  window.TournamentAppInit('library').catch((error) => {
    if (window.TournamentApp) window.TournamentApp.fatalError(error);
  });
})();
