(function () {
  'use strict';

  let pendingTarget = null;

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));
  }

  function debounce(fn, wait) {
    let timer = null;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, wait);
    };
  }

  function save() {
    return window.TournamentApp.idbPut(window.TournamentApp.current);
  }

  function canEdit() {
    const app = window.TournamentApp;
    return !(app.mode === 'cloud' && !app.isAdmin());
  }

  async function addImageToSlot(targetKey, file) {
    if (!file || !targetKey) return;
    const [playerIndex, deckIndex, slotIndex] = targetKey.split('-').map(Number);
    try {
      const blob = await window.TournamentApp.compressImage(file, 1600);
      const deck = window.TournamentApp.current.players[playerIndex].decks[deckIndex];
      const ref = window.TournamentApp.mode === 'cloud'
        ? await window.TournamentApp.uploadImage(blob)
        : blob;
      if (slotIndex < deck.images.length) deck.images[slotIndex] = ref;
      else deck.images.push(ref);
      await save();
      renderAll();
    } catch (error) {
      alert(error.message);
    }
  }

  function renderAll() {
    if (!window.TournamentApp || !window.TournamentApp.current) return;
    renderPlayers();
  }

  function imageSlot(player, deck, playerIndex, deckIndex, slotIndex) {
    const image = deck.images[slotIndex];
    if (!image) {
      return (
        '<button type="button" class="image-slot empty" data-add="' + playerIndex + '-' + deckIndex + '-' + slotIndex + '"' +
        (canEdit() ? '' : ' disabled') + '>' +
        '<span class="slot-plus" aria-hidden="true">＋</span>' +
        '添加图片' +
        '</button>'
      );
    }
    const label = escapeHtml(player.name) + ' 的 ' + escapeHtml(deck.name) + ' 图片 ' + (slotIndex + 1);
    const editable = canEdit();
    return (
      '<div class="image-slot-wrap">' +
      '<button type="button" class="image-slot" data-view="' + playerIndex + '-' + deckIndex + '-' + slotIndex + '"' +
      ' style="background-image:url(' + window.TournamentApp.blobUrl(image) + ')"' +
      ' aria-label="放大查看 ' + label + '"></button>' +
      '<span class="slot-actions">' +
      '<button type="button" class="slot-action" data-replace="' + playerIndex + '-' + deckIndex + '-' + slotIndex + '"' +
      (editable ? '' : ' disabled') + '>更换</button>' +
      '<button type="button" class="slot-action danger" data-delete="' + playerIndex + '-' + deckIndex + '-' + slotIndex + '"' +
      (editable ? '' : ' disabled') + '>删除</button>' +
      '</span>' +
      '</div>'
    );
  }

  function deckBlock(player, deck, playerIndex, deckIndex) {
    const slots = [0, 1].map((slotIndex) => imageSlot(
      player,
      deck,
      playerIndex,
      deckIndex,
      slotIndex
    )).join('');
    return (
      '<section class="deck" aria-label="' + escapeHtml(player.name) + ' 的 ' + escapeHtml(deck.name) + '">' +
      '<label class="visually-hidden" for="deck-name-' + deck.id + '">' + escapeHtml(player.name) + ' 的卡组 ' + (deckIndex + 1) + ' 名称</label>' +
      '<input class="deck-name-input" id="deck-name-' + deck.id + '" value="' + escapeHtml(deck.name) + '" autocomplete="off"' +
      (canEdit() ? '' : ' disabled') + '>' +
      '<div class="deck-images">' + slots + '</div>' +
      '</section>'
    );
  }

  function renderPlayers() {
    const record = window.TournamentApp.current;
    const grid = document.getElementById('players-grid');
    grid.innerHTML = record.players.map((player, playerIndex) =>
      '<article class="player-card">' +
      '<header class="player-card-head">' +
      '<span class="roster-index">' + (playerIndex + 1) + '</span>' +
      '<label class="visually-hidden" for="player-name-' + player.id + '">选手 ' + (playerIndex + 1) + ' 姓名</label>' +
      '<input class="player-name-input" id="player-name-' + player.id + '" value="' + escapeHtml(player.name) + '" autocomplete="off"' +
      (canEdit() ? '' : ' disabled') + '>' +
      '</header>' +
      player.decks.map((deck, deckIndex) => deckBlock(player, deck, playerIndex, deckIndex)).join('') +
      '</article>'
    ).join('');

    grid.querySelectorAll('.player-name-input').forEach((input, playerIndex) => {
      const player = record.players[playerIndex];
      const commit = () => {
        const next = input.value.trim();
        if (next) player.name = next;
        else input.value = player.name;
        save();
      };
      input.addEventListener('change', commit);
      input.addEventListener('input', debounce(commit, 500));
    });

    grid.querySelectorAll('.deck-name-input').forEach((input) => {
      const deck = record.players.flatMap((p) => p.decks).find((d) => d.id === input.id.replace('deck-name-', ''));
      const commit = () => {
        const next = input.value.trim();
        if (next) deck.name = next;
        else input.value = deck.name;
        save();
      };
      input.addEventListener('change', commit);
      input.addEventListener('input', debounce(commit, 500));
    });

    grid.querySelectorAll('[data-add], [data-replace]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!canEdit()) return;
        pendingTarget = btn.dataset.add || btn.dataset.replace;
        document.getElementById('deck-file-input').click();
      });
    });

    grid.querySelectorAll('[data-add]').forEach((btn) => {
      const target = btn.dataset.add;
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
        if (file) addImageToSlot(target, file);
      });
    });

    grid.querySelectorAll('[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const [playerIndex, deckIndex, slotIndex] = btn.dataset.view.split('-').map(Number);
        const deck = record.players[playerIndex].decks[deckIndex];
        const items = deck.images.map((image, i) => ({
          src: window.TournamentApp.blobUrl(image),
          alt: record.players[playerIndex].name + ' 的 ' + deck.name + ' 图片 ' + (i + 1)
        }));
        window.TournamentApp.openLightbox(items, slotIndex, btn);
      });
    });

    grid.querySelectorAll('[data-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const [playerIndex, deckIndex, slotIndex] = btn.dataset.delete.split('-').map(Number);
        record.players[playerIndex].decks[deckIndex].images.splice(slotIndex, 1);
        await save();
        renderAll();
      });
    });
  }

  function bindFileInput() {
    document.getElementById('deck-file-input').addEventListener('change', async (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      const target = pendingTarget;
      pendingTarget = null;
      await addImageToSlot(target, file);
    });

    // 防止图片被拖到添加框之外时浏览器直接打开文件
    document.addEventListener('dragover', (event) => event.preventDefault());
    document.addEventListener('drop', (event) => event.preventDefault());
  }

  document.addEventListener('ts:ready', renderAll);
  document.addEventListener('ts:changed', renderAll);
  bindFileInput();
  window.TournamentAppInit('decks');
})();
