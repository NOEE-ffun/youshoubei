(function () {
  'use strict';

  const DB_NAME = 'tournament-site';
  const DB_VERSION = 2;
  const STORE = 'tournaments';
  const META_STORE = 'meta';
  const META_PLAYERS = 'globalPlayers';
  const LS_ACTIVE = 'ts:activeTournamentId';
  /* 跨文件事件协议:数据变更 / 应用就绪。common.js 派发,各页面监听 */
  const EVT_CHANGED = 'ts:changed';
  const EVT_READY = 'ts:ready';
  const pad2 = (n) => String(n).padStart(2, '0');
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
   * 异常协议或带引号的 URL 不得进入属性或 CSS url()）。
   * 注意不放行 http: —— 主站图片最终要入库 OSS 并被 https 页面引用;
   * 海报编辑器(vs-poster/js/upload.js 的 isAllowedURL)另需放行 http: 供本机调试,
   * 两处策略有意不同,统一前先确认场景 */
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
      tag: '',
      tagImg: null,
      tagImgRatio: null,
      tagImgSize: null,
      title: '',
      color: null,
      avatar: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }));
  }

  /* 选手对象归一化：title(赛前垃圾话)统一为纯文本字符串、color 校验为 #rrggbb 或 null、
   * tag(ID/队名)为 ≤16 字符纯文本(与海报输入框 maxlength 一致)、
   * tagImg(队标图)为字符串(dataURL 或 OSS URL)或 null,ratio/size 为正数或 null。
   * 兼容上一版 {type,text,image} 对象结构,取其中 text 并丢弃 image。
   * 非法选手对象返回 null；字段可修复时返回浅拷贝的新对象（原对象不动）。 */
  function normalizePlayer(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    let title = '';
    if (typeof p.title === 'string') title = p.title;
    else if (p.title && typeof p.title === 'object' && typeof p.title.text === 'string') title = p.title.text;
    const color = /^#[0-9a-fA-F]{6}$/.test(p.color || '') ? p.color : null;
    const tag = typeof p.tag === 'string' ? p.tag.trim().slice(0, 16) : '';
    const tagImg = typeof p.tagImg === 'string' && p.tagImg ? p.tagImg : null;
    const tagImgRatio = Number.isFinite(Number(p.tagImgRatio)) && Number(p.tagImgRatio) > 0 ? Number(p.tagImgRatio) : null;
    const tagImgSize = Number.isFinite(Number(p.tagImgSize)) && Number(p.tagImgSize) > 0 ? Number(p.tagImgSize) : null;
    const out = Object.assign({}, p);
    out.title = title;
    out.color = color;
    out.tag = tag;
    out.tagImg = tagImg;
    out.tagImgRatio = tagImgRatio;
    out.tagImgSize = tagImgSize;
    return out;
  }

  function makeDefaultTournament(name, roster) {
    const r = roster || [];
    const record = CanvasModel.createDefaultTournament(name, r);
    record.rules = DEFAULT_RULES;
    return record;
  }

  function makeBlankTournament(name) {
    const record = CanvasModel.createBlankTournament(name);
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
   * 404(未部署 API)/超时/网络错误 → 本机模式,省掉原先 /api/health 的串行往返。
   * 401 是会话问题而非部署问题:跳登录页并中止 init,绝不落本地模式 */
  async function probeCloud() {
    let timer = null;
    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), 2000);
      const response = await fetch('/api/data', { signal: controller.signal, headers: cloudGetHeaders() });
      clearTimeout(timer);
      timer = null;
      if (!response.ok) {
        if (response.status === 401) throw redirectOnExpiredSession();
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
      /* 登录跳转错误必须穿透,否则会被这里吞掉落回本机模式 */
      if (error && error.loginRedirect) throw error;
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /* 补齐 workspace 缺省字段:players/tournaments 为空时造默认数据,activeId 兜底到第一场。
   * series 全链路透传:非数组统一补 [](条目保留原样,结构由服务端 PUT 守卫校验),
   * 否则管理端任一次整库保存会把云端系列列表洗掉 */
  function normalizeWorkspace(workspace) {
    workspace.series = Array.isArray(workspace.series) ? workspace.series : [];
    if (!workspace.players) workspace.players = [];
    if (!workspace.tournaments || !workspace.tournaments.length) {
      const list = workspace.players.length ? workspace.players : makeDefaultPlayers();
      workspace.players = list;
      const fresh = makeDefaultTournament('我的赛事', list.map((p) => p.id));
      workspace = { series: workspace.series, players: workspace.players, tournaments: [fresh], activeId: fresh.id };
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

  /* GET 无需显式鉴权头:同源自动携带会话 cookie,服务端对未公示卡组按请求者剥离,
   * 管理员必须拿全量数据,否则本地快照再保存会把选手已提交的卡组抹掉 */
  function cloudGetHeaders() {
    return { 'Accept': 'application/json' };
  }

  async function revalidateWorkspaceQuietly() {
    try {
      const response = await fetch('/api/data', { headers: cloudGetHeaders() });
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
      writeWorkspaceCache(fresh); /* 变化时也必须回写,否则后续页面 60s 内命中旧缓存 */
      await refreshApp();
      document.dispatchEvent(new CustomEvent(EVT_CHANGED));
    } catch (error) {
      /* 后台校新失败:沿用现有数据,不打扰用户 */
    }
  }

  async function cloudGetWorkspace() {
    const response = await fetch('/api/data', { headers: cloudGetHeaders() });
    if (response.status === 404) return { tournaments: [], series: [], players: [], activeId: null };
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
      if (!remote) byId.set(t.id, t);
      else if ((t.updatedAt || 0) >= (remote.updatedAt || 0)) byId.set(t.id, mergeRecordClassLinks(t, remote));
      else byId.set(t.id, mergeRecordClassLinks(remote, t));
    }
    const playerMap = new Map();
    for (const p of (latest && latest.players) || []) playerMap.set(p.id, p);
    for (const p of (local && local.players) || []) {
      const remote = playerMap.get(p.id);
      if (!remote || (p.updatedAt || 0) >= (remote.updatedAt || 0)) playerMap.set(p.id, p);
    }
    /* series 按 id 并集、字段以云端为准:系列的建/改/删走后台专用接口,不随整库快照合并;
     * 本地快照里独有的系列追加在后,避免合并路径把云端系列列表剥掉 */
    const seriesMap = new Map();
    for (const s of (latest && latest.series) || []) {
      if (s && s.id != null) seriesMap.set(s.id, s);
    }
    for (const s of (local && local.series) || []) {
      if (s && s.id != null && !seriesMap.has(s.id)) seriesMap.set(s.id, s);
    }
    return {
      activeId: (local && local.activeId) || (latest && latest.activeId) || null,
      players: [...playerMap.values()],
      tournaments: [...byId.values()],
      series: [...seriesMap.values()]
    };
  }

  /* 管理端旧快照落盘时,远端记录里选手已提交的 classLinks 不能丢:
   * 逐卡逐侧,胜者侧为"未填"([]/缺省)而败者侧有实际条目 → 保留败者条目。
   * 显式 null(阻断继承)是有意为之,不做让位。
   * signup.players(报名名单)同理:胜者快照未见过的新报名并回来,open 以胜者为准。 */
  function mergeRecordClassLinks(winner, loser) {
    const loserCards = new Map(((loser && loser.canvas && loser.canvas.cards) || []).map((c) => [c.id, c]));
    for (const card of ((winner && winner.canvas && winner.canvas.cards) || [])) {
      const other = loserCards.get(card.id);
      if (!other || !other.classLinks) continue;
      if (!card.classLinks || typeof card.classLinks !== 'object') card.classLinks = { a: [], b: [] };
      for (const side of ['a', 'b']) {
        const mine = card.classLinks[side];
        const theirs = other.classLinks[side];
        const mineEmpty = mine === undefined || (Array.isArray(mine) && mine.length === 0);
        if (mineEmpty && Array.isArray(theirs) && theirs.length > 0) card.classLinks[side] = theirs;
      }
    }
    if (loser && loser.signup && loser.signup.players) {
      if (!winner.signup) {
        winner.signup = loser.signup;
      } else {
        const merged = Array.isArray(winner.signup.players) ? winner.signup.players.slice() : [];
        for (const id of loser.signup.players) {
          if (typeof id === 'string' && !merged.includes(id)) merged.push(id);
        }
        winner.signup.players = merged;
        /* 取前人数(管理端配置):胜者未设则继承败者,不随快照丢失 */
        if (winner.signup.slots == null && loser.signup.slots != null) {
          winner.signup.slots = loser.signup.slots;
        }
      }
    }
    return winner;
  }

  /* 云端写队列：同一页面内串行化，避免并发写乱序覆盖 */
  let cloudWriteQueue = Promise.resolve();

  async function cloudPutWorkspace(workspace, options) {
    if (!isAdmin()) throw new Error('需要管理员权限');
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
      /* 写入鉴权走同源会话 cookie(服务端校验 admin/super 角色) */
      const response = await fetch('/api/data', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (response.status === 401) throw new Error('登录已过期，请重新登录');
      if (!response.ok) throw new Error((await apiErrorMessage(response)) || '保存云端数据失败');
      /* 上传成功后本地快照与上传内容对齐 */
      setCloudWorkspace(payload);
    };
    const result = cloudWriteQueue.then(run, run);
    cloudWriteQueue = result.catch(() => {});
    return result;
  }

  async function uploadCloudImage(blob) {
    /* 鉴权走同源自动携带的会话 cookie:管理员或登录选手均可上传 */
    const response = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob
    });
    if (response.status === 401) throw new Error('登录已过期，请重新登录后再上传');
    if (response.status === 403) throw new Error('上传需要选手或管理员身份');
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
      /* 保存即打时间戳:合并逻辑按 updatedAt 取新者,不打戳的话
       * 选手提交刚顶新过服务器记录,管理端这次保存会被整条丢弃 */
      record.updatedAt = Date.now();
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

  function isAdmin() {
    return Boolean(sessionUser && (sessionUser.role === 'admin' || sessionUser.role === 'super'));
  }

  /* 归属管理权(与服务端 api/acl.js canManageResource 同口径):super 恒 true;
   * admin 需 resource.createdBy === 本人 id;createdBy 缺失/null(系统资源/未回读)
   * 仅 super 可管;其余角色恒 false。本地模式无归属概念,调用方以 mode!=='cloud' 短路。 */
  function canManage(resource) {
    if (!sessionUser) return false;
    if (sessionUser.role === 'super') return true;
    if (sessionUser.role !== 'admin') return false;
    return Boolean(resource && resource.createdBy != null && resource.createdBy === sessionUser.id);
  }

  async function migrateLocalToCloud() {
    const local = await idbGetAll();
    const localPlayers = (await idbGetMeta(META_PLAYERS)) || [];
    const playerMap = new Map(localPlayers.map((p) => [p.id, p]));
    const tournaments = [];
    /* 头像与赛事无关,只上传一轮;放在赛事循环外,避免每条记录重复扫描全部选手 */
    for (const player of playerMap.values()) {
      if (player.avatar && typeof player.avatar !== 'string') {
        player.avatar = await uploadCloudImage(player.avatar);
      }
    }
    for (const record of local) {
      const copy = structuredClone(record);
      CanvasModel.migrateLegacyTournament(copy, playerMap);
      if (copy.canvas) CanvasModel.migrateCanvasToDot(copy.canvas);
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
      series: [],
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
  let seriesDialog = null;
  let seriesEditing = null; /* 系列弹窗当前编辑对象;null=新建模式 */
  let pendingBackground = null;

  /* ---------- 管理弹窗 ---------- */

  function buildManageDialog() {
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
      '    <select id="new-tournament-series" aria-label="所属系列" hidden></select>' +
      '    <button type="submit" class="btn btn-primary btn-sm">新建比赛</button>' +
      '  </form>' +
      '  <div class="manage-subsection" id="series-subsection" hidden>' +
      '    <h3>系列</h3>' +
      '    <div class="dialog-actions">' +
      '      <span class="hint">系列用于主页与切换下拉的分组;创建后可在主页小节标题旁编辑名称与简介。</span>' +
      '      <button type="button" id="manage-new-series-btn" class="btn btn-secondary btn-sm">新建系列</button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="manage-subsection">' +
      '    <h3>比赛列表</h3>' +
      '    <div id="manage-list" class="manage-list" aria-label="已有比赛列表"></div>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(manageDialog);

    manageDialog.querySelector('#create-tournament-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = manageDialog.querySelector('#new-tournament-name');
      const template = manageDialog.querySelector('#new-tournament-template');
      const seriesSelect = manageDialog.querySelector('#new-tournament-series');
      const name = input.value.trim() || '我的赛事';
      let record;
      if (template && template.value === 'double') {
        record = makeDefaultTournament(name);
      } else {
        record = makeBlankTournament(name);
      }
      /* 所属系列:下拉值写入 seriesId,「未分组」= null;
       * createdBy 由服务端整库守卫盖章,前端不管 */
      record.seriesId = (seriesSelect && !seriesSelect.hidden && seriesSelect.value) || null;
      try {
        await storagePut(record);
      } catch (error) {
        notify('新建比赛失败：' + errMsg(error), 'danger');
        return;
      }
      await setActiveId(record.id);
      input.value = '';
      if (seriesSelect) seriesSelect.value = '';
      renderManageList();
      document.dispatchEvent(new CustomEvent(EVT_CHANGED));
    });

    manageDialog.querySelector('#manage-new-series-btn').addEventListener('click', () => {
      openSeriesDialog(null);
    });
  }

  /* 管理弹窗系列控件:新建届的所属系列下拉(全部系列+未分组)与「新建系列」入口,
   * 仅云端管理员可见——series 只存在于云端 workspace,本地模式恒隐藏 */
  function renderSeriesControls() {
    if (!manageDialog) return;
    const subsection = manageDialog.querySelector('#series-subsection');
    const select = manageDialog.querySelector('#new-tournament-series');
    const adminCloud = mode === 'cloud' && isAdmin();
    const list = adminCloud
      ? ((appInstance && appInstance.series) || []).filter((s) => s && s.id != null && s.name)
      : [];
    if (subsection) subsection.hidden = !adminCloud;
    if (!select) return;
    select.hidden = !adminCloud || !list.length;
    const sig = list.map((s) => s.id + ':' + s.name).join('|');
    if (select.dataset.sig !== sig) {
      select.dataset.sig = sig;
      select.innerHTML = '<option value="">未分组</option>' +
        list.map((s) =>
          '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.name) + '</option>'
        ).join('');
    }
  }

  /* ---------- 系列弹窗(新建/编辑共用) ----------
   * 系列建/改一律走 noMerge 精确流:GET 服务端原始 JSON → 就地改 series →
   * PUT {noMerge:true} → 回读拿服务端盖章的 createdBy。
   * 绝不能改 cloudWorkspace.series 后走默认 merge:mergeWorkspace 对 series
   * 是"云端权威+并集",本地改名会被静默抹掉(与 storageDelete 同理)。
   * 删除系列本期不做(YAGNI,届的迁移去向需产品决策)。 */
  function buildSeriesDialog() {
    seriesDialog = document.createElement('dialog');
    seriesDialog.id = 'series-dialog';
    seriesDialog.setAttribute('aria-labelledby', 'series-dialog-title');
    seriesDialog.innerHTML =
      '<div class="dialog-head">' +
      '  <h2 id="series-dialog-title">系列</h2>' +
      '  <button type="button" class="btn btn-ghost btn-sm" data-dialog-close>关闭</button>' +
      '</div>' +
      '<form id="series-form">' +
      '  <div class="dialog-body">' +
      '    <div class="form-field">' +
      '      <label for="series-name-input">系列名称</label>' +
      '      <input type="text" id="series-name-input" required maxlength="32" autocomplete="off">' +
      '    </div>' +
      '    <div class="form-field">' +
      '      <label for="series-desc-input">简介(可选)</label>' +
      '      <textarea id="series-desc-input" placeholder="一句话介绍该系列,留空亦可"></textarea>' +
      '    </div>' +
      '    <div class="dialog-actions">' +
      '      <button type="button" class="btn btn-secondary" data-dialog-close>取消</button>' +
      '      <button type="submit" class="btn btn-primary" id="series-save-btn">保存</button>' +
      '    </div>' +
      '  </div>' +
      '</form>';
    document.body.appendChild(seriesDialog);
    seriesDialog.querySelector('#series-form').addEventListener('submit', saveSeriesFromDialog);
  }

  /* series 传系列对象=编辑模式;null/undefined=新建模式 */
  function openSeriesDialog(series) {
    buildDialogs();
    const target = series && series.id != null
      ? (((appInstance && appInstance.series) || []).find((s) => s && s.id === series.id) || series)
      : null;
    seriesEditing = target;
    seriesDialog.querySelector('#series-dialog-title').textContent = target ? '编辑系列' : '新建系列';
    seriesDialog.querySelector('#series-name-input').value = target ? (target.name || '') : '';
    seriesDialog.querySelector('#series-desc-input').value = target ? (target.desc || '') : '';
    seriesDialog.showModal();
    const nameInput = seriesDialog.querySelector('#series-name-input');
    nameInput.focus();
    nameInput.select();
  }

  async function saveSeriesFromDialog(event) {
    event.preventDefault();
    if (mode !== 'cloud' || !isAdmin()) {
      notify('系列管理需要管理员账号(云端模式)', 'danger');
      return;
    }
    const nameInput = seriesDialog.querySelector('#series-name-input');
    const descInput = seriesDialog.querySelector('#series-desc-input');
    const name = nameInput.value.trim();
    if (!name) {
      notify('请填写系列名称', 'danger');
      return;
    }
    const desc = descInput.value.trim();
    const editing = Boolean(seriesEditing);
    const saveBtn = seriesDialog.querySelector('#series-save-btn');
    saveBtn.disabled = true;
    try {
      const latest = await cloudGetWorkspace(); /* 服务端原始 JSON */
      latest.series = Array.isArray(latest.series) ? latest.series : [];
      if (editing) {
        const target = latest.series.find((s) => s && s.id === seriesEditing.id);
        if (!target) throw new Error('该系列已不存在，请刷新后重试');
        /* 前端预判归属,服务端整库守卫仍是权威兜底 */
        if (!canManage(target)) throw new Error('无权修改该系列');
        target.name = name;
        target.desc = desc;
      } else {
        latest.series.push({ id: uid('s'), name: name, desc: desc, createdAt: Date.now() });
      }
      await cloudPutWorkspace(latest, { noMerge: true });
      /* 回读服务端盖章的 createdBy(新建必经;编辑统一同口径) */
      try {
        setCloudWorkspace(normalizeWorkspace(await cloudGetWorkspace()));
      } catch (error) {
        notify('已保存，但回读最新数据失败：' + errMsg(error), 'danger');
      }
      await refreshApp();
      renderSeriesControls();
      seriesDialog.close();
      document.dispatchEvent(new CustomEvent(EVT_CHANGED));
      notify(editing ? '系列已更新' : '系列已创建');
    } catch (error) {
      notify((editing ? '保存系列失败：' : '新建系列失败：') + errMsg(error), 'danger');
    } finally {
      saveBtn.disabled = false;
    }
  }

  /* ---------- 设置弹窗 ---------- */

  function buildSettingsDialog() {
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
      '    <div class="form-field">' +
      '      <span id="deck-window-label">卡组提交</span>' +
      '      <div class="deck-window-controls">' +
      '        <label for="deck-window-open">每日开放</label>' +
      '        <input type="time" id="deck-window-open" aria-label="每日开放时间">' +
      '        <label for="deck-window-close">至</label>' +
      '        <input type="time" id="deck-window-close" aria-label="每日关闭时间">' +
      '        <select id="deck-window-manual" aria-label="手动开关">' +
      '          <option value="auto">按时段自动</option>' +
      '          <option value="open">手动：开启</option>' +
      '          <option value="closed">手动：关闭</option>' +
      '        </select>' +
      '      </div>' +
      '      <p class="hint" id="deck-window-hint">开启期间：选手可在「我的对局」修改自己未开始场次的卡组，未开始场次的卡组对其他人隐藏；关闭即全员公示。时段留空则只看手动开关。</p>' +
      '    </div>' +
'    <div class="form-field">' +
'      <span id="signup-label">比赛报名</span>' +
'      <div class="deck-window-controls">' +
'        <select id="signup-open" aria-label="报名开关">' +
'          <option value="closed">关闭</option>' +
'          <option value="open">开放报名</option>' +
'        </select>' +
'        <span class="hint" id="signup-count"></span>' +
'      </div>' +
'      <div class="deck-window-controls">' +
'        <label for="signup-slots">取前</label>' +
'        <input type="number" id="signup-slots" min="1" max="999" step="1" aria-label="取前多少人参赛">' +
'        <span class="hint">人参赛(报名不限人数,按先后取前 N)</span>' +
'        <span class="hint" id="signup-slots-hint"></span>' +
'      </div>' +
'      <p class="hint">开放期间选手在「我的比赛」页自助报名/取消;已上场的选手不能自助退赛。</p>' +
'      <div class="dialog-actions" id="signup-autofill-row">' +
'        <button type="button" id="signup-autofill" class="btn btn-secondary btn-sm">自动填入选手</button>' +
'        <span class="hint">报名关闭后可用:前 N 名随机填入无箭头指向的比赛,已指派选手会被覆盖。</span>' +
'      </div>' +
'    </div>' +
      '    <div class="dialog-actions" id="migration-actions" hidden>' +
      '      <button type="button" id="migrate-up" class="btn btn-secondary btn-sm">将本机数据上传到云端</button>' +
      '      <button type="button" id="migrate-down" class="btn btn-secondary btn-sm">从云端拉取覆盖本机</button>' +
      '    </div>' +
      '    <div class="dialog-actions">' +
      '      <button type="button" class="btn btn-secondary" data-dialog-close>取消</button>' +
      '      <button type="submit" class="btn btn-primary">保存</button>' +
      '    </div>' +
      '  </div>' +
      '</form>' +
      '<input type="file" id="bg-file-input" accept="image/*" hidden>';
    document.body.appendChild(settingsDialog);

    bindSettingsForm();
    bindBackgroundControls();
    bindMigrationButtons();
  }

  function bindSettingsForm() {
    settingsDialog.querySelector('#settings-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (mode === 'cloud' && !appInstance.isAdmin()) {
        notify('保存设置需要管理员账号', 'danger');
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
      /* 卡组提交开关:手动优先,时段留空=不自动 */
      const dwOpen = settingsDialog.querySelector('#deck-window-open');
      const dwClose = settingsDialog.querySelector('#deck-window-close');
      const dwManual = settingsDialog.querySelector('#deck-window-manual');
      const dw = { open: '', close: '', manual: null };
      if (dwOpen && dwClose && dwManual) {
        dw.open = dwOpen.value || '';
        dw.close = dwClose.value || '';
        dw.manual = dwManual.value === 'open' ? 'open' : dwManual.value === 'closed' ? 'closed' : null;
      }
      /* 半配置即静默恒关(服务端 parseHHMM 缺一恒 false):成对校验,当次保存拦截 */
      if ((dw.open ? 1 : 0) !== (dw.close ? 1 : 0)) {
        notify('卡组提交时段需成对填写:开放与关闭时间都填,或都留空只用手动开关', 'danger');
        return;
      }
      if (dw.open || dw.close || dw.manual) record.deckWindow = dw;
      else delete record.deckWindow;
      /* 报名开关:只改 open/取前人数,players 名单保留 */
      const signupSel = settingsDialog.querySelector('#signup-open');
      if (signupSel) {
        const players = (record.signup && Array.isArray(record.signup.players)) ? record.signup.players : [];
        const slotsInput = settingsDialog.querySelector('#signup-slots');
        let slots = null;
        if (slotsInput && slotsInput.value.trim()) {
          slots = Math.floor(Number(slotsInput.value));
          if (!Number.isInteger(slots) || slots < 1) {
            notify('取前人数需为正整数', 'danger');
            return;
          }
          const capacity = CanvasModel.entryCards(record.canvas).length * 2;
          if (slots > capacity) {
            notify('取前人数不能大于空位数(' + capacity + ')', 'danger');
            return;
          }
        }
        const opening = signupSel.value === 'open';
        if (opening || record.signup || slots) {
          record.signup = { open: opening, players, slots };
        }
      }
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

    /* 报名自动填入:关闭报名后手动触发,前 N 名洗牌覆盖入场卡,走正常保存链路 */
    settingsDialog.querySelector('#signup-autofill').addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      if (mode === 'cloud' && !appInstance.isAdmin()) {
        notify('自动填入需要管理员账号', 'danger');
        return;
      }
      const record = appInstance.current;
      const signup = record && record.signup;
      const selNow = settingsDialog.querySelector('#signup-open');
      if (!signup || signup.open || (selNow && selNow.value === 'open')) {
        notify('报名开放期间不能自动填入,请先关闭报名并保存', 'danger');
        return;
      }
      if (!Array.isArray(signup.players) || !signup.players.length) {
        notify('暂无报名选手,无法自动填入', 'danger');
        return;
      }
      const slots = Number(signup.slots);
      if (!Number.isInteger(slots) || slots < 1) {
        notify('请先设置「取前 N 人参赛」并保存', 'danger');
        return;
      }
      const entries = CanvasModel.entryCards(record.canvas);
      const capacity = entries.length * 2;
      if (!capacity) {
        notify('画布上没有入场空位(无箭头指向的比赛)', 'danger');
        return;
      }
      if (slots > capacity) {
        notify('取前人数不能大于空位数(' + capacity + ')', 'danger');
        return;
      }
      const scores = record.scores || {};
      if (entries.some((card) => scores[card.id])) {
        notify('入场卡已录比分,不能自动填入', 'danger');
        return;
      }
      const known = new Set((appInstance.players || []).map((p) => p.id));
      const take = signup.players.filter((id) => known.has(id)).slice(0, slots);
      if (!take.length) {
        notify('报名选手均已不在选手库,无法自动填入', 'danger');
        return;
      }
      btn.disabled = true;
      try {
        const filled = CanvasModel.autoFillEntries(record.canvas, take);
        record.roster = CanvasModel.deriveRoster(record.canvas);
        await storagePut(record);
        notify('已随机填入 ' + filled + ' 名选手');
        renderHeader();
        settingsDialog.close();
        document.dispatchEvent(new CustomEvent(EVT_CHANGED));
      } catch (error) {
        notify('自动填入保存失败：' + errMsg(error), 'danger');
      } finally {
        btn.disabled = false;
      }
    });
  }

  function bindBackgroundControls() {
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
  }

  function bindMigrationButtons() {
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

  function buildDialogs() {
    if (manageDialog) return;
    buildManageDialog();
    buildSettingsDialog();
    buildSeriesDialog();
    for (const dialog of [manageDialog, settingsDialog, seriesDialog]) {
      dialog.querySelectorAll('[data-dialog-close]').forEach((btn) => {
        btn.addEventListener('click', () => dialog.close());
      });
    }
  }

  /* 云端模式下编辑权限按登录角色锁定:非管理员全部字段禁用,迁移按钮隐藏 */
  function syncSettingsAdminState() {
    if (!settingsDialog) return;
    const admin = mode !== 'cloud' || appInstance.isAdmin();
    const migration = settingsDialog.querySelector('#migration-actions');
    const fields = [
      settingsDialog.querySelector('#settings-name'),
      settingsDialog.querySelector('#settings-status'),
      settingsDialog.querySelector('#settings-live-url'),
      settingsDialog.querySelector('#settings-start-time'),
      settingsDialog.querySelector('#settings-rules'),
      settingsDialog.querySelector('#bg-upload'),
      settingsDialog.querySelector('#bg-remove'),
      settingsDialog.querySelector('#deck-window-open'),
      settingsDialog.querySelector('#deck-window-close'),
      settingsDialog.querySelector('#deck-window-manual'),
      settingsDialog.querySelector('#signup-open'),
      settingsDialog.querySelector('#settings-form').querySelector('button[type="submit"]')
    ];

    if (migration) migration.hidden = !admin;
    for (const field of fields) field.disabled = !admin;
  }

  /* 深拷贝赛事:画布卡片换新 id 并重映射集内连线,比分与卡组清零 */
  function cloneTournament(source) {
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
    return copy;
  }

  async function renameTournament(input) {
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
  }

  async function switchTournament(id) {
    try {
      await setActiveId(id);
      renderManageList();
      document.dispatchEvent(new CustomEvent(EVT_CHANGED));
    } catch (error) {
      notify('切换比赛失败：' + errMsg(error), 'danger');
    }
  }

  async function copyTournament(id) {
    try {
      const all = await storageGetAll();
      const source = all.find((t) => t.id === id);
      if (!source) return;
      const copy = cloneTournament(source);
      await storagePut(copy);
      await setActiveId(copy.id);
      renderManageList();
      document.dispatchEvent(new CustomEvent(EVT_CHANGED));
    } catch (error) {
      notify('复制比赛失败：' + errMsg(error), 'danger');
    }
  }

  async function deleteTournament(id) {
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
        /* 删光后兜底重建默认赛事,避免空工作区 */
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
      input.addEventListener('change', () => { renameTournament(input); });
    });
    list.querySelectorAll('[data-switch]').forEach((btn) => {
      btn.addEventListener('click', () => { switchTournament(btn.dataset.switch); });
    });
    list.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', () => { copyTournament(btn.dataset.copy); });
    });
    list.querySelectorAll('[data-delete]').forEach((btn) => {
      btn.addEventListener('click', () => { deleteTournament(btn.dataset.delete); });
    });
  }

  function openManageDialog() {
    buildDialogs();
    renderSeriesControls();
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
    const dw = record.deckWindow || {};
    const dwOpen = settingsDialog.querySelector('#deck-window-open');
    const dwClose = settingsDialog.querySelector('#deck-window-close');
    const dwManual = settingsDialog.querySelector('#deck-window-manual');
    if (dwOpen) dwOpen.value = dw.open || '';
    if (dwClose) dwClose.value = dw.close || '';
    if (dwManual) dwManual.value = dw.manual === 'open' ? 'open' : dw.manual === 'closed' ? 'closed' : 'auto';
    const signupSel = settingsDialog.querySelector('#signup-open');
    const signupCount = settingsDialog.querySelector('#signup-count');
    if (signupSel) signupSel.value = (record.signup && record.signup.open) ? 'open' : 'closed';
    if (signupCount) {
      const n = (record.signup && Array.isArray(record.signup.players)) ? record.signup.players.length : 0;
      signupCount.textContent = n ? ('已报名 ' + n + ' 人') : '暂无报名';
    }
    const signupSlots = settingsDialog.querySelector('#signup-slots');
    const signupSlotsHint = settingsDialog.querySelector('#signup-slots-hint');
    const signupFill = settingsDialog.querySelector('#signup-autofill');
    if (signupSlots) signupSlots.value = (record.signup && record.signup.slots) || '';
    if (signupSlotsHint) {
      signupSlotsHint.textContent = '当前入场空位 ' + (CanvasModel.entryCards(record.canvas).length * 2) + ' 个';
    }
    if (signupFill) signupFill.disabled = Boolean(record.signup && record.signup.open);
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
    const color = CanvasModel.avatarColor(player ? player.id : '');
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
    const standings = CanvasModel.deriveStandings(record);
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

  /* 系列-届分组(主页总览与页头届切换下拉共用),返回 [{ id, label, count, items }]:
   * - 系列顺序 = workspace.series 数组序(后端/种子决定);
   * - 无 seriesId、seriesId 指向不存在的系列(孤儿)、系列名为空 → 归末尾「未分组」;
   * - 届行保持传入顺序,排序与点击行为由调用方决定;
   * - 没有任何届的系列不产出空组。 */
  function groupTournamentsBySeries(tournaments, series) {
    const groups = [];
    const byId = new Map();
    for (const s of (series || []).filter(Boolean)) {
      if (!s.name) continue; /* 系列名为空:其届归「未分组」 */
      const group = { id: s.id, label: s.name, count: 0, items: [] };
      groups.push(group);
      if (s.id != null && !byId.has(s.id)) byId.set(s.id, group);
    }
    const ungrouped = { id: null, label: '未分组', count: 0, items: [] };
    for (const t of (tournaments || []).filter((x) => x && x.id)) {
      const group = (t.seriesId != null && byId.get(t.seriesId)) || ungrouped;
      group.items.push(t);
      group.count += 1;
    }
    const result = groups.filter((g) => g.count > 0);
    if (ungrouped.count > 0) result.push(ungrouped);
    return result;
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

  /* 选手自助页启动守卫(my-decks/my-tourneys 共用):
   * 云模式+登录+绑定选手才放行,返回选手对象;不可用时应答空态并返回 null */
  async function requirePlayerSession(pageNoun, showEmpty) {
    const app = window.TournamentApp;
    if (app.mode !== 'cloud') {
      showEmpty(pageNoun + '需要连接服务器(当前为本机数据模式)。', false);
      return null;
    }
    await app.refreshSession();
    const { user, player } = app.getSession();
    if (!user) {
      showEmpty('未登录。', true);
      return null;
    }
    if (!player) {
      showEmpty('当前是管理员账号(未绑定选手),' + pageNoun + '仅选手账号可用。', false);
      return null;
    }
    return player;
  }

  window.TournamentUtils = {
    escapeHtml,
    iconMarkup,
    errMsg,
    safeUrl,
    cssUrl,
    debounce,
    canEdit,
    canManage,
    save,
    formatStartTime,
    medalMap,
    avatarMarkup,
    normalizePlayer,
    notify,
    uiConfirm,
    bindZoomDock,
    bindZoomFitOnResize,
    requirePlayerSession,
    groupTournamentsBySeries
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
      { page: 'poster', href: 'poster.html', icon: 'vs_poster', label: '海报' },
      { page: 'stats', href: 'stats.html', icon: 'bar_chart', label: '数据统计' },
      { page: 'me', href: 'me.html', icon: 'person', label: '选手中心' }
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

  /* 后台入口链接:侧栏六个主页面的骨架都是各页 HTML 静态自带,
   * renderSidebar 只在无骨架页生效——admin 链接不写进任何静态骨架/items,
   * 统一在此按需补建(静态骨架页与动态构建页两条路都覆盖),
   * 显隐交给 syncHeaderState 按超管角色同步 */
  function ensureAdminNavLink() {
    const sidebar = document.getElementById('app-sidebar');
    const nav = sidebar && sidebar.querySelector('.side-nav');
    if (!nav || nav.querySelector('.side-link[data-page="admin"]')) return;
    const link = document.createElement('a');
    link.className = 'side-link';
    link.href = 'admin.html';
    link.dataset.page = 'admin';
    link.title = '后台';
    link.setAttribute('aria-label', '后台');
    link.innerHTML = '<span class="side-icon" aria-hidden="true">' + iconMarkup('dashboard', '后台') + '</span>';
    /* 文字标签与既有链接同构:侧栏功能组已建好(本次 sync 晚于 buildSideActions)
     * 则自补;否则交给 buildSideActions 统一注入,避免重复标签 */
    if (sideActionsBuilt) appendSideLabel(link, '后台');
    nav.appendChild(link);
  }

  /* 非 owner 管理员浏览他人届的一次性提示台账(每届一次,页面生命周期内) */
  const ownershipNoticed = new Set();

  let headerHeightBound = false;

  /* 顶栏高度随视口换行变化，写入 CSS 变量供整页画布 calc 使用 */
  function syncHeaderHeight() {
    const placeholder = document.getElementById('app-header');
    if (!placeholder) return;
    document.documentElement.style.setProperty('--header-height', placeholder.offsetHeight + 'px');
  }

  /* 顶栏骨架只在首次渲染时构建一次并绑定事件;后续数据/主题/权限变化
   * 走 syncHeaderState 增量更新——全量重建会销毁海报页头的主题菜单、
   * 分辨率选择等控件状态,还会在每次保存后重放整段 HTML 解析 */
  let headerBuilt = false;

  function buildHeaderSkeleton() {
    const app = window.TournamentApp;
    const placeholder = document.getElementById('app-header');
    if (!placeholder) return false;
    const isSchedule = app.activePage === 'schedule';
    const isPoster = app.activePage === 'poster';
    const isPlayers = app.activePage === 'players';
    const showTournamentSwitch = app.activePage === 'schedule';
    /* 这些页 main 不再放 h1(避免与页头重复),顶栏标题承担 h1 */
    const headerAsH1 = ['schedule', 'players', 'stats', 'me'].includes(app.activePage);
    const titleTag = headerAsH1 ? 'h1' : 'span';
    const titleGroup = app.activePage === 'home'
      ? ''
      : '  <div class="header-title-group">' +
        '    <' + titleTag + ' class="header-title"></' + titleTag + '>' +
        '  </div>';
    const tournamentSwitch = showTournamentSwitch
      ? '<label class="visually-hidden" for="tournament-switch">切换比赛</label>' +
        '<select id="tournament-switch" class="header-select" title="切换比赛" aria-label="切换比赛"></select>'
      : '';
    const searchBox = isSchedule
      ? '<div class="header-search" id="header-search">' +
        iconMarkup('search', '查找') +
        '<input type="search" id="match-search" placeholder="查找比赛 / 选手 / 阶段" autocomplete="off" aria-label="查找比赛">' +
        '<span class="search-count" id="match-search-count" hidden></span>' +
        '</div>'
      : '';
    const scheduleActions = isSchedule
      ? '<button type="button" id="view-toggle" class="btn btn-ghost btn-sm icon-btn" title="切换到列表视图" aria-label="切换到列表视图">' + iconMarkup('view_list', '切换到列表视图') + '</button>' +
        searchBox +
        '<button type="button" id="header-rules-btn" class="btn btn-ghost btn-sm icon-btn" title="赛制规则" aria-label="赛制规则">' + iconMarkup('rule', '赛制规则') + '</button>' +
        '<button type="button" id="header-roster-btn" class="btn btn-ghost btn-sm icon-btn" title="选手名单" aria-label="选手名单">' + iconMarkup('groups', '选手名单') + '</button>' +
        '<button type="button" id="header-edit-btn" class="btn btn-secondary btn-sm icon-btn" title="编辑" aria-label="编辑">' + iconMarkup('edit', '编辑') + '</button>' +
        '<button type="button" id="settings-btn" class="btn btn-secondary btn-sm icon-btn" title="赛事设置" aria-label="赛事设置">' + iconMarkup('settings', '赛事设置') + '</button>'
      : '';
    /* 选手库页头:搜索(全员) + 新增(仅管理员,显隐由 syncHeaderState 同步) */
    const playersControls = isPlayers
      ? '<div class="header-search" id="players-search-box">' +
        iconMarkup('search', '搜索选手') +
        '<input type="search" id="players-search" placeholder="搜索选手" autocomplete="off" aria-label="搜索选手">' +
        '</div>' +
        '<form id="add-player-form" class="header-add">' +
        '<input type="text" id="new-player-name" placeholder="新增选手名" required autocomplete="off" aria-label="新增选手名">' +
        '<button type="submit" class="btn btn-primary btn-sm">新增</button>' +
        '</form>'
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
    placeholder.innerHTML =
      '<div class="header-inner">' +
      titleGroup +
      '  <div class="header-actions">' +
      tournamentSwitch +
      scheduleActions +
      playersControls +
      posterControls +
      '  </div>' +
      '</div>';

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
    /* 赛事设置是单场比赛的设置,只挂在赛程页页头 */
    const settingsBtn = placeholder.querySelector('#settings-btn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => openSettingsDialog(false));
    }
    if (!headerHeightBound) {
      headerHeightBound = true;
      window.addEventListener('resize', debounce(syncHeaderHeight, 120));
    }
    headerBuilt = true;
    return true;
  }

  function syncHeaderState() {
    const app = window.TournamentApp;
    const header = document.getElementById('app-header');
    if (header && app.current) {
      const active = app.current;
      const pageTitles = { home: '右手杯', players: '选手库', poster: '海报生成器', stats: '数据统计', me: '选手中心' };
      const headerTitle = pageTitles[app.activePage] || active.name;

      const titleEl = header.querySelector('.header-title');
      if (titleEl && titleEl.textContent !== headerTitle) {
        titleEl.textContent = headerTitle;
        titleEl.setAttribute('title', headerTitle);
      }

      /* 状态徽章只在赛程页出现;值未变时不碰 DOM */
      if (app.activePage === 'schedule') {
        const group = header.querySelector('.header-title-group');
        let badge = group.querySelector('.status-badge');
        const statusKey = String(active.status || '');
        if (!badge || badge.dataset.status !== statusKey) {
          if (badge) badge.remove();
          group.insertAdjacentHTML('beforeend', statusBadgeMarkup(active.status));
          badge = group.querySelector('.status-badge');
          if (badge) badge.dataset.status = statusKey;
        }
      }

      /* 编辑/设置按钮按当前届归属显隐:云端需 admin 且本人可管理该届
       * (super 恒可;非 owner 管理员=选手视角,编辑器进入路径隐藏即只读);
       * 本地模式无归属概念,不设限。画布工具栏/录比分入口都在编辑模式内,
       * 入口按钮隐藏后不可达,无需单独判定 */
      if (app.activePage === 'schedule') {
        const ownerEditable = mode !== 'cloud' || (isAdmin() && canManage(active));
        const editEntryBtn = header.querySelector('#header-edit-btn');
        if (editEntryBtn) editEntryBtn.hidden = !ownerEditable;
        const settingsEntryBtn = header.querySelector('#settings-btn');
        if (settingsEntryBtn) settingsEntryBtn.hidden = !ownerEditable;
        /* 非 owner 管理员打开他人届:顶部一次性提示(每届每页一次) */
        if (mode === 'cloud' && !ownerEditable && isAdmin() && !ownershipNoticed.has(active.id)) {
          ownershipNoticed.add(active.id);
          notify(sessionUser && sessionUser.playerId
            ? '该届由他人创建，你以选手身份浏览'
            : '该届由他人创建，无编辑权限');
        }
      }

      /* 切换比赛下拉:按系列 optgroup 分组(未分组最后),签名变化才重建 options,
       * 否则只同步选中值;签名含系列列表与各届 seriesId,分组变动也会触发重建 */
      const switchSelect = header.querySelector('#tournament-switch');
      if (switchSelect) {
        const signature = app.list.map((item) => item.id + ':' + item.name + ':' + (item.seriesId || '')).join('|')
          + '#' + (app.series || []).map((s) => (s && s.id) + ':' + (s && s.name)).join('|');
        if (switchSelect.dataset.sig !== signature) {
          switchSelect.dataset.sig = signature;
          switchSelect.innerHTML = groupTournamentsBySeries(app.list, app.series).map((group) =>
            '<optgroup label="' + escapeHtml(group.label) + '">' +
            group.items.map((item) =>
              '<option value="' + escapeHtml(item.id) + '"' + (item.id === active.id ? ' selected' : '') + '>' +
              escapeHtml(item.name) +
              '</option>'
            ).join('') +
            '</optgroup>'
          ).join('');
        } else if (switchSelect.value !== active.id) {
          switchSelect.value = active.id;
        }
      }

      /* 海报 OBS 推送按钮仅管理员可见（访客只读渲染） */
      const posterObs = header.querySelector('#poster-obs');
      if (posterObs) posterObs.hidden = !canEdit();

      /* 选手库新增表单仅管理员可见;搜索全员可用 */
      const playersAdd = header.querySelector('#add-player-form');
      if (playersAdd) playersAdd.hidden = !canEdit();

      syncHeaderHeight();
    }

    /* 主题/管理按钮在侧栏底部,与页头是否存在无关 */
    const manageBtn = document.getElementById('manage-btn');
    if (manageBtn) manageBtn.hidden = mode === 'cloud' && !appInstance.isAdmin();

    /* 选手中心导航项:云端+登录+账号绑定了选手即可见(管理员绑选手同样放行) */
    const playerPagesVisible = Boolean(mode === 'cloud' && sessionUser && sessionUser.playerId);
    document.querySelectorAll('#app-sidebar .side-link[data-page="me"]').forEach((link) => {
      link.hidden = !playerPagesVisible;
    });

    /* 后台导航项:按需补建 + 仅超管可见(admin.html 独立轻量页,不引 common.js) */
    ensureAdminNavLink();
    const adminVisible = Boolean(mode === 'cloud' && sessionUser && sessionUser.role === 'super');
    document.querySelectorAll('#app-sidebar .side-link[data-page="admin"]').forEach((link) => {
      link.hidden = !adminVisible;
    });

    /* 登录/账号按钮:本地模式隐藏;登录态显示头像+昵称,点击进资料页 */
    const loginBtn = document.getElementById('header-login-btn');
    if (loginBtn) {
      loginBtn.hidden = mode !== 'cloud';
      const sig = sessionUser
        ? sessionUser.id + ':' + (sessionPlayer ? sessionPlayer.name : sessionUser.username)
        : 'anon';
      if (loginBtn.dataset.ssig !== sig) {
        loginBtn.dataset.ssig = sig;
        if (sessionUser) {
          const label = (sessionPlayer && sessionPlayer.name) || sessionUser.username;
          loginBtn.title = '个人中心:' + label;
          loginBtn.setAttribute('aria-label', loginBtn.title);
          loginBtn.innerHTML = avatarMarkup(sessionPlayer || { name: sessionUser.username }, 'avatar-side') +
            '<span class="side-label">' + escapeHtml(label) + '</span>';
        } else {
          loginBtn.title = '登录';
          loginBtn.setAttribute('aria-label', '登录');
          loginBtn.innerHTML = iconMarkup('person', '登录') + '<span class="side-label">登录</span>';
        }
      }
    }

    const theme = currentTheme();
    const themeBtn = document.getElementById('header-theme-btn');
    if (themeBtn && themeBtn.dataset.mode !== theme) {
      themeBtn.dataset.mode = theme;
      const toDark = theme !== 'dark';
      const themeLabel = toDark ? '切换为深色模式' : '切换为浅色模式';
      themeBtn.title = themeLabel;
      themeBtn.setAttribute('aria-label', themeLabel);
      /* 图标重写时带上文字标签,展开模式不丢 */
      themeBtn.innerHTML = iconMarkup(toDark ? 'dark_mode' : 'light_mode', themeLabel) +
        '<span class="side-label">主题</span>';
    }
  }

  /* 左侧栏底部的功能按钮组(主题/管理/设置),独立于页头存在——主页无页头也能用。
   * 侧栏顶部的展开/收起按钮与文字标签也在此注入,四个页面共用一套逻辑 */
  const LS_SIDEBAR_EXPANDED = 'ts:sidebarExpanded';
  let sideActionsBuilt = false;

  function sidebarExpanded() {
    return document.body.classList.contains('side-expanded');
  }

  function setSidebarExpanded(expanded) {
    document.body.classList.toggle('side-expanded', expanded);
    try {
      localStorage.setItem(LS_SIDEBAR_EXPANDED, expanded ? '1' : '0');
    } catch (error) { /* 存储不可用:仅本次会话生效 */ }
    syncSideToggle();
  }

  function syncSideToggle() {
    const btn = document.getElementById('side-toggle');
    if (!btn) return;
    const expanded = sidebarExpanded();
    const label = expanded ? '收起侧栏' : '展开侧栏';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-expanded', String(expanded));
    btn.innerHTML = iconMarkup(expanded ? 'chevron_left' : 'menu', label);
  }

  function appendSideLabel(el, text) {
    const label = document.createElement('span');
    label.className = 'side-label';
    label.textContent = text;
    el.appendChild(label);
  }

  function buildSideActions() {
    if (sideActionsBuilt) return;
    const sidebar = document.getElementById('app-sidebar');
    if (!sidebar) return;
    try {
      if (localStorage.getItem(LS_SIDEBAR_EXPANDED) === '1') {
        document.body.classList.add('side-expanded');
      }
    } catch (error) { /* 忽略 */ }

    /* 展开切换按钮置顶 */
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.id = 'side-toggle';
    toggle.className = 'side-action side-toggle';
    sidebar.insertBefore(toggle, sidebar.firstChild);
    toggle.addEventListener('click', () => setSidebarExpanded(!sidebarExpanded()));

    /* 导航链接注入文字标签(取自 aria-label) */
    sidebar.querySelectorAll('.side-nav .side-link').forEach((link) => {
      const text = link.getAttribute('aria-label') || link.title || '';
      if (text) appendSideLabel(link, text);
    });

    const group = document.createElement('div');
    group.className = 'side-actions';
    /* 桌面:.side-more-menu 为 display:contents,三钮原位列出;
     * 移动端:收进「更多」弹出层,底栏只留更多钮,不再溢出 */
    const moreMenu = document.createElement('div');
    moreMenu.className = 'side-more-menu';
    moreMenu.innerHTML =
      '<button type="button" id="header-login-btn" class="side-action" title="登录" aria-label="登录"></button>' +
      '<button type="button" id="header-theme-btn" class="side-action" aria-label="切换主题"></button>' +
      '<button type="button" id="manage-btn" class="side-action" title="管理" aria-label="管理">' + iconMarkup('dashboard', '管理') + '</button>';
    group.appendChild(moreMenu);
    sidebar.appendChild(group);
    appendSideLabel(moreMenu.querySelector('#manage-btn'), '管理');

    /* 移动端底栏「更多」:登录/主题/管理三钮收进弹出层,底栏不再溢出(桌面隐藏) */
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.id = 'side-more-btn';
    moreBtn.className = 'side-action';
    moreBtn.setAttribute('aria-label', '更多');
    moreBtn.setAttribute('aria-expanded', 'false');
    moreBtn.innerHTML = iconMarkup('menu', '更多');
    appendSideLabel(moreBtn, '更多');
    group.insertBefore(moreBtn, group.firstChild);
    const closeSideMore = () => {
      document.body.classList.remove('side-more-open');
      moreBtn.setAttribute('aria-expanded', 'false');
    };
    moreBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const open = document.body.classList.toggle('side-more-open');
      moreBtn.setAttribute('aria-expanded', String(open));
    });
    moreMenu.querySelectorAll('.side-action').forEach((btn) => {
      btn.addEventListener('click', closeSideMore);
    });
    document.addEventListener('click', (event) => {
      if (document.body.classList.contains('side-more-open') && !group.contains(event.target)) closeSideMore();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeSideMore();
    });

    group.querySelector('#header-login-btn').addEventListener('click', () => {
      if (sessionUser) location.href = 'me.html#profile';
      else openLoginDialog();
    });
    group.querySelector('#header-theme-btn').addEventListener('click', toggleTheme);
    group.querySelector('#manage-btn').addEventListener('click', openManageDialog);
    syncSideToggle();
    sideActionsBuilt = true;
  }

  function renderHeader() {
    buildSideActions();
    /* 主页无页头:buildHeaderSkeleton 返回 false,但侧栏按钮的主题图标/
     * 可见性同步仍需执行(syncHeaderState 内部对页头部分自带守卫) */
    if (!headerBuilt) buildHeaderSkeleton();
    syncHeaderState();
  }

  /* ---------- 登录会话(登录页 login.html 承载,这里只管会话态与跳转) ---------- */

  let sessionUser = null;   /* {id, username, role, playerId} 或 null */
  let sessionPlayer = null; /* 会话绑定的选手对象 */

  function loginUrl() {
    return 'login.html?returnTo=' + encodeURIComponent(location.pathname + location.hash);
  }

  /* 会话过期/缺失时的统一出口:跳登录页并返回带标记的错误供调用方中止流程 */
  function redirectOnExpiredSession() {
    location.replace(loginUrl());
    const error = new Error('登录已过期，请重新登录');
    error.loginRedirect = true;
    return error;
  }

  function getSession() {
    return { user: sessionUser, player: sessionPlayer };
  }

  /* 本地超管模式(2026-08-31):未连云(本地 IndexedDB)且未登录时合成超管身份,
   * 仅驱动前端 UI 权限(isAdmin/canManage/编辑控件);服务端仍无会话——云接口
   * (/api/me 等)照旧 401,本地数据只落浏览器,不产生任何服务端写入 */
  function enterLocalSuper() {
    sessionUser = { id: 'local-super', username: '本地超管', nickname: '本地超管', role: 'super', playerId: null };
    sessionPlayer = null;
  }

  /* 拉取 /api/me 更新会话态并刷新侧栏按钮;任何失败按未登录处理 */
  async function refreshSession() {
    try {
      const resp = await fetch('/api/me', { headers: { 'Accept': 'application/json' } });
      if (resp.ok) {
        const data = await resp.json().catch(() => ({}));
        sessionUser = (data && data.user) || null;
        sessionPlayer = (data && data.player) || null;
      } else {
        sessionUser = null;
        sessionPlayer = null;
      }
    } catch (error) {
      sessionUser = null;
      sessionPlayer = null;
    }
    syncHeaderState();
    /* 会话就绪晚于页面首渲(如赛程页公示锁按本人判定),广播一次让依赖身份的视图重绘 */
    document.dispatchEvent(new CustomEvent('ts:session'));
    return getSession();
  }

  async function logoutSession() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (error) { /* 网络失败也按登出处理 */ }
    await refreshSession();
    notify('已退出登录');
    /* 登出后当前页需要登录态,整页跳回登录页(带 returnTo 便于重新登录后回来) */
    location.replace(loginUrl());
  }

  /* 登录入口统一跳独立登录页;旧弹窗(用户名+密码+邀请码注册)已随口令体系退役 */
  function openLoginDialog() {
    location.href = loginUrl();
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
        CanvasModel.migrateLegacyTournament(record, playerMap);
        record.schemaVersion = SCHEMA_VERSION;
      }
      if (record.canvas) {
        /* 格→点阵坐标迁移(幂等,有 grid 标记跳过);有实际换算则需落盘 */
        if (CanvasModel.migrateCanvasToDot(record.canvas) && !dirtyRecords.includes(record)) {
          dirtyRecords.push(record);
        }
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
    /* seriesId 供主页总览/页头下拉按系列分组;series 数组序即分组顺序(云端为权威) */
    appInstance.list = all.map((t) => ({ id: t.id, name: t.name, updatedAt: t.updatedAt, seriesId: t.seriesId || null }));
    appInstance.series = (mode === 'cloud' && cloudWorkspace && Array.isArray(cloudWorkspace.series))
      ? cloudWorkspace.series
      : [];
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
      series: [],
      players: [],
      mode: 'local',
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
      isAdmin,
      canManage,
      openSeriesDialog,
      setActiveId,
      refreshSession,
      getSession,
      logoutSession,
      openLoginDialog,
      revalidateWorkspace: revalidateWorkspaceQuietly,
      uploadImage: uploadCloudImage,
      fatalError: showFatalError
    };
    window.TournamentApp = appInstance;
    bindSystemThemeChange();
    const sess = await refreshSession();
    /* 登录墙判定在模式确定之后(2026-08-31 本地超管模式):
     * - 云模式(缓存命中/探测成功):无会话跳登录;匿名探测配置好的服务器会在
     *   probeCloud 的 401 分支统一跳登录,墙语义不变
     * - 本地模式(未连云):免墙,无会话时合成超管身份(enterLocalSuper) */
    try {
      const cached = readWorkspaceCache();
      if (cached) {
        if (!sess.user) {
          redirectOnExpiredSession();
          return;
        }
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
        if (!sess.user) enterLocalSuper();
      }
      appInstance.mode = mode;
      await refreshApp();
      if (cloudFallbackReason) {
        notify('云端数据不可用，已切换到本机数据：' + cloudFallbackReason, 'danger');
      }
    } catch (error) {
      /* 登录跳转错误不是初始化故障:redirectOnExpiredSession 已在跳页,不再叠横幅 */
      if (error && error.loginRedirect) return;
      showFatalError(error);
      return;
    }
    document.dispatchEvent(new CustomEvent(EVT_READY));
  }

  window.TournamentAppInit = init;
})();
