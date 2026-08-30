'use strict';

/* 会话/角色门:2026-08-30 权限重构后唯一鉴权入口。
 *   requireUser(req, res)       会话必须;banned 拒
 *   requireRole(req, res, roles) 在 requireUser 之上校角色,不足 403
 * 旧口令体系(Bearer 头校验)已随权限重构退役删除。 */
const { effectiveRole } = require('./rbac');

async function requireUser(req, res) {
  const user = await require('./account').currentUser(req).catch(() => null);
  if (!user || user.status === 'banned') {
    res.status(401).json({ error: '未登录或账号已被停用' });
    return null;
  }
  return user;
}

async function requireRole(req, res, roles) {
  const user = await requireUser(req, res);
  if (!user) return null;
  if (!roles.includes(effectiveRole(user))) {
    res.status(403).json({ error: '权限不足' });
    return null;
  }
  return user;
}

module.exports = { requireUser, requireRole };
