(function () {
  'use strict';

  const DB_NAME = 'tournament-site';
  const DB_VERSION = 2;
  const STORE = 'tournaments';
  const META_STORE = 'meta';
  const META_PLAYERS = 'globalPlayers';
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
  let cloudFallbackReason = null;

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(META_STORE)) {
            db.createObjectStore(META_STORE, { keyPath: 'key' });
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

  function idbGetMeta(key) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readonly');
      const request = tx.objectStore(META_STORE).get(key);
      request.onsuccess = () => resolve(request.result ? request.result.value : null);
      request.onerror = () => reject(request.error);
    }));
  }

  function idbPutMeta(key, value) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readwrite');
      tx.objectStore(META_STORE).put({ key, value });
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

  function iconMarkup(name, alt) {
    return '<img class="icon" src="icons/' + escapeHtml(name) + '.svg" alt="' +
      escapeHtml(alt || '') + '" aria-hidden="true">';
  }

  function errMsg(error) {
    return error && error.message ? error.message : String(error);
  }

  /* 图片 URL 白名单：仅放行本地 Blob、HTTPS 与 data:image（云端数据可能被篡改，
   * 异常协议或带引号的 URL 不得进入属性或 CSS url()） */
  function safeUrl(url) {
    const value = String(url || '').trim();
    if (!/^(blob:|https:|data:image\/)/i.test(value)) return '';
    return value;
  }

  /* CSS url() 包装：白名单校验后剔除各类引号与反斜杠，防止逃逸出字符串。
   * 用单引号包裹——deck-modal 会把结果拼进双引号 HTML 属性，
   * 双引号会提前截断属性值（卡组缩略图曾因此全部失效） */
  function cssUrl(url) {
    return "url('" + safeUrl(url).replace(/["'\\]/g, '') + "')";
  }

  function makeDefaultPlayers() {
    return Array.from({ length: 8 }, (_, i) => ({
      id: uid('p'),
      name: '选手 ' + (i + 1),
      avatar: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }));
  }

  function makeDefaultTournament(name, roster) {
    const r = roster || [];
    const record = (typeof CanvasModel !== 'undefined' && CanvasModel.createDefaultTournament)
      ? CanvasModel.createDefaultTournament(name, r)
      : {
          id: uid('t'),
          name: (name && name.trim()) || '我的赛事',
          status: 'upcoming',
          startTime: null,
          liveUrl: '',
          rules: DEFAULT_RULES,
          background: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          roster: r.slice(),
          canvas: { cards: [] },
          scores: {},
          matchDecks: {}
        };
    record.rules = DEFAULT_RULES;
    return record;
  }

  function makeBlankTournament(name) {
    const record = (typeof CanvasModel !== 'undefined' && CanvasModel.createBlankTournament)
      ? CanvasModel.createBlankTournament(name)
      : makeDefaultTournament(name, []);
    record.rules = DEFAULT_RULES;
    return record;
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

  /* 一次请求同时完成模式探测与云端取数:拿到合法 workspace 即云端模式;
   * 404(未部署 API)/超时/网络错误 → 本机模式,省掉原先 /api/health 的串行往返 */
  async function probeCloud() {
    let timer = null;
    try {
      const hasAbort = typeof AbortController !== 'undefined';
      const controller = hasAbort ? new AbortController() : null;
      timer = setTimeout(() => controller && controller.abort(), 2000);
      const response = await fetch('/api/data', controller ? { signal: controller.signal } : {});
      clearTimeout(timer);
      timer = null;
      if (!response.ok) {
        if (response.status >= 500) {
          const message = await apiErrorMessage(response).catch(() => '');
          cloudFallbackReason = message ? ('云端数据读取失败:' + message) : '云端数据读取失败';
        }
        return null;
      }
      const workspace = await response.json();
      if (!workspace || !Array.isArray(workspace.tournaments)) return null;
      return workspace;
    } catch (error) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /* 补齐 workspace 缺省字段:players/tournaments 为空时造默认数据,activeId 兜底到第一场 */
  function normalizeWorkspace(workspace) {
    if (!workspace.players) workspace.players = [];
    if (!workspace.tournaments || !workspace.tournaments.length) {
      const list = workspace.players.length ? workspace.players : makeDefaultPlayers();
      workspace.players = list;
      const fresh = makeDefaultTournament('我的赛事', list.map((p) => p.id));
      workspace = { players: workspace.players, tournaments: [fresh], activeId: fresh.id };
    }
    if (!workspace.activeId || !workspace.tournaments.some((t) => t.id === workspace.activeId)) {
      workspace.activeId = workspace.tournaments[0].id;
    }
    return workspace;
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

  /* 合并冲突消解：同 id 记录取 updatedAt 较新者（相同取本地），activeId 取本地，
   * 避免多设备并发时旧快照静默覆盖新修改 */
  function mergeWorkspace(latest, local) {
    const byId = new Map();
    for (const t of (latest && latest.tournaments) || []) byId.set(t.id, t);
    for (const t of (local && local.tournaments) || []) {
      const remote = byId.get(t.id);
      if (!remote || (t.updatedAt || 0) >= (remote.updatedAt || 0)) byId.set(t.id, t);
    }
    const playerMap = new Map();
    for (const p of (latest && latest.players) || []) playerMap.set(p.id, p);
    for (const p of (local && local.players) || []) {
      const remote = playerMap.get(p.id);
      if (!remote || (p.updatedAt || 0) >= (remote.updatedAt || 0)) playerMap.set(p.id, p);
    }
    return {
      activeId: (local && local.activeId) || (latest && latest.activeId) || null,
      players: [...playerMap.values()],
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
      if (!response.ok) {
        const message = (await apiErrorMessage(response)) || '保存云端数据失败';
        if (/suspended|quota|exceed|满额|额度/i.test(message)) {
          throw new Error('Vercel Blob 存储额度已用尽或已暂停，请在 Vercel 控制台恢复 / 升级 Blob 后重试。');
        }
        throw new Error(message);
      }
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
    if (!response.ok) {
      const message = (await apiErrorMessage(response)) || '图片上传失败';
      if (/suspended|quota|exceed|满额|额度/i.test(message)) {
        throw new Error('Vercel Blob 存储额度已用尽或已暂停，请在 Vercel 控制台恢复 / 升级 Blob 后重试。');
      }
      throw new Error(message);
    }
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

  async function storageGetPlayers() {
    if (mode === 'cloud') return (cloudWorkspace && cloudWorkspace.players) || [];
    return (await idbGetMeta(META_PLAYERS)) || [];
  }

  async function storagePutPlayers(players) {
    if (mode === 'cloud') {
      cloudWorkspace.players = players || [];
      await cloudPutWorkspace(cloudWorkspace);
      return;
    }
    await idbPutMeta(META_PLAYERS, players || []);
  }

  async function storageDeletePlayer(id) {
    if (!id) return;
    if (mode === 'cloud') {
      // 云端不能用 mergeWorkspace 删除：合并逻辑只增不删，会导致选手复活。
      // 因此读取最新 workspace 后，用 noMerge 精确删除该选手。
      const latest = await cloudGetWorkspace();
      latest.players = (latest.players || []).filter((p) => p.id !== id);
      await cloudPutWorkspace(latest, { noMerge: true });
      cloudWorkspace = latest;
      return;
    }
    const players = (await idbGetMeta(META_PLAYERS)) || [];
    await idbPutMeta(META_PLAYERS, players.filter((p) => p.id !== id));
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
    const localPlayers = (await idbGetMeta(META_PLAYERS)) || [];
    const playerMap = new Map(localPlayers.map((p) => [p.id, p]));
    const tournaments = [];
    for (const record of local) {
      const copy = structuredClone(record);
      if (typeof CanvasModel !== 'undefined' && CanvasModel.migrateLegacyTournament) {
        CanvasModel.migrateLegacyTournament(copy, playerMap);
      }
      if (typeof CanvasModel !== 'undefined' && CanvasModel.ensureCanvasDecks) {
        CanvasModel.ensureCanvasDecks(copy);
      }
      for (const player of playerMap.values()) {
        if (player.avatar && typeof player.avatar !== 'string') {
          player.avatar = await uploadCloudImage(player.avatar);
        }
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

    let players = [...playerMap.values()];
    if (!players.length) {
      players = makeDefaultPlayers();
      playerMap.clear();
      for (const p of players) playerMap.set(p.id, p);
    }
    if (!tournaments.length) {
      const fresh = makeDefaultTournament('我的赛事', players.map((p) => p.id));
      tournaments.push(fresh);
    }

    const workspace = {
      players,
      tournaments,
      activeId: localStorage.getItem(LS_ACTIVE) || (tournaments[0] || {}).id || null
    };
    if (!workspace.activeId) workspace.activeId = workspace.tournaments[0].id;

    await cloudPutWorkspace(workspace);
    cloudWorkspace = workspace;
    await refreshApp();
    notify('已将 ' + workspace.tournaments.length + ' 场比赛上传到云端');
  }

  async function migrateCloudToLocal() {
    const workspace = await cloudGetWorkspace();
    await idbPutMeta(META_PLAYERS, workspace.players || []);
    for (const record of workspace.tournaments) {
      await idbPut(record);
    }
    const activeId = workspace.activeId || (workspace.tournaments[0] || {}).id;
    if (activeId) localStorage.setItem(LS_ACTIVE, activeId);
    notify('已从云端拉取 ' + workspace.tournaments.length + ' 场比赛到本机');
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

  /* ---------- 轻量提示（toast）与非阻塞确认 ---------- */

  let toastRegion = null;

  function ensureToastRegion() {
    if (!toastRegion) {
      toastRegion = document.createElement('div');
      toastRegion.className = 'toast-region';
      toastRegion.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastRegion);
    }
    return toastRegion;
  }

  /* 自动消失的操作反馈；type 为 'danger' 时用于错误提示 */
  function notify(message, type) {
    const region = ensureToastRegion();
    const toast = document.createElement('div');
    toast.className = 'toast' + (type === 'danger' ? ' toast-danger' : '');
    toast.textContent = message;
    region.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast-out');
      setTimeout(() => toast.remove(), 300);
    }, 3600);
    return toast;
  }

  let confirmDialog = null;

  function buildConfirmDialog() {
    confirmDialog = document.createElement('dialog');
    confirmDialog.id = 'confirm-dialog';
    confirmDialog.setAttribute('aria-labelledby', 'confirm-title');
    confirmDialog.innerHTML =
      '<div class="dialog-head">' +
      '  <h2 id="confirm-title">请确认</h2>' +
      '</div>' +
      '<div class="dialog-body">' +
      '  <p class="confirm-text"></p>' +
      '  <div class="dialog-actions">' +
      '    <button type="button" class="btn btn-secondary" data-confirm-cancel>取消</button>' +
      '    <button type="button" class="btn btn-danger" data-confirm-ok>确定</button>' +
      '  </div>' +
      '</div>';
    confirmDialog.querySelector('[data-confirm-ok]').addEventListener('click', () => {
      confirmDialog.__ok = true;
      confirmDialog.close();
    });
    confirmDialog.querySelector('[data-confirm-cancel]').addEventListener('click', () => {
      confirmDialog.close();
    });
    /* Esc 触发 cancel 默认行为同样会走到 close，统一在 close 里结算 */
    confirmDialog.addEventListener('close', () => {
      const resolve = confirmDialog.__resolve;
      confirmDialog.__resolve = null;
      if (resolve) resolve(Boolean(confirmDialog.__ok));
    });
    document.body.appendChild(confirmDialog);
  }

  /* 返回 Promise<boolean>：确定为 true，取消/按 Esc/点击遮罩为 false */
  function uiConfirm(message) {
    return new Promise((resolve) => {
      if (!confirmDialog) buildConfirmDialog();
      confirmDialog.__ok = false;
      confirmDialog.__resolve = resolve;
      confirmDialog.querySelector('.confirm-text').textContent = message;
      confirmDialog.showModal();
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

    /* 焦点圈定：Tab 循环限制在灯箱按钮内，不落到遮罩后的页面上 */
    function trapFocus(event) {
      const focusables = [close, prev, next].filter((el) => !el.hidden);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !lightbox.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !lightbox.contains(active))) {
        event.preventDefault();
        first.focus();
      }
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
      if (event.key === 'Tab') trapFocus(event);
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
      '    <select id="new-tournament-template" aria-label="新建模板">' +
      '      <option value="blank">空白画布</option>' +
      '      <option value="double">8 人双败模板</option>' +
      '    </select>' +
      '    <button type="submit" class="btn btn-primary btn-sm">新建比赛</button>' +
      '  </form>' +
      '  <div class="manage-subsection">' +
      '    <h3>比赛列表</h3>' +
      '    <div id="manage-list" class="manage-list" aria-label="已有比赛列表"></div>' +
      '  </div>' +
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
      '      <label for="settings-status">赛事状态</label>' +
      '      <select id="settings-status">' +
      '        <option value="upcoming">未开始</option>' +
      '        <option value="ongoing">进行中</option>' +
      '        <option value="finished">已结束</option>' +
      '      </select>' +
      '    </div>' +
      '    <div class="form-field">' +
      '      <label for="settings-live-url">直播链接</label>' +
      '      <input type="url" id="settings-live-url" placeholder="https://..." autocomplete="off">' +
      '    </div>' +
      '    <div class="form-field">' +
      '      <label for="settings-start-time">开赛时间</label>' +
      '      <input type="datetime-local" id="settings-start-time">' +
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
      const template = manageDialog.querySelector('#new-tournament-template');
      const name = input.value.trim() || '我的赛事';
      let record;
      if (template && template.value === 'double') {
        record = makeDefaultTournament(name);
      } else {
        record = makeBlankTournament(name);
      }
      try {
        await storagePut(record);
      } catch (error) {
        notify('新建比赛失败：' + errMsg(error), 'danger');
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
        notify('请先输入管理口令并解锁', 'danger');
        return;
      }
      const record = appInstance.current;
      const nameInput = settingsDialog.querySelector('#settings-name');
      const rulesInput = settingsDialog.querySelector('#settings-rules');
      const statusInput = settingsDialog.querySelector('#settings-status');
      const liveUrlInput = settingsDialog.querySelector('#settings-live-url');
      const startTimeInput = settingsDialog.querySelector('#settings-start-time');
      record.name = nameInput.value.trim() || '我的赛事';
      record.rules = rulesInput.value;
      record.status = statusInput ? statusInput.value : (record.status || 'upcoming');
      record.liveUrl = liveUrlInput ? liveUrlInput.value.trim() : (record.liveUrl || '');
      record.startTime = startTimeInput && startTimeInput.value
        ? new Date(startTimeInput.value).toISOString()
        : (record.startTime || null);
      if (pendingBackground !== undefined) {
        record.background = pendingBackground;
      }
      pendingBackground = undefined;
      try {
        await storagePut(record);
      } catch (error) {
        notify('保存设置失败：' + errMsg(error), 'danger');
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
        preview.style.backgroundImage = cssUrl(blobUrl(pendingBackground));
        preview.setAttribute('aria-label', '背景图预览');
      } catch (error) {
        notify(errMsg(error), 'danger');
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
        if (mode !== 'cloud') {
          status.textContent = '当前为本机模式，未连接云端：' + (cloudFallbackReason || '云端不可用');
          syncSettingsAdminState(true);
          return;
        }
        try {
          cloudWorkspace = await cloudGetWorkspace();
          if (!cloudWorkspace.players) cloudWorkspace.players = [];
          if (!cloudWorkspace.tournaments) cloudWorkspace.tournaments = [];
          if (!cloudWorkspace.activeId) cloudWorkspace.activeId = (cloudWorkspace.tournaments[0] || {}).id || null;
        } catch (error) {
          status.textContent = '云端数据读取失败：' + errMsg(error);
          syncSettingsAdminState(true);
          return;
        }
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
        notify(errMsg(error), 'danger');
      }
    });

    settingsDialog.querySelector('#migrate-down').addEventListener('click', async () => {
      try {
        await migrateCloudToLocal();
      } catch (error) {
        notify(errMsg(error), 'danger');
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
      settingsDialog.querySelector('#settings-status'),
      settingsDialog.querySelector('#settings-live-url'),
      settingsDialog.querySelector('#settings-start-time'),
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

  function renderPlayerLibrary() {
    if (!manageDialog) return;
    const list = manageDialog.querySelector('#player-library-list');
    if (!list) return;
    const players = (appInstance && appInstance.players) || [];
    list.innerHTML = players.map((p) =>
      '<div class="player-library-item">' +
      avatarMarkup(p, 'avatar-sm') +
      '<span>' + escapeHtml(p.name) + '</span>' +
      '<button type="button" class="btn btn-danger btn-sm" data-delete-player="' + p.id + '">删除</button>' +
      '</div>'
    ).join('') || '<p class="hint">暂无选手，先添加一位。</p>';
    list.querySelectorAll('[data-delete-player]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.deletePlayer;
        if (!(await uiConfirm('确定从全局选手库删除该选手吗？历史比赛记录不会被删除，但该选手会显示为“待定”。'))) return;
        try {
          // 只删除选手库条目，保留所有历史比赛数据
          await storageDeletePlayer(id);
          appInstance.players = (appInstance.players || []).filter((p) => p.id !== id);
          renderPlayerLibrary();
          renderRosterEditor();
          renderManageList();
          document.dispatchEvent(new CustomEvent('ts:changed'));
        } catch (error) {
          notify('删除选手失败：' + errMsg(error), 'danger');
        }
      });
    });
  }

  function renderRosterEditor() {
    if (!manageDialog) return;
    const list = manageDialog.querySelector('#roster-editor-list');
    if (!list) return;
    const record = appInstance && appInstance.current;
    if (!record) return;
    const players = (appInstance && appInstance.players) || [];
    const rosterSet = new Set(record.roster || []);
    list.innerHTML = players.map((p) =>
      '<label class="roster-toggle">' +
      '<input type="checkbox" data-roster-toggle="' + p.id + '"' + (rosterSet.has(p.id) ? ' checked' : '') + '> ' +
      escapeHtml(p.name) +
      '</label>'
    ).join('') || '<p class="hint">全局选手库为空。</p>';
    list.querySelectorAll('[data-roster-toggle]').forEach((input) => {
      input.addEventListener('change', async () => {
        const record = appInstance.current;
        if (!record) return;
        const id = input.dataset.rosterToggle;
        if (!Array.isArray(record.roster)) record.roster = [];
        if (input.checked) {
          if (!record.roster.includes(id)) record.roster.push(id);
        } else {
          record.roster = record.roster.filter((x) => x !== id);
          for (const card of (record.canvas && record.canvas.cards) || []) {
            for (const slot of card.slots || []) {
              if (slot && slot.type === 'player' && slot.playerId === id) {
                slot.type = 'empty';
                delete slot.playerId;
              }
            }
          }
        }
        record.updatedAt = Date.now();
        await storagePut(record);
        renderRosterEditor();
        renderManageList();
        document.dispatchEvent(new CustomEvent('ts:changed'));
      });
    });
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
        '<button type="button" class="btn btn-secondary btn-sm" data-copy="' + item.id + '">复制</button>' +
        '<button type="button" class="btn btn-danger btn-sm" data-delete="' + item.id + '">删除</button>' +
        '</div>'
      );
    }).join('');

    list.querySelectorAll('.manage-item-name').forEach((input) => {
      input.addEventListener('change', async () => {
        try {
          const id = input.closest('.manage-item').querySelector('[data-switch]').dataset.switch;
          const all = await storageGetAll();
          const record = all.find((t) => t.id === id);
          if (!record) return;
          record.name = input.value.trim() || record.name;
          try {
            await storagePut(record);
          } catch (error) {
            notify('重命名失败：' + errMsg(error), 'danger');
            return;
          }
          await refreshApp();
          renderManageList();
          document.dispatchEvent(new CustomEvent('ts:changed'));
        } catch (error) {
          notify('重命名失败：' + errMsg(error), 'danger');
        }
      });
    });

    list.querySelectorAll('[data-switch]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await setActiveId(btn.dataset.switch);
          renderManageList();
          document.dispatchEvent(new CustomEvent('ts:changed'));
        } catch (error) {
          notify('切换比赛失败：' + errMsg(error), 'danger');
        }
      });
    });

    list.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const all = await storageGetAll();
          const source = all.find((t) => t.id === btn.dataset.copy);
          if (!source) return;
          const copy = structuredClone(source);
          copy.id = uid('t');
          copy.name = source.name + ' 副本';
          copy.createdAt = Date.now();
          copy.updatedAt = Date.now();
          copy.scores = {};
          copy.matchDecks = {};
          const idMap = new Map();
          for (const card of copy.canvas.cards || []) {
            const newId = uid('c');
            idMap.set(card.id, newId);
            card.id = newId;
          }
          for (const card of copy.canvas.cards || []) {
            for (const slot of card.slots || []) {
              if (slot && slot.type === 'flow' && idMap.has(slot.cardId)) {
                slot.cardId = idMap.get(slot.cardId);
              }
            }
          }
          await storagePut(copy);
          await setActiveId(copy.id);
          renderManageList();
          document.dispatchEvent(new CustomEvent('ts:changed'));
        } catch (error) {
          notify('复制比赛失败：' + errMsg(error), 'danger');
        }
      });
    });

    list.querySelectorAll('[data-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.delete;
        const item = window.TournamentApp.list.find((t) => t.id === id);
        if (!item) return;
        if (!(await uiConfirm('确定删除比赛「' + item.name + '」吗？该操作不可恢复。'))) return;
        try {
          await storageDelete(id);
        } catch (error) {
          notify('删除失败：' + errMsg(error), 'danger');
          return;
        }
        try {
          const remaining = (await storageGetAll());
          if (!remaining.length) {
            const playerIds = (window.TournamentApp.players || []).slice(0, 8).map((p) => p.id);
            const fresh = makeDefaultTournament('我的赛事', playerIds);
            try {
              await storagePut(fresh);
            } catch (error) {
              notify('新建默认比赛失败：' + errMsg(error), 'danger');
              return;
            }
            remaining.push(fresh);
          }
          if (id === window.TournamentApp.current.id) {
            await setActiveId(remaining[0].id);
          } else {
            await refreshApp();
          }
        } catch (error) {
          notify('删除后刷新失败：' + errMsg(error), 'danger');
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

  function toDateTimeLocal(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function openSettingsDialog(focusRules) {
    buildDialogs();
    const record = window.TournamentApp.current;
    const nameInput = settingsDialog.querySelector('#settings-name');
    const rulesInput = settingsDialog.querySelector('#settings-rules');
    const statusInput = settingsDialog.querySelector('#settings-status');
    const liveUrlInput = settingsDialog.querySelector('#settings-live-url');
    const startTimeInput = settingsDialog.querySelector('#settings-start-time');
    const preview = settingsDialog.querySelector('#bg-preview');
    nameInput.value = record.name;
    rulesInput.value = record.rules || '';
    if (statusInput) statusInput.value = record.status || 'upcoming';
    if (liveUrlInput) liveUrlInput.value = record.liveUrl || '';
    if (startTimeInput) startTimeInput.value = toDateTimeLocal(record.startTime);
    pendingBackground = undefined;
    if (record.background) {
      preview.style.backgroundImage = cssUrl(blobUrl(record.background));
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

  /* 头像 HTML：有图显示图片（URL 经白名单校验），无图显示首字符占位（颜色按选手 id 确定性取） */
  function avatarMarkup(player, sizeClass) {
    const cls = 'avatar ' + sizeClass;
    if (player && player.avatar) {
      return '<img class="' + cls + '" loading="lazy" src="' +
        escapeHtml(safeUrl(blobUrl(player.avatar))) + '"' +
        ' alt="' + escapeHtml(player.name || '') + ' 的头像">';
    }
    const initial = String((player && player.name) || '?').trim().charAt(0) || '?';
    const color = (typeof CanvasModel !== 'undefined' && CanvasModel.avatarColor)
      ? CanvasModel.avatarColor(player ? player.id : '')
      : '#3563e9';
    return '<span class="' + cls + ' avatar-fallback" style="background:' + color + '">' +
      escapeHtml(initial) + '</span>';
  }

  /* ---------- 跨文件共享工具 ----------
   * escapeHtml/debounce/canEdit/save/medalMap 原在 bracket.js、deck-modal.js、home.js
   * 各复制一份，改一处漏三处；统一收敛到此处，经 window.TournamentUtils 暴露。 */

  function debounce(fn, wait) {
    let timer = null;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, wait);
    };
  }

  function canEdit() {
    const app = window.TournamentApp;
    return !(app && app.mode === 'cloud' && !app.isAdmin());
  }

  function save() {
    /* 保存失败必须可见：云端未解锁/口令失效时 toast 提示，避免“看似保存实则丢失” */
    return window.TournamentApp.storagePut(window.TournamentApp.current).catch((error) => {
      console.error('[save] 失败:', error);
      notify('保存失败：' + errMsg(error), 'danger');
    });
  }

  /* 比赛已分出冠亚季军时，返回 playerId → 奖牌信息 的映射；未结束返回空 Map */
  function medalMap(record) {
    const map = new Map();
    if (!record || !record.canvas || !Array.isArray(record.roster)) return map;
    const standings = (typeof CanvasModel !== 'undefined' && CanvasModel.deriveStandings)
      ? CanvasModel.deriveStandings(record)
      : { champion: null, runnerUp: null, thirdPlace: null };
    if (!standings.champion) return map;
    if (standings.champion) map.set(standings.champion, { type: 'gold', emoji: '🥇' });
    if (standings.runnerUp) map.set(standings.runnerUp, { type: 'silver', emoji: '🥈' });
    if (standings.thirdPlace) map.set(standings.thirdPlace, { type: 'bronze', emoji: '🥉' });
    return map;
  }

  window.TournamentUtils = {
    escapeHtml,
    iconMarkup,
    errMsg,
    safeUrl,
    cssUrl,
    debounce,
    canEdit,
    save,
    medalMap,
    avatarMarkup,
    notify,
    uiConfirm
  };

  function applyBackground(record) {
    const layer = document.getElementById('bg-layer');
    if (!layer) return;
    if (record && record.background) {
      layer.style.backgroundImage = cssUrl(blobUrl(record.background));
    } else {
      layer.style.backgroundImage = '';
    }
  }

  function renderSidebar() {
    const placeholder = document.getElementById('app-sidebar');
    if (!placeholder) return;
    const app = window.TournamentApp;
    const active = app && app.activePage;
    const items = [
      { page: 'home', href: 'index.html', icon: 'home', label: '主页' },
      { page: 'match', href: 'schedule.html', icon: 'emoji_events', label: '比赛' },
      { page: 'players', href: 'players.html', icon: 'groups', label: '选手库' }
    ];
    const isActive = (page) => {
      if (page === 'match') return active === 'schedule' || active === 'match';
      return active === page;
    };
    placeholder.innerHTML =
      '<nav class="side-nav" aria-label="主导航">' +
      items.map((item) =>
        '<a class="side-link' + (isActive(item.page) ? ' is-active' : '') + '" href="' + item.href + '" data-page="' + item.page + '"' +
        ' title="' + item.label + '" aria-label="' + item.label + '">' +
        '<span class="side-icon" aria-hidden="true">' + iconMarkup(item.icon, item.label) + '</span>' +
        '</a>'
      ).join('') +
      '</nav>';
  }

  function renderHeader() {
    const app = window.TournamentApp;
    const placeholder = document.getElementById('app-header');
    if (!placeholder) return;
    const active = app.current;
    const pageTitles = { home: '右手杯', players: '选手库' };
    const headerTitle = pageTitles[app.activePage] || active.name;
    const options = app.list.map((item) =>
      '<option value="' + item.id + '"' + (item.id === active.id ? ' selected' : '') + '>' +
      escapeHtml(item.name) +
      '</option>'
    ).join('');
    const isSchedule = app.activePage === 'schedule';
    const showTournamentSwitch = app.activePage === 'schedule';
    const scheduleActions = isSchedule
      ? '<button type="button" id="header-rules-btn" class="btn btn-ghost btn-sm icon-btn" title="赛制规则">' + iconMarkup('rule', '赛制规则') + '</button>' +
        '<button type="button" id="header-roster-btn" class="btn btn-ghost btn-sm icon-btn" title="选手名单">' + iconMarkup('groups', '选手名单') + '</button>' +
        '<button type="button" id="header-edit-btn" class="btn btn-secondary btn-sm icon-btn" title="编辑">' + iconMarkup('edit', '编辑') + '</button>'
      : '';
    const tournamentSwitch = showTournamentSwitch
      ? '<label class="visually-hidden" for="tournament-switch">切换比赛</label>' +
        '<select id="tournament-switch" class="header-select" title="切换比赛">' + options + '</select>'
      : '';
    placeholder.innerHTML =
      '<div class="header-inner">' +
      '  <span class="header-title" title="' + escapeHtml(headerTitle) + '">' + escapeHtml(headerTitle) + '</span>' +
      '  <div class="header-actions">' +
      tournamentSwitch +
      scheduleActions +
      '    <button type="button" id="manage-btn" class="btn btn-secondary btn-sm icon-btn" title="管理">' + iconMarkup('dashboard', '管理') + '</button>' +
      '    <button type="button" id="settings-btn" class="btn btn-secondary btn-sm icon-btn" title="设置">' + iconMarkup('settings', '设置') + '</button>' +
      '  </div>' +
      '</div>';

    const switchSelect = placeholder.querySelector('#tournament-switch');
    if (switchSelect) {
      switchSelect.addEventListener('change', async (event) => {
        try {
          await setActiveId(event.target.value);
          document.dispatchEvent(new CustomEvent('ts:changed'));
        } catch (error) {
          notify('切换比赛失败：' + errMsg(error), 'danger');
        }
      });
    }
    const manageBtn = placeholder.querySelector('#manage-btn');
    manageBtn.hidden = mode === 'cloud' && !appInstance.isAdmin();
    manageBtn.addEventListener('click', openManageDialog);
    placeholder.querySelector('#settings-btn').addEventListener('click', () => openSettingsDialog(false));

    const rulesBtn = placeholder.querySelector('#header-rules-btn');
    if (rulesBtn) {
      rulesBtn.addEventListener('click', () => {
        if (window.BracketActions && window.BracketActions.openRules) window.BracketActions.openRules();
      });
    }
    const rosterBtn = placeholder.querySelector('#header-roster-btn');
    if (rosterBtn) {
      rosterBtn.addEventListener('click', () => {
        if (window.BracketActions && window.BracketActions.openRoster) window.BracketActions.openRoster();
        else openManageDialog();
      });
    }
    const editBtn = placeholder.querySelector('#header-edit-btn');
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        if (window.BracketActions && window.BracketActions.requestEdit) window.BracketActions.requestEdit();
        else if (window.BracketActions && window.BracketActions.toggleEdit) window.BracketActions.toggleEdit();
      });
    }
  }

  /* ---------- 主流程 ---------- */

  async function ensureFirstTournament() {
    const all = await idbGetAll();
    const players = (await idbGetMeta(META_PLAYERS)) || [];
    if (!all.length) {
      const list = players.length ? players : makeDefaultPlayers();
      if (!players.length) await idbPutMeta(META_PLAYERS, list);
      const record = makeDefaultTournament('我的赛事', list.map((p) => p.id));
      await idbPut(record);
      localStorage.setItem(LS_ACTIVE, record.id);
      return;
    }
    const activeId = localStorage.getItem(LS_ACTIVE);
    if (!activeId || !all.some((t) => t.id === activeId)) {
      localStorage.setItem(LS_ACTIVE, all[0].id);
    }
  }

  /* 旧快照的 ObjectURL 回收：每次重读记录都会得到新的 Blob 对象，
   * 切换/保存后上一快照的 URL 不再被 DOM 引用，统一释放避免长会话累积泄漏 */
  let lastSnapshotUrls = [];

  function collectSnapshotUrls(record) {
    const urls = [];
    const push = (ref) => {
      if (ref && typeof ref !== 'string') {
        const url = urlCache.get(ref);
        if (url) urls.push(url);
      }
    };
    if (!record) return urls;
    const app = window.TournamentApp;
    for (const player of (app && app.players) || []) push(player.avatar);
    for (const decks of Object.values(record.matchDecks || {})) {
      for (const deckList of Object.values(decks || {})) {
        for (const deck of deckList || []) {
          for (const image of deck.images || []) push(image);
        }
      }
    }
    push(record.background);
    /* 设置弹窗中已选但未保存的背景仍被预览引用，不能回收 */
    if (pendingBackground && typeof pendingBackground !== 'string') push(pendingBackground);
    return urls;
  }

  function releaseStaleBlobUrls(record) {
    const keep = new Set(collectSnapshotUrls(record));
    for (const url of lastSnapshotUrls) {
      if (!keep.has(url)) URL.revokeObjectURL(url);
    }
    lastSnapshotUrls = [...keep];
  }

  async function refreshApp() {
    let all = await storageGetAll();
    let players = await storageGetPlayers();
    const playerMap = new Map((players || []).map((p) => [p.id, p]));
    const dirtyRecords = [];

    for (const record of all) {
      if (!record) continue;
      const before = JSON.stringify(record);
      if (typeof CanvasModel !== 'undefined' && CanvasModel.migrateLegacyTournament) {
        CanvasModel.migrateLegacyTournament(record, playerMap);
      }
      if (typeof CanvasModel !== 'undefined' && CanvasModel.ensureCanvasDecks) {
        CanvasModel.ensureCanvasDecks(record);
      }
      if (typeof CanvasModel !== 'undefined' && CanvasModel.deriveRoster && record.canvas) {
        record.roster = CanvasModel.deriveRoster(record.canvas).filter((id) => playerMap.has(id));
      }
      if (JSON.stringify(record) !== before) dirtyRecords.push(record);
    }
    players = [...playerMap.values()];
    // 云端只读访客不允许写库：迁移/推导只放在内存里，避免初始化直接失败
    const canWrite = mode !== 'cloud' || (appInstance && appInstance.isAdmin());
    if (canWrite && (dirtyRecords.length || !players.length)) {
      try {
        await storagePutPlayers(players);
      } catch (error) {
        console.error('[refreshApp] 保存全局选手失败:', error);
      }
    }
    // 只回写发生变化的比赛，避免每次刷新都全量写库
    if (canWrite) {
      for (const record of dirtyRecords) {
        await storagePut(record);
      }
    }

    /* activeId 优先取 localStorage（本机最近切换，即时一致），云端兜底（跨设备） */
    const activeId = mode === 'cloud'
      ? (localStorage.getItem(LS_ACTIVE) || (cloudWorkspace && cloudWorkspace.activeId))
      : localStorage.getItem(LS_ACTIVE);
    const record = all.find((t) => t.id === activeId) || all[0];
    appInstance.current = record;
    appInstance.list = all.map((t) => ({ id: t.id, name: t.name, updatedAt: t.updatedAt }));
    appInstance.players = players;
    applyBackground(record);
    renderHeader();
    renderSidebar();
    releaseStaleBlobUrls(record);
    return record;
  }

  function sidebarHidden() {
    return localStorage.getItem(LS_SIDEBAR) === '1';
  }

  function setSidebarHidden(hidden) {
    localStorage.setItem(LS_SIDEBAR, hidden ? '1' : '0');
  }

  /* 初始化失败横幅：IndexedDB 打开失败/云端数据损坏时给出可见提示，替代静默白屏 */
  function showFatalError(error) {
    console.error('[init] 初始化失败:', error);
    if (document.getElementById('init-error')) return;
    const banner = document.createElement('div');
    banner.id = 'init-error';
    banner.className = 'init-error';
    banner.setAttribute('role', 'alert');
    banner.textContent = '数据加载失败，请刷新重试（' + errMsg(error) + '）';
    const header = document.getElementById('app-header');
    if (header && header.parentNode) {
      header.parentNode.insertBefore(banner, header.nextSibling);
    } else {
      document.body.prepend(banner);
    }
  }

  async function init(activePage) {
    appInstance = {
      activePage,
      current: null,
      list: [],
      players: [],
      mode: 'local',
      adminToken: localStorage.getItem(LS_ADMIN_TOKEN) || '',
      uid,
      blobUrl,
      compressImage,
      compressAvatar,
      openLightbox,
      openSettings: openSettingsDialog,
      openManage: openManageDialog,
      renderHeader,
      renderSidebar,
      sidebarHidden,
      setSidebarHidden,
      /* 存储适配器：本地模式走 IndexedDB，云端模式走 Vercel Blob */
      storagePut,
      storageGetAll,
      storageDelete,
      storageGetPlayers,
      storagePutPlayers,
      storageDeletePlayer,
      isAdmin,
      setAdminToken,
      setActiveId,
      uploadImage: uploadCloudImage,
      migrateLocalToCloud,
      migrateCloudToLocal,
      fatalError: showFatalError
    };
    window.TournamentApp = appInstance;
    try {
      const workspace = await probeCloud();
      if (workspace) {
        cloudWorkspace = normalizeWorkspace(workspace);
      } else {
        /* 仅本地模式需要本地兜底初始化;云端模式不得触碰 localStorage/IndexedDB,
         * 否则会覆盖用户刚切换的 activeId(主页/赛程显示错乱) */
        mode = 'local';
        await ensureFirstTournament();
      }
      appInstance.mode = mode;
      await refreshApp();
      if (cloudFallbackReason) {
        notify('云端数据不可用，已切换到本机数据：' + cloudFallbackReason, 'danger');
      }
    } catch (error) {
      showFatalError(error);
      return;
    }
    document.dispatchEvent(new CustomEvent('ts:ready'));
  }

  window.TournamentAppInit = init;
})();
