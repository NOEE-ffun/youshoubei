'use strict';

/* ACL 纯函数(无 IO):资源归属判定 + 整库 PUT 守卫。
 * 二期引入 series(系列)/tournament(届)两级资源与 createdBy 服务端盖章:
 * 客户端提交的 createdBy 一律不信——新资源由服务端盖请求者 id,
 * 已有资源无条件回填 current 存档值,防越权篡改归属。 */

const { effectiveRole } = require('./rbac');

/* 资源类型 → 展示名(403 错误信息用) */
const RESOURCE_LABELS = { series: '系列', tournaments: '届' };

/* 归属判定:super 恒 true;admin 需 resource.createdBy === userId;
 * createdBy 缺失/null = 系统预置资源,仅 super 可动;其余角色恒 false。 */
function canManageResource(role, userId, resource) {
  if (role === 'super') return true;
  if (role !== 'admin' || userId == null || !resource) return false;
  return resource.createdBy != null && resource.createdBy === userId;
}

/* 剥 updatedAt 的 JSON 序列化(顶层键排序):纯时间戳/键序变化不视为内容修改 */
function comparableResource(resource) {
  const copy = Object.assign({}, resource || {});
  delete copy.updatedAt;
  return JSON.stringify(copy, Object.keys(copy).sort());
}

/* 一类资源(series/tournaments)的删/改判定 + 盖章回填(就地改 outList,它已是深拷贝):
 * - current 有而 incoming 无 → 删除,非本人(系统资源同)拒
 * - id 在 current 中 → 内容有变(剥 updatedAt 比较)且非本人 → 拒;createdBy 无条件回填存档值
 * - current 无此 id → 新资源,createdBy 盖章为请求者(客户端伪造值一并盖掉)
 * 返回 {status,error} 或 null(通过)。 */
function guardList(role, userId, kind, curList, outList) {
  const label = RESOURCE_LABELS[kind] || kind;
  const curById = new Map();
  for (const r of curList) {
    if (r && r.id != null) curById.set(String(r.id), r);
  }
  const incomingIds = new Set();
  for (const r of outList) {
    if (r && r.id != null) incomingIds.add(String(r.id));
  }
  for (const r of curList) {
    if (r && r.id != null && !incomingIds.has(String(r.id))
        && !canManageResource(role, userId, r)) {
      return { status: 403, error: `无权删除${label}:${r.name || r.id}` };
    }
  }
  for (const r of outList) {
    if (!r || r.id == null) continue;
    const existing = curById.get(String(r.id));
    if (!existing) {
      r.createdBy = userId;
      continue;
    }
    if (role !== 'super'
        && comparableResource(r) !== comparableResource(existing)
        && !canManageResource(role, userId, existing)) {
      return { status: 403, error: `无权修改${label}:${existing.name || existing.id}` };
    }
    r.createdBy = existing.createdBy == null ? null : existing.createdBy;
  }
  return null;
}

/* 整库写守卫:user 为 currentUser 原始对象(内部 effectiveRole 判 super/admin)。
 * 返回 {ok:true, workspace}(处理后的 incoming 深拷贝,已盖章/回填 createdBy)
 * 或 {ok:false, status, error}。只做归属判定:players/activeId 等顶层字段自由,
 * 结构校验仅防御非数组(完整结构校验由 data.js 承担)。 */
function workspacePutGuard(user, current, incoming) {
  const role = effectiveRole(user);
  if (role !== 'admin' && role !== 'super') {
    return { ok: false, status: 403, error: '无权写入工作区' };
  }
  if (!incoming || !Array.isArray(incoming.tournaments)
      || (incoming.series !== undefined && !Array.isArray(incoming.series))) {
    return { ok: false, status: 400, error: '数据格式不正确:series/tournaments 必须是数组' };
  }
  const cur = current || {};
  const userId = user && user.id != null ? user.id : null;
  /* 输出 = incoming 深拷贝:绝不改 current,也不复用其对象引用 */
  const workspace = JSON.parse(JSON.stringify(incoming));
  if (!Array.isArray(workspace.series)) workspace.series = [];   /* series 缺失按 [] 处理 */

  const err = guardList(role, userId, 'tournaments',
    Array.isArray(cur.tournaments) ? cur.tournaments : [], workspace.tournaments)
    || guardList(role, userId, 'series',
      Array.isArray(cur.series) ? cur.series : [], workspace.series);
  if (err) return { ok: false, status: err.status, error: err.error };
  return { ok: true, workspace };
}

module.exports = { canManageResource, comparableResource, workspacePutGuard };
