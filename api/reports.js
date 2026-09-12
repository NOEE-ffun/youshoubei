'use strict';

const crypto = require('node:crypto');
const { sendJson, readJsonBody, createStorage, maskUser } = require('./helpers');
const { backupJson, backupData, appendAudit } = require('./oss');
const { requireUser, requireRole } = require('./auth');
const { withWorkspaceLock } = require('./workspace-lock');
const { shared: sharedModeration } = require('./moderation');

/* 举报通道(内容审查·方案甲 Task 3):
 *   POST /api/reports  登录:{kind:'nickname'|'avatar'|'other', detail≤200 字}
 *   GET  /api/reports  super:最近 200 条倒序(新在前)
 *   PUT  /api/reports  super:{id, action:'dismiss'|'name-reset'|'avatar-clear', playerId?}
 * 存储:OSS reports.json([{id,uid,username,kind,detail,at,handled:null}]),独立于
 * workspace,不被整库保存冲掉(同 notices.json 惯例)。
 * detail 本身过 moderation.checkText——举报文本也是用户输入,违禁词同样拒之门外。
 * 处置语义:
 *   dismiss      仅标 handled(不动任何数据)
 *   name-reset   锁内精确流(读最新→定点改→写回)把 player.name 与所有绑该选手的
 *                user.nickname 同改为「选手」+ playerId 尾 4 位——两侧同名同改,
 *                不给「选手名干净、昵称仍脏」留半张脸
 *   avatar-clear 锁内精确流把 player.avatar/tagImg/tagImgRatio/tagImgSize 置 null
 * handled = {action, by, at};重复处理 409。
 * 审计:report.new / report.handle(dismiss) / mod.name-reset / mod.avatar-clear,
 * 一律带 by=(脱敏账号名)。 */
const REPORTS_KEY = 'reports.json';
const DATA_KEY = 'data.json';
const USERS_KEY = 'users.json';
const MAX_BODY = 8 * 1024;
const DETAIL_MAX = 200;
const LIST_LIMIT = 200;
const KINDS = ['nickname', 'avatar', 'other'];
const ACTIONS = ['dismiss', 'name-reset', 'avatar-clear'];

/* 处置目标名:「选手」+ playerId 尾 4 位(playerId 短于 4 位时整体拼上) */
function resetNameFor(playerId) {
  return '选手' + String(playerId).slice(-4);
}

function newReportId() {
  return 'r_' + crypto.randomBytes(8).toString('hex');
}

