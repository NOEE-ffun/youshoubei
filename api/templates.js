'use strict';

const crypto = require('node:crypto');
const { sendJson, readJsonBody, createStorage, maskUser } = require('./helpers');
const { appendAudit, backupJson } = require('./oss');
const { requireRole } = require('./auth');
const { withWorkspaceLock } = require('./workspace-lock');

/* 卡片模板(2026-09-12 spec):个人库 + 市场,单文件 templates.json。
 * 个人库=每管理用户一块;市场=快照数组:上架时深拷贝(后续改库/删库不影响在架条目),
 * 撤架仅作者本人可撤,加入=深拷贝出新 id(撤架不追回已加入者)。
 * 配额:库 ≤50 模板/单模板 ≤50 卡/在架 ≤10;模板名 trim 非空 ≤20 字。 */
const TPL_KEY = 'templates.json';
const MAX_BODY = 256 * 1024;
const LIMITS = { library: 50, cards: 50, listed: 10, name: 20 };
const ROLES = ['admin', 'super'];

function emptyFile() { return { libraries: {}, market: [] }; }

function newTplId() { return 'tpl_' + crypto.randomUUID(); }

function createHandler(storage, options) {
  const o = options || {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const audit = typeof o.appendAudit === 'function' ? o.appendAudit : appendAudit;
  const backup = typeof o.backupJson === 'function' ? o.backupJson : backupJson; /* 同 signup.js 注入面 */
  const { read, write } = createStorage(storage);

  async function readFile() { return (await read(TPL_KEY)) || emptyFile(); }

  function getLibrary(file, uid) { return (file.libraries[uid] && file.libraries[uid].templates) || []; }

  /* 单模板归一:名字 trim 非空 ≤20 字、卡数 ≤50;id 缺失补发;时间戳走注入 now */
  function normalizeTemplate(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.cards)) return null;
    const name = String(raw.name == null ? '' : raw.name).trim();
    if (!name || name.length > LIMITS.name) return { error: '模板名须为 1-20 字' };
    if (raw.cards.length > LIMITS.cards) return { error: '单模板最多 ' + LIMITS.cards + ' 张卡' };
    return {
      value: {
        id: typeof raw.id === 'string' && raw.id ? raw.id : newTplId(),
        name,
        cards: raw.cards,
        meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : { w: 0, h: 0 },
        createdAt: Number(raw.createdAt) || now(),
        updatedAt: now()
      }
    };
  }

  /* 校验整个提交库:逐模板 normalize,任一失败 400;同名两条 409 */
  function validateLibrary(body) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.templates)) return { code: 400, error: '数据格式不正确' };
    if (body.templates.length > LIMITS.library) return { code: 400, error: '个人模板库上限 ' + LIMITS.library };
    const names = new Set();
    for (const raw of body.templates) {
      const r = normalizeTemplate(raw);
      if (!r) return { code: 400, error: '数据格式不正确' };
      if (r.error) return { code: 400, error: r.error };
      if (names.has(r.value.name)) return { code: 409, error: '模板名重复:' + r.value.name };
      names.add(r.value.name);
    }
    return { ok: true };
  }

  /* 锁内落库(读→前后对比审计→只写自己块→写回):personalPut 与 __putLibrary 共用 */
  async function applyLibrary(user, body) {
    const checked = validateLibrary(body);
    if (checked.code) return checked;
    const file = await readFile();
    const prev = getLibrary(file, user.id);
    const next = body.templates.map((raw) => normalizeTemplate(raw).value);
    /* 审计三分支:save=新 id / delete=消失 / cover=同 id 保留(覆盖更新) */
    const prevIds = new Map(prev.map((t) => [t.id, t.name]));
    const added = next.filter((t) => !prevIds.has(t.id));
    const removed = prev.filter((t) => !next.some((n) => n.id === t.id));
    const covered = next.filter((n) => prevIds.has(n.id));
    for (const t of added) audit('tpl.save', '模板「' + t.name + '」' + t.cards.length + ' 卡 by=' + maskUser(user.username));
    for (const t of removed) audit('tpl.delete', '模板「' + prevIds.get(t.id) + '」by=' + maskUser(user.username));
    for (const t of covered) audit('tpl.cover', '模板「' + t.name + '」覆盖更新 by=' + maskUser(user.username));
    if (!file.libraries[user.id]) file.libraries[user.id] = { templates: [] };
    file.libraries[user.id].templates = next;
    await write(TPL_KEY, file);
    return { templates: next };
  }

  /* GET /api/templates → 本人库 */
  async function personalGet(req, res) {
    const user = await requireRole(req, res, ROLES);
    if (!user) return;
    const file = await readFile();
    sendJson(res, 200, { templates: getLibrary(file, user.id) });
  }

  /* PUT /api/templates → 整体提交本人库(前端权威;服务端只校验+写自己块) */
  async function personalPut(req, res) {
    const user = await requireRole(req, res, ROLES);
    if (!user) return;
    const body = await readJsonBody(req, res, MAX_BODY);
    if (body === undefined) return; /* readJsonBody 失败已应答(400/413),真实契约返回 undefined 而非 null */
    const outcome = await withWorkspaceLock(async () => applyLibrary(user, body));
    if (outcome.code) { sendJson(res, outcome.code, { error: outcome.error }); return; }
    sendJson(res, 200, { templates: outcome.templates });
  }

  /* 市场在架列表(listedAt 倒序,GET 与 __marketList 共用) */
  async function marketList() {
    const file = await readFile();
    return { market: file.market.slice().sort((a, b) => b.listedAt - a.listedAt) };
  }

  /* 市场三动作(锁内读-改-写,只动 market 数组或本人库):
   * list=上架快照 / unlist=本人撤架 / adopt=深拷贝加入本人库 */
  async function marketAction(user, body) {
    if (!body || typeof body !== 'object') return { code: 400, error: '数据格式不正确' };
    const who = maskUser(user.username);
    if (body.action === 'list' || body.action === 'unlist') {
      const tid = String(body.templateId || '');
      return withWorkspaceLock(async () => {
        const file = await readFile();
        if (body.action === 'list') {
          const mine = getLibrary(file, user.id).find((t) => t.id === tid);
          if (!mine) return { code: 404, error: '库内无此模板' };
          /* 在架计数按 authorUid 全量:同模板重复上架也占在架位 */
          const listed = file.market.filter((m) => m.authorUid === user.id);
          if (listed.length >= LIMITS.listed) return { code: 400, error: '在架上限 ' + LIMITS.listed };
          const item = {
            id: 'mkt_' + crypto.randomUUID(),
            snapshot: JSON.parse(JSON.stringify(mine)),
            authorUid: user.id,
            authorName: who,
            listedAt: now()
          };
          file.market.push(item);
          await write(TPL_KEY, file);
          audit('tpl.list', '模板「' + mine.name + '」上架 by=' + who);
          return { item };
        }
        /* unlist:本人条目才可见,否则 404(不泄露他人条目存在性) */
        const idx = file.market.findIndex((m) => m.authorUid === user.id && m.snapshot.id === tid);
        if (idx < 0) return { code: 404, error: '无此在架条目' };
        const [gone] = file.market.splice(idx, 1);
        /* 市场是全局共享态,坏写波及他人数据——仅撤架(唯一从共享数组删除条目的破坏性写)
         * 前备份一份(T2 评审折中);list/adopt 只追加/只写本人库,失败可由提交方重放,不备份。 */
        await backup(TPL_KEY, 'templates');
        await write(TPL_KEY, file);
        audit('tpl.unlist', '模板「' + gone.snapshot.name + '」撤架 by=' + who);
        return { ok: true };
      });
    }
    if (body.action === 'adopt') {
      const mid = String(body.marketId || '');
      return withWorkspaceLock(async () => {
        const file = await readFile();
        const item = file.market.find((m) => m.id === mid);
        if (!item) return { code: 404, error: '该条目已被撤架' };
        const lib = getLibrary(file, user.id);
        if (lib.length >= LIMITS.library) return { code: 400, error: '个人模板库上限 ' + LIMITS.library };
        const copy = JSON.parse(JSON.stringify(item.snapshot));
        copy.id = newTplId();
        copy.createdAt = now();
        copy.updatedAt = now();
        const want = String(body.renameTo == null ? copy.name : body.renameTo).trim();
        if (!want || want.length > LIMITS.name) return { code: 400, error: '模板名须为 1-20 字' };
        if (lib.some((t) => t.name === want)) return { code: 409, error: '已有同名模板:' + want };
        copy.name = want;
        if (!file.libraries[user.id]) file.libraries[user.id] = { templates: [] };
        file.libraries[user.id].templates.push(copy);
        await write(TPL_KEY, file);
        audit('tpl.adopt', '市场「' + item.snapshot.name + '」加入为「' + want + '」 by=' + who);
        return { template: copy };
      });
    }
    return { code: 400, error: '未知操作' };
  }

  /* GET /api/templates/market → 在架列表;POST → 三动作 */
  async function marketGet(req, res) {
    const user = await requireRole(req, res, ROLES);
    if (!user) return;
    sendJson(res, 200, await marketList());
  }

  async function marketPost(req, res) {
    const user = await requireRole(req, res, ROLES);
    if (!user) return;
    const body = await readJsonBody(req, res, MAX_BODY);
    if (body === undefined) return; /* readJsonBody 失败已应答(400/413),真实契约返回 undefined */
    const outcome = await marketAction(user, body);
    if (outcome.code) { sendJson(res, outcome.code, { error: outcome.error }); return; }
    sendJson(res, 200, outcome);
  }

  const api = {
    /* /api/templates:GET=本人库 / PUT=整体提交(method 分支,同 data.js 惯例) */
    async personal(req, res) {
      if (req.method === 'GET') return personalGet(req, res);
      if (req.method === 'PUT') return personalPut(req, res);
      return sendJson(res, 405, { error: 'Method Not Allowed' });
    },
    /* /api/templates/market:GET=在架列表(listedAt 倒序)/ POST={action:list|unlist|adopt} */
    async market(req, res) {
      if (req.method === 'GET') return marketGet(req, res);
      if (req.method === 'POST') return marketPost(req, res);
      return sendJson(res, 405, { error: 'Method Not Allowed' });
    },
    /* ---- 单测注入面(内部逻辑直测,HTTP 层薄) ---- */
    __validateLibrary: validateLibrary,
    __getLibrary: async (uid) => getLibrary(await readFile(), uid),
    /* 直写路径:绕过 requireRole/readJsonBody,直测校验+落库+审计 */
    __putLibrary: applyLibrary,
    __marketAction: marketAction,
    __marketList: marketList
  };
  return api;
}

/* 同 codes.js 尾式:默认实例供 server.js 路由表直挂;createHandler 供测试注入存储 */
const handler = createHandler();
module.exports = handler;
module.exports.createHandler = createHandler;
