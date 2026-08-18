(function () {
  'use strict';

  const { escapeHtml, canEdit, avatarMarkup, notify, errMsg, uiConfirm } = window.TournamentUtils;

  let fileInput = null;
  let pendingPlayerId = null;

  function render() {
    const app = window.TournamentApp;
    const grid = document.getElementById('players-grid');
    if (!grid) return;
    const editable = canEdit();
    const banner = document.getElementById('players-lock-banner');
    if (banner) banner.hidden = editable;
    const players = app.players || [];
    grid.innerHTML = players.map((p) =>
      '<div class="player-card">' +
      '<div class="player-card-avatar">' +
      avatarMarkup(p, 'avatar-lg') +
      (editable ? '<button type="button" class="avatar-action" data-avatar-upload="' + p.id + '">' + (p.avatar ? '更换' : '上传') + '</button>' : '') +
      '</div>' +
      '<input class="player-card-name" data-player-name="' + p.id + '" value="' + escapeHtml(p.name) + '"' +
      (editable ? '' : ' disabled') + ' autocomplete="off">' +
      (editable ? '<button type="button" class="btn btn-danger btn-sm" data-delete-player="' + p.id + '">删除</button>' : '') +
      '</div>'
    ).join('') || '<p class="hint">暂无选手，先新增一位。</p>';

    grid.querySelectorAll('[data-player-name]').forEach((input) => {
      input.addEventListener('change', async () => {
        const p = (app.players || []).find((x) => x.id === input.dataset.playerName);
        if (!p) return;
        const next = input.value.trim();
        if (next) p.name = next;
        else input.value = p.name;
        p.updatedAt = Date.now();
        try {
          await app.storagePutPlayers(app.players);
        } catch (error) {
          notify(errMsg(error), 'danger');
        }
      });
    });

    grid.querySelectorAll('[data-delete-player]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.deletePlayer;
        if (!(await uiConfirm('确定从选手库删除该选手吗？历史比赛记录不会被删除，但该选手会显示为“待定”。'))) return;
        try {
          await app.storageDeletePlayer(id);
          app.players = (app.players || []).filter((x) => x.id !== id);
          render();
        } catch (error) {
          notify(errMsg(error), 'danger');
        }
      });
    });

    grid.querySelectorAll('[data-avatar-upload]').forEach((btn) => {
      btn.addEventListener('click', () => {
        pendingPlayerId = btn.dataset.avatarUpload;
        ensureFileInput().click();
      });
    });

    syncAddFormAccess();
  }

  function ensureFileInput() {
    if (fileInput) return fileInput;
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.hidden = true;
    document.body.appendChild(fileInput);
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      const id = pendingPlayerId;
      pendingPlayerId = null;
      if (!file || !id) return;
      const app = window.TournamentApp;
      const p = (app.players || []).find((x) => x.id === id);
      if (!p) return;
      try {
        const blob = await app.compressAvatar(file);
        p.avatar = app.mode === 'cloud' ? await app.uploadImage(blob) : blob;
        p.updatedAt = Date.now();
        await app.storagePutPlayers(app.players);
        render();
      } catch (error) {
        notify(errMsg(error), 'danger');
      }
    });
    return fileInput;
  }

  function syncAddFormAccess() {
    const form = document.getElementById('add-player-form');
    if (!form) return;
    const input = document.getElementById('new-player-name');
    const submit = form.querySelector('button[type="submit"]');
    const editable = canEdit();
    if (input) input.disabled = !editable;
    if (submit) submit.disabled = !editable;
  }

  function bindAddForm() {
    const form = document.getElementById('add-player-form');
    if (!form) return;
    const input = document.getElementById('new-player-name');
    syncAddFormAccess();
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!canEdit()) {
        notify('需要管理员密码', 'danger');
        return;
      }
      const name = input.value.trim();
      if (!name) return;
      const app = window.TournamentApp;
      if (!app.players) app.players = [];
      const player = {
        id: (window.CanvasModel && CanvasModel.uid) ? CanvasModel.uid('p') : ('p_' + Date.now()),
        name,
        title: '',
        color: null,
        avatar: null,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      app.players.push(player);
      try {
        await app.storagePutPlayers(app.players);
        input.value = '';
        render();
      } catch (error) {
        notify(errMsg(error), 'danger');
      }
    });
  }

  document.addEventListener('ts:ready', () => {
    render();
    bindAddForm();
    document.addEventListener('ts:changed', render);
  });

  window.TournamentAppInit('players').catch((error) => {
    if (window.TournamentApp) window.TournamentApp.fatalError(error);
  });
})();
