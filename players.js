(function () {
  'use strict';

  const { escapeHtml, canEdit, avatarMarkup, notify, errMsg, uiConfirm } = window.TournamentUtils;

  let fileInput = null;
  let pendingPlayerId = null;
  let titleFileInput = null;
  let pendingTitlePlayerId = null;

  /* 选手自定义色；未设置时回退按 id 确定性取的默认色（与头像占位一致） */
  function playerColor(p) {
    if (p && /^#[0-9a-fA-F]{6}$/.test(p.color || '')) return p.color;
    return (window.CanvasModel && window.CanvasModel.avatarColor)
      ? window.CanvasModel.avatarColor(p ? p.id : '')
      : '#3563e9';
  }

  /* 选手称号（title）对象兜底：缺失/非法时回退为纯文本 */
  function titleOf(p) {
    const t = (p && p.title && typeof p.title === 'object' && !Array.isArray(p.title)) ? p.title : null;
    if (!t) return { type: 'text', text: '', image: null };
    return {
      type: t.type === 'image' ? 'image' : 'text',
      text: typeof t.text === 'string' ? t.text : '',
      image: (t.image == null || typeof t.image === 'string' || typeof t.image === 'object')
        ? (t.image == null ? null : t.image)
        : null
    };
  }

  function render() {
    const app = window.TournamentApp;
    const grid = document.getElementById('players-grid');
    if (!grid) return;
    const editable = canEdit();
    const banner = document.getElementById('players-lock-banner');
    if (banner) banner.hidden = editable;
    const players = app.players || [];
    grid.innerHTML = players.map((p) => {
      const color = playerColor(p);
      const hasCustomColor = /^#[0-9a-fA-F]{6}$/.test(p.color || '');
      const title = titleOf(p);
      const isImageTitle = title.type === 'image' && title.image != null;
      return '<div class="player-card">' +
        '<div class="player-card-avatar">' +
        avatarMarkup(p, 'avatar-lg') +
        (editable ? '<button type="button" class="avatar-action" data-avatar-upload="' + p.id + '">' + (p.avatar ? '更换' : '上传') + '</button>' : '') +
        '</div>' +
        '<input class="player-card-name" data-player-name="' + p.id + '" value="' + escapeHtml(p.name) + '"' +
        (editable ? '' : ' disabled') + ' autocomplete="off" aria-label="选手名称">' +
        '<div class="player-card-title-wrap">' +
        (isImageTitle
          ? '<span class="player-card-title-badge">[图片]</span>'
          : '<input class="player-card-title" data-player-title="' + p.id + '" value="' + escapeHtml(title.text) + '"' +
            ' placeholder="称号" maxlength="16" aria-label="称号"' +
            (editable ? '' : ' disabled') + ' autocomplete="off">') +
        (editable
          ? (isImageTitle
            ? '<button type="button" class="player-card-title-remove" data-player-title-remove="' + p.id + '" title="移除称号图片">✕</button>'
            : '<button type="button" class="player-card-title-img" data-player-title-img="' + p.id + '" title="上传称号图片">🖼</button>')
          : '') +
        '</div>' +
        '<div class="player-card-color">' +
        '<span class="player-card-color-dot" aria-hidden="true" style="background:' + color + '"></span>' +
        '<input type="color" class="player-card-color-input" data-player-color="' + p.id + '" value="' + color + '"' +
        ' aria-label="选手颜色" title="自定义颜色（用于头像与海报）"' +
        (editable ? '' : ' disabled') + '>' +
        (editable
          ? '<button type="button" class="player-card-color-clear" data-player-color-clear="' + p.id + '" title="恢复默认颜色"' +
            (hasCustomColor ? '' : ' hidden') + '>默认</button>'
          : '') +
        '</div>' +
        (editable ? '<button type="button" class="btn btn-danger btn-sm" data-delete-player="' + p.id + '">删除</button>' : '') +
        '</div>';
    }).join('') || '<p class="hint">暂无选手，先新增一位。</p>';

    const savePlayers = () => app.storagePutPlayers(app.players)
      .catch((error) => notify(errMsg(error), 'danger'));

    function bindPlayerText(selector, datasetKey, field, required) {
      grid.querySelectorAll(selector).forEach((input) => {
        input.addEventListener('change', () => {
          const p = (app.players || []).find((x) => x.id === input.dataset[datasetKey]);
          if (!p) return;
          const next = input.value.trim();
          if (required && !next) {
            input.value = p[field];
            return;
          }
          p[field] = next;
          p.updatedAt = Date.now();
          savePlayers();
        });
      });
    }
    bindPlayerText('[data-player-name]', 'playerName', 'name', true);

    grid.querySelectorAll('[data-player-title]').forEach((input) => {
      input.addEventListener('change', () => {
        const p = (app.players || []).find((x) => x.id === input.dataset.playerTitle);
        if (!p) return;
        p.title = { type: 'text', text: input.value.trim(), image: null };
        p.updatedAt = Date.now();
        savePlayers();
      });
    });

    grid.querySelectorAll('[data-player-title-img]').forEach((btn) => {
      btn.addEventListener('click', () => {
        pendingTitlePlayerId = btn.dataset.playerTitleImg;
        ensureTitleFileInput().click();
      });
    });

    grid.querySelectorAll('[data-player-title-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = (app.players || []).find((x) => x.id === btn.dataset.playerTitleRemove);
        if (!p) return;
        p.title = { type: 'text', text: '', image: null };
        p.updatedAt = Date.now();
        savePlayers();
        render();
      });
    });

    grid.querySelectorAll('[data-player-color]').forEach((input) => {
      input.addEventListener('change', () => {
        const p = (app.players || []).find((x) => x.id === input.dataset.playerColor);
        if (!p) return;
        p.color = /^#[0-9a-fA-F]{6}$/.test(input.value) ? input.value : null;
        p.updatedAt = Date.now();
        savePlayers();
        // 即时同步色点与「默认」按钮显隐，避免整卡重建
        const card = input.closest('.player-card');
        if (card) {
          const dot = card.querySelector('.player-card-color-dot');
          if (dot) dot.style.background = p.color || playerColor(p);
          const clear = card.querySelector('[data-player-color-clear]');
          if (clear) clear.hidden = !p.color;
        }
      });
    });

    grid.querySelectorAll('[data-player-color-clear]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = (app.players || []).find((x) => x.id === btn.dataset.playerColorClear);
        if (!p) return;
        p.color = null;
        p.updatedAt = Date.now();
        savePlayers();
        render();
      });
    });

    grid.querySelectorAll('[data-delete-player]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.deletePlayer;
        if (!(await uiConfirm('确定从选手库删除该选手吗？历史比赛记录不会被删除，但该选手会显示为“待定”。'))) return;
        try {
          // 使用专门删除方法：云端采用 noMerge 精确删除，避免刷新后选手复活
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

  function ensureTitleFileInput() {
    if (titleFileInput) return titleFileInput;
    titleFileInput = document.createElement('input');
    titleFileInput.type = 'file';
    titleFileInput.accept = 'image/*';
    titleFileInput.hidden = true;
    document.body.appendChild(titleFileInput);
    titleFileInput.addEventListener('change', async () => {
      const file = titleFileInput.files && titleFileInput.files[0];
      titleFileInput.value = '';
      const id = pendingTitlePlayerId;
      pendingTitlePlayerId = null;
      if (!file || !id) return;
      const app = window.TournamentApp;
      const p = (app.players || []).find((x) => x.id === id);
      if (!p) return;
      try {
        const blob = await app.compressImage(file, 160, 0.9);
        const image = app.mode === 'cloud' ? await app.uploadImage(blob) : blob;
        p.title = { type: 'image', text: '', image };
        p.updatedAt = Date.now();
        await app.storagePutPlayers(app.players);
        render();
      } catch (error) {
        notify(errMsg(error), 'danger');
      }
    });
    return titleFileInput;
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
        title: { type: 'text', text: '', image: null },
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
