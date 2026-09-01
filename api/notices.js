'use strict';

const crypto = require('node:crypto');
const { sendJson, readJsonBody, createStorage } = require('./helpers');
const { backupJson, appendAudit } = require('./oss');
const { requireUser, requireRole } = require('./auth');
const { withWorkspaceLock } = require('./workspace-lock');

/* 通知横幅(2026-09-01):站点级通知存独立 notices.json,不进 workspace——
 * 整库保存/合并/归属守卫链路全部不涉及,不会被任何一次管理端保存冲掉。
 *   GET  /api/notices                   会话:仅生效中通知(公共字段,时间窗+启用过滤)
 *   GET  /api/admin/notices             super:全量管理列表(含状态派生)
 *   POST /api/admin/notices             super:新建
 *   POST /api/admin/notices/:id/update  super:编辑(createdBy/createdAt 服务端保留)
 *   POST /api/admin/notices/:id/delete  super:删除
 * 写路径:读改写整段上 workspace-lock + 写前备份(notices- 前缀,留 20 代)+ 审计;
 * admin.js 的 /api/admin 前缀分发把 notices* 尾段整体委托到本模块 adminHandler。 */
const NOTICES_KEY = 'notices.json';
const MAX_BODY = 16 * 1024;
const TEXT_MAX = 120;

function newNoticeId() {
  return 'n_' + crypto.randomBytes(8).toString('hex');
}

