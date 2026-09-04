(function () {
  'use strict';

  const { escapeHtml, canEdit, avatarMarkup, notify, errMsg, uiConfirm, formatStartTime } = window.TournamentUtils;

  let fileInput = null;
  let pendingPlayerId = null;
  let filterText = '';

  /* 页头搜索:按名称/队伍 ID 过滤行(不区分大小写);render 后重放 */
  function applyFilter() {
    const grid = document.getElementById('players-grid');
    if (!grid || !filterText) return;
    const needle = filterText;
    grid.querySelectorAll('tbody tr').forEach((tr) => {
      const nameInput = tr.querySelector('.col-name input');
      const name = nameInput ? nameInput.value : '';
      const tag = (tr.querySelector('.col-tag') || {}).textContent || '';
      tr.hidden = !(name.toLowerCase().includes(needle) || tag.toLowerCase().includes(needle));
    });
  }

  function bindSearch() {
    const input = document.getElementById('players-search');
    if (!input) return;
    input.addEventListener('input', () => {
      filterText = input.value.trim().toLowerCase();
      const grid = document.getElementById('players-grid');
      grid.querySelectorAll('tbody tr').forEach((tr) => { tr.hidden = false; });
      applyFilter();
    });
  }

  /* 数据库式紧凑表格:一行一选手,列=头像/名称(行内改)/队伍ID/垃圾话/颜色/加入/操作。
   * 头像即上传入口(编辑态,铅笔角标提示);删除收进操作列,不再与内容抢权重 */
  function render() {
    const app = window.TournamentApp;
    const grid = document.getElementById('players-grid');
    if (!grid) return;
    const editable = canEdit();
    const banner = document.getElementById('players-lock-banner');
    if (banner) banner.hidden = editable;
    const players = app.players || [];
    if (!players.length) {
      grid.innerHTML = '<p class="hint">' + (editable ? '暂无选手，先新增一位。' : '暂无选手。') + '</p>';
      syncAddFormAccess();
      return;
    }
    const EMPTY = '<span class="td-empty">—</span>';
    const rows = players.map((p) => {
      const avatar = avatarMarkup(p, 'avatar avatar-td');
      const avatarCell = editable
        ? '<button type="button" class="avatar-btn" data-avatar-upload="' + p.id + '"' +
          ' title="' + (p.avatar ? '更换' : '上传') + '头像" aria-label="' + (p.avatar ? '更换' : '上传') + escapeHtml(p.name) + '的头像">' +
          avatar + '<img class="icon avatar-edit" src="icons/upload.svg" alt="" aria-hidden="true"></button>'
        : avatar;
      const tagCell = (p.tagImg ? '<img class="tag-img" src="' + escapeHtml(p.tagImg) + '" alt="" aria-hidden="true">' : '') +
        (p.tag ? escapeHtml(p.tag) : EMPTY);
      return '<tr>' +
        '<td class="col-avatar">' + avatarCell + '</td>' +
        '<td class="col-name"><input class="player-name-input" data-player-name="' + p.id + '"' +
        ' value="' + escapeHtml(p.name) + '" aria-label="' + escapeHtml(p.name) + ' 的名称"' +
        (editable ? '' : ' disabled') + ' autocomplete="off"></td>' +
        '<td class="col-tag">' + tagCell + '</td>' +
        '<td class="col-title">' + (p.title ? escapeHtml(p.title) : EMPTY) + '</td>' +
        '<td class="col-color">' + (p.color ? '<span class="color-dot" style="background:' + escapeHtml(p.color) + '" title="' + escapeHtml(p.color) + '"></span>' : EMPTY) + '</td>' +
        '<td class="col-joined">' + (p.createdAt ? escapeHtml(formatStartTime(p.createdAt)) : EMPTY) + '</td>' +
        (editable
          ? '<td class="col-actions"><button type="button" class="row-del" data-delete-player="' + p.id + '" title="删除选手" aria-label="删除选手 ' + escapeHtml(p.name) + '"><img class="icon" src="icons/delete.svg" alt="" aria-hidden="true"></button></td>'
          : '') +
        '</tr>';
    }).join('');
    grid.innerHTML =
      '<div class="players-table-wrap"><table class="players-table">' +
      '<thead><tr>' +
      '<th class="col-avatar" scope="col">头像</th>' +
      '<th class="col-name" scope="col">名称</th>' +
      '<th class="col-tag" scope="col">队伍 ID</th>' +
      '<th class="col-title" scope="col">垃圾话</th>' +
      '<th class="col-color" scope="col">颜色</th>' +
      '<th class="col-joined" scope="col">加入</th>' +
      (editable ? '<th class="col-actions" scope="col">操作</th>' : '') +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';

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
          notify('已保存');
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

    applyFilter();
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

  /* 选手库新增表单绑定:本机模式专用(云模式表单由 common.js 隐藏,选手只由注册产生) */
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
        id: CanvasModel.uid('p'),
        name,
        title: '',
        tag: '',
        tagImg: null,
        tagImgRatio: null,
        tagImgSize: null,
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
    bindSearch();
    document.addEventListener('ts:changed', render);
  });

  window.TournamentAppInit('players').catch((error) => {
    if (window.TournamentApp) window.TournamentApp.fatalError(error);
  });
})();
