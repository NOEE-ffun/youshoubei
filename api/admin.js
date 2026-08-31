'use strict';

const { requireRole } = require('./auth');
const { effectiveRole } = require('./rbac');
const { sendJson, readJsonBody, createStorage } = require('./helpers');
const { withWorkspaceLock } = require('./workspace-lock');
const oss = require('./oss');

/* 后台接口(仅超管 super;写操作全部审计):
 * 读:
 *   GET  /api/admin/users   账号总览(手机脱敏 138****1234;playerName 从 data.json 映射)
 *   GET  /api/admin/audit   审计流水(audit/log-<yyyy-mm>.json,最新在前,limit 钳 1-1000)
 *   GET  /api/admin/health  健康与备份列表(数据量计数 + backups/ 列表,lastBackupAt 从名解析)
 * 写:
 *   POST /api/admin/users/:id/status  封禁/解封(audit admin.ban/admin.unban)
 *   POST /api/admin/users/:id/role    角色降级/升级 player↔admin(audit admin.role);
 *                                    置 super 不支持(角色升级唯一入口是 redeem 填码)
 *   POST /api/admin/users/:id/delete  删除账号(audit admin.delete):手机号随记录
 *                                    消失即释放可重新注册;绑定选手档案保留仅解绑;
 *                                    超管/本人不可删;既有会话自然失效
 *   POST /api/admin/backup            手工快照三件套(data/users/invite-codes 各一份,
 *                                    backups/manual-<kind>-<ts>.json,永不自动清理;
 *                                    三件全败 → 500「备份全部失败」,部分成功仍 200)
 *   POST /api/admin/restore           把 backups/ 里的 data 类备份恢复为 data.json
 *                                    (恢复前 backupData 留底;key 白名单校验)
 * 超管保护:目标 effectiveRole==='super'(env 名单命中也算)或目标即操作者本人
 * → 400「超管账号不可在此操作」;目标不存在 → 404。
 * 子路径分发:按 req.url 尾段路由(/api/admin/<tail>,tail 可多段);裸 /api/admin 与
 * 未知段 404(server.js 现有 API_ROUTES 是精确匹配,前缀分发由后续任务挂载)。
 * 存储走 createStorage 三态:注入(测试)> dev-store(无 OSS 环境)> OSS;
 * users 写为读-改-写整段上锁(与 account 各 users 写者互斥);
 * 审计月文件不存在 → 空数组;未配 OSS 附 oss:false 降级信号。 */

const USERS_KEY = 'users.json';
const DATA_KEY = 'data.json';
const CODES_KEY = 'invite-codes.json';
const AUDIT_KEY_PREFIX = 'audit/log-';
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const BACKUP_KEYS_SHOW = 20;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_BODY = 64 * 1024;

/* 手工快照三件套:与自动备份的 data/users/codes 前缀一一对应。
 * manual-<kind>-<ts> 命名两得:自动清理的保留窗口只按各自 kind 前缀
 * (如 ^backups/data-)裁剪,manual-* 永不落入;manual-data-* 仍含 'data-'
 * 子串,listBackups 可见 → 可经 restore 白名单恢复。 */
const MANUAL_SOURCES = [DATA_KEY, USERS_KEY, CODES_KEY];
const MANUAL_KIND = { 'data.json': 'data', 'users.json': 'users', 'invite-codes.json': 'codes' };
/* data 类备份名(自动 backups/data-<ts>.json 与手工 backups/manual-data-<ts>.json) */
const DATA_BACKUP_RE = /^backups\/(?:manual-)?data-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/;

/** 11 位手机号共用的脱敏变换:138****1234 */
function maskDigits11(s) {
  return s.slice(0, 3) + '****' + s.slice(7);
}

/** 手机号脱敏:仅 11 位数字回 138****1234;其余(非 11 位/null)回 null */
function maskPhone(phone) {
  const s = phone == null ? '' : String(phone);
  return /^\d{11}$/.test(s) ? maskDigits11(s) : null;
}

/** username 本身是手机号(短信自动注册 username=phone)→ 同规则脱敏,
 * 否则 phoneMasked 会被同响应里的完整手机号用户名抵消;其余用户名原样 */
function maskUsername(username) {
  if (username === null || username === undefined) return null;
  const s = String(username);
  return /^1\d{10}$/.test(s) ? maskDigits11(s) : s;
}

