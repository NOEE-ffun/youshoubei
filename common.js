(function () {
  'use strict';

  const DB_NAME = 'tournament-site';
  const DB_VERSION = 1;
  const STORE = 'tournaments';
  const LS_ACTIVE = 'ts:activeTournamentId';
  const LS_SIDEBAR = 'ts:rulesSidebarHidden';
  const LS_ADMIN_TOKEN = 'ts:adminToken';

  const DEFAULT_RULES = [
    '8 人双败淘汰赛（BO3/BO5 混合赛制）',
    '',
    '1. 常规对局为三局两胜（BO3），比分只可能为 2:0、2:1、1:2、0:2；胜者组决赛、败者组决赛和总决赛为五局三胜（BO5），比分只可能为 3:0、3:1、3:2、2:3、1:3、0:3。',
    '2. 胜者组失利的选手进入败者组继续比赛；胜者组决赛的败者进入败者组决赛。',
    '3. 败者组再次失利即被淘汰。',
    '4. 总决赛由胜者组冠军对阵败者组冠军；胜者组冠军只需赢下一场 BO5 即可夺冠。',
    '5. 总决赛结束后依次决出冠军、亚军、季军（季军为败者组决赛败者）。'
  ].join('\n');

  let dbPromise = null;
  let appInstance = null;
  let mode = 'local';
  let cloudWorkspace = null;

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'id' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return dbPromise;
  }

  function idbPut(record) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }

  function idbGetAll() {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    }));
  }

  function idbDelete(id) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));
  }

  function makeDefaultTournament(name) {
    const now = Date.now();
    const players = Array.from({ length: 8 }, (_, i) => ({
      id: uid('p'),
      name: '选手 ' + (i + 1)
    }));
    return {
      id: uid('t'),
      name: (name && name.trim()) || '我的赛事',
      rules: DEFAULT_RULES,
      createdAt: now,
      updatedAt: now,
      players,
      scores: {},
      matchDecks: {},
      background: null
    };
  }

  /* ---------- 图片工具 ---------- */

  const urlCache = new WeakMap();

  function blobUrl(ref) {
    if (!ref) return '';
    if (typeof ref === 'string') return ref;
    let url = urlCache.get(ref);
    if (!url) {
      url = URL.createObjectURL(ref);
      urlCache.set(ref, url);
    }
    return url;
  }

  /* ---------- 云端存储适配 ---------- */

  async function detectMode() {
    let timer = null;
    try {
      const hasAbort = typeof AbortController !== 'undefined';
      const controller = hasAbort ? new AbortController() : null;
      timer = setTimeout(() => controller && controller.abort(), 2500);
      const response = await fetch('/api/health', controller ? { signal: controller.signal } : {});
      clearTimeout(timer);
      timer = null;
      if (!response.ok) return 'local';
      const data = await response.json().catch(() => ({}));
      return data && data.ok ? 'cloud' : 'local';
    } catch (error) {
      return 'local';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function apiErrorMessage(response) {
    try {
      const data = await response.json();
      return data && data.error ? String(data.error) : '';
    } catch (error) {
      return '';
    }
  }

  async function cloudGetWorkspace() {
    const response = await fetch('/api/data');
    if (response.status === 404) return { tournaments: [], activeId: null };
    if (!response.ok) throw new Error((await apiErrorMessage(response)) || '读取云端数据失败');
    return response.json();
  }

  /* 合并冲突消解：云端为底，本地记录按 id 覆盖，activeId 取本地 */
  function mergeWorkspace(latest, local) {
    const byId = new Map();
    for (const t of (latest && latest.tournaments) || []) byId.set(t.id, t);
    for (const t of (local && local.tournaments) || []) byId.set(t.id, t);
    return {
      activeId: (local && local.activeId) || (latest && latest.activeId) || null,
      tournaments: [...byId.values()]
    };
  }

  /* 云端写队列：同一页面内串行化，避免并发写乱序覆盖 */
  let cloudWriteQueue = Promise.resolve();

  async function cloudPutWorkspace(workspace, options) {
    if (!appInstance.adminToken) throw new Error('需要管理口令');
    const opts = options || {};
    const run = async () => {
      let payload = workspace;
      if (!opts.noMerge) {
        /* 写前合并：先拉取云端最新，避免过期快照覆盖其他页面的修改；
         * 读取失败则取消保存，绝不基于未知状态覆盖云端 */
        let latest;
        try {
          latest = await cloudGetWorkspace();
        } catch (error) {
          throw new Error('无法确认云端最新数据，已取消保存以免覆盖：' +
            (error && error.message ? error.message : error));
        }
        payload = mergeWorkspace(latest, workspace);
      }
      const response = await fetch('/api/data', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + appInstance.adminToken
        },
        body: JSON.stringify(payload)
      });
      if (response.status === 401) throw new Error('管理口令错误');
      if (!response.ok) throw new Error((await apiErrorMessage(response)) || '保存云端数据失败');
      /* 上传成功后本地快照与上传内容对齐 */
      cloudWorkspace = payload;
    };
    const result = cloudWriteQueue.then(run, run);
    cloudWriteQueue = result.catch(() => {});
    return result;
  }

  async function uploadCloudImage(blob) {
    if (!appInstance.adminToken) throw new Error('需要管理口令');
    const response = await fetch('/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': blob.type || 'application/octet-stream',
        'Authorization': 'Bearer ' + appInstance.adminToken
      },
      body: blob
    });
    if (response.status === 401) throw new Error('管理口令错误');
    if (!response.ok) throw new Error((await apiErrorMessage(response)) || '图片上传失败');
    const data = await response.json();
    return data.url;
  }

  async function storageGetAll() {
    if (mode === 'cloud') return cloudWorkspace ? cloudWorkspace.tournaments : [];
    return idbGetAll();
  }

  async function storagePut(record) {
    if (mode === 'cloud') {
      const tournaments = cloudWorkspace.tournaments;
      const index = tournaments.findIndex((t) => t.id === record.id);
      if (index >= 0) tournaments[index] = record;
      else tournaments.push(record);
      await cloudPutWorkspace(cloudWorkspace);
      return;
    }
    return idbPut(record);
  }

  async function storageDelete(id) {
    if (mode === 'cloud') {
      /* 基于云端最新数据删除（noMerge），避免删除“复活” */
      const latest = await cloudGetWorkspace();
      latest.tournaments = latest.tournaments.filter((t) => t.id !== id);
      if (latest.activeId === id) {
        latest.activeId = (latest.tournaments[0] || {}).id || null;
      }
      await cloudPutWorkspace(latest, { noMerge: true });
      cloudWorkspace = latest;
      return;
    }
    return idbDelete(id);
  }

  async function setActiveId(id) {
    /* activeId 先同步写入 localStorage（页面跳转/上传取消也不丢），
     * 云端上传异步进行；另一页面（主页/赛程）立即可读正确比赛 */
    localStorage.setItem(LS_ACTIVE, id);
    if (mode === 'cloud') {
      cloudWorkspace.activeId = id;
      if (appInstance.isAdmin()) await cloudPutWorkspace(cloudWorkspace);
    }
    await refreshApp();
  }

  function setAdminToken(token) {
    appInstance.adminToken = (token || '').trim();
    if (appInstance.adminToken) localStorage.setItem(LS_ADMIN_TOKEN, appInstance.adminToken);
    else localStorage.removeItem(LS_ADMIN_TOKEN);
  }

  function isAdmin() {
    return Boolean(appInstance && appInstance.adminToken);
  }

  async function migrateLocalToCloud() {
    const local = await idbGetAll();
    const tournaments = [];
    for (const record of local) {
      const copy = {
        ...record,
        background: record.background,
        players: record.players.map((player) => ({
          ...player,
          decks: Array.isArray(player.decks)
            ? player.decks.map((deck) => ({
                ...deck,
                images: Array.isArray(deck.images) ? deck.images.slice() : []
              }))
            : undefined
        }))
      };
      if (typeof BracketModel !== 'undefined' && BracketModel.ensureMatchDecks) {
        BracketModel.ensureMatchDecks(copy);
      }
      for (const player of copy.players) {
        if (player.avatar && typeof player.avatar !== 'string') {
          player.avatar = await uploadCloudImage(player.avatar);
        }
      }
      for (const player of copy.players) {
        delete player.decks;
      }
      for (const matchId of Object.keys(copy.matchDecks || {})) {
        for (const playerId of Object.keys(copy.matchDecks[matchId])) {
          for (const deck of copy.matchDecks[matchId][playerId]) {
            if (!Array.isArray(deck.images)) deck.images = [];
            for (let i = 0; i < deck.images.length; i += 1) {
              if (typeof deck.images[i] !== 'string') {
                deck.images[i] = await uploadCloudImage(deck.images[i]);
              }
            }
          }
        }
      }
      if (copy.background && typeof copy.background !== 'string') {
        copy.background = await uploadCloudImage(copy.background);
      }
      tournaments.push(copy);
    }

    const workspace = {
      tournaments,
      activeId: localStorage.getItem(LS_ACTIVE) || (tournaments[0] || {}).id || null
    };
    if (!workspace.tournaments.length) {
      const fresh = makeDefaultTournament('我的赛事');
      workspace.tournaments.push(fresh);
      workspace.activeId = fresh.id;
    }
    if (!workspace.activeId) workspace.activeId = workspace.tournaments[0].id;

    await cloudPutWorkspace(workspace);
    cloudWorkspace = workspace;
    await refreshApp();
    alert('已将 ' + workspace.tournaments.length + ' 场比赛上传到云端');
  }

  async function migrateCloudToLocal() {
    const workspace = await cloudGetWorkspace();
    for (const record of workspace.tournaments) {
      await idbPut(record);
    }
    const activeId = workspace.activeId || (workspace.tournaments[0] || {}).id;
    if (activeId) localStorage.setItem(LS_ACTIVE, activeId);
    alert('已从云端拉取 ' + workspace.tournaments.length + ' 场比赛到本机');
  }

  function compressImage(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type || !file.type.startsWith('image/')) {
        reject(new Error('请选择图片文件'));
        return;
      }
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, maxDim / Math.max(image.naturalWidth, image.naturalHeight));
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('图片压缩失败'));
        }, 'image/jpeg', quality || 0.85);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('无法读取图片'));
      };
      image.src = url;
    });
  }

  /* 头像压缩：中心裁切成 200×200 方形后转 JPEG */
  function compressAvatar(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type || !file.type.startsWith('image/')) {
        reject(new Error('请选择图片文件'));
        return;
      }
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        const size = Math.min(image.naturalWidth, image.naturalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = 200;
        canvas.height = 200;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image,
          (image.naturalWidth - size) / 2,
          (image.naturalHeight - size) / 2,
          size, size,
          0, 0, 200, 200);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('图片压缩失败'));
        }, 'image/jpeg', 0.85);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('无法读取图片'));
      };
      image.src = url;
    });
  }

  /* ---------- 灯箱 ---------- */

  let lightbox = null;
  let lightboxItems = [];
  let lightboxIndex = 0;
  let lightboxReturnFocus = null;
  let lightboxReturnCallback = null;

  function buildLightbox() {
    lightbox = document.createElement('div');
    lightbox.className = 'lightbox';
    lightbox.id = 'lightbox';
    lightbox.hidden = true;
    lightbox.innerHTML =
      '<img class="lightbox-img" alt="">' +
      '<button type="button" class="lightbox-btn lightbox-close" aria-label="关闭放大图">✕</button>' +
      '<button type="button" class="lightbox-btn lightbox-prev" aria-label="上一张">‹</button>' +
      '<button type="button" class="lightbox-btn lightbox-next" aria-label="下一张">›</button>';
    document.body.appendChild(lightbox);

    const img = lightbox.querySelector('.lightbox-img');
    const close = lightbox.querySelector('.lightbox-close');
    const prev = lightbox.querySelector('.lightbox-prev');
    const next = lightbox.querySelector('.lightbox-next');

    function show() {
      const item = lightboxItems[lightboxIndex];
      img.src = item.src;
      img.alt = item.alt || '';
      const hasMultiple = lightboxItems.length > 1;
      prev.hidden = !hasMultiple;
      next.hidden = !hasMultiple;
      lightbox.hidden = false;
    }

    function closeLightbox() {
      lightbox.hidden = true;
      img.src = '';
      const target = lightboxReturnFocus;
      lightboxReturnFocus = null;
      const callback = lightboxReturnCallback;
      lightboxReturnCallback = null;
      lightboxItems = [];
      if (target && document.contains(target)) target.focus();
      if (callback) callback();
    }

    function step(delta) {
      lightboxIndex = (lightboxIndex + delta + lightboxItems.length) % lightboxItems.length;
      show();
    }

    close.addEventListener('click', closeLightbox);
    prev.addEventListener('click', () => step(-1));
    next.addEventListener('click', () => step(1));
    lightbox.addEventListener('click', (event) => {
      if (event.target === lightbox) closeLightbox();
    });
    document.addEventListener('keydown', (event) => {
      if (lightbox.hidden) return;
      if (event.key === 'Escape') closeLightbox();
      if (event.key === 'ArrowLeft') step(-1);
      if (event.key === 'ArrowRight') step(1);
    });

    lightbox.__show = show;
    lightbox.__close = closeLightbox;
  }

  function openLightbox(items, index, returnFocus, onClose) {
    if (!lightbox) buildLightbox();
    lightboxItems = items;
    lightboxIndex = Math.max(0, Math.min(index || 0, items.length - 1));
    lightboxReturnFocus = returnFocus || null;
    lightboxReturnCallback = typeof onClose === 'function' ? onClose : null;
    lightbox.__show();
    lightbox.querySelector('.lightbox-close').focus();
  }

  /* ---------- 弹窗 ---------- */

  let manageDialog = null;
  let settingsDialog = null;
  let pendingBackground = null;

  function buildDialogs() {
    if (manageDialog) return;

    manageDialog = document.createElement('dialog');
    manageDialog.id = 'manage-dialog';
    manageDialog.setAttribute('aria-labelledby', 'manage-title');
    manageDialog.innerHTML =
      '<div class="dialog-head">' +
      '  <h2 id="manage-title">比赛管理</h2>' +
      '  <button type="button" class="btn btn-ghost btn-sm" data-dialog-close>关闭</button>' +
      '</div>' +
      '<div class="dialog-body">' +
      '  <form id="create-tournament-form" class="dialog-actions">' +
      '    <label class="visually-hidden" for="new-tournament-name">新比赛名称</label>' +
      '    <input type="text" id="new-tournament-name" placeholder="新比赛名称" required>' +
      '    <button type="submit" class="btn btn-primary btn-sm">新建比赛</button>' +
      '  </form>' +
      '  <div id="manage-list" class="manage-list" aria-label="已有比赛列表"></div>' +
      '</div>';
    document.body.appendChild(manageDialog);

    settingsDialog = document.createElement('dialog');
    settingsDialog.id = 'settings-dialog';
    settingsDialog.setAttribute('aria-labelledby', 'settings-title');
    settingsDialog.innerHTML =
      '<div class="dialog-head">' +
      '  <h2 id="settings-title">赛事设置</h2>' +
      '  <button type="button" class="btn btn-ghost btn-sm" data-dialog-close>关闭</button>' +
      '</div>' +
      '<form id="settings-form">' +
      '  <div class="dialog-body">' +
      '    <div class="form-field">' +
      '      <label for="settings-name">比赛名称</label>' +
      '      <input type="text" id="settings-name" required>' +
      '    </div>' +
      '    <div class="form-field">' +
      '      <label for="settings-rules">赛制规则</label>' +
      '      <textarea id="settings-rules"></textarea>' +
      '    </div>' +
      '    <div class="form-field">' +
      '      <span id="bg-label">背景图片</span>' +
      '      <div class="bg-controls">' +
      '        <div class="bg-preview" id="bg-preview" role="img" aria-label="背景图预览"></div>' +
      '        <button type="button" id="bg-upload" class="btn btn-secondary btn-sm" aria-describedby="bg-hint">上传背景</button>' +
      '        <button type="button" id="bg-remove" class="btn btn-danger btn-sm">移除背景</button>' +
      '      </div>' +
      '      <p class="hint" id="bg-hint">支持常见图片格式，上传后自动压缩至最长边 1920px。</p>' +
      '    </div>' +
      '    <div class="form-field" id="admin-field" hidden>' +
      '      <label for="settings-admin-token">管理口令</label>' +
      '      <div class="admin-controls">' +
      '        <input type="password" id="settings-admin-token" autocomplete="off" placeholder="输入部署时设置的口令">' +
      '        <button type="button" id="admin-unlock" class="btn btn-secondary btn-sm">解锁</button>' +
      '      </div>' +
      '      <p class="hint" id="admin-status"></p>' +
      '      <div class="dialog-actions" id="migration-actions" hidden>' +
      '        <button type="button" id="migrate-up" class="btn btn-secondary btn-sm">将本机数据上传到云端</button>' +
      '        <button type="button" id="migrate-down" class="btn btn-secondary btn-sm">从云端拉取覆盖本机</button>' +
      '      </div>' +
      '    </div>' +
      '    <div class="dialog-actions">' +
      '      <button type="button" class="btn btn-secondary" data-dialog-close>取消</button>' +
      '      <button type="submit" class="btn btn-primary">保存</button>' +
      '    </div>' +
      '  </div>' +
      '</form>' +
      '<input type="file" id="bg-file-input" accept="image/*" hidden>';
    document.body.appendChild(settingsDialog);

    for (const dialog of [manageDialog, settingsDialog]) {
      dialog.querySelectorAll('[data-dialog-close]').forEach((btn) => {
        btn.addEventListener('click', () => dialog.close());
      });
    }

    manageDialog.querySelector('#create-tournament-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = manageDialog.querySelector('#new-tournament-name');
      const name = input.value.trim() || '我的赛事';
      const record = makeDefaultTournament(name);
      try {
        await storagePut(record);
      } catch (error) {
        alert('新建比赛失败：' + (error && error.message ? error.message : error));
        return;
      }
      await setActiveId(record.id);
      input.value = '';
      renderManageList();
      document.dispatchEvent(new CustomEvent('ts:changed'));
    });

    settingsDialog.querySelector('#settings-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (mode === 'cloud' && !appInstance.isAdmin()) {
        alert('请先输入管理口令并解锁');
        return;
      }
      const record = appInstance.current;
      const nameInput = settingsDialog.querySelector('#settings-name');
      const rulesInput = settingsDialog.querySelector('#settings-rules');
      record.name = nameInput.value.trim() || '我的赛事';
      record.rules = rulesInput.value;
      if (pendingBackground !== undefined) {
        record.background = pendingBackground;
      }
      pendingBackground = undefined;
      try {
        await storagePut(record);
      } catch (error) {
        alert('保存设置失败：' + (error && error.message ? error.message : error));
        return;
      }
      applyBackground(record);
      renderHeader();
      settingsDialog.close();
      document.dispatchEvent(new CustomEvent('ts:changed'));
    });

    settingsDialog.querySelector('#bg-upload').addEventListener('click', () => {
      settingsDialog.querySelector('#bg-file-input').click();
    });
    settingsDialog.querySelector('#bg-remove').addEventListener('click', () => {
      pendingBackground = null;
      const preview = settingsDialog.querySelector('#bg-preview');
      preview.style.backgroundImage = '';
      preview.setAttribute('aria-label', '背景图预览（无图）');
    });
    settingsDialog.querySelector('#bg-file-input').addEventListener('change', async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      try {
        let image = await compressImage(file, 1920);
        if (mode === 'cloud') image = await uploadCloudImage(image);
        pendingBackground = image;
        const preview = settingsDialog.querySelector('#bg-preview');
        preview.style.backgroundImage = 'url(' + blobUrl(pendingBackground) + ')';
        preview.setAttribute('aria-label', '背景图预览');
      } catch (error) {
        alert(error.message);
      } finally {
        event.target.value = '';
      }
    });

    settingsDialog.querySelector('#admin-unlock').addEventListener('click', async () => {
      const input = settingsDialog.querySelector('#settings-admin-token');
      const status = settingsDialog.querySelector('#admin-status');
      setAdminToken(input.value);
      if (!appInstance.adminToken) {
        status.textContent = '已清除口令';
        syncSettingsAdminState(true);
        renderHeader();
        document.dispatchEvent(new CustomEvent('ts:changed'));
        return;
      }
      if (!cloudWorkspace) {
        status.textContent = '云端数据未就绪';
        syncSettingsAdminState(true);
        return;
      }
      try {
        await cloudPutWorkspace(cloudWorkspace);
        status.textContent = '口令正确，已解锁';
        renderHeader();
        document.dispatchEvent(new CustomEvent('ts:changed'));
      } catch (error) {
        setAdminToken('');
        input.value = '';
        status.textContent = error.message;
      }
      syncSettingsAdminState(true);
    });

    settingsDialog.querySelector('#migrate-up').addEventListener('click', async () => {
      try {
        await migrateLocalToCloud();
        syncSettingsAdminState();
      } catch (error) {
        alert(error.message);
      }
    });

    settingsDialog.querySelector('#migrate-down').addEventListener('click', async () => {
      try {
        await migrateCloudToLocal();
      } catch (error) {
        alert(error.message);
      }
    });
  }

  function syncSettingsAdminState(preserveStatus) {
    if (!settingsDialog) return;
    const admin = mode !== 'cloud' || appInstance.isAdmin();
    const adminField = settingsDialog.querySelector('#admin-field');
    const tokenInput = settingsDialog.querySelector('#settings-admin-token');
    const status = settingsDialog.querySelector('#admin-status');
    const migration = settingsDialog.querySelector('#migration-actions');
    const fields = [
      settingsDialog.querySelector('#settings-name'),
      settingsDialog.querySelector('#settings-rules'),
      settingsDialog.querySelector('#bg-upload'),
      settingsDialog.querySelector('#bg-remove'),
      settingsDialog.querySelector('#settings-form').querySelector('button[type="submit"]')
    ];

    adminField.hidden = mode !== 'cloud';
    if (mode === 'cloud') {
      tokenInput.value = appInstance.adminToken;
      if (!preserveStatus) {
        status.textContent = appInstance.isAdmin() ? '已解锁' : '未解锁，编辑功能已锁定';
      }
      migration.hidden = !appInstance.isAdmin();
    }
    for (const field of fields) field.disabled = !admin;
  }

  function renderManageList() {
    if (!manageDialog) return;
    const list = manageDialog.querySelector('#manage-list');
    const all = window.TournamentApp.list;
    list.innerHTML = all.map((item) => {
      const active = item.id === window.TournamentApp.current.id;
      return (
        '<div class="manage-item' + (active ? ' is-active' : '') + '">' +
        (active ? '<span class="active-badge">当前</span>' : '') +
        '<input class="manage-item-name" value="' + escapeHtml(item.name) + '" aria-label="比赛名称">' +
        '<button type="button" class="btn btn-secondary btn-sm" data-switch="' + item.id + '">切换</button>' +
        '<button type="button" class="btn btn-danger btn-sm" data-delete="' + item.id + '">删除</button>' +
        '</div>'
      );
    }).join('');

    list.querySelectorAll('.manage-item-name').forEach((input) => {
      input.addEventListener('change', async () => {
        const id = input.closest('.manage-item').querySelector('[data-switch]').dataset.switch;
        const record = await storageGetAll().then((all) => all.find((t) => t.id === id));
        if (!record) return;
        record.name = input.value.trim() || record.name;
        try {
          await storagePut(record);
        } catch (error) {
          alert('重命名失败：' + (error && error.message ? error.message : error));
          return;
        }
        await refreshApp();
        renderManageList();
        document.dispatchEvent(new CustomEvent('ts:changed'));
      });
    });

    list.querySelectorAll('[data-switch]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await setActiveId(btn.dataset.switch);
        renderManageList();
        document.dispatchEvent(new CustomEvent('ts:changed'));
      });
    });

    list.querySelectorAll('[data-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.delete;
        const item = window.TournamentApp.list.find((t) => t.id === id);
        if (!item) return;
        if (!confirm('确定删除比赛「' + item.name + '」吗？该操作不可恢复。')) return;
        try {
          await storageDelete(id);
        } catch (error) {
          alert('删除失败：' + (error && error.message ? error.message : error));
          return;
        }
        const remaining = (await storageGetAll());
        if (!remaining.length) {
          const fresh = makeDefaultTournament('我的赛事');
          try {
            await storagePut(fresh);
          } catch (error) {
            alert('新建默认比赛失败：' + (error && error.message ? error.message : error));
            return;
          }
          remaining.push(fresh);
        }
        if (id === window.TournamentApp.current.id) {
          await setActiveId(remaining[0].id);
        } else {
          await refreshApp();
        }
        renderManageList();
        document.dispatchEvent(new CustomEvent('ts:changed'));
      });
    });
  }

  function openManageDialog() {
    buildDialogs();
    renderManageList();
    manageDialog.showModal();
  }

  function openSettingsDialog(focusRules) {
    buildDialogs();
    const record = window.TournamentApp.current;
    const nameInput = settingsDialog.querySelector('#settings-name');
    const rulesInput = settingsDialog.querySelector('#settings-rules');
    const preview = settingsDialog.querySelector('#bg-preview');
    nameInput.value = record.name;
    rulesInput.value = record.rules || '';
    pendingBackground = undefined;
    if (record.background) {
      preview.style.backgroundImage = 'url(' + blobUrl(record.background) + ')';
      preview.setAttribute('aria-label', '背景图预览');
    } else {
      preview.style.backgroundImage = '';
      preview.setAttribute('aria-label', '背景图预览（无图）');
    }
    syncSettingsAdminState();
    settingsDialog.showModal();
    if (focusRules) {
      rulesInput.focus();
    } else {
      nameInput.focus();
      nameInput.select();
    }
  }

  /* ---------- 背景与页头 ---------- */

  /* 头像 HTML：有图显示图片，无图显示首字符占位（颜色按选手 id 确定性取） */
  function avatarMarkup(player, sizeClass) {
    const cls = 'avatar ' + sizeClass;
    if (player && player.avatar) {
      return '<img class="' + cls + '" src="' + blobUrl(player.avatar) + '"' +
        ' alt="' + escapeHtml(player.name || '') + ' 的头像">';
    }
    const initial = String((player && player.name) || '?').trim().charAt(0) || '?';
    const color = (typeof BracketModel !== 'undefined' && BracketModel.avatarColor)
      ? BracketModel.avatarColor(player ? player.id : '')
      : '#3563e9';
    return '<span class="' + cls + ' avatar-fallback" style="background:' + color + '">' +
      escapeHtml(initial) + '</span>';
  }
  /* 跨文件暴露：bracket.js（选手名单）与 deck-modal.js（卡组弹窗）渲染头像 */
  window.avatarMarkup = avatarMarkup;

  function applyBackground(record) {
    const layer = document.getElementById('bg-layer');
    if (!layer) return;
    if (record && record.background) {
      layer.style.backgroundImage = 'url(' + blobUrl(record.background) + ')';
    } else {
      layer.style.backgroundImage = '';
    }
  }

  function renderHeader() {
    const app = window.TournamentApp;
    const placeholder = document.getElementById('app-header');
    if (!placeholder) return;
    const active = app.current;
    const options = app.list.map((item) =>
      '<option value="' + item.id + '"' + (item.id === active.id ? ' selected' : '') + '>' +
      escapeHtml(item.name) +
      '</option>'
    ).join('');
    placeholder.innerHTML =
      '<div class="header-inner">' +
      '  <a class="brand" href="index.html">赛制面板</a>' +
      '  <span class="header-title" title="' + escapeHtml(active.name) + '">' + escapeHtml(active.name) + '</span>' +
      '  <nav class="main-nav" aria-label="页面导航">' +
      '    <a href="index.html" data-page="home">主页</a>' +
      '    <a href="schedule.html" data-page="schedule">赛程</a>' +
      '  </nav>' +
      '  <div class="header-actions">' +
      '    <label class="visually-hidden" for="tournament-switch">切换比赛</label>' +
      '    <select id="tournament-switch" class="header-select" title="切换比赛">' + options + '</select>' +
      '    <button type="button" id="manage-btn" class="btn btn-secondary btn-sm">管理</button>' +
      '    <button type="button" id="settings-btn" class="btn btn-secondary btn-sm">设置</button>' +
      '  </div>' +
      '</div>';

    const currentLink = placeholder.querySelector('.main-nav a[data-page="' + app.activePage + '"]');
    if (currentLink) currentLink.setAttribute('aria-current', 'page');

    placeholder.querySelector('#tournament-switch').addEventListener('change', async (event) => {
      await setActiveId(event.target.value);
      document.dispatchEvent(new CustomEvent('ts:changed'));
    });
    const manageBtn = placeholder.querySelector('#manage-btn');
    manageBtn.hidden = mode === 'cloud' && !appInstance.isAdmin();
    placeholder.querySelector('#manage-btn').addEventListener('click', openManageDialog);
    placeholder.querySelector('#settings-btn').addEventListener('click', () => openSettingsDialog(false));
  }

  /* ---------- 主流程 ---------- */

  async function ensureFirstTournament() {
    const all = await idbGetAll();
    if (!all.length) {
      const record = makeDefaultTournament('我的赛事');
      await idbPut(record);
      localStorage.setItem(LS_ACTIVE, record.id);
      return;
    }
    const activeId = localStorage.getItem(LS_ACTIVE);
    if (!activeId || !all.some((t) => t.id === activeId)) {
      localStorage.setItem(LS_ACTIVE, all[0].id);
    }
  }

  async function refreshApp() {
    const all = await storageGetAll();
    /* activeId 优先取 localStorage（本机最近切换，即时一致），云端兜底（跨设备） */
    const activeId = mode === 'cloud'
      ? (localStorage.getItem(LS_ACTIVE) || (cloudWorkspace && cloudWorkspace.activeId))
      : localStorage.getItem(LS_ACTIVE);
    const record = all.find((t) => t.id === activeId) || all[0];
    if (record && typeof BracketModel !== 'undefined' && BracketModel.ensureMatchDecks) {
      BracketModel.ensureMatchDecks(record);
    }
    appInstance.current = record;
    appInstance.list = all.map((t) => ({ id: t.id, name: t.name, updatedAt: t.updatedAt }));
    applyBackground(record);
    renderHeader();
    return record;
  }

  function sidebarHidden() {
    return localStorage.getItem(LS_SIDEBAR) === '1';
  }

  function setSidebarHidden(hidden) {
    localStorage.setItem(LS_SIDEBAR, hidden ? '1' : '0');
  }

  async function init(activePage) {
    appInstance = {
      activePage,
      current: null,
      list: [],
      mode: 'local',
      adminToken: localStorage.getItem(LS_ADMIN_TOKEN) || '',
      uid,
      blobUrl,
      compressImage,
      compressAvatar,
      openLightbox,
      openSettings: openSettingsDialog,
      openManage: openManageDialog,
      sidebarHidden,
      setSidebarHidden,
      idbPut: storagePut,
      idbGetAll: storageGetAll,
      idbDelete: storageDelete,
      isAdmin,
      setAdminToken,
      setActiveId,
      uploadImage: uploadCloudImage,
      migrateLocalToCloud,
      migrateCloudToLocal
    };
    window.TournamentApp = appInstance;
    mode = await detectMode();
    if (mode === 'cloud') {
      try {
        cloudWorkspace = await cloudGetWorkspace();
        if (!cloudWorkspace.tournaments || !cloudWorkspace.tournaments.length) {
          const fresh = makeDefaultTournament('我的赛事');
          cloudWorkspace = { tournaments: [fresh], activeId: fresh.id };
        }
        if (!cloudWorkspace.activeId || !cloudWorkspace.tournaments.some((t) => t.id === cloudWorkspace.activeId)) {
          cloudWorkspace.activeId = cloudWorkspace.tournaments[0].id;
        }
      } catch (error) {
        mode = 'local';
        cloudWorkspace = null;
      }
    }
    /* 仅本地模式需要本地兜底初始化；云端模式不得触碰 localStorage/IndexedDB，
     * 否则会覆盖用户刚切换的 activeId（主页/赛程显示错乱） */
    if (mode === 'local') {
      await ensureFirstTournament();
    }
    appInstance.mode = mode;
    await refreshApp();
    document.dispatchEvent(new CustomEvent('ts:ready'));
  }

  window.TournamentAppInit = init;
})();
