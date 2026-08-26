'use strict';

const { sendJson, readBody } = require('./helpers');
const { DATA_PATH, readJson, writeJson, backupJson, isOssConfigured } = require('./oss');
const account = require('./account');
const devStore = require('./dev-store');
const { deriveRoster } = require('../canvas-model');

/* 比赛报名(2026-08-26):
 *   PUT /api/me/signup  body { tournamentId, action: 'join'|'leave' }
 * 数据:record.signup = { open: true|false, players: [playerId...] }(独立字段;
 * record.roster 是派生值会被客户端重算,不能承载报名)。
 * 规则:开关关=423;join 幂等;leave 幂等;选手已上画布(派生 roster 含其)
 * 不得自助退报(409,找管理员)。写前备份+bump updatedAt+审计。 */
const MAX_BODY = 8 * 1024;

function isSignupOpen(record) {
  const s = record && record.signup;
  return Boolean(s && s.open === true);
}

function signupPlayers(record) {
  const s = record && record.signup;
  return (s && Array.isArray(s.players)) ? s.players.filter((id) => typeof id === 'string') : [];
}

function createHandler(storage, options) {
  const o = options || {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const audit = typeof o.appendAudit === 'function' ? o.appendAudit : require('./oss').appendAudit;
  const backup = typeof o.backupJson === 'function' ? o.backupJson : backupJson;
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

  async function signup(req, res) {
    if (req.method !== 'PUT') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
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
    const action = body.action === 'join' ? 'join' : body.action === 'leave' ? 'leave' : null;
    if (!body.tournamentId || !action) {
      sendJson(res, 400, { error: '缺少 tournamentId / action' });
      return;
    }

    const workspace = await read(DATA_PATH);
    const record = workspace && (workspace.tournaments || []).find((t) => t && t.id === body.tournamentId);
    if (!record) {
      sendJson(res, 404, { error: '比赛不存在' });
      return;
    }
    if (!isSignupOpen(record)) {
      sendJson(res, 423, { error: '该比赛未开放报名' });
      return;
    }

    const onCanvas = deriveRoster(record.canvas || {}).includes(user.playerId);
    const players = signupPlayers(record);
    const joined = players.includes(user.playerId);

    if (action === 'join') {
      if (joined || onCanvas) {
        sendJson(res, 200, { ok: true, joined: true, players: players.length });
        return;
      }
      players.push(user.playerId);
    } else {
      if (!joined) {
        sendJson(res, 200, { ok: true, joined: false, players: players.length });
        return;
      }
      if (onCanvas) {
        sendJson(res, 409, { error: '你已在该届比赛上场,退赛请联系管理员' });
        return;
      }
      players.splice(players.indexOf(user.playerId), 1);
    }

    record.signup = { open: true, players };
    record.updatedAt = now();
    await backup(DATA_PATH, 'data');
    await write(DATA_PATH, workspace);
    audit('signup.' + action, 'user=' + user.username + ' tournament=' + (record.name || record.id) + ' n=' + players.length);
    sendJson(res, 200, { ok: true, joined: action === 'join', players: players.length });
  }

  return { signup, isSignupOpen };
}

const handler = createHandler();
module.exports = handler.signup;
module.exports.createHandler = createHandler;
module.exports.isSignupOpen = isSignupOpen;
module.exports.signupPlayers = signupPlayers;
