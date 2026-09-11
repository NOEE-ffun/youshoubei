'use strict';

const crypto = require('node:crypto');
const { sendJson, readJsonBody, createStorage, maskUser } = require('./helpers');
const { appendAudit } = require('./oss');
const { requireRole } = require('./auth');
const { withWorkspaceLock } = require('./workspace-lock');

/* 卡片模板(2026-09-12 spec):个人库 + 市场,单文件 templates.json。
 * 个人库=每管理用户一块;市场=快照数组(上架发布当时深拷贝,撤架不追回已加入者,Task 3 实装)。
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
    const prev = getLibrary(file, user.uid);
    const next = body.templates.map((raw) => normalizeTemplate(raw).value);
    /* 审计三分支:save=新 id / delete=消失 / cover=同 id 保留(覆盖更新) */
    const prevIds = new Map(prev.map((t) => [t.id, t.name]));
    const added = next.filter((t) => !prevIds.has(t.id));
    const removed = prev.filter((t) => !next.some((n) => n.id === t.id));
    const covered = next.filter((n) => prevIds.has(n.id));
    for (const t of added) audit('tpl.save', '模板「' + t.name + '」' + t.cards.length + ' 卡 by=' + maskUser(user.username));
    for (const t of removed) audit('tpl.delete', '模板「' + prevIds.get(t.id) + '」by=' + maskUser(user.username));
    for (const t of covered) audit('tpl.cover', '模板「' + t.name + '」覆盖更新 by=' + maskUser(user.username));
    if (!file.libraries[user.uid]) file.libraries[user.uid] = { templates: [] };
    file.libraries[user.uid].templates = next;
    await write(TPL_KEY, file);
    return { templates: next };
  }

  /* GET /api/templates → 本人库 */
  async function personalGet(req, res) {
    const user = await requireRole(req, res, ROLES);
    if (!user) return;
    const file = await readFile();
    sendJson(res, 200, { templates: getLibrary(file, user.uid) });
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

  const api = {
    /* /api/templates:GET=本人库 / PUT=整体提交(method 分支,同 data.js 惯例) */
    async personal(req, res) {
      if (req.method === 'GET') return personalGet(req, res);
      if (req.method === 'PUT') return personalPut(req, res);
      return sendJson(res, 405, { error: 'Method Not Allowed' });
    },
    /* /api/templates/market:Task 3 实装,先 405 占位 */
    async market(req, res) { return sendJson(res, 405, { error: 'Method Not Allowed' }); },
    /* ---- 单测注入面(内部逻辑直测,HTTP 层薄) ---- */
    __validateLibrary: validateLibrary,
    __getLibrary: async (uid) => getLibrary(await readFile(), uid),
    /* 直写路径:绕过 requireRole/readJsonBody,直测校验+落库+审计 */
    __putLibrary: applyLibrary
  };
  return api;
}

/* 同 codes.js 尾式:默认实例供 server.js 路由表直挂;createHandler 供测试注入存储 */
const handler = createHandler();
module.exports = handler;
module.exports.createHandler = createHandler;
