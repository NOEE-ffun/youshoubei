'use strict';

/* 角色纯函数(无 IO):角色判定唯一来源。
 * env 超管名单 SUPER_ADMIN_USERNAMES(用户名)/SUPER_ADMIN_PHONES(手机号)
 * 动态升格——幂等、改 env 即生效,同时充当全新环境的引导通道
 * (第一条短信登录命中名单即成超管)。名单匹配不区分大小写。 */
const ROLES = ['user', 'player', 'admin', 'super'];

function envList(name) {
  return String(process.env[name] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function effectiveRole(user) {
  if (!user) return null;
  if (user.usernameLower && envList('SUPER_ADMIN_USERNAMES').includes(user.usernameLower)) return 'super';
  if (user.phone && envList('SUPER_ADMIN_PHONES').includes(String(user.phone).toLowerCase())) return 'super';
  return ROLES.includes(user.role) ? user.role : 'user';
}

function isAdminRole(role) {
  return role === 'admin' || role === 'super';
}

module.exports = { ROLES, effectiveRole, isAdminRole };
