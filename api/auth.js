'use strict';

const crypto = require('node:crypto');
const { sessionOf } = require('./session');

/* 管理写操作统一鉴权：data/upload/stage 共用，避免各接口重复实现。
 * 判定返回三态：
 *   null  → 未配置 ADMIN_TOKEN（管理功能未启用）
 *   true  → Bearer token 与 ADMIN_TOKEN 一致
 *   false → 口令错误
 * 用 timingSafeEqual 做常量时间比较，防止时序侧信道。
 * 2026-08-25 紧急加固：请求携带选手登录会话时，管理口令一律失效——
 * 选手账号即使浏览器残留有效口令也绝不放行管理写操作。 */
function isAuthorized(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return null;
  const header = String(req.headers.authorization || '');
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function adminGate(req, res) {
  if (sessionOf(req)) {
    const user = await require('./account').currentUser(req).catch(() => null);
    if (user && user.role === 'player') {
      res.status(403).json({ error: '选手账号无管理权限' });
      return false;
    }
  }
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
