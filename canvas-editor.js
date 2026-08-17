(function () {
  'use strict';

  const { escapeHtml, canEdit, save, notify, errMsg, uiConfirm } = window.TournamentUtils;

  const COL_GAP = 320;
  const ROW_GAP = 210;
  const MIN_SCALE = 0.05;
  const MAX_SCALE = 3;

  let active = false;
  let tool = 'select';
  let zoomMode = false;
  let scale = 1;
  let baseWidth = 600;
  let baseHeight = 400;
  let selectedCardId = null;
  let batchSelected = new Set();
  let dragState = null;
  let connectState = null;
  let copiedCard = null;
  let cardDialog = null;
  let editingCardId = null;
  let wheelBound = false;

  function currentRecord() {
    return window.TournamentApp.current;
  }

  function findCard(id) {
    return (currentRecord().canvas.cards || []).find((c) => c.id === id) || null;
  }

  function saveCanvas() {
    currentRecord().updatedAt = Date.now();
    return save();
  }

  function board() {
    return document.getElementById('canvas-board');
  }

  function scrollEl() {
    return document.getElementById('canvas-scroll');
  }

  function stageEl() {
    return document.getElementById('canvas-stage');
  }

  function cardElement(id) {
    const b = board();
    return b ? b.querySelector('.canvas-card[data-match="' + id + '"]') : null;
  }

  function selectedIds() {
    if (tool === 'delete') return [...batchSelected];
    return selectedCardId ? [selectedCardId] : [];
  }

  function refreshToolbarUI() {
    if (window.BracketRender && window.BracketRender.updateToolbar) window.BracketRender.updateToolbar();
  }

  /* ---------- 编辑模式生命周期 ---------- */

  function enter() {
    active = true;
    const b = board();
    if (b) b.classList.add('editing');
    bindBoardEvents();
    bindWheel();
    syncZoom();
    const hint = document.getElementById('canvas-hint');
    if (hint) hint.textContent = '编辑模式';
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
    removeTempLine();
    const b = board();
    if (b) {
      b.classList.remove('editing');
      b.classList.remove('tool-link', 'tool-delete', 'zoom-mode');
    }
    const hint = document.getElementById('canvas-hint');
    if (hint) hint.textContent = '查看模式 · Ctrl/⌘+滚轮缩放';
    if (cardDialog && cardDialog.open) cardDialog.close();
    refreshToolbarUI();
  }

  /* ---------- 工具模式 ---------- */

  function setTool(next) {
    tool = next;
    if (next !== 'delete') batchSelected.clear();
    const b = board();
    if (b) {
      b.classList.toggle('tool-link', next === 'link');
      b.classList.toggle('tool-delete', next === 'delete');
    }
    highlightSelected();
    refreshToolbarUI();
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

  function syncZoom() {
    const b = board();
    const stage = stageEl();
    if (!b || !stage) return;
    baseWidth = parseFloat(b.style.width) || 600;
    baseHeight = parseFloat(b.style.height) || 400;
    stage.style.width = (baseWidth * scale) + 'px';
    stage.style.height = (baseHeight * scale) + 'px';
    b.style.transform = 'scale(' + scale + ')';
    b.style.transformOrigin = '0 0';
    /* 右下角常驻缩放控件的百分比读数（仅赛程页存在该元素） */
    const label = document.getElementById('zoom-level');
    if (label) label.textContent = Math.round(scale * 100) + '%';
  }

  function setZoom(next) {
    scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
    syncZoom();
    refreshToolbarUI();
  }

  function zoomAtCenter(factor) {
    const sc = scrollEl();
    if (!sc) return;
    const rect = sc.getBoundingClientRect();
    const cx = sc.scrollLeft + rect.width / 2;
    const cy = sc.scrollTop + rect.height / 2;
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
    const ratio = next / scale;
    scale = next;
    syncZoom();
    sc.scrollLeft = cx * ratio - rect.width / 2;
    sc.scrollTop = cy * ratio - rect.height / 2;
    refreshToolbarUI();
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
    const next = Math.max(MIN_SCALE, Math.min(1, Math.min(
      (rect.width - 24) / extent.width,
      (rect.height - 24) / extent.height
    )));
    scale = next;
    syncZoom();
    refreshToolbarUI();
  }

  function onWheel(event) {
    // CAD 式：Ctrl/Cmd + 滚轮缩放（Mac 捏合手势会转换为 ctrl+wheel）；缩放模式下普通滚轮也缩放
    if (!event.ctrlKey && !event.metaKey && !zoomMode) return;
    event.preventDefault();
    const lineDelta = event.deltaY / (event.deltaMode === 1 ? 33.3 : event.deltaMode === 2 ? 100 : 1);
    const factor = Math.exp(-lineDelta * 0.0018);
    zoomAtCenter(factor);
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
    const b = board();
    if (!b) return;
    b.addEventListener('pointerdown', onPointerDown);
    b.addEventListener('pointermove', onPointerMove);
    b.addEventListener('pointerup', onPointerUp);
    b.addEventListener('dblclick', onDblClick);
    b.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeyDown);
  }

  function onPointerDown(event) {
    if (!active) return;
    const output = event.target.closest('.port-output');
    if (output && tool !== 'delete') {
      event.preventDefault();
      const sourceCardId = output.dataset.card;
      const outcome = output.dataset.outcome;
      connectState = { sourceCardId, outcome };
      ensureTempLine();
      updateTempLine(event.clientX, event.clientY);
      return;
    }
    const cardEl = event.target.closest('.canvas-card');
    if (!cardEl) return;
    if (tool === 'delete') {
      event.preventDefault();
      toggleBatchSelected(cardEl.dataset.match);
      return;
    }
    if (tool === 'link') {
      selectedCardId = cardEl.dataset.match;
      highlightSelected();
      return;
    }
    if (tool === 'select' && !event.target.closest('button, input, select, a, .port')) {
      selectedCardId = cardEl.dataset.match;
      highlightSelected();
      const card = findCard(selectedCardId);
      if (!card) return;
      dragState = {
        cardId: selectedCardId,
        startX: event.clientX,
        startY: event.clientY,
        originX: Number(card.x) || 0,
        originY: Number(card.y) || 0,
        moved: false
      };
      event.preventDefault();
    }
  }

  function onPointerMove(event) {
    if (connectState) {
      updateTempLine(event.clientX, event.clientY);
      return;
    }
    if (!dragState) return;
    const card = findCard(dragState.cardId);
    if (!card) return;
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    const nextX = dragState.originX + Math.round(dx / (COL_GAP * scale));
    const nextY = dragState.originY + Math.round(dy / (ROW_GAP * scale));
    if (nextX !== card.x || nextY !== card.y) {
      card.x = nextX;
      card.y = nextY;
      dragState.moved = true;
      const el = cardElement(dragState.cardId);
      if (el) {
        el.style.left = (nextX * COL_GAP) + 'px';
        el.style.top = (nextY * ROW_GAP) + 'px';
      }
    }
  }

  function onPointerUp(event) {
    if (connectState) {
      const input = event.target.closest('.port-input');
      if (input && input.dataset.card && input.dataset.slot !== undefined) {
        const targetCard = findCard(input.dataset.card);
        if (targetCard) {
          targetCard.slots[Number(input.dataset.slot)] = {
            type: 'flow',
            cardId: connectState.sourceCardId,
            outcome: connectState.outcome
          };
          saveCanvas().then(() => {
            if (window.BracketRender) window.BracketRender.renderCanvas();
          });
        }
      }
      removeTempLine();
      connectState = null;
      return;
    }
    if (dragState) {
      if (dragState.moved) {
        saveCanvas().then(() => {
          if (window.BracketRender) window.BracketRender.renderCanvas();
        });
      }
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
    const x = Math.round((event.clientX - rect.left) / (COL_GAP * scale));
    const y = Math.round((event.clientY - rect.top) / (ROW_GAP * scale));
    addCard(x, y);
  }

  function onClick(event) {
    if (!active) return;
    const cardEl = event.target.closest('.canvas-card');
    if (!cardEl) return;
    if (tool === 'delete') return;
    selectedCardId = cardEl.dataset.match;
    highlightSelected();
  }

  function onKeyDown(event) {
    if (!active) return;
    if (event.target && event.target.closest && event.target.closest('input, textarea, select')) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && (event.key === 'c' || event.key === 'C')) {
      const id = selectedIds()[0];
      if (id) {
        const card = findCard(id);
        if (card) {
          copiedCard = JSON.parse(JSON.stringify(card));
          notify('已复制卡片');
        }
      }
      return;
    }
    if (mod && (event.key === 'v' || event.key === 'V')) {
      if (copiedCard) pasteCard(copiedCard);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const ids = selectedIds();
      if (ids.length) {
        event.preventDefault();
        deleteCards(ids);
      }
    }
  }

  /* ---------- 选择 ---------- */

  function toggleBatchSelected(id) {
    if (batchSelected.has(id)) batchSelected.delete(id);
    else batchSelected.add(id);
    if (batchSelected.size) selectedCardId = [...batchSelected][0];
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
    const card = {
      id: (typeof CanvasModel !== 'undefined' && CanvasModel.uid) ? CanvasModel.uid('c') : ('c_' + Date.now()),
      label: '新对局',
      phase: '',
      format: 'BO3',
      x: Math.max(0, x || 0),
      y: Math.max(0, y || 0),
      slots: [{ type: 'empty' }, { type: 'empty' }],
      exitRanks: {}
    };
    canvas.cards.push(card);
    selectedCardId = card.id;
    if (tool === 'delete') setTool('select');
    saveCanvas().then(() => {
      if (window.BracketRender) window.BracketRender.renderCanvas();
      openCardDialog(card.id);
    });
  }

  async function deleteCards(ids) {
    if (!ids || !ids.length) return;
    const record = currentRecord();
    const canvas = record.canvas || { cards: [] };
    const cards = ids.map((id) => canvas.cards.find((c) => c.id === id)).filter(Boolean);
    if (!cards.length) return;
    const names = cards.map((c) => c.label || c.id).join('、');
    if (!(await uiConfirm('确定删除卡片：' + names + ' 吗？'))) return;
    const idSet = new Set(cards.map((c) => c.id));
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
    selectedCardId = null;
    batchSelected.clear();
    saveCanvas().then(() => {
      if (window.BracketRender) window.BracketRender.renderCanvas();
      refreshToolbarUI();
    });
  }

  function deleteCard(id) {
    return deleteCards([id]);
  }

  function deleteSelected() {
    return deleteCards(selectedIds());
  }

  function pasteCard(source) {
    const record = currentRecord();
    const canvas = record.canvas || (record.canvas = { cards: [] });
    const clone = JSON.parse(JSON.stringify(source));
    const idMap = new Map();
    const newId = (typeof CanvasModel !== 'undefined' && CanvasModel.uid) ? CanvasModel.uid('c') : ('c_' + Date.now());
    idMap.set(clone.id, newId);
    clone.id = newId;
    clone.label = clone.label + ' 副本';
    clone.x = (Number(clone.x) || 0) + 3;
    clone.y = (Number(clone.y) || 0) + 2;
    clone.slots = (clone.slots || []).map((slot) => {
      if (slot && slot.type === 'flow' && idMap.has(slot.cardId)) {
        return { ...slot, cardId: idMap.get(slot.cardId) };
      }
      return slot ? { ...slot } : { type: 'empty' };
    });
    canvas.cards.push(clone);
    selectedCardId = clone.id;
    if (tool === 'delete') setTool('select');
    saveCanvas().then(() => {
      if (window.BracketRender) window.BracketRender.renderCanvas();
      openCardDialog(clone.id);
    });
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
      '  <div class="form-field"><label for="card-slot-a">A 位选手</label><select id="card-slot-a"></select></div>' +
      '  <div class="form-field"><label for="card-slot-b">B 位选手</label><select id="card-slot-b"></select></div>' +
      '  <div class="form-field"><label for="card-rank-winner">胜者出口名次</label><input type="number" id="card-rank-winner" placeholder="如 1"></div>' +
      '  <div class="form-field"><label for="card-rank-loser">败者出口名次</label><input type="number" id="card-rank-loser" placeholder="如 2"></div>' +
      '  <p class="hint">连线请用卡片右侧输出口拖到目标卡片左侧输入口；这里只设置直接参赛选手。</p>' +
      '  <div class="dialog-actions">' +
      '    <button type="button" class="btn btn-secondary" data-card-close>取消</button>' +
      '    <button type="button" class="btn btn-primary" data-card-save>保存</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(cardDialog);
    cardDialog.querySelectorAll('[data-card-close]').forEach((btn) => btn.addEventListener('click', () => cardDialog.close()));
    cardDialog.querySelector('[data-card-save]').addEventListener('click', saveCardDialog);
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
    cardDialog.querySelector('#card-label').value = card.label || '';
    cardDialog.querySelector('#card-phase').value = card.phase || '';
    cardDialog.querySelector('#card-format').value = card.format || 'BO3';
    cardDialog.querySelector('#card-deck-count').value = card.deckCount || '';
    const slotA = card.slots && card.slots[0];
    const slotB = card.slots && card.slots[1];
    cardDialog.querySelector('#card-slot-a').innerHTML = playerOptions(slotA && slotA.type === 'player' ? slotA.playerId : '');
    cardDialog.querySelector('#card-slot-b').innerHTML = playerOptions(slotB && slotB.type === 'player' ? slotB.playerId : '');
    if (slotA && slotA.type === 'flow') {
      cardDialog.querySelector('#card-slot-a').insertAdjacentHTML('beforeend',
        '<option value="__flow" selected>来自 ' + escapeHtml(flowSourceLabel(slotA.cardId)) + ' 的' + (slotA.outcome === 'loser' ? '败者' : '胜者') + '</option>');
    }
    if (slotB && slotB.type === 'flow') {
      cardDialog.querySelector('#card-slot-b').insertAdjacentHTML('beforeend',
        '<option value="__flow" selected>来自 ' + escapeHtml(flowSourceLabel(slotB.cardId)) + ' 的' + (slotB.outcome === 'loser' ? '败者' : '胜者') + '</option>');
    }
    cardDialog.querySelector('#card-rank-winner').value = card.exitRanks && card.exitRanks.winner != null ? card.exitRanks.winner : '';
    cardDialog.querySelector('#card-rank-loser').value = card.exitRanks && card.exitRanks.loser != null ? card.exitRanks.loser : '';
    cardDialog.showModal();
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
    }
    if (slotBValue === '') {
      card.slots[1] = { type: 'empty' };
    } else if (slotBValue && slotBValue !== '__flow') {
      card.slots[1] = { type: 'player', playerId: slotBValue };
    }
    card.exitRanks = card.exitRanks || {};
    const rw = Number(cardDialog.querySelector('#card-rank-winner').value);
    const rl = Number(cardDialog.querySelector('#card-rank-loser').value);
    card.exitRanks.winner = Number.isFinite(rw) ? rw : null;
    card.exitRanks.loser = Number.isFinite(rl) ? rl : null;
    cardDialog.close();
    saveCanvas().then(() => {
      if (window.BracketRender) window.BracketRender.renderCanvas();
    });
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

  function portRect(cardId, kind, slotIndex) {
    const b = board();
    if (!b) return null;
    const selector = kind === 'output'
      ? '.port-output[data-card="' + cardId + '"][data-outcome="' + slotIndex + '"]'
      : '.port-input[data-card="' + cardId + '"][data-slot="' + slotIndex + '"]';
    const port = b.querySelector(selector);
    if (port) return port.getBoundingClientRect();
    const card = findCard(cardId);
    if (!card) return null;
    const boardRect = b.getBoundingClientRect();
    return {
      left: boardRect.left + (Number(card.x) || 0) * COL_GAP * scale + (kind === 'output' ? 280 * scale : 0),
      top: boardRect.top + (Number(card.y) || 0) * ROW_GAP * scale + (slotIndex === 'loser' || Number(slotIndex) === 1 ? 108 * scale : 70 * scale),
      width: 12,
      height: 12
    };
  }

  function updateTempLine(x, y) {
    const line = document.getElementById('canvas-temp-line');
    if (!line || !connectState) return;
    const outcome = connectState.outcome;
    const startRect = portRect(connectState.sourceCardId, 'output', outcome);
    if (!startRect) return;
    const b = board();
    const rect = b.getBoundingClientRect();
    const startX = startRect.left - rect.left + startRect.width / 2;
    const startY = startRect.top - rect.top + startRect.height / 2;
    const endX = x - rect.left;
    const endY = y - rect.top;
    const mid = (startX + endX) / 2;
    line.style.left = rect.left + 'px';
    line.style.top = rect.top + 'px';
    line.setAttribute('width', rect.width || 1000);
    line.setAttribute('height', rect.height || 800);
    line.innerHTML = '<path d="M ' + startX + ' ' + startY +
      ' C ' + mid + ' ' + startY + ', ' + mid + ' ' + endY + ', ' + endX + ' ' + endY +
      '" class="canvas-edge temp ' + (outcome === 'loser' ? 'loser' : 'winner') + '"></path>';
  }

  function removeTempLine() {
    const line = document.getElementById('canvas-temp-line');
    if (line) line.remove();
  }

  bindWheel();

  /* ---------- 暴露接口 ---------- */

  window.CanvasEditor = {
    enter,
    exit,
    addCard,
    deleteCard,
    deleteSelected,
    setTool,
    getTool,
    isZoomMode,
    toggleZoomMode,
    zoomIn,
    zoomOut,
    setZoom,
    fitCanvas,
    syncZoom,
    getSelectedCount
  };
})();