/** 审计详情读侧脱敏:appendAudit 既有写入模式 user=<username>(短信用户即手机号),
 * 下发前把独立 11 位手机形态子串(1[3-9] 开头,\b 词边界)换成脱敏形态;
 * IP/时间戳等不含连续 11 位手机形态,不受影响 */
function maskDetail(detail) {
  return String(detail || '').replace(/\b1[3-9]\d{9}\b/g, (m) => m.slice(0, 3) + '****' + m.slice(7));
}

/** 当月(UTC)yyyy-mm,与 oss.js auditKeyNow 的月份规则同源 */
function monthKeyNow(now) {
  const d = new Date(now());
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

/** backups/<prefix>-<ts>.json 名内时间戳 → ISO(名里 : 与 . 被 backupKeyNow 换成 -,此处逆变换)。
 * 前缀覆盖手工快照 manual-<kind>-(与自动 <kind>- 同构),否则 manual-data 的
 * lastBackupAt 解析不到、排序也插不进时间轴 */
const BACKUP_TS_RE = /^backups\/(?:manual-)?(?:data|users|codes)-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/;
function backupTimeOf(key) {
  const m = BACKUP_TS_RE.exec(String(key || ''));
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** 备份名按时间排序(旧→新):manual-* 前缀长度不同,字典序会把 manual-data-8月
 * 排到 data-8月 之后、users-1月 之前,时间轴错乱;不可解析的名排在最后(名字序) */
function backupKeyComparator(a, b) {
  const ta = backupTimeOf(a);
  const tb = backupTimeOf(b);
  if (ta && tb && ta !== tb) return ta < tb ? -1 : 1;
  if (ta && !tb) return -1;
  if (!ta && tb) return 1;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** 数组长度(非数组/脏 null 条目按 0 计) */
function countIfArray(value) {
  return Array.isArray(value) ? value.filter(Boolean).length : 0;
}

/** 手工快照对象名:backups/manual-<kind>-<ts>.json(ts 变换同 oss.backupKeyNow,可单测) */
function manualBackupKey(ts, sourceKey) {
  return oss.backupKeyNow(ts, 'manual-' + (MANUAL_KIND[sourceKey] || 'data'));
}

/** 手工备份真实现:OSS copy 一份 manual-<kind>-<ts>.json,回对象名;
 * 未配 OSS(本地开发)静默跳过回 null;不做保留窗口清理(manual 永不自动清) */
async function defaultBackupManual(sourceKey, ts) {
  if (!oss.isOssConfigured()) return null;
  const dest = manualBackupKey(ts, sourceKey);
  await oss.getClient().copy(dest, sourceKey);
  return dest;
}

/** 恢复真实现:把备份 key 拷回 data.json(留底由调用方先 backupData;
 * 拷贝语义同 scripts/restore-data.js 的 client.copy) */
async function defaultRestoreCopy(key) {
  await oss.getClient().copy(DATA_KEY, key);
}

/** 超管保护:目标 effectiveRole 为 super(env 名单命中也算)或目标即操作者本人 */
function isSuperProtected(target, operator) {
  if (!target) return true;
  return effectiveRole(target) === 'super' || Boolean(operator && target.id === operator.id);
}

/** 写接口回包的用户摘要(脱敏口径同 users 总览) */
function adminUserView(u) {
  return {
    id: u.id || null,
    username: maskUsername(u.username),
    nickname: u.nickname || null,
    role: effectiveRole(u),
    status: u.status || 'active'
  };
}

function createHandlers(options) {
  const o = options || {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const listBackups = typeof o.listBackups === 'function' ? o.listBackups : oss.listBackups;
  /* 写侧注入点:审计/手工备份/恢复留底/恢复拷贝(测试传假实现断言序列) */
  const appendAudit = typeof o.appendAudit === 'function' ? o.appendAudit : oss.appendAudit;
  const backupManual = typeof o.backupManual === 'function' ? o.backupManual : defaultBackupManual;
  const backupData = typeof o.backupData === 'function' ? o.backupData : oss.backupData;
  const restoreCopy = typeof o.restoreCopy === 'function' ? o.restoreCopy : defaultRestoreCopy;
  const { read, write } = createStorage(o.storage);

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
        username: maskUsername(u.username),
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
      .map((e) => (e ? { action: e.action || '', detail: maskDetail(e.detail), at: e.t || null } : null))
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
      /* 时间序(旧→新):字典序在 manual- 与自动前缀混排时会错位 */
      const keys = ((await listBackups()) || []).slice().sort(backupKeyComparator);
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

  /* ---------- 写接口(全部 super + 审计) ---------- */

  /** users 读改写整段上锁:与 account 各 users 写者互斥,防旧快照覆盖丢改 */
  async function mutateUser(res, id, operator, apply) {
    await withWorkspaceLock(async () => {
      const users = (await read(USERS_KEY)) || [];
      const idx = users.findIndex((u) => u && u.id === id);
      if (idx < 0) return sendJson(res, 404, { error: '账号不存在' });
      if (isSuperProtected(users[idx], operator)) {
        return sendJson(res, 400, { error: '超管账号不可在此操作' });
      }
      const { user, action, detail } = apply(users[idx]);
      users[idx] = user;
      await oss.backupJson(USERS_KEY, 'users');
      await write(USERS_KEY, users);
      appendAudit(action, detail + ' by=' + operator.username);
      sendJson(res, 200, { ok: true, user: adminUserView(user) });
    });
  }

  /* POST /api/admin/users/:id/status body {banned:bool}:封禁/解封 */
  async function userStatus(req, res, id) {
    const operator = await requireRole(req, res, ['super']);
    if (!operator) return;
    const body = await readJsonBody(req, res, MAX_BODY);
    if (body === undefined) return;
    if (typeof body.banned !== 'boolean') return sendJson(res, 400, { error: 'banned 需为布尔值' });
    await mutateUser(res, id, operator, (target) => {
      const user = Object.assign({}, target, { status: body.banned ? 'banned' : 'active' });
      return {
        user,
        action: body.banned ? 'admin.ban' : 'admin.unban',
        detail: 'user=' + (user.username || '-')
      };
    });
  }

  /* POST /api/admin/users/:id/role body {role:'player'|'admin'}:降级/升级。
   * 置 super 不支持(400);banned 账号可改(封禁与角色正交) */
  async function userRole(req, res, id) {
    const operator = await requireRole(req, res, ['super']);
    if (!operator) return;
    const body = await readJsonBody(req, res, MAX_BODY);
    if (body === undefined) return;
    if (body.role !== 'player' && body.role !== 'admin') {
      return sendJson(res, 400, { error: 'role 仅支持 player 或 admin' });
    }
    await mutateUser(res, id, operator, (target) => {
      const user = Object.assign({}, target, { role: body.role });
      return { user, action: 'admin.role', detail: 'user=' + (user.username || '-') + ' role=' + body.role };
    });
  }

  /* POST /api/admin/users/:id/delete:删除账号(2026-08-31)。
   * 语义:users.json 记录移除——手机号随记录消失即释放(同号可重新短信注册建新号);
   * 绑定的选手档案保留在 data.json players(可经绑定码重新认领),仅解除账号归属;
   * 既有会话随 uid 查无此人自然失效(currentUser null);超管/操作者本人不可删。
   * 与封禁/降级不同走独立实现(mutateUser 是改写,删除要 splice 掉条目) */
  async function userDelete(req, res, id) {
    const operator = await requireRole(req, res, ['super']);
    if (!operator) return;
    await withWorkspaceLock(async () => {
      const users = (await read(USERS_KEY)) || [];
      const idx = users.findIndex((u) => u && u.id === id);
      if (idx < 0) return sendJson(res, 404, { error: '账号不存在' });
      if (isSuperProtected(users[idx], operator)) {
        return sendJson(res, 400, { error: '超管账号不可在此操作' });
      }
      const target = users[idx];
      users.splice(idx, 1);
      await oss.backupJson(USERS_KEY, 'users');
      await write(USERS_KEY, users);
      appendAudit('admin.delete',
        'user=' + (target.username || '-') +
        (target.phone ? ' phone=***' + String(target.phone).slice(-4) : '') +
        (target.playerId ? ' player=' + target.playerId + '(档案保留解绑)' : '') +
        ' by=' + operator.username);
      sendJson(res, 200, { ok: true, deleted: adminUserView(target) });
    });
  }

  /* POST /api/admin/backup:手工快照三件套(data/users/invite-codes 各一份),
   * 共用同一时间戳成套;逐件 best-effort,失败记日志不阻塞其余;
   * 三件全败(keys 全 null,含未配 OSS 的静默跳过)→ 500,不让「成功」
   * 掩盖一份备份都没落下的实情;部分成功仍 200 带部分 keys */
  async function backup(req, res) {
    const operator = await requireRole(req, res, ['super']);
    if (!operator) return;
    const ts = now();
    const keys = [];
    for (const source of MANUAL_SOURCES) {
      try {
        keys.push(await backupManual(source, ts));
      } catch (error) {
        keys.push(null);
        console.error('[admin] 手工备份失败(' + source + '):', error.message);
      }
    }
    appendAudit('admin.backup', 'keys=' + keys.filter(Boolean).join(',') + ' by=' + operator.username);
    if (!keys.some(Boolean)) return sendJson(res, 500, { error: '备份全部失败' });
    sendJson(res, 200, { ok: true, keys });
  }

  /* POST /api/admin/restore body {key}:把 backups/ 里的 data 类备份恢复为 data.json。
   * key 白名单三重校验(防任意 OSS key 被拷贝):backups/ 前缀 + 命中 listBackups
   * 列表 + data 类命名;通过后先 backupData 留底再 copy(整段上锁,与 data 写者互斥) */
  async function restore(req, res) {
    const operator = await requireRole(req, res, ['super']);
    if (!operator) return;
    const body = await readJsonBody(req, res, MAX_BODY);
    if (body === undefined) return;
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!key.startsWith('backups/')) return sendJson(res, 400, { error: 'key 需为 backups/ 前缀的备份名' });
    let keys;
    try {
      keys = (await listBackups()) || [];
    } catch (error) {
      console.error('[admin] listBackups 失败:', error.message);
      return sendJson(res, 500, { error: '备份列表读取失败' });
    }
    if (!keys.includes(key)) return sendJson(res, 400, { error: '备份不存在' });
    if (!DATA_BACKUP_RE.test(key)) return sendJson(res, 400, { error: '仅支持恢复 data 类备份' });
    await withWorkspaceLock(async () => {
      try {
        await backupData(); /* 恢复前留底:恢复出错仍有恢复前版本可回 */
        await restoreCopy(key);
      } catch (error) {
        console.error('[admin] 恢复失败(' + key + '):', error.message);
        return sendJson(res, 500, { error: '恢复失败' });
      }
      appendAudit('admin.restore', 'key=' + key + ' by=' + operator.username);
      sendJson(res, 200, { ok: true });
    });
  }

  /* 子路径分发:/api/admin/<tail>(tail 可多段)。
   * 读:users/audit/health(仅 GET);写:users/<id>/status|role、backup、restore(仅 POST);
   * 裸路径/未知段 → 404;已知段方法不符 → 405 */
  async function handler(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return sendJson(res, 404, { error: 'Not Found' });
    }
    const m = /^\/api\/admin\/(.+?)\/?$/.exec(pathname);
    if (!m) return sendJson(res, 404, { error: 'Not Found' });
    const tail = m[1];
    let w;
    if ((w = /^users\/([^/]+)\/status$/.exec(tail))) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method Not Allowed' });
      return userStatus(req, res, w[1]);
    }
    if ((w = /^users\/([^/]+)\/role$/.exec(tail))) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method Not Allowed' });
      return userRole(req, res, w[1]);
    }
    if ((w = /^users\/([^/]+)\/delete$/.exec(tail))) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method Not Allowed' });
      return userDelete(req, res, w[1]);
    }
    if (tail === 'backup' || tail === 'restore') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method Not Allowed' });
      return tail === 'backup' ? backup(req, res) : restore(req, res);
    }
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method Not Allowed' });
    if (tail === 'users') return listUsers(req, res);
    if (tail === 'audit') return audit(req, res);
    if (tail === 'health') return health(req, res);
    return sendJson(res, 404, { error: 'Not Found' });
  }

  /* 工厂直接回 handler(与 codes/poster-stage 工厂用法一致);子端点挂属性备用 */
  handler.listUsers = listUsers;
  handler.audit = audit;
  handler.health = health;
  handler.userStatus = userStatus;
  handler.userRole = userRole;
  handler.userDelete = userDelete;
  handler.backup = backup;
  handler.restore = restore;
  return handler;
}

module.exports = createHandlers();
module.exports.createHandlers = createHandlers;
module.exports.maskPhone = maskPhone;
module.exports.maskUsername = maskUsername;
module.exports.maskDetail = maskDetail;
module.exports.monthKeyNow = monthKeyNow;
module.exports.backupTimeOf = backupTimeOf;
module.exports.manualBackupKey = manualBackupKey;
