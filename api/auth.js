'use strict';

const crypto = require('node:crypto');

/* 管理写操作统一鉴权：data/upload/stage 共用，避免各接口重复实现。
 * 判定返回三态：
 *   null  → 未配置 ADMIN_TOKEN（管理功能未启用）
 *   true  → Bearer token 与 ADMIN_TOKEN 一致
 *   false → 口令错误
 * 用 timingSafeEqual 做常量时间比较，防止时序侧信道。 */
function isAuthorized(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return null;
  const header = String(req.headers.authorization || '');
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* 管理写门禁：通过返回 true；未配置/口令错误时写出 403/401 并返回 false。
 * 调用方应 `if (!adminGate(req, res)) return;`。 */
function adminGate(req, res) {
  const authed = isAuthorized(req);
  if (authed === null) {
    res.status(403).json({ error: '管理功能未配置（ADMIN_TOKEN）' });
    return false;
  }
  if (!authed) {
    res.status(401).json({ error: '管理口令错误' });
    return false;
  }
  return true;
}

module.exports = { isAuthorized, adminGate };
