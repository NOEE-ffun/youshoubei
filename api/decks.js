'use strict';

const { sendJson, readJsonBody, createStorage } = require('./helpers');
const { DATA_PATH, backupData, appendAudit } = require('./oss');
const account = require('./account');
const { withWorkspaceLock } = require('./workspace-lock');
const { CLASS_LIST, resolveCanvas, getResult, isWindowOpen } = require('../canvas-model');

/* 卡组提交窗口(二期):
 *   PUT /api/me/classlinks  选手在开关开启期间,为自己参与且未录比分的卡提交卡组
 * 开关语义见 canvas-model.js isWindowOpen(与前端展示共用同一份判定)。
 * 开=可改+对非所属者隐藏未开始卡;关=公示(全员可见)。 */
const MAX_BODY = 64 * 1024;
const MAX_LINKS = 12;

/* links 白名单归一化:与 canvas-model.normalizeClassLink 同规则,空数组=恢复继承 */
function normalizeLinks(links) {
  if (!Array.isArray(links)) return null;
  const out = [];
  for (const entry of links.slice(0, MAX_LINKS)) {
    if (!entry || typeof entry !== 'object') continue;
    if (!CLASS_LIST.includes(entry.cls)) continue;
    const url = typeof entry.url === 'string' ? entry.url.trim().slice(0, 500) : '';
    const text = typeof entry.text === 'string' ? entry.text.trim().slice(0, 60) : '';
    if (!url && !text) continue;
    out.push({ cls: entry.cls, url, text });
  }
  return out;
}

function createHandler(storage, options) {
  const o = options || {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const audit = typeof o.appendAudit === 'function' ? o.appendAudit : appendAudit;
  const backup = typeof o.backupData === 'function' ? o.backupData : backupData;
  /* 会话→用户解析默认走全局 account(共用其存储降级);测试可注入 */
  const currentUser = typeof o.currentUser === 'function' ? o.currentUser : (req) => account.currentUser(req);
  const { read, write } = createStorage(storage);

  async function submit(req, res) {
    if (req.method !== 'PUT') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    /* 会话鉴权:admin Bearer 不适用本接口(管理员走 /api/data),必须是登录选手 */
    const user = await currentUser(req);
    if (!user || !user.playerId) {
      sendJson(res, 401, { error: '需要登录选手账号' });
      return;
    }

    const body = await readJsonBody(req, res, MAX_BODY);
    if (body === undefined) return;
    const { tournamentId, cardId } = body;
    const side = body.side === 'a' ? 'a' : body.side === 'b' ? 'b' : null;
    if (!tournamentId || !cardId || !side) {
      sendJson(res, 400, { error: '缺少 tournamentId / cardId / side' });
      return;
    }
    const links = normalizeLinks(body.links);
    if (links === null) {
      sendJson(res, 400, { error: 'links 必须是数组' });
      return;
    }

    /* 读-改-写整段上锁:并发提交互斥,防止后写者的旧快照覆盖前者的提交 */
    return withWorkspaceLock(async () => {
      const workspace = await read(DATA_PATH);
      const record = workspace && (workspace.tournaments || []).find((t) => t && t.id === tournamentId);
      if (!record || !record.canvas) {
        sendJson(res, 404, { error: '比赛不存在' });
        return;
      }
      const card = (record.canvas.cards || []).find((c) => c.id === cardId);
      if (!card) {
        sendJson(res, 404, { error: '卡片不存在' });
        return;
      }

      /* 归属判定:resolveCanvas 解析该侧选手(含 flow 继承)必须 === 登录选手 */
      const resolved = resolveCanvas(record.canvas, record.roster || [], record.scores || {});
      const resolvedCard = resolved.cards.find((c) => c.id === cardId);
      const sidePlayer = resolvedCard ? (side === 'a' ? resolvedCard.a : resolvedCard.b) : null;
      if (sidePlayer !== user.playerId) {
        sendJson(res, 403, { error: '该场次这一侧不是你的比赛' });
        return;
      }

      /* 比赛已开始(有合法比分)即锁定 */
      const result = getResult((record.scores || {})[cardId]);
      if (result && result.valid && !result.draw) {
        sendJson(res, 423, { error: '比赛已开始,卡组已锁定' });
        return;
      }
      if (!isWindowOpen(record, now)) {
        sendJson(res, 423, { error: '卡组提交窗口已关闭,等待公示' });
        return;
      }

      if (!card.classLinks || typeof card.classLinks !== 'object') card.classLinks = { a: [], b: [] };
      card.classLinks[side] = links;
      record.updatedAt = now();
      await backup();
      await write(DATA_PATH, workspace);
      audit('deck.submit', 'user=' + user.username + ' card=' + cardId + ' side=' + side + ' n=' + links.length);
      sendJson(res, 200, { ok: true, links });
    });
  }

  return { submit, isWindowOpen };
}

const handler = createHandler();
module.exports = handler.submit;
module.exports.createHandler = createHandler;
module.exports.isWindowOpen = isWindowOpen;
module.exports.normalizeLinks = normalizeLinks;
