'use strict';

const crypto = require('node:crypto');
const { sendJson, readJsonBody, createStorage } = require('./helpers');
const { backupJson, appendAudit } = require('./oss');
const { requireUser, requireRole } = require('./auth');
const { withWorkspaceLock } = require('./workspace-lock');
const { effectiveRole, isAdminRole } = require('./rbac');
const { DOC_CATEGORY_KEYS, docCategoryOrder } = require('../docs-meta');

/* 官方文档(2026-09-01):super 撰写 md 文档,登录可读,单篇可标仅管理员可见。
 * 存独立 docs.json 不进 workspace(同 notices.json 隔离,不被整库保存冲掉)。
 *   GET  /api/docs                   会话:可见篇目(adminOnly 对非管理员服务端整篇剥离)
 *   GET  /api/admin/docs             super:全量管理列表
 *   POST /api/admin/docs             super:新建
 *   POST /api/admin/docs/:id/update  super:编辑(createdBy/createdAt 服务端保留)
 *   POST /api/admin/docs/:id/delete  super:删除
 * 写路径:读改写整段上 workspace-lock + 写前备份(docs- 前缀,留 20 代)+ 审计;
 * admin.js 的 /api/admin 前缀分发把 docs* 尾段整体委托到本模块 adminHandler。 */
const DOCS_KEY = 'docs.json';
const MAX_BODY = 80 * 1024;
const TITLE_MAX = 60;
const BODY_MAX = 64 * 1024;

function newDocId() {
  return 'd_' + crypto.randomBytes(8).toString('hex');
}

/** 归一化编辑入参(create/update 共用单点):{ok:true,fields} | {ok:false,error} */
function normalizeInput(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return { ok: false, error: '标题不能为空' };
  if (title.length > TITLE_MAX) return { ok: false, error: '标题不能超过 ' + TITLE_MAX + ' 字' };
  if (!DOC_CATEGORY_KEYS.includes(body.category)) return { ok: false, error: '分类不合法' };
  const md = typeof body.body === 'string' ? body.body : '';
  if (md.length > BODY_MAX) return { ok: false, error: '正文不能超过 ' + (BODY_MAX / 1024) + 'KB' };
  if (body.adminOnly !== undefined && typeof body.adminOnly !== 'boolean') return { ok: false, error: '可见性参数不合法' };
  const sort = body.sort === undefined ? 0 : Number(body.sort);
  if (!Number.isInteger(sort) || Math.abs(sort) > 1e9) return { ok: false, error: '排序必须是整数' };
  return { ok: true, fields: { title, category: body.category, body: md, adminOnly: body.adminOnly === true, sort } };
}

/** 列表序:分类展示序 → sort 升序 → updatedAt 降序(同序号新写的排前) */
function docComparator(a, b) {
  const ca = docCategoryOrder(a.category);
  const cb = docCategoryOrder(b.category);
  if (ca !== cb) return ca - cb;
  const sa = typeof a.sort === 'number' ? a.sort : 0;
  const sb = typeof b.sort === 'number' ? b.sort : 0;
  if (sa !== sb) return sa - sb;
  return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
}

/** 公共字段:剥离 createdBy 等管理元数据 */
function publicFields(x) {
  return {
    id: x.id,
    title: x.title,
    category: x.category,
    body: String(x.body || ''),
    adminOnly: x.adminOnly === true,
    sort: typeof x.sort === 'number' ? x.sort : 0,
    updatedAt: x.updatedAt
  };
}

