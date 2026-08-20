(function () {
  'use strict';

  let dialog = null;
  let currentMatchId = null;
  let pendingTarget = null;

  const { escapeHtml, debounce, canEdit, save, avatarMarkup, cssUrl, notify, errMsg, iconMarkup, uiConfirm } =
    window.TournamentUtils;

  function buildDialog() {
    dialog = document.createElement('dialog');
    dialog.id = 'deck-dialog';
    dialog.setAttribute('aria-labelledby', 'deck-dialog-title');
    dialog.innerHTML =
      '<div class="dialog-head">' +
      '  <h2 id="deck-dialog-title">本局卡组</h2>' +
      '  <button type="button" class="btn btn-ghost btn-sm" id="deck-dialog-close">关闭</button>' +
      '</div>' +
      '<div class="dialog-body deck-dialog-body" id="deck-dialog-body"></div>' +
      '<input type="file" id="deck-file-input" accept="image/*" hidden>';
    document.body.appendChild(dialog);

    dialog.querySelector('#deck-dialog-close').addEventListener('click', () => dialog.close());
    dialog.querySelector('#deck-file-input').addEventListener('change', async (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      const target = pendingTarget;
      pendingTarget = null;
      await addImage(target, file);
    });

    document.addEventListener('dragover', (event) => event.preventDefault());
    document.addEventListener('drop', (event) => event.preventDefault());
  }

  function cardDef() {
    const record = window.TournamentApp.current;
    return (record.canvas.cards || []).find((c) => c.id === currentMatchId) || null;
  }

  function matchContext() {
    const app = window.TournamentApp;
    const record = app.current;
    const card = cardDef();
    const match = (typeof CanvasModel !== 'undefined' && CanvasModel.resolveCardById)
      ? CanvasModel.resolveCardById(record.canvas, record.roster || [], record.scores || {}, currentMatchId)
      : null;
    const names = new Map((app.players || []).map((p) => [p.id, p.name]));
    return { record, match, card, names };
  }

  function open(matchId) {
    if (!dialog) buildDialog();
    currentMatchId = matchId;
    if (typeof CanvasModel !== 'undefined' && CanvasModel.ensureCanvasDecks) {
      CanvasModel.ensureCanvasDecks(window.TournamentApp.current);
    }
    render();
    dialog.showModal();
  }

  function render() {
    const { match, card, names } = matchContext();
    if (!match || !card) {
      dialog.querySelector('#deck-dialog-title').textContent = '本局卡组';
      dialog.querySelector('#deck-dialog-body').innerHTML = '<p class="hint">未找到这张对局。</p>';
      return;
    }
    dialog.querySelector('#deck-dialog-title').textContent =
      (match.label || card.label || '对局') + ' · ' + (match.format || card.format || 'BO3');
    const body = dialog.querySelector('#deck-dialog-body');
    body.innerHTML = [0, 1].map((side) => playerColumn(side, match, names)).join('');
    bindEvents();
  }

  function playerColumn(side, match, names) {
    const playerId = side === 0 ? match.a : match.b;
    if (!playerId) {
      return (
        '<section class="deck-player">' +
        '<h3>待定</h3>' +
        '<p class="hint">该位置选手尚未确定</p>' +
        '</section>'
      );
    }
    const record = window.TournamentApp.current;
    const decks = (record.matchDecks[currentMatchId] && record.matchDecks[currentMatchId][playerId]) || [];
    const editable = canEdit();
    const avatarPlayer = (window.TournamentApp.players || []).find((p) => p.id === playerId);
    return (
      '<section class="deck-player" data-player="' + playerId + '">' +
      '<h3 class="deck-player-head">' +
      avatarMarkup(avatarPlayer, 'avatar-md') +
      '<span>' + escapeHtml(names.get(playerId) || '选手') + '</span>' +
      '</h3>' +
      decks.map((deck, deckIndex) => deckBlock(playerId, deck, deckIndex, editable)).join('') +
      '</section>'
    );
  }

  function deckBlock(playerId, deck, deckIndex, editable) {
    const key = currentMatchId + '-' + playerId + '-' + deckIndex;
    return (
      '<div class="deck">' +
      '<label class="visually-hidden" for="deck-name-' + key + '">卡组 ' + (deckIndex + 1) + ' 名称</label>' +
      '<input class="deck-name-input" id="deck-name-' + key + '" data-deck-key="' +
      currentMatchId + '|' + playerId + '|' + deckIndex + '" value="' + escapeHtml(deck.name) + '"' +
      ' autocomplete="off"' + (editable ? '' : ' disabled') + '>' +
      '<div class="deck-images">' +
      [0, 1].map((slotIndex) => imageSlot(playerId, deck, deckIndex, slotIndex, editable)).join('') +
      '</div>' +
      '</div>'
    );
  }

  function imageSlot(playerId, deck, deckIndex, slotIndex, editable) {
    const key = [currentMatchId, playerId, deckIndex, slotIndex].join('|');
    const image = deck.images[slotIndex];
    if (!image) {
      return (
        '<button type="button" class="image-slot empty" data-add="' + key + '"' +
        (editable ? '' : ' disabled') + '>' +
        '<span class="slot-plus" aria-hidden="true">' + iconMarkup('add', '') + '</span>添加图片' +
        '</button>'
      );
    }
    const label = '卡组 ' + (deckIndex + 1) + ' 图片 ' + (slotIndex + 1);
    return (
      '<div class="image-slot-wrap">' +
      '<button type="button" class="image-slot" data-view="' + key + '"' +
      ' style="background-image:' + cssUrl(window.TournamentApp.blobUrl(image)) + '"' +
      ' aria-label="放大查看 ' + label + '"></button>' +
      (editable
        ? '<span class="slot-actions">' +
          '<button type="button" class="slot-action" data-replace="' + key + '">更换</button>' +
          '<button type="button" class="slot-action danger" data-delete="' + key + '">删除</button>' +
          '</span>'
        : '') +
      '</div>'
    );
  }

  function bindEvents() {
    const body = dialog.querySelector('#deck-dialog-body');

    body.querySelectorAll('.deck-name-input').forEach((input) => {
      const [matchId, playerId, deckIndex] = (input.dataset.deckKey || '').split('|');
      const matchDecks = window.TournamentApp.current.matchDecks || {};
      const playerDecks = (matchDecks[matchId] && matchDecks[matchId][playerId]) || [];
      const deck = playerDecks[Number(deckIndex)];
      if (!deck) return;
      const commit = () => {
        const next = input.value.trim();
        if (next) deck.name = next;
        else input.value = deck.name;
        save();
      };
      input.addEventListener('input', debounce(commit, 500));
    });

    body.querySelectorAll('[data-add], [data-replace]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!canEdit()) return;
        pendingTarget = btn.dataset.add || btn.dataset.replace;
        dialog.querySelector('#deck-file-input').click();
      });
    });

    body.querySelectorAll('[data-add]').forEach((btn) => {
      btn.addEventListener('dragenter', (event) => {
        if (!canEdit()) return;
        event.preventDefault();
        btn.classList.add('drag-over');
      });
      btn.addEventListener('dragover', (event) => {
        if (!canEdit()) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      });
      btn.addEventListener('dragleave', (event) => {
        if (!btn.contains(event.relatedTarget)) btn.classList.remove('drag-over');
      });
      btn.addEventListener('drop', (event) => {
        if (!canEdit()) return;
        event.preventDefault();
        btn.classList.remove('drag-over');
        const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
        if (file) addImage(btn.dataset.add, file);
      });
    });

    body.querySelectorAll('[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const [matchId, playerId, deckIndex, slotIndex] = btn.dataset.view.split('|');
        const deck = window.TournamentApp.current.matchDecks[matchId][playerId][Number(deckIndex)];
        const items = deck.images.map((image, i) => ({
          src: window.TournamentApp.blobUrl(image),
          alt: '卡组图片 ' + (i + 1)
        }));
        if (dialog.open) dialog.close();
        window.TournamentApp.openLightbox(items, Number(slotIndex), btn, () => {
          if (!dialog.open) dialog.showModal();
          if (document.contains(btn)) btn.focus();
        });
      });
    });

    body.querySelectorAll('[data-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!(await uiConfirm('确定删除这张卡组图片吗？'))) return;
        const [matchId, playerId, deckIndex, slotIndex] = btn.dataset.delete.split('|');
        window.TournamentApp.current.matchDecks[matchId][playerId][Number(deckIndex)].images
          .splice(Number(slotIndex), 1);
        await save();
        render();
      });
    });
  }

  async function addImage(targetKey, file) {
    if (!file || !targetKey) return;
    const [matchId, playerId, deckIndex, slotIndex] = targetKey.split('|');
    try {
      const blob = await window.TournamentApp.compressImage(file, 1600);
      const deck = window.TournamentApp.current.matchDecks[matchId][playerId][Number(deckIndex)];
      const ref = window.TournamentApp.mode === 'cloud'
        ? await window.TournamentApp.uploadImage(blob)
        : blob;
      if (Number(slotIndex) < deck.images.length) deck.images[Number(slotIndex)] = ref;
      else deck.images.push(ref);
      await save();
      render();
    } catch (error) {
      notify(errMsg(error), 'danger');
    }
  }

  window.DeckModal = { open };
})();
