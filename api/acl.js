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

/* 递归规范序列化:对象每层键名排序后拼接、数组保序、原始值走 JSON。
 * 不能用 JSON.stringify 的数组型 replacer 排键——replacer 数组是每层生效的
 * 属性白名单,嵌套对象会被剥成空壳(canvas:{cards:[7]} 与 cards:[1] 同为
 * {"canvas":{}}),导致「仅改嵌套内容」逃过修改检测。 */
function deepCanonical(value) {
  if (value === undefined) return 'null';               /* 与 JSON 语义对齐:[undefined] → [null] */
  if (Array.isArray(value)) return '[' + value.map(deepCanonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .filter((k) => { const v = value[k]; return v !== undefined && typeof v !== 'function' && typeof v !== 'symbol'; })
      .map((k) => JSON.stringify(k) + ':' + deepCanonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/* 剥 updatedAt 的规范序列化:纯时间戳/键序变化不视为内容修改 */
function comparableResource(resource) {
  const copy = Object.assign({}, resource || {});
  delete copy.updatedAt;
  return deepCanonical(copy);
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
 * 结构校验仅防御非数组(完整结构校验由 data.js 承担)。
 * 第 4 参 boundPlayerIds(可选 Set<string>):被账号绑定的选手 id 集,
 * current 有而 incoming 无且仍在绑定集 → 409(省略 = 不检查,兼容既有调用)。 */
function workspacePutGuard(user, current, incoming, boundPlayerIds) {
  const role = effectiveRole(user);
  if (role !== 'admin' && role !== 'super') {
    return { ok: false, status: 403, error: '无权写入工作区' };
  }
  /* series 仅「缺失(undefined)」按 [] 处理;显式 null/非数组一律 400——
   * fail-closed:字段带了却不是数组即为畸形输入,拒绝而不是猜语义 */
  if (!incoming || !Array.isArray(incoming.tournaments)
      || (incoming.series !== undefined && !Array.isArray(incoming.series))) {
    return { ok: false, status: 400, error: '数据格式不正确:series/tournaments 必须是数组' };
  }
  /* 条目必须带字符串 id:无 id 条目进不了盖章/回填/比较任一分支,
   * 会带着客户端伪造的 createdBy 原样落库 → fail-closed 400 */
  for (const kind of ['tournaments', 'series']) {
    const list = kind === 'series' ? (incoming.series || []) : incoming.tournaments;
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') {
        return { ok: false, status: 400, error: `资源缺少 id:${RESOURCE_LABELS[kind]} 第 ${i + 1} 项` };
      }
    }
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
  /* 被账号绑定的选手禁删:选手与账号 1:1 后,删绑定选手会留悬空 playerId
   * (自愈会另建新档,原档案不辞而别)。换绑/删号端点自带清理,不经此路径。
   * boundPlayerIds 省略时不检查(纯函数兼容既有调用)。 */
  if (boundPlayerIds && boundPlayerIds.size) {
    const curPlayers = Array.isArray(cur.players) ? cur.players : [];
    for (const p of curPlayers) {
      if (!p || p.id == null || !boundPlayerIds.has(String(p.id))) continue;
      const kept = Array.isArray(workspace.players)
        && workspace.players.some((q) => q && q.id != null && String(q.id) === String(p.id));
      if (!kept) {
        return { ok: false, status: 409, error: '该选手仍被账号绑定,请先在后台换绑或删除账号:' + (p.name || p.id) };
      }
    }
  }
  if (err) return { ok: false, status: err.status, error: err.error };
  return { ok: true, workspace };
}

module.exports = { canManageResource, comparableResource, workspacePutGuard };