function createHandlers(storage, options) {
  const o = options || {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const audit = typeof o.appendAudit === 'function' ? o.appendAudit : appendAudit;
  const { read, write } = createStorage(storage);

  const readDocs = async () => (((await read(DOCS_KEY)) || []).filter(Boolean));

  /* GET /api/docs:任意会话;非管理员整篇剥离 adminOnly(不靠前端隐藏) */
  async function publicList(req, res) {
    const user = await requireUser(req, res);
    if (!user) return;
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method Not Allowed' });
    const adminView = isAdminRole(effectiveRole(user));
    const docs = (await readDocs())
      .filter((x) => adminView || x.adminOnly !== true)
      .sort(docComparator)
      .map(publicFields);
    sendJson(res, 200, { docs });
  }

  /* GET /api/admin/docs:super 全量管理列表 */
  async function adminList(req, res) {
    const user = await requireRole(req, res, ['super']);
    if (!user) return;
    const docs = (await readDocs()).slice().sort(docComparator);
    sendJson(res, 200, { docs });
  }

  /* POST /api/admin/docs */
  async function adminCreate(req, res, body) {
    const user = await requireRole(req, res, ['super']);
    if (!user) return;
    const r = normalizeInput(body);
    if (!r.ok) return sendJson(res, 400, { error: r.error });
    return withWorkspaceLock(async () => {
      const docs = await readDocs();
      const entry = Object.assign(
        { id: newDocId(), createdBy: user.id, createdAt: new Date(now()).toISOString() },
        r.fields,
        { updatedAt: new Date(now()).toISOString() }
      );
      docs.push(entry);
      await backupJson(DOCS_KEY, 'docs');
      await write(DOCS_KEY, docs);
      audit('admin.docCreate', 'title=' + String(entry.title).slice(0, 12) + ' by=' + user.username);
      sendJson(res, 200, { doc: entry });
    });
  }

  /* POST /api/admin/docs/:id/update:覆盖可编辑字段;id/createdBy/createdAt 保留存档值 */
  async function adminUpdate(req, res, id, body) {
    const user = await requireRole(req, res, ['super']);
    if (!user) return;
    const r = normalizeInput(body);
    if (!r.ok) return sendJson(res, 400, { error: r.error });
    return withWorkspaceLock(async () => {
      const docs = await readDocs();
      const idx = docs.findIndex((x) => x && x.id === id);
      if (idx < 0) return sendJson(res, 404, { error: '文档不存在' });
      docs[idx] = Object.assign({}, docs[idx], r.fields, {
        id: docs[idx].id,
        createdBy: docs[idx].createdBy,
        createdAt: docs[idx].createdAt,
        updatedAt: new Date(now()).toISOString()
      });
      await backupJson(DOCS_KEY, 'docs');
      await write(DOCS_KEY, docs);
      audit('admin.docUpdate', 'id=' + id + ' title=' + String(r.fields.title).slice(0, 12) + ' by=' + user.username);
      sendJson(res, 200, { doc: docs[idx] });
    });
  }

  /* POST /api/admin/docs/:id/delete */
  async function adminDelete(req, res, id) {
    const user = await requireRole(req, res, ['super']);
    if (!user) return;
    return withWorkspaceLock(async () => {
      const docs = await readDocs();
      const idx = docs.findIndex((x) => x && x.id === id);
      if (idx < 0) return sendJson(res, 404, { error: '文档不存在' });
      const [removed] = docs.splice(idx, 1);
      await backupJson(DOCS_KEY, 'docs');
      await write(DOCS_KEY, docs);
      audit('admin.docDelete', 'id=' + id + ' title=' + String(removed.title).slice(0, 12) + ' by=' + user.username);
      sendJson(res, 200, { ok: true });
    });
  }

  /* /api/admin/docs* 尾段分发(由 admin.js 前缀分发整体委托) */
  async function adminHandler(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return sendJson(res, 404, { error: 'Not Found' });
    }
    if (pathname === '/api/admin/docs') {
      if (req.method === 'GET') return adminList(req, res);
      if (req.method === 'POST') {
        const body = await readJsonBody(req, res, MAX_BODY);
        if (body === undefined) return;
        return adminCreate(req, res, body);
      }
      return sendJson(res, 405, { error: 'Method Not Allowed' });
    }
    const m = /^\/api\/admin\/docs\/([^/]+)\/(update|delete)$/.exec(pathname);
    if (!m) return sendJson(res, 404, { error: 'Not Found' });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method Not Allowed' });
    if (m[2] === 'delete') return adminDelete(req, res, m[1]);
    const body = await readJsonBody(req, res, MAX_BODY);
    if (body === undefined) return;
    return adminUpdate(req, res, m[1], body);
  }

  return { publicList, adminHandler, adminList, adminCreate, adminUpdate, adminDelete };
}

const publicHandler = createHandlers().publicList;
module.exports = publicHandler;
module.exports.createPublicHandler = (storage, options) => createHandlers(storage, options).publicList;
module.exports.createAdminHandler = (storage, options) => createHandlers(storage, options).adminHandler;
module.exports.normalizeInput = normalizeInput;
module.exports.DOCS_KEY = DOCS_KEY;
