'use strict';

const { requireUser, requireRole } = require('./auth');
const { effectiveRole, isAdminRole } = require('./rbac');
const { isWindowOpen } = require('./decks');
const { resolveCanvas, getResult } = require('../canvas-model');
const { sendJson, readBody, createStorage } = require('./helpers');
const { workspacePutGuard } = require('./acl');
const { DATA_PATH, backupData, appendAudit, isOssConfigured } = require('./oss');
const { withWorkspaceLock } = require('./workspace-lock');

/* data.json 只含文本数据（图片存 OSS 为 URL），1MB 上限绰绰有余，防内存被打爆 */
const MAX_BODY = 1024 * 1024;

/* 读-改-写走三态存储(无 OSS 环境降级开发内存,行为与云端一致) */
const storage = createStorage();

/* 未公示卡组剥离:开关开启期间,该届未录比分的卡,某侧已提交的 own classLinks
 * 对"非该侧所属选手"的请求者置 [](继承链自动回退到已公示数据,不泄露)。
 * 管理员角色(admin/super)原样;仅作用于响应,不落盘。viewerPlayerId 为会话选手 id 或 null。 */
function stripHiddenDecks(workspace, viewerPlayerId) {
  for (const record of (workspace.tournaments || [])) {
    if (!record || !record.canvas) continue;
    if (!isWindowOpen(record, Date.now)) continue;
    const scores = record.scores || {};
    const unscored = new Set(
      (record.canvas.cards || [])
        .filter((c) => {
          const r = getResult(scores[c.id]);
          return !(r && r.valid && !r.draw);
        })
        .map((c) => c.id)
    );
    if (!unscored.size) continue;
    let resolved;
    try {
      resolved = resolveCanvas(record.canvas, record.roster || [], scores);
    } catch {
      continue;
    }
    for (const card of (record.canvas.cards || [])) {
      if (!unscored.has(card.id) || !card.classLinks) continue;
      const rc = resolved.cards.find((c) => c.id === card.id);
      if (!rc) continue;
      const hidden = {};
      for (const [side, pid] of [['a', rc.a], ['b', rc.b]]) {
        hidden[side] = pid && pid !== viewerPlayerId && Array.isArray(card.classLinks[side]) && card.classLinks[side].length > 0;
      }
      if (hidden.a || hidden.b) {
        card.classLinks = {
          a: hidden.a ? [] : card.classLinks.a,
          b: hidden.b ? [] : card.classLinks.b
        };
      }
    }
  }
  return workspace;
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    /* 本地开发免墙(2026-08-31):未配 OSS 的纯本地进程对匿名放行——空存储随即
     * 走下方 500 → 前端落本地模式并合成超管(本地超管模式);生产(OSS 已配)与
     * E2E(专用 YOUSHOUBEI_ENFORCE_WALL=1,playwright 配置注入)仍严格执行登录墙 */
    const localDev = !isOssConfigured() && !process.env.YOUSHOUBEI_ENFORCE_WALL;
    const user = localDev
      ? await require('./account').currentUser(req).catch(() => null)
      : await requireUser(req, res);
    if (!localDev && !user) return;
    try {
      const workspace = await storage.read(DATA_PATH);
      /* 开发存储为空时按"云端不可用"处理(500),页面回落本地模式——
       * 与旧无 OSS 行为一致,避免 E2E 各用例间状态串扰 */
      if (workspace === null && !isOssConfigured()) {
        sendJson(res, 500, { error: 'OSS 配置不完整:需要 OSS_REGION / OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET' });
        return;
      }
      let payload = workspace || { tournaments: [], activeId: null };
      /* 管理员(admin/super)原样;其余登录者剥离未公示卡组,自己两侧保留;
       * localDev 匿名时 user 为 null → 按非管理员剥离(viewer null) */
      if (!isAdminRole(effectiveRole(user))) {
        payload = stripHiddenDecks(JSON.parse(JSON.stringify(payload)), (user && user.playerId) || null);
      }
      sendJson(res, 200, payload);
    } catch (error) {
      console.error('[data] GET 失败:', error.message);
      sendJson(res, 500, { error: '读取云端数据失败' });
    }
    return;
  }

  if (req.method === 'PUT') {
    const user = await requireRole(req, res, ['admin', 'super']);
    if (!user) return;

    const body = await readBody(req, MAX_BODY);
    if (body === null) {
      sendJson(res, 413, { error: '数据过大' });
      return;
    }
    let workspace;
    try {
      workspace = JSON.parse(body.toString('utf8'));
      if (!workspace || !Array.isArray(workspace.tournaments)) throw new Error('数据格式不正确');
    } catch (error) {
      sendJson(res, 400, { error: '数据格式不正确' });
      return;
    }

    try {
      /* 写入段上锁:与选手提交/报名/资料的读-改-写互斥,避免交错覆盖 */
      const outcome = await withWorkspaceLock(async () => {
        /* 守卫必须用锁内最新 current:锁外读快照会开 TOCTOU 窗口
         * (读完判完、写入前被并发写改库,判定基准已过期) */
        const current = await storage.read(DATA_PATH)
          || { tournaments: [], series: [], players: [], activeId: null };
        const guarded = workspacePutGuard(user, current, workspace);
        if (!guarded.ok) return { status: guarded.status, error: guarded.error };
        /* 覆盖前备份当前版本(best-effort,失败不阻塞);落盘守卫盖章后的 workspace */
        await backupData();
        await storage.write(DATA_PATH, guarded.workspace);
        return { workspace: guarded.workspace };
      });
      if (outcome.error) {
        sendJson(res, outcome.status, { error: outcome.error });
        return;
      }
      const saved = outcome.workspace;
      /* 审计:记录届数与当前届名,不落具体内容 */
      appendAudit('data.put', (saved.tournaments || []).length + ' 届 / active=' + ((saved.tournaments || []).find((t) => t.id === saved.activeId) || {}).name);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      console.error('[data] PUT 失败:', error.message);
      sendJson(res, 500, { error: '保存云端数据失败' });
    }
    return;
  }

  sendJson(res, 405, { error: 'Method Not Allowed' });
};

module.exports.stripHiddenDecks = stripHiddenDecks;