function createHandler(storage, options) {
  const o = options || {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const audit = typeof o.appendAudit === 'function' ? o.appendAudit : appendAudit;
  /* 内容审查:默认共享单例;测试注入合成词实例(同 account/decks 惯例) */
  const moderation = o.moderation || sharedModeration;
  const { read, write } = createStorage(storage);

  const readReports = async () => (((await read(REPORTS_KEY)) || []).filter(Boolean));

  /* POST /api/reports:任意登录会话提交举报 */
  async function create(req, res) {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readJsonBody(req, res, MAX_BODY);
    if (body === undefined) return;
    if (!KINDS.includes(body.kind)) {
      return sendJson(res, 400, { error: "kind 必须是 'nickname' / 'avatar' / 'other'" });
    }
    const detail = typeof body.detail === 'string' ? body.detail.trim() : '';
    if (!detail) return sendJson(res, 400, { error: '举报内容不能为空' });
    if (detail.length > DETAIL_MAX) {
      return sendJson(res, 400, { error: '举报内容不能超过 ' + DETAIL_MAX + ' 字' });
    }
    /* 举报文本本身先过审:命中即拒,不给词库内容经举报通道回显/落盘的口子 */
    const verdict = await moderation.checkText(detail);
    if (!verdict.ok) return sendJson(res, 400, { error: verdict.reason });

    /* reports.json 读改写整段上锁(读→追加→备份→写):并发提交交错会旧快照整体
     * 覆盖丢举报;与其他带锁写者共用工作区锁 */
    return withWorkspaceLock(async () => {
      const reports = await readReports();
      const entry = {
        id: newReportId(), uid: user.id, username: user.username,
        kind: body.kind, detail, at: new Date(now()).toISOString(), handled: null
      };
      reports.push(entry);
      await backupJson(REPORTS_KEY, 'reports');
      await write(REPORTS_KEY, reports);
      audit('report.new', 'by=' + maskUser(user.username) + ' kind=' + body.kind);
      sendJson(res, 200, { ok: true, id: entry.id });
    });
  }

  /* GET /api/reports:super 管理列表,最近 200 条倒序(新在前);
   * username 走脱敏(手机号账号只回末 4 位,同 codes.js 列表口径) */
  async function list(req, res) {
    const user = await requireRole(req, res, ['super']);
    if (!user) return;
    const reports = await readReports();
    sendJson(res, 200, {
      reports: reports.slice(-LIST_LIMIT).reverse().map((x) => ({
        id: x.id, uid: x.uid, username: maskUser(x.username),
        kind: x.kind, detail: x.detail, at: x.at,
        handled: x.handled ? {
          action: x.handled.action, by: maskUser(x.handled.by), at: x.handled.at
        } : null
      }))
    });
  }

  /* PUT /api/reports:super 处置。全部在锁内以「读最新→定点改→写回」的精确流执行,
   * 不吃锁外旧快照(与 me PUT 双段写同把锁互斥) */
  async function update(req, res) {
    const user = await requireRole(req, res, ['super']);
    if (!user) return;
    const body = await readJsonBody(req, res, MAX_BODY);
    if (body === undefined) return;
    if (!ACTIONS.includes(body.action)) {
      return sendJson(res, 400, { error: "action 必须是 'dismiss' / 'name-reset' / 'avatar-clear'" });
    }
    const action = body.action;
    const playerId = typeof body.playerId === 'string' ? body.playerId.trim() : '';
    if (action !== 'dismiss' && !playerId) {
      return sendJson(res, 400, { error: '处置需选手 ID(name-reset / avatar-clear 必填)' });
    }

    return withWorkspaceLock(async () => {
      const reports = await readReports();
      const idx = reports.findIndex((x) => x && x.id === body.id);
      if (idx < 0) return sendJson(res, 404, { error: '举报不存在' });
      if (reports[idx].handled) return sendJson(res, 409, { error: '该举报已处理' });

      /* 数据面定点改(锁内读最新,处置不动举报内容以外的字段) */
      if (action === 'name-reset' || action === 'avatar-clear') {
        const workspace = (await read(DATA_KEY)) || { tournaments: [], series: [], players: [], activeId: null };
        const players = Array.isArray(workspace.players) ? workspace.players : [];
        const player = players.find((p) => p && p.id === playerId);
        if (!player) return sendJson(res, 404, { error: '选手不存在:' + playerId });
        if (action === 'name-reset') {
          const next = resetNameFor(playerId);
          player.name = next;
          player.updatedAt = now();
          /* 同步所有绑该选手的账号昵称(users 读改写同锁) */
          const users = (await read(USERS_KEY)) || [];
          let touched = false;
          for (const u of users) {
            if (u && String(u.playerId) === playerId && u.nickname !== next) {
              u.nickname = next;
              touched = true;
            }
          }
          if (touched) {
            await backupJson(USERS_KEY, 'users');
            await write(USERS_KEY, users);
          }
        } else {
          player.avatar = null;
          player.tagImg = null;
          player.tagImgRatio = null;
          player.tagImgSize = null;
          player.updatedAt = now();
        }
        await backupData();
        await write(DATA_KEY, workspace);
      }

      reports[idx].handled = { action, by: maskUser(user.username), at: new Date(now()).toISOString() };
      await backupJson(REPORTS_KEY, 'reports');
      await write(REPORTS_KEY, reports);
      if (action === 'dismiss') {
        audit('report.handle', 'id=' + reports[idx].id + ' action=dismiss by=' + maskUser(user.username));
      } else {
        audit('mod.' + action, 'id=' + reports[idx].id + ' player=' + playerId + ' by=' + maskUser(user.username));
      }
      sendJson(res, 200, { ok: true, report: reports[idx] });
    });
  }

  return async function handler(req, res) {
    if (req.method === 'POST') return create(req, res);
    if (req.method === 'GET') return list(req, res);
    if (req.method === 'PUT') return update(req, res);
    sendJson(res, 405, { error: 'Method Not Allowed' });
  };
}

const handler = createHandler();
module.exports = handler;
module.exports.createHandler = createHandler;
module.exports.resetNameFor = resetNameFor;
