'use strict';

const { sendJson, readBody } = require('./helpers');
const { DATA_PATH, readJson, writeJson, backupData, appendAudit, isOssConfigured } = require('./oss');
const account = require('./account');
const devStore = require('./dev-store');
const { withWorkspaceLock } = require('./workspace-lock');
const { CLASS_LIST, resolveCanvas, getResult } = require('../canvas-model');

/* 卡组提交窗口(二期):
 *   PUT /api/me/classlinks  选手在开关开启期间,为自己参与且未录比分的卡提交卡组
 * 开关语义(与 api/data.js GET 剥离逻辑共用 isWindowOpen):
 *   record.deckWindow = { open:"HH:MM", close:"HH:MM", manual: null|'open'|'closed' }
 *   manual 优先;无 manual 且时段齐全时按服务器本地时间每日循环判定;否则恒关。
 * 开=可改+对非所属者隐藏未开始卡;关=公示(全员可见)。 */
const MAX_BODY = 64 * 1024;
const MAX_LINKS = 12;

function parseHHMM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/* 生效状态:true=开(可提交+隐藏),false=关(锁定+公示)。now 可注入供测试:
 * Date 实例 / 毫秒数 / 返回任一者的函数均可(生产注入的是 Date.now 本身) */
function isWindowOpen(record, now) {
  const w = record && record.deckWindow;
  if (!w || typeof w !== 'object') return false;
  if (w.manual === 'open') return true;
  if (w.manual === 'closed') return false;
  const openMin = parseHHMM(w.open);
  const closeMin = parseHHMM(w.close);
  if (openMin === null || closeMin === null || openMin === closeMin) return false;
  const raw = typeof now === 'function' ? now() : now;
  const t = raw instanceof Date ? raw : new Date(Number.isFinite(raw) ? raw : Date.now());
  const cur = t.getHours() * 60 + t.getMinutes();
  /* 每日循环:支持跨零点时段(如 20:00-02:00) */
  return openMin < closeMin ? (cur >= openMin && cur < closeMin) : (cur >= openMin || cur < closeMin);
}

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

  async function read(key) {
    if (storage && storage.readJson) return storage.readJson(key);
    if (!isOssConfigured()) return devStore.readJson(key);
    return readJson(key);
  }

  async function write(key, value) {
    if (storage && storage.writeJson) return storage.writeJson(key, value);
    if (!isOssConfigured()) return devStore.writeJson(key, value);
    return writeJson(key, value);
  }

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

    const buffer = await readBody(req, MAX_BODY);
    if (buffer === null) {
      sendJson(res, 413, { error: '数据过大' });
      return;
    }
    let body;
    try {
      body = JSON.parse(buffer.toString('utf8'));
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' });
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { error: '请求体必须是 JSON 对象' });
      return;
    }
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
module.exports.parseHHMM = parseHHMM;