/** 归一化编辑入参(create/update 共用单点):{ok:true,fields} | {ok:false,error} */
function normalizeInput(body) {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return { ok: false, error: '通知内容不能为空' };
  if (text.length > TEXT_MAX) return { ok: false, error: '通知内容不能超过 ' + TEXT_MAX + ' 字' };
  const level = body.level === 'important' ? 'important' : 'info';
  const dismissible = body.dismissible !== false;
  const enabled = body.enabled !== false;
  let linkUrl = null;
  let linkText = null;
  if (body.linkUrl != null && String(body.linkUrl).trim() !== '') {
    linkUrl = String(body.linkUrl).trim();
    if (!/^https?:\/\//i.test(linkUrl)) return { ok: false, error: '链接必须是 http(s) 地址' };
    linkText = typeof body.linkText === 'string' && body.linkText.trim()
      ? body.linkText.trim().slice(0, 12)
      : '查看';
  }
  const qrImage = typeof body.qrImage === 'string' && body.qrImage.trim() ? body.qrImage.trim() : null;
  let startAt = null;
  let endAt = null;
  if (body.startAt != null && body.startAt !== '') {
    const t = Date.parse(body.startAt);
    if (!Number.isFinite(t)) return { ok: false, error: '生效时间格式不正确' };
    startAt = new Date(t).toISOString();
  }
  if (body.endAt != null && body.endAt !== '') {
    const t = Date.parse(body.endAt);
    if (!Number.isFinite(t)) return { ok: false, error: '过期时间格式不正确' };
    endAt = new Date(t).toISOString();
  }
  if (startAt && endAt && endAt <= startAt) return { ok: false, error: '过期时间必须晚于生效时间' };
  const sortOrder = Number.isFinite(Number(body.sortOrder)) ? Math.floor(Number(body.sortOrder)) : 0;
  return { ok: true, fields: { text, level, dismissible, enabled, linkUrl, linkText, qrImage, startAt, endAt, sortOrder } };
}

/** 状态派生:已撤下(enabled off)> 未开始(startAt 未来)> 已过期(endAt 过去)> 生效中 */
function statusOf(notice, nowMs) {
  if (!notice || notice.enabled === false) return 'disabled';
  if (notice.startAt && Date.parse(notice.startAt) > nowMs) return 'pending';
  if (notice.endAt && Date.parse(notice.endAt) <= nowMs) return 'expired';
  return 'active';
}

/** 列表序:sortOrder 升序 → createdAt 升序(同序号按创建先后) */
function noticeComparator(a, b) {
  const sa = typeof a.sortOrder === 'number' ? a.sortOrder : 0;
  const sb = typeof b.sortOrder === 'number' ? b.sortOrder : 0;
  if (sa !== sb) return sa - sb;
  return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
}

function createHandlers(storage, options) {
  const o = options || {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const audit = typeof o.appendAudit === 'function' ? o.appendAudit : appendAudit;
  const { read, write } = createStorage(storage);

  const readNotices = async () => (((await read(NOTICES_KEY)) || []).filter(Boolean));

  /* GET /api/notices:任意会话;只回生效条目+公共字段(剥离管理元数据) */
  async function publicList(req, res) {
    const user = await requireUser(req, res);
    if (!user) return;
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method Not Allowed' });
    const nowMs = now();
    const notices = (await readNotices())
      .filter((x) => statusOf(x, nowMs) === 'active')
      .sort(noticeComparator)
      .map((x) => ({
        id: x.id,
        text: String(x.text || ''),
        level: x.level === 'important' ? 'important' : 'info',
        dismissible: x.dismissible !== false,
        linkUrl: x.linkUrl || null,
        linkText: x.linkText || null,
        qrImage: x.qrImage || null
      }));
    sendJson(res, 200, { notices });
  }

  /* GET /api/admin/notices:全量 + 状态派生 */
  async function adminList(req, res) {
    const user = await requireRole(req, res, ['super']);
    if (!user) return;
    const nowMs = now();
    const notices = (await readNotices())
      .slice()
      .sort(noticeComparator)
      .map((x) => Object.assign({}, x, { status: statusOf(x, nowMs) }));
    sendJson(res, 200, { notices });
  }

  /* POST /api/admin/notices */
  async function adminCreate(req, res, body) {
    const user = await requireRole(req, res, ['super']);
    if (!user) return;
    const r = normalizeInput(body);
    if (!r.ok) return sendJson(res, 400, { error: r.error });
    return withWorkspaceLock(async () => {
      const notices = await readNotices();
      const entry = Object.assign(
        { id: newNoticeId(), createdBy: user.id, createdAt: new Date(now()).toISOString() },
        r.fields,
        { updatedAt: new Date(now()).toISOString() }
      );
      notices.push(entry);
      await backupJson(NOTICES_KEY, 'notices');
      await write(NOTICES_KEY, notices);
      audit('admin.noticeCreate', 'text=' + String(entry.text).slice(0, 12) + ' by=' + user.username);
      sendJson(res, 200, { notice: entry });
    });
  }

  /* POST /api/admin/notices/:id/update:覆盖可编辑字段;id/createdBy/createdAt 保留存档值 */
  async function adminUpdate(req, res, id, body) {
    const user = await requireRole(req, res, ['super']);
    if (!user) return;
    const r = normalizeInput(body);
    if (!r.ok) return sendJson(res, 400, { error: r.error });
    return withWorkspaceLock(async () => {
      const notices = await readNotices();
      const idx = notices.findIndex((x) => x && x.id === id);
      if (idx < 0) return sendJson(res, 404, { error: '通知不存在' });
      notices[idx] = Object.assign({}, notices[idx], r.fields, {
        id: notices[idx].id,
        createdBy: notices[idx].createdBy,
        createdAt: notices[idx].createdAt,
        updatedAt: new Date(now()).toISOString()
      });
      await backupJson(NOTICES_KEY, 'notices');
      await write(NOTICES_KEY, notices);
      audit('admin.noticeUpdate', 'id=' + id + ' text=' + String(r.fields.text).slice(0, 12) + ' by=' + user.username);
      sendJson(res, 200, { notice: notices[idx] });
    });
  }

  /* POST /api/admin/notices/:id/delete */
  async function adminDelete(req, res, id) {
    const user = await requireRole(req, res, ['super']);
    if (!user) return;
    return withWorkspaceLock(async () => {
      const notices = await readNotices();
      const idx = notices.findIndex((x) => x && x.id === id);
      if (idx < 0) return sendJson(res, 404, { error: '通知不存在' });
      const [removed] = notices.splice(idx, 1);
      await backupJson(NOTICES_KEY, 'notices');
      await write(NOTICES_KEY, notices);
      audit('admin.noticeDelete', 'id=' + id + ' text=' + String(removed.text).slice(0, 12) + ' by=' + user.username);
      sendJson(res, 200, { ok: true });
    });
  }

  /* /api/admin/notices* 尾段分发(由 admin.js 前缀分发整体委托) */
  async function adminHandler(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return sendJson(res, 404, { error: 'Not Found' });
    }
    if (pathname === '/api/admin/notices') {
      if (req.method === 'GET') return adminList(req, res);
      if (req.method === 'POST') {
        const body = await readJsonBody(req, res, MAX_BODY);
        if (body === undefined) return;
        return adminCreate(req, res, body);
      }
      return sendJson(res, 405, { error: 'Method Not Allowed' });
    }
    const m = /^\/api\/admin\/notices\/([^/]+)\/(update|delete)$/.exec(pathname);
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
module.exports.statusOf = statusOf;
module.exports.NOTICES_KEY = NOTICES_KEY;
