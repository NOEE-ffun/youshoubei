'use strict';

const crypto = require('node:crypto');

/* 无状态签名会话:cookie 里放 uid+过期时间的 HMAC 签名载荷,服务端不存会话表。
 *   sess=<base64url(payload)>.<base64url(hmac-sha256)>
 * 密钥 SESSION_SECRET 未配置时每次启动随机生成(仅警告):重启后所有登录失效,
 * 生产环境必须在 env 里固定。 */
const COOKIE_NAME = 'sess';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; /* 30 天 */

let cachedSecret = null;
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (!cachedSecret) {
    cachedSecret = crypto.randomBytes(32).toString('hex');
    console.warn('[session] SESSION_SECRET 未配置,已生成临时密钥(进程重启后所有登录失效)');
  }
  return cachedSecret;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function hmac(data) {
  return crypto.createHmac('sha256', sessionSecret()).update(data).digest();
}

/* 签发:payload 建议 {uid, exp};exp 由 issueFor 统一填 */
function signSession(payload) {
  const body = b64url(JSON.stringify(payload));
  return body + '.' + b64url(hmac(body));
}

/* 为用户签发默认 30 天会话;pv = 密码版本(取 passHash 尾 8 位),
 * 改密后旧 pv 的会话全部失效(把其他浏览器/被盗 cookie 踢下线) */
function issueFor(uid, pv, now) {
  const base = typeof now === 'function' ? now() : Date.now();
  return signSession({ uid, pv: String(pv || ''), exp: base + SESSION_TTL_MS });
}

/* 校验:通过返回 payload 对象,失败返回 null(签名不符/过期/格式错) */
function verifySession(raw) {
  if (typeof raw !== 'string' || raw.length > 512) return null;
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  let expected;
  try {
    expected = b64url(hmac(body));
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.uid !== 'string' || !Number.isFinite(payload.exp)) return null;
  if (typeof payload.pv !== 'string') return null;
  if (Date.now() > payload.exp) return null;
  return payload;
}

/* 解析 Cookie 头 → 对象(重复键取首个) */
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (key && !(key in out)) {
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    }
  }
  return out;
}

/* 从请求取会话 payload(无/无效返回 null) */
function sessionOf(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifySession(cookies[COOKIE_NAME]);
}

/* HTTPS 判定:直连 TLS 或经 nginx 反代(X-Forwarded-Proto) */
function isHttps(req) {
  return Boolean(req && req.socket && req.socket.encrypted) ||
    String(req && req.headers && req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
}

/* 写会话 cookie;maxAgeMs=0 表示立即过期(登出) */
function setSessionCookie(res, value, req, maxAgeMs) {
  const parts = [
    COOKIE_NAME + '=' + encodeURIComponent(value),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + Math.max(0, Math.floor((maxAgeMs === 0 ? 0 : maxAgeMs || SESSION_TTL_MS) / 1000))
  ];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

module.exports = {
  issueFor,
  signSession,
  verifySession,
  parseCookies,
  sessionOf,
  setSessionCookie,
  isHttps
};
