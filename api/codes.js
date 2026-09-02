'use strict';

const crypto = require('node:crypto');
const { sendJson, readJsonBody, createStorage, maskUser } = require('./helpers');
const { backupJson, appendAudit } = require('./oss');
const { requireRole } = require('./auth');
const { withWorkspaceLock } = require('./workspace-lock');

/* 发码中心(一期网页化,替代命令行 gen-invite 的日常使用):
 *   GET  /api/codes  admin/super:码全量列表(带选手名)
 *   POST /api/codes  {kind:'admin'}  仅 admin 码,且仅 super 可发。
 * 选手码(空白/绑定)已停用:注册即选手后无发放语义,一律 400(2026-09-01);
 * 存量码缺 kind 按 'player' 归一化(读时兼容,不回写,历史码自然作废)。 */
const CODES_KEY = 'invite-codes.json';
const MAX_BODY = 8 * 1024;

function generateCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += alphabet[bytes[i] % alphabet.length];
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12);
}

function createHandler(storage, options) {
  const o = options || {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const audit = typeof o.appendAudit === 'function' ? o.appendAudit : appendAudit;
  const { read, write } = createStorage(storage);

  async function readCodes() {
    return ((await read(CODES_KEY)) || []).map((c) => c && Object.assign({ kind: 'player', issuedBy: null }, c)).filter(Boolean);
  }

  async function list(req, res) {
    const user = await requireRole(req, res, ['admin', 'super']);
    if (!user) return;
    const codes = await readCodes();
    const workspace = await read('data.json').catch(() => null);
    const pmap = new Map(((workspace && workspace.players) || []).map((p) => [p.id, p.name]));
    sendJson(res, 200, {
      codes: codes.map((c) => ({
        code: c.code, kind: c.kind, playerId: c.playerId || null,
        playerName: c.playerId ? (pmap.get(c.playerId) || null) : null,
        used: Boolean(c.used), usedBy: c.usedBy || null, usedAt: c.usedAt || null,
        issuedBy: c.issuedBy || null, createdAt: c.createdAt || null
      }))
    });
  }

  async function create(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method Not Allowed' });
    const roles = ['admin', 'super'];
    const user = await requireRole(req, res, roles);
    if (!user) return;
    const body = await readJsonBody(req, res, MAX_BODY);
    if (body === undefined) return;
    if (body.kind !== 'admin') {
      return sendJson(res, 400, { error: '选手码已停用:所有账号注册时自动创建选手档案' });
    }
    const kind = 'admin';
    const again = await requireRole(req, res, ['super']);
    if (!again) return;
    /* 码表读改写(读→追加→备份→写)整段上锁:与 redeem(核销)及其他 create 互斥。
     * 无锁时并发交错会用读到的旧快照整体覆盖,把已核销码复活成 used:false,
     * 或丢掉同期发放的新码(与 account redeem 用同一把工作区锁) */
    return withWorkspaceLock(async () => {
      const codes = await readCodes();
      const entry = {
        code: generateCode(), kind, playerId: null,
        used: false, usedBy: null, usedAt: null,
        issuedBy: user.id, createdAt: new Date(now()).toISOString()
      };
      codes.push(entry);
      await backupJson(CODES_KEY, 'codes');
      await write(CODES_KEY, codes);
      audit('codes.create', 'by=' + maskUser(user.username) + ' kind=' + kind);
      sendJson(res, 200, { code: entry.code, kind, playerId: null });
    });
  }

  return async function handler(req, res) {
    if (req.method === 'GET') return list(req, res);
    if (req.method === 'POST') return create(req, res);
    sendJson(res, 405, { error: 'Method Not Allowed' });
  };
}

const handler = createHandler();
module.exports = handler;
module.exports.createHandler = createHandler;
module.exports.generateCode = generateCode;
