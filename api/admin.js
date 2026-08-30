'use strict';

const { requireRole } = require('./auth');
const { effectiveRole } = require('./rbac');
const { sendJson, createStorage } = require('./helpers');
const oss = require('./oss');

/* 后台读接口(仅超管 super):
 *   GET /api/admin/users   账号总览(手机脱敏 138****1234;playerName 从 data.json 映射)
 *   GET /api/admin/audit   审计流水(audit/log-<yyyy-mm>.json,最新在前,limit 钳 1-1000)
 *   GET /api/admin/health  健康与备份列表(数据量计数 + backups/ 列表,lastBackupAt 从名解析)
 * 子路径分发:按 req.url 尾段路由(/api/admin/<tail>);裸 /api/admin 与未知段 404
 * (server.js 现有 API_ROUTES 是精确匹配,前缀分发由后续任务挂载)。
 * 存储走 createStorage 三态:注入(测试)> dev-store(无 OSS 环境)> OSS;
 * 审计月文件不存在 → 空数组;未配 OSS 附 oss:false 降级信号。 */

const USERS_KEY = 'users.json';
const DATA_KEY = 'data.json';
const AUDIT_KEY_PREFIX = 'audit/log-';
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const BACKUP_KEYS_SHOW = 20;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 手机号脱敏:仅 11 位数字回 138****1234;其余(非 11 位/null)回 null */
function maskPhone(phone) {
  const s = phone == null ? '' : String(phone);
  return /^\d{11}$/.test(s) ? s.slice(0, 3) + '****' + s.slice(7) : null;
}

/** 当月(UTC)yyyy-mm,与 oss.js auditKeyNow 的月份规则同源 */
function monthKeyNow(now) {
  const d = new Date(now());
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

/** backups/<prefix>-<ts>.json 名内时间戳 → ISO(名里 : 与 . 被 backupKeyNow 换成 -,此处逆变换) */
const BACKUP_TS_RE = /^backups\/(?:data|users|codes)-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/;
function backupTimeOf(key) {
  const m = BACKUP_TS_RE.exec(String(key || ''));
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** 数组长度(非数组/脏 null 条目按 0 计) */
function countIfArray(value) {
  return Array.isArray(value) ? value.filter(Boolean).length : 0;
}

function createHandlers(options) {
  const o = options || {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const listBackups = typeof o.listBackups === 'function' ? o.listBackups : oss.listBackups;
  const { read } = createStorage(o.storage);

  /* GET /api/admin/users:账号总览(role 用 effectiveRole,env 升格即时生效) */
  async function listUsers(req, res) {
    const user = await requireRole(req, res, ['super']);
    if (!user) return;
    const raw = (await read(USERS_KEY)) || [];
    const workspace = await read(DATA_KEY).catch(() => null);
    const players = new Map(
      ((workspace && workspace.players) || [])
        .filter((p) => p && p.id)
        .map((p) => [p.id, p.name || null])
    );
    sendJson(res, 200, {
      users: raw.filter(Boolean).map((u) => ({
        id: u.id || null,
        username: u.username || null,
        nickname: u.nickname || null,
        role: effectiveRole(u),
        playerId: u.playerId || null,
        playerName: u.playerId ? players.get(u.playerId) || null : null,
        status: u.status || 'active',
        phoneMasked: maskPhone(u.phone),
        createdAt: u.createdAt || null
      }))
    });
  }

  /* GET /api/admin/audit?month=yyyy-mm&limit=200:审计流水,最新在前 */
  async function audit(req, res) {
    const user = await requireRole(req, res, ['super']);
    if (!user) return;
    const query = new URL(req.url, 'http://localhost').searchParams;
    const monthParam = query.get('month');
    let month;
    if (monthParam === null || monthParam === '') {
      month = monthKeyNow(now); /* 缺省当月(UTC) */
    } else if (!MONTH_RE.test(monthParam)) {
      return sendJson(res, 400, { error: 'month 需为 yyyy-mm 格式' });
    } else {
      month = monthParam;
    }
    /* limit 缺省 200,钳 1-1000;非数字按缺省处理 */
    const limitParam = query.get('limit');
    let limit = DEFAULT_LIMIT;
    if (limitParam !== null && limitParam !== '') {
      const n = Number(limitParam);
      if (Number.isFinite(n)) limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
    }
    let list = null;
    try {
      list = await read(AUDIT_KEY_PREFIX + month + '.json');
    } catch {
      list = null; /* 读失败按无流水处理,不让审计块拖垮后台 */
    }
    const entries = Array.isArray(list) ? list : [];
    /* 文件内追加序=时间序:尾部取 limit 条再倒序 → 最新在前 */
    const items = entries
      .slice(-limit)
      .reverse()
      .map((e) => (e ? { action: e.action || '', detail: e.detail || '', at: e.t || null } : null))
      .filter(Boolean);
    sendJson(res, 200, { month, items, oss: oss.isOssConfigured() });
  }

  /* GET /api/admin/health:OSS 健康 + 备份列表 + 数据量计数 */
  async function health(req, res) {
    const user = await requireRole(req, res, ['super']);
    if (!user) return;
    /* 数据量:users/users.json;tournaments、series/data.json(读失败按 0) */
    let usersCount = 0;
    let tournaments = 0;
    let series = 0;
    try {
      usersCount = countIfArray(await read(USERS_KEY));
      const workspace = await read(DATA_KEY);
      tournaments = countIfArray(workspace && workspace.tournaments);
      series = countIfArray(workspace && workspace.series);
    } catch (error) {
      console.error('[admin] health 数据量读取失败:', error.message);
    }
    /* 备份列表:未配 OSS 时 listBackups→getClient 直接 throw → 捕获降级 oss:false */
    let ossOk = true;
    const backups = { count: 0, latest: null, keys: [] };
    let lastBackupAt = null;
    try {
      const keys = ((await listBackups()) || []).slice().sort();
      backups.count = keys.length;
      backups.keys = keys.slice(-BACKUP_KEYS_SHOW); /* 最近 20 */
      backups.latest = keys.length ? keys[keys.length - 1] : null;
      lastBackupAt = backups.latest ? backupTimeOf(backups.latest) : null;
    } catch (error) {
      ossOk = false;
      console.error('[admin] listBackups 失败(未配 OSS 时为预期降级):', error.message);
    }
    sendJson(res, 200, { oss: ossOk, backups, lastBackupAt, users: usersCount, tournaments, series });
  }

  /* 子路径分发:/api/admin/<tail>;裸路径/未知段/多段 → 404;非 GET → 405 */
  async function handler(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return sendJson(res, 404, { error: 'Not Found' });
    }
    const m = /^\/api\/admin\/([^/]+)\/?$/.exec(pathname);
    if (!m) return sendJson(res, 404, { error: 'Not Found' });
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method Not Allowed' });
    const tail = m[1];
    if (tail === 'users') return listUsers(req, res);
    if (tail === 'audit') return audit(req, res);
    if (tail === 'health') return health(req, res);
    return sendJson(res, 404, { error: 'Not Found' });
  }

  /* 工厂直接回 handler(与 codes/poster-stage 工厂用法一致);子端点挂属性备用 */
  handler.listUsers = listUsers;
  handler.audit = audit;
  handler.health = health;
  return handler;
}

module.exports = createHandlers();
module.exports.createHandlers = createHandlers;
module.exports.maskPhone = maskPhone;
module.exports.monthKeyNow = monthKeyNow;
module.exports.backupTimeOf = backupTimeOf;
