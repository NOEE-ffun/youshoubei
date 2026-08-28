'use strict';

const crypto = require('node:crypto');
const { sendJson, readJsonBody, createStorage } = require('./helpers');
const { appendAudit, backupData, backupJson } = require('./oss');
const { withWorkspaceLock } = require('./workspace-lock');
const { sessionOf, setSessionCookie, issueFor } = require('./session');

/* 账号体系(一期):
 *   POST /api/auth/register  邀请码注册(空白码=建新选手,绑定码=继承既有选手,ADMIN_INVITE_CODE=管理员)
 *   POST /api/auth/login     登录(内存限速:同 IP 15 分钟 5 次失败锁 10 分钟)
 *   POST /api/auth/logout    登出
 *   GET  /api/me             当前会话的用户+绑定选手
 *   PUT  /api/me/player      选手自助改资料(字段白名单)
 *   PUT  /api/me/password    修改密码
 * 存储:OSS users.json / invite-codes.json / data.json(players);测试用 createHandlers(storage) 注入。
 * 绑定码逻辑是老选手过渡方案,三期整体删除——所有相关代码集中在本文件 register() 内。 */
const USERS_KEY = 'users.json';
const CODES_KEY = 'invite-codes.json';
const DATA_KEY = 'data.json';
const MAX_BODY = 64 * 1024;

const USERNAME_RE = /^[\w\u4e00-\u9fff-]{2,24}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/* ---------- 密码:scrypt + 随机盐,常量时间比较 ---------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return 'scrypt:' + salt.toString('hex') + ':' + hash.toString('hex');
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ---------- 工具 ---------- */

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

function safeUser(user) {
  return { id: user.id, username: user.username, role: user.role, playerId: user.playerId || null, createdAt: user.createdAt };
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 500) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function clampText(value, max) {
  const s = String(value == null ? '' : value).trim();
  return s ? s.slice(0, max) : null;
}

/* ---------- 登录限速(内存,单实例) ---------- */

function createRateLimiter(now) {
  const WINDOW_MS = 15 * 60 * 1000;
  const LOCK_MS = 10 * 60 * 1000;
  const MAX_FAILS = 5;
  const MAX_ENTRIES = 5000;
  const table = new Map(); /* ip -> {windowStart, fails, lockUntil} */
  function sweep() {
    const t = now();
    for (const [ip, rec] of table) {
      if (rec.lockUntil < t && t - rec.windowStart > WINDOW_MS) table.delete(ip);
    }
  }
  return {
    blocked(ip) {
      if (table.size > MAX_ENTRIES) sweep();
      const rec = table.get(ip);
      if (!rec) return 0;
      if (rec.lockUntil > now()) return Math.ceil((rec.lockUntil - now()) / 1000);
      return 0;
    },
    recordFail(ip) {
      const t = now();
      let rec = table.get(ip);
      if (!rec || t - rec.windowStart > WINDOW_MS) rec = { windowStart: t, fails: 0, lockUntil: 0 };
      rec.fails += 1;
      if (rec.fails >= MAX_FAILS) rec.lockUntil = t + LOCK_MS;
      table.set(ip, rec);
    },
    reset(ip) {
      table.delete(ip);
    }
  };
}

/* 客户端真实 IP:优先 nginx 的 X-Real-IP(不可伪造);
 * X-Forwarded-For 用最后一段(add 模式下末段才是真实 TCP 对端,首段可被客户端伪造) */
function clientIp(req) {
  const real = req.headers['x-real-ip'];
  if (real) return String(real).split(',')[0].trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',');
    return parts[parts.length - 1].trim();
  }
  return (req.socket && req.socket.remoteAddress) || '?';
}

/* 常量时间字符串比较(管理码这类人工口令防时序侧信道;随机邀请码本身高熵可不加) */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/* 密码版本:passHash 尾 8 位,改密即变 */
function pvOf(user) {
  return String(user.passHash || '').slice(-8);
}

/* ---------- 处理器工厂(storage 注入 + options.now 时钟注入) ---------- */

