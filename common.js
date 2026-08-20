(function () {
  'use strict';

  const DB_NAME = 'tournament-site';
  const DB_VERSION = 2;
  const STORE = 'tournaments';
  const META_STORE = 'meta';
  const META_PLAYERS = 'globalPlayers';
  const LS_ACTIVE = 'ts:activeTournamentId';
  const LS_ADMIN_TOKEN = 'ts:adminToken';
  /* 跨文件事件协议:数据变更 / 应用就绪。common.js 派发,各页面监听 */
  const EVT_CHANGED = 'ts:changed';
  const EVT_READY = 'ts:ready';
  const pad2 = (n) => String(n).padStart(2, '0');
  /* Vercel Blob 额度耗尽/暂停的错误识别,写数据与传图片共用 */
  const BLOB_QUOTA_RE = /suspended|quota|exceed|满额|额度/i;
  const BLOB_QUOTA_MESSAGE = 'Vercel Blob 存储额度已用尽或已暂停，请在 Vercel 控制台恢复 / 升级 Blob 后重试。';
  const LS_THEME = 'ts:theme';

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

  /* 事务模板:五个 idb 操作共用,resolve 请求结果(写操作为 key,无消费方) */
  function withStore(storeName, mode, run) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const request = run(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(request ? request.result : undefined);
      tx.onerror = () => reject(tx.error);
    }));
  }

  function idbPut(record) {
    return withStore(STORE, 'readwrite', (store) => store.put(record));
  }

  function idbGetAll() {
    return withStore(STORE, 'readonly', (store) => store.getAll()).then((rows) => rows || []);
  }

  function idbDelete(id) {
    return withStore(STORE, 'readwrite', (store) => store.delete(id));
  }

  function idbGetMeta(key) {
    return withStore(META_STORE, 'readonly', (store) => store.get(key)).then((row) => (row ? row.value : null));
  }

  function idbPutMeta(key, value) {
    return withStore(META_STORE, 'readwrite', (store) => store.put({ key, value }));
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
      title: '',
      color: null,
      avatar: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }));
  }

  /* 选手对象归一化：title(赛前垃圾话)统一为纯文本字符串、color 校验为 #rrggbb 或 null。
   * 兼容上一版 {type,text,image} 对象结构,取其中 text 并丢弃 image。
   * 非法选手对象返回 null；字段可修复时返回浅拷贝的新对象（原对象不动）。 */
  function normalizePlayer(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    let title = '';
    if (typeof p.title === 'string') title = p.title;
    else if (p.title && typeof p.title === 'object' && typeof p.title.text === 'string') title = p.title.text;
    const color = /^#[0-9a-fA-F]{6}$/.test(p.color || '') ? p.color : null;
    const out = Object.assign({}, p);
    out.title = title;
    out.color = color;
    return out;
  }

  function makeDefaultTournament(name, roster) {
    const r = roster || [];
    const record = CanvasModel.createDefaultTournament      ? CanvasModel.createDefaultTournament(name, r)
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
    const record = CanvasModel.createBlankTournament      ? CanvasModel.createBlankTournament(name)
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

  /* ---------- 云端 workspace 本地缓存(SWR) ----------
   * 云端数据是纯 JSON(图片为 URL 字符串),localStorage 可整体序列化;
   * 命中缓存先渲染秒开,超过 TTL 再后台校新,避免页面间跳转每次全量重拉 */
  const WORKSPACE_CACHE_KEY = 'ts:workspaceCache';
  const WORKSPACE_CACHE_TTL = 60000;

  function readWorkspaceCache() {
    try {
      const raw = localStorage.getItem(WORKSPACE_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.workspace && parsed.workspace.tournaments)
        || !Number.isFinite(parsed.savedAt)) return null;
      return parsed;
    } catch (error) {
      return null;
    }
  }

  function writeWorkspaceCache(workspace) {
    try {
      localStorage.setItem(WORKSPACE_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), workspace }));
    } catch (error) {
      /* 隐私模式/存储满:缓存写不进不影响主流程 */
    }
  }

  function setCloudWorkspace(workspace) {
    cloudWorkspace = workspace;
    writeWorkspaceCache(workspace);
  }

  async function revalidateWorkspaceQuietly() {
    try {
      const response = await fetch('/api/data');
      /* 非 200(含 404=API 未部署)一律保留缓存:
       * cloudGetWorkspace 会把 404 当"空云端"返回,直连会把缓存覆盖成默认空赛事 */
      if (!response.ok) return;
      const fresh = normalizeWorkspace(await response.json());
      if (!Array.isArray(fresh.tournaments)) return;
      if (JSON.stringify(fresh) === JSON.stringify(cloudWorkspace)) {
        writeWorkspaceCache(fresh); /* 只刷新时间戳 */
        return;
      }
      setCloudWorkspace(fresh);
      await refreshApp();
      document.dispatchEvent(new CustomEvent(EVT_CHANGED));
    } catch (error) {
      /* 后台校新失败:沿用现有数据,不打扰用户 */
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
        const message = (await apiErrorMessage(response)) || fallbackMessage;
        if (BLOB_QUOTA_RE.test(message)) throw new Error(BLOB_QUOTA_MESSAGE);
        throw new Error(message);
      }
      /* 上传成功后本地快照与上传内容对齐 */
      setCloudWorkspace(payload);
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
      if (BLOB_QUOTA_RE.test(message)) throw new Error(BLOB_QUOTA_MESSAGE);
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
      setCloudWorkspace(latest);
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
      setCloudWorkspace(latest);
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
    if (appInstance.adminToken) sessionStorage.setItem(LS_ADMIN_TOKEN, appInstance.adminToken);
    else sessionStorage.removeItem(LS_ADMIN_TOKEN);
  }

  /* 口令只放 sessionStorage,关闭标签页即清;旧版本曾落在 localStorage,首次加载迁走并删除 */
  function loadAdminToken() {
    try {
      const legacy = localStorage.getItem(LS_ADMIN_TOKEN);
      if (legacy !== null) {
        if (legacy && sessionStorage.getItem(LS_ADMIN_TOKEN) === null) {
          sessionStorage.setItem(LS_ADMIN_TOKEN, legacy);
        }
        localStorage.removeItem(LS_ADMIN_TOKEN);
      }
      return sessionStorage.getItem(LS_ADMIN_TOKEN) || '';
    } catch {
      return '';
    }
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
      if (CanvasModel.migrateLegacyTournament) {
        CanvasModel.migrateLegacyTournament(copy, playerMap);
      }
      if (CanvasModel.ensureCanvasDecks) {
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
    setCloudWorkspace(workspace);
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

  /* 压缩公共管线:加载文件 → canvas 重采样 → WebP 优先、JPEG 回退。
   * draw 负责设置画布尺寸并绘制(等比缩放 or 头像中心裁切)。 */
  function compressToBlob(file, draw, quality) {
    const q = quality || 0.85;
    return new Promise((resolve, reject) => {
      if (!file || !file.type || !file.type.startsWith('image/')) {
        reject(new Error('请选择图片文件'));
        return;
      }
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        const canvas = document.createElement('canvas');
        draw(image, canvas);
        canvas.toBlob((blob) => {
          if (blob && blob.type === 'image/webp') { resolve(blob); return; }
          /* 不支持 WebP 编码的浏览器回退 JPEG */
          canvas.toBlob((fallback) => {
            if (fallback) resolve(fallback);
            else reject(new Error('图片压缩失败'));
          }, 'image/jpeg', q);
        }, 'image/webp', q);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('无法读取图片'));
      };
      image.src = url;
    });
  }

  function compressImage(file, maxDim, quality) {
    return compressToBlob(file, (image, canvas) => {
      const scale = Math.min(1, maxDim / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    }, quality);
  }

  /* 头像压缩：中心裁切成 200×200 方形 */
  function compressAvatar(file) {
    return compressToBlob(file, (image, canvas) => {
      const size = Math.min(image.naturalWidth, image.naturalHeight);
      canvas.width = 200;
      canvas.height = 200;
      canvas.getContext('2d').drawImage(image,
        (image.naturalWidth - size) / 2,
        (image.naturalHeight - size) / 2,
        size, size,
        0, 0, 200, 200);
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

  /* 自动消失的操作反馈；type 为 'danger' 时用于错误提示（assertive 播报） */
  function notify(message, type) {
    const region = ensureToastRegion();
    const isDanger = type === 'danger';
    const toast = document.createElement('div');
    toast.className = 'toast' + (isDanger ? ' toast-danger' : '');
    toast.setAttribute('role', isDanger ? 'alert' : 'status');
    toast.textContent = message;
    region.appendChild(toast);
    if (isDanger) region.setAttribute('aria-live', 'assertive');
    setTimeout(() => {
      toast.classList.add('toast-out');
      setTimeout(() => {
        toast.remove();
        if (!region.querySelector('.toast-danger')) region.setAttribute('aria-live', 'polite');
      }, 300);
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
      '<button type="button" class="lightbox-btn lightbox-close" aria-label="关闭放大图">' + iconMarkup('close', '') + '</button>' +
      '<button type="button" class="lightbox-btn lightbox-prev" aria-label="上一张">' + iconMarkup('chevron_left', '') + '</button>' +
      '<button type="button" class="lightbox-btn lightbox-next" aria-label="下一张">' + iconMarkup('chevron_right', '') + '</button>';
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
      '      <p class="hint" id="bg-hint">支持常见图片格式，上传后自动压缩至最长边 1600px。</p>' +
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
      document.dispatchEvent(new CustomEvent(EVT_CHANGED));
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
      document.dispatchEvent(new CustomEvent(EVT_CHANGED));
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
        let image = await compressImage(file, 1600, 0.8);
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
        document.dispatchEvent(new CustomEvent(EVT_CHANGED));
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
        document.dispatchEvent(new CustomEvent(EVT_CHANGED));
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
          document.dispatchEvent(new CustomEvent(EVT_CHANGED));
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
          document.dispatchEvent(new CustomEvent(EVT_CHANGED));
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
          document.dispatchEvent(new CustomEvent(EVT_CHANGED));
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
        document.dispatchEvent(new CustomEvent(EVT_CHANGED));
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
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
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

  /* 头像 HTML：有图显示图片（URL 经白名单校验），无图显示首字符占位。
   * 占位色按选手 id 确定性取；选手颜色仅供海报板块使用,不在选手库展示。 */
  function avatarMarkup(player, sizeClass) {
    const cls = 'avatar ' + sizeClass;
    if (player && player.avatar) {
      return '<img class="' + cls + '" loading="lazy" src="' +
        escapeHtml(safeUrl(blobUrl(player.avatar))) + '"' +
        ' alt="' + escapeHtml(player.name || '') + ' 的头像">';
    }
    const initial = String((player && player.name) || '?').trim().charAt(0) || '?';
    const color = CanvasModel.avatarColor      ? CanvasModel.avatarColor(player ? player.id : '')
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

  /* 开赛时间格式化（主页 hero 与赛程页共用）：M月d日 HH:mm */
  function formatStartTime(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /* 比赛已分出冠亚季军时，返回 playerId → 奖牌信息 的映射；未结束返回空 Map */
  function medalMap(record) {
    const map = new Map();
    if (!record || !record.canvas || !Array.isArray(record.roster)) return map;
    const standings = CanvasModel.deriveStandings      ? CanvasModel.deriveStandings(record)
      : { champion: null, runnerUp: null, thirdPlace: null };
    if (!standings.champion) return map;
    if (standings.champion) map.set(standings.champion, { type: 'gold', emoji: '🥇' });
    if (standings.runnerUp) map.set(standings.runnerUp, { type: 'silver', emoji: '🥈' });
    if (standings.thirdPlace) map.set(standings.thirdPlace, { type: 'bronze', emoji: '🥉' });
    return map;
  }

  /* 赛事状态徽章（upcoming/ongoing/finished），渲染在赛程页顶栏标题旁；
   * ongoing 红色 LIVE，配合 .status-dot 呼吸点（reduced-motion 下静态） */
  function statusBadgeMarkup(status) {
    const map = {
      upcoming: { cls: 'status-upcoming', text: '未开始' },
      ongoing: { cls: 'status-ongoing', text: 'LIVE' },
      finished: { cls: 'status-finished', text: '已结束' }
    };
    const item = map[status] || map.upcoming;
    return '<span class="status-badge ' + item.cls + '"><span class="status-dot" aria-hidden="true"></span>' +
      item.text + '</span>';
  }

  /* 赛程页的浮动缩放控件绑定 */
  function bindZoomDock(handlers) {
    const dock = document.getElementById('zoom-dock');
    if (!dock || !handlers) return;
    dock.addEventListener('click', (event) => {
      const btn = event.target.closest('.zoom-btn');
      if (!btn) return;
      const kind = btn.dataset.zoom;
      if (kind === 'in' && handlers.onZoomIn) handlers.onZoomIn();
      else if (kind === 'out' && handlers.onZoomOut) handlers.onZoomOut();
      else if (kind === 'reset' && handlers.onReset) handlers.onReset();
      else if (kind === 'fit' && handlers.onFit) handlers.onFit();
    });
  }

  function bindZoomFitOnResize(shouldFit, fit) {
    if (typeof shouldFit !== 'function' || typeof fit !== 'function') return;
    window.addEventListener('resize', debounce(() => {
      if (shouldFit()) fit();
    }, 200));
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
    formatStartTime,
    medalMap,
    avatarMarkup,
    normalizePlayer,
    notify,
    uiConfirm,
    bindZoomDock,
    bindZoomFitOnResize
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

  /* ---------- 主题(浅/深)----------
   * theme-init.js 已在首帧前写入初始 data-theme;这里负责读取当前生效主题、
   * 切换与持久化,以及未显式选择时跟随系统偏好变化。 */

  function currentTheme() {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark' || attr === 'light') return attr;
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (error) {
      return 'light';
    }
  }

  function applyTheme(theme) {
    if (theme !== 'dark' && theme !== 'light') return;
    document.documentElement.setAttribute('data-theme', theme);
  }

  function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(LS_THEME, next);
    } catch (error) {
      /* 存储不可用:仅本次会话生效 */
    }
    applyTheme(next);
    renderHeader();
  }

  function bindSystemThemeChange() {
    try {
      const query = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => {
        let stored = null;
        try { stored = localStorage.getItem(LS_THEME); } catch (error) { /* 忽略 */ }
        if (stored === 'light' || stored === 'dark') return; /* 已显式选择 */
        applyTheme(currentTheme());
        renderHeader();
      };
      if (query.addEventListener) query.addEventListener('change', onChange);
      else if (query.addListener) query.addListener(onChange);
    } catch (error) {
      /* 不支持 matchMedia 的环境跳过跟随 */
    }
  }

  function renderSidebar() {
    const placeholder = document.getElementById('app-sidebar');
    if (!placeholder) return;
    /* 页面自带静态导航骨架时不再重建,避免闪烁也省一次 innerHTML */
    if (placeholder.querySelector('.side-nav')) return;
    const app = window.TournamentApp;
    const active = app && app.activePage;
    const items = [
      { page: 'home', href: 'index.html', icon: 'home', label: '主页' },
      { page: 'match', href: 'schedule.html', icon: 'emoji_events', label: '比赛' },
      { page: 'players', href: 'players.html', icon: 'groups', label: '选手库' },
      { page: 'poster', href: 'poster.html', icon: 'vs_poster', label: '海报' }
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

  let headerHeightBound = false;

  /* 顶栏高度随视口换行变化，写入 CSS 变量供整页画布 calc 使用 */
  function syncHeaderHeight() {
    const placeholder = document.getElementById('app-header');
    if (!placeholder) return;
    document.documentElement.style.setProperty('--header-height', placeholder.offsetHeight + 'px');
  }

  function renderHeader() {
    const app = window.TournamentApp;
    const placeholder = document.getElementById('app-header');
    if (!placeholder) return;
    const active = app.current;
    const pageTitles = { home: '右手杯', players: '选手库', poster: '海报生成器' };
    const headerTitle = pageTitles[app.activePage] || active.name;
    const options = app.list.map((item) =>
      '<option value="' + item.id + '"' + (item.id === active.id ? ' selected' : '') + '>' +
      escapeHtml(item.name) +
      '</option>'
    ).join('');
    const isSchedule = app.activePage === 'schedule';
    const isPoster = app.activePage === 'poster';
    const showTournamentSwitch = app.activePage === 'schedule';
    const scheduleActions = isSchedule
      ? '<button type="button" id="header-rules-btn" class="btn btn-ghost btn-sm icon-btn" title="赛制规则" aria-label="赛制规则">' + iconMarkup('rule', '赛制规则') + '</button>' +
        '<button type="button" id="header-roster-btn" class="btn btn-ghost btn-sm icon-btn" title="选手名单" aria-label="选手名单">' + iconMarkup('groups', '选手名单') + '</button>' +
        '<button type="button" id="header-edit-btn" class="btn btn-secondary btn-sm icon-btn" title="编辑" aria-label="编辑">' + iconMarkup('edit', '编辑') + '</button>'
      : '';
    const tournamentSwitch = showTournamentSwitch
      ? '<label class="visually-hidden" for="tournament-switch">切换比赛</label>' +
        '<select id="tournament-switch" class="header-select" title="切换比赛" aria-label="切换比赛">' + options + '</select>'
      : '';
    /* 海报页页头专属控制（主题选择/分辨率/导出/OBS），仅海报页渲染 */
    const posterControls = isPoster
      ? '<div class="header-poster-controls" id="header-poster-controls">' +
        '  <div class="picker poster-picker">' +
        '    <button type="button" id="poster-theme-picker" class="btn btn-ghost btn-sm poster-theme-btn" aria-haspopup="listbox" aria-expanded="false">' +
        '      <span class="poster-theme-dot" id="poster-theme-dot" aria-hidden="true"></span>' +
        '      <span id="poster-theme-name">红蓝宿敌</span>' +
        '    </button>' +
        '    <ul id="poster-theme-menu" class="poster-theme-menu" role="listbox" aria-label="选择海报主题" hidden></ul>' +
        '  </div>' +
        '  <label class="field field--inline poster-resolution" for="poster-resolution"><span class="field__label">分辨率</span>' +
        '    <select id="poster-resolution" class="field__control"><option value="1080p">1080p</option><option value="2k">2K</option><option value="4k">4K</option></select></label>' +
        '  <button type="button" id="poster-export" class="btn btn-primary btn-sm"><span id="poster-export-label">导出 PNG</span></button>' +
        '  <button type="button" id="poster-obs" class="btn btn-ghost btn-sm" title="复制 OBS 浏览器源链接">OBS 源</button>' +
        '</div>'
      : '';
    /* 主题切换按钮:显示"将切换到"的目标模式图标(浅色时显示月亮) */
    const theme = currentTheme();
    const toDark = theme !== 'dark';
    const themeLabel = toDark ? '切换为深色模式' : '切换为浅色模式';
    const themeBtn =
      '<button type="button" id="header-theme-btn" class="btn btn-ghost btn-sm icon-btn" title="' + themeLabel + '" aria-label="' + themeLabel + '">' +
      iconMarkup(toDark ? 'dark_mode' : 'light_mode', themeLabel) +
      '</button>';
    /* 赛程页 main 无 h1,顶栏标题承担 h1;其余页面 main 自带 h1,顶栏用 span 避免双 h1。
     * 主页顶栏不显示标题;状态徽章只在赛程页出现 */
    const titleTag = isSchedule ? 'h1' : 'span';
    const titleGroup = app.activePage === 'home'
      ? ''
      : '  <div class="header-title-group">' +
        '    <' + titleTag + ' class="header-title" title="' + escapeHtml(headerTitle) + '">' + escapeHtml(headerTitle) + '</' + titleTag + '>' +
        (isSchedule ? statusBadgeMarkup(active.status) : '') +
        '  </div>';
    placeholder.innerHTML =
      '<div class="header-inner">' +
      titleGroup +
      '  <div class="header-actions">' +
      tournamentSwitch +
      scheduleActions +
      posterControls +
      themeBtn +
      '    <button type="button" id="manage-btn" class="btn btn-secondary btn-sm icon-btn" title="管理" aria-label="管理">' + iconMarkup('dashboard', '管理') + '</button>' +
      '    <button type="button" id="settings-btn" class="btn btn-secondary btn-sm icon-btn" title="设置" aria-label="设置">' + iconMarkup('settings', '设置') + '</button>' +
      '  </div>' +
      '</div>';

    placeholder.querySelector('#header-theme-btn').addEventListener('click', toggleTheme);

    /* 海报 OBS 推送按钮仅管理员可见（访客只读渲染） */
    const posterObs = placeholder.querySelector('#poster-obs');
    if (posterObs) posterObs.hidden = !canEdit();

    const switchSelect = placeholder.querySelector('#tournament-switch');
    if (switchSelect) {
      switchSelect.addEventListener('change', async (event) => {
        try {
          await setActiveId(event.target.value);
          document.dispatchEvent(new CustomEvent(EVT_CHANGED));
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
      });
    }
    syncHeaderHeight();
    if (!headerHeightBound) {
      headerHeightBound = true;
      window.addEventListener('resize', debounce(syncHeaderHeight, 120));
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

  /* 记录结构版本:已是最新的记录跳过迁移,免每条记录两次全量 JSON.stringify */
  const SCHEMA_VERSION = 2;

  async function refreshApp() {
    let all = await storageGetAll();
    let players = await storageGetPlayers();
    /* 归一化选手字段（title 对象结构 / color 校验），损坏条目丢弃并标记待回写 */
    let playersDirty = false;
    const normalizedPlayers = [];
    for (const p of (players || [])) {
      const n = normalizePlayer(p);
      if (!n) {
        playersDirty = true;
        continue;
      }
      normalizedPlayers.push(n);
      if (JSON.stringify(n) !== JSON.stringify(p)) playersDirty = true;
    }
    players = normalizedPlayers;
    const playerMap = new Map(players.map((p) => [p.id, p]));
    const dirtyRecords = [];

    for (const record of all) {
      if (!record) continue;
      const needsMigration = record.schemaVersion !== SCHEMA_VERSION;
      const before = needsMigration ? JSON.stringify(record) : JSON.stringify(record.roster || null);
      if (needsMigration) {
        if (CanvasModel.migrateLegacyTournament) {
          CanvasModel.migrateLegacyTournament(record, playerMap);
        }
        if (CanvasModel.ensureCanvasDecks) {
          CanvasModel.ensureCanvasDecks(record);
        }
        record.schemaVersion = SCHEMA_VERSION;
      }
      if (CanvasModel.deriveRoster && record.canvas) {
        record.roster = CanvasModel.deriveRoster(record.canvas).filter((id) => playerMap.has(id));
      }
      const after = needsMigration ? JSON.stringify(record) : JSON.stringify(record.roster || null);
      if (before !== after) dirtyRecords.push(record);
    }
    players = [...playerMap.values()];
    // 云端只读访客不允许写库：迁移/推导只放在内存里，避免初始化直接失败
    const canWrite = mode !== 'cloud' || (appInstance && appInstance.isAdmin());
    if (canWrite && (dirtyRecords.length || playersDirty || !players.length)) {
      try {
        await storagePutPlayers(players);
      } catch (error) {
        console.error('[refreshApp] 保存全局选手失败:', error);
      }
    }
    // 只回写发生变化的比赛;云端模式合并为一次 GET+PUT,
    // 避免逐条 storagePut 各自先拉云端再覆盖(写放大)
    if (canWrite && dirtyRecords.length) {
      if (mode === 'cloud') {
        for (const record of dirtyRecords) {
          const index = cloudWorkspace.tournaments.findIndex((t) => t.id === record.id);
          if (index >= 0) cloudWorkspace.tournaments[index] = record;
          else cloudWorkspace.tournaments.push(record);
        }
        try {
          await cloudPutWorkspace(cloudWorkspace);
        } catch (error) {
          console.error('[refreshApp] 批量保存失败:', error);
        }
      } else {
        for (const record of dirtyRecords) {
          await storagePut(record);
        }
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
      adminToken: loadAdminToken(),
      blobUrl,
      compressImage,
      compressAvatar,
      openLightbox,
      renderHeader,
      renderSidebar,
      /* 存储适配器：本地模式走 IndexedDB，云端模式走 Vercel Blob */
      storagePut,
      storageGetAll,
      storagePutPlayers,
      storageDeletePlayer,
      setAdminToken,
      uploadImage: uploadCloudImage,
      fatalError: showFatalError
    };
    window.TournamentApp = appInstance;
    bindSystemThemeChange();
    try {
      const cached = readWorkspaceCache();
      if (cached) {
        /* 缓存命中:立即以云端模式渲染,过期则后台校新 */
        mode = 'cloud';
        setCloudWorkspace(normalizeWorkspace(cached.workspace));
        appInstance.mode = mode;
        await refreshApp();
        document.dispatchEvent(new CustomEvent(EVT_READY));
        if (Date.now() - cached.savedAt > WORKSPACE_CACHE_TTL) revalidateWorkspaceQuietly();
        return;
      }
      const workspace = await probeCloud();
      if (workspace) {
        mode = 'cloud';
        setCloudWorkspace(normalizeWorkspace(workspace));
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
    document.dispatchEvent(new CustomEvent(EVT_READY));
  }

  window.TournamentAppInit = init;
})();
