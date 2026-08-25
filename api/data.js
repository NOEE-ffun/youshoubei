'use strict';

const { isAuthorized, adminGate } = require('./auth');
const { sessionOf } = require('./session');
const { isWindowOpen } = require('./decks');
const { resolveCanvas, getResult } = require('../canvas-model');
const { sendJson, readBody } = require('./helpers');
const { DATA_PATH, readJson, writeJson, backupData, appendAudit } = require('./oss');

/* data.json 只含文本数据（图片存 OSS 为 URL），1MB 上限绰绰有余，防内存被打爆 */
const MAX_BODY = 1024 * 1024;

async function readWorkspace() {
  return readJson(DATA_PATH);
}

/* 未公示卡组剥离:开关开启期间,该届未录比分的卡,某侧已提交的 own classLinks
 * 对"非该侧所属选手"的请求者置 [](继承链自动回退到已公示数据,不泄露)。
 * 管理员(Bearer)原样;仅作用于响应,不落盘。viewerPlayerId 为会话选手 id 或 null。 */
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
    try {
      const workspace = await readWorkspace();
      let payload = workspace || { tournaments: [], activeId: null };
      /* 管理员原样;登录选手保留自己两侧;游客/其他选手剥离未公示卡组 */
      if (isAuthorized(req) !== true) {
        let viewerPlayerId = null;
        if (sessionOf(req)) {
          const account = require('./account');
          const user = await account.currentUser(req).catch(() => null);
          viewerPlayerId = (user && user.playerId) || null;
        }
        payload = stripHiddenDecks(JSON.parse(JSON.stringify(payload)), viewerPlayerId);
      }
      sendJson(res, 200, payload);
    } catch (error) {
      console.error('[data] GET 失败:', error.message);
      sendJson(res, 500, { error: '读取云端数据失败' });
    }
    return;
  }

  if (req.method === 'PUT') {
    if (!(await adminGate(req, res))) return;

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
      /* 覆盖前备份当前版本(best-effort,失败不阻塞) */
      await backupData();
      await writeJson(DATA_PATH, workspace);
      /* 审计:记录届数与当前届名,不落具体内容 */
      appendAudit('data.put', (workspace.tournaments || []).length + ' 届 / active=' + ((workspace.tournaments || []).find((t) => t.id === workspace.activeId) || {}).name);
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