function createHandlers(storage, options) {
  const o = options || {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const audit = typeof o.appendAudit === 'function' ? o.appendAudit : appendAudit;
  const backup = typeof o.backupData === 'function' ? o.backupData : backupData;
  const rate = o.rateLimiter || createRateLimiter(now);
  const { read, write } = createStorage(storage);

  /* 开发测试码核销记录(模块级,随进程) */
  const devUsed = new Set();

  async function readUsers() {
    return (await read(USERS_KEY)) || [];
  }

  async function readWorkspace() {
    try {
      return await read(DATA_KEY);
    } catch {
      return null;
    }
  }

  async function currentUser(req) {
    const payload = sessionOf(req);
    if (!payload) return null;
    const users = await readUsers();
    const user = users.find((u) => u.id === payload.uid) || null;
    /* pv 不匹配 = 密码已改过,旧会话全部失效 */
    if (user && payload.pv !== pvOf(user)) return null;
    return user;
  }

  async function playerOf(user) {
    if (!user || !user.playerId) return null;
    const workspace = await readWorkspace();
    const players = (workspace && workspace.players) || [];
    return players.find((p) => p && p.id === user.playerId) || null;
  }

  /* 以用户名新建选手并入 workspace(空白码/开发码共用) */
  async function createPlayerFor(username) {
    const t = now();
    const player = {
      id: newId('p'),
      name: username,
      tag: null,
      tagImg: null,
      tagImgRatio: null,
      tagImgSize: null,
      title: null,
      color: null,
      avatar: null,
      createdAt: t,
      updatedAt: t
    };
    const workspace = (await read(DATA_KEY)) || { tournaments: [], players: [], activeId: null };
    if (!Array.isArray(workspace.players)) workspace.players = [];
    workspace.players.push(player);
    await backup();
    await write(DATA_KEY, workspace);
    return player.id;
  }

  /* 邀请码注册。绑定码(码文件里预写 playerId)为老选手过渡逻辑,三期删除 */
  async function register(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    const ip = clientIp(req);
    const wait = rate.blocked(ip);
    if (wait > 0) {
      return sendJson(res, 429, { error: '尝试过于频繁,请 ' + wait + ' 秒后再试' });
    }
    const body = await readJsonBody(req, res, MAX_BODY);
    if (body === undefined) return;

    const code = String(body.code || '').trim();
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!code) return failRegister(res, ip, '请填写邀请码');
    if (!USERNAME_RE.test(username)) return failRegister(res, ip, '用户名需 2-24 位(中文/字母/数字/_/-)');
    if (password.length < 8 || password.length > 72) return failRegister(res, ip, '密码需 8-72 位');

    const users = await readUsers();
    if (users.some((u) => u.usernameLower === username.toLowerCase())) {
      return failRegister(res, ip, '用户名已被占用', 409);
    }

    const adminCode = process.env.ADMIN_INVITE_CODE;
    let role = 'player';
    let playerId = null;
    let codeKind = '';

    if (adminCode && safeEqual(code, adminCode)) {
      role = 'admin';
      codeKind = 'admin';
    } else {
      const codes = (await read(CODES_KEY)) || [];
      const entry = codes.find((c) => c && c.code === code);
      if (entry && !entry.used) {
        if (entry.playerId) {
          const workspace = await readWorkspace();
          const players = (workspace && workspace.players) || [];
          const target = players.find((p) => p && p.id === entry.playerId);
          if (!target) return failRegister(res, ip, '邀请码绑定的选手不存在');
          if (users.some((u) => u.playerId === entry.playerId)) {
            return failRegister(res, ip, '该选手已被其他账号绑定', 409);
          }
          playerId = entry.playerId;
          codeKind = 'bound';
        } else {
          /* 空白码:以用户名建新选手 */
          playerId = await createPlayerFor(username);
          codeKind = 'blank';
        }
        entry.used = true;
        entry.usedBy = username;
        entry.usedAt = t0iso(now);
        await backupJson(CODES_KEY, 'codes');
        await write(CODES_KEY, codes);
      } else {
        /* 开发测试码(env 提供,仅内存核销) */
        const devCodes = String(process.env.AUTH_DEV_INVITE_CODES || '').split(',').map((s) => s.trim()).filter(Boolean);
        if (devCodes.includes(code) && !devUsed.has(code)) {
          devUsed.add(code);
          /* 开发码等价空白码:同样以用户名建选手(E2E 全链路可见) */
          playerId = await createPlayerFor(username);
          codeKind = 'dev';
        } else {
          return failRegister(res, ip, '邀请码无效或已被使用');
        }
      }
    }

    const user = {
      id: newId('u'),
      username,
      usernameLower: username.toLowerCase(),
      passHash: hashPassword(password),
      role,
      playerId,
      createdAt: t0iso(now)
    };
    users.push(user);
    await backupJson(USERS_KEY, 'users');
    await write(USERS_KEY, users);
    audit('auth.register', 'user=' + username + ' role=' + role + ' player=' + (playerId || '-') + ' code=' + codeKind);

    setSessionCookie(res, issueFor(user.id, pvOf(user), now), req);
    sendJson(res, 200, { user: safeUser(user), player: await playerOf(user) });
  }

  /* 注册校验失败也计入限速(防在线枚举用户名/撞管理码);冲突类保留 409 语义 */
  function failRegister(res, ip, message, status) {
    rate.recordFail(ip);
    return sendJson(res, status || 400, { error: message });
  }

  async function login(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    const ip = clientIp(req);
    const wait = rate.blocked(ip);
    if (wait > 0) {
      return sendJson(res, 429, { error: '尝试过于频繁,请 ' + wait + ' 秒后再试' });
    }
    const body = await readJsonBody(req, res, MAX_BODY);
    if (body === undefined) return;

    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const users = await readUsers();
    const user = users.find((u) => u.usernameLower === username);
    if (!user || !verifyPassword(password, user.passHash)) {
      rate.recordFail(ip);
      audit('auth.login.fail', 'user=' + username + ' ip=' + ip);
      return sendJson(res, 401, { error: '用户名或密码错误' });
    }
    rate.reset(ip);
    audit('auth.login', 'user=' + user.username + ' ip=' + ip);
    setSessionCookie(res, issueFor(user.id, pvOf(user), now), req);
    sendJson(res, 200, { user: safeUser(user), player: await playerOf(user) });
  }

  async function logout(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    const user = await currentUser(req);
    audit('auth.logout', user ? 'user=' + user.username : 'anonymous');
    setSessionCookie(res, '', req, 0);
    sendJson(res, 200, { ok: true });
  }

  /* GET /api/me:会话信息;PUT /api/me/player:自助改资料(白名单) */
  async function me(req, res) {
    if (req.method === 'GET') {
      const user = await currentUser(req);
      if (!user) return sendJson(res, 401, { error: '未登录' });
      sendJson(res, 200, { user: safeUser(user), player: await playerOf(user) });
      return;
    }
    if (req.method === 'PUT') {
      const user = await currentUser(req);
      if (!user) return sendJson(res, 401, { error: '未登录' });
      if (!user.playerId) return sendJson(res, 400, { error: '该账号未绑定选手,无法编辑资料' });

      const body = await readJsonBody(req, res, MAX_BODY);
      if (body === undefined) return;
      const patch = {};
      if ('name' in body) {
        const v = clampText(body.name, 24);
        if (!v) return sendJson(res, 400, { error: '昵称不能为空' });
        patch.name = v;
      }
      if ('tag' in body) patch.tag = clampText(body.tag, 16);
      if ('title' in body) patch.title = clampText(body.title, 30);
      if ('color' in body) {
        const v = body.color;
        if (v !== null && !COLOR_RE.test(String(v))) return sendJson(res, 400, { error: '颜色需为 #rrggbb' });
        patch.color = v;
      }
      if ('avatar' in body) {
        const v = body.avatar;
        if (v !== null && !isHttpUrl(v)) return sendJson(res, 400, { error: '头像需为 http(s) 图片地址' });
        patch.avatar = v;
      }
      if ('tagImg' in body) {
        const v = body.tagImg;
        if (v !== null && !isHttpUrl(v)) return sendJson(res, 400, { error: '队标需为 http(s) 图片地址' });
        patch.tagImg = v;
      }
      if ('tagImgRatio' in body) {
        const v = body.tagImgRatio;
        if (v !== null && !(typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 20)) {
          return sendJson(res, 400, { error: '队标宽高比非法' });
        }
        patch.tagImgRatio = v;
      }
      if ('tagImgSize' in body) {
        const v = body.tagImgSize;
        if (v !== null && !(typeof v === 'number' && Number.isFinite(v) && v >= 16 && v <= 320)) {
          return sendJson(res, 400, { error: '队标大小需在 16-320 之间' });
        }
        patch.tagImgSize = v;
      }
      if (!Object.keys(patch).length) return sendJson(res, 400, { error: '没有可更新的字段' });

      /* 读-改-写整段上锁:与提交/报名/管理写共用一把锁 */
      await withWorkspaceLock(async () => {
        const workspace = await readWorkspace();
        const players = (workspace && workspace.players) || [];
        const idx = players.findIndex((p) => p && p.id === user.playerId);
        if (idx < 0) return sendJson(res, 404, { error: '绑定的选手不存在' });
        players[idx] = Object.assign({}, players[idx], patch, { updatedAt: now() });
        await backup();
        await write(DATA_KEY, workspace);
        audit('me.player', 'user=' + user.username + ' player=' + players[idx].name + ' fields=' + Object.keys(patch).join(','));
        sendJson(res, 200, { player: players[idx] });
      });
      return;
    }
    sendJson(res, 405, { error: 'Method Not Allowed' });
  }

  async function mePassword(req, res) {
    if (req.method !== 'PUT') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    const user = await currentUser(req);
    if (!user) return sendJson(res, 401, { error: '未登录' });
    const body = await readJsonBody(req, res, MAX_BODY);
    if (body === undefined) return;
    if (!verifyPassword(String(body.current || ''), user.passHash)) {
      return sendJson(res, 400, { error: '当前密码错误' });
    }
    const next = String(body.next || '');
    if (next.length < 8 || next.length > 72) return sendJson(res, 400, { error: '新密码需 8-72 位' });
    const users = await readUsers();
    const idx = users.findIndex((u) => u.id === user.id);
    if (idx < 0) return sendJson(res, 401, { error: '账号不存在' });
    users[idx].passHash = hashPassword(next);
    await backupJson(USERS_KEY, 'users');
    await write(USERS_KEY, users);
    audit('me.password', 'user=' + user.username);
    /* 重签当前会话(新 pv),其他浏览器/旧 cookie 因 pv 不匹配全部下线 */
    setSessionCookie(res, issueFor(user.id, pvOf(users[idx]), now), req);
    sendJson(res, 200, { ok: true });
  }

  return { register, login, logout, me, mePassword, currentUser };
}

function t0iso(now) {
  return new Date(now()).toISOString();
}

const handlers = createHandlers();
module.exports = handlers;
module.exports.createHandlers = createHandlers;
module.exports.hashPassword = hashPassword;
module.exports.verifyPassword = verifyPassword;
module.exports.createRateLimiter = createRateLimiter;
module.exports.USERNAME_RE = USERNAME_RE;
