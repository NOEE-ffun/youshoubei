'use strict';

const crypto = require('node:crypto');
const { requireRole } = require('./auth');
const { sendJson, readBody } = require('./helpers');
const { readJsonCached, writeJson, appendAudit } = require('./oss');

/* OBS 舞台(浏览器源)实时接口(2026-09-07 实时化)：
 *   POST → admin/super 创建新舞台,返回自包含 URL(/poster-stage.html?id=…)
 *   PUT  → admin/super 按 id 全量覆写并续命(updatedAt;过期舞台复活同 id)
 *   GET  → 匿名放行,链接即凭证(128 位随机 hex);过期/缺失 404;
 *          private,no-cache + etag() 供舞台页 5s 轮询(304 省流量)
 * 舞台存私有 OSS 对象 poster-stages/<id>.json;TTL=7 天无推送(可 env 覆盖),
 * 仅拦公共读——属主 PUT 即复活,URL 对操作员终身稳定。 */
const STAGE_KEY_PREFIX = 'poster-stages/';

/* 舞台 payload 可能携带选手头像/队标 dataURL（≤512px 压缩），
 * 3MB 上限兼顾体积与防滥用。 */
const MAX_BODY = 3 * 1024 * 1024;

const ID_RE = /^[0-9a-f]{32}$/;

function stageKey(id) {
  return STAGE_KEY_PREFIX + id + '.json';
}

/* 默认过期天数，可用 POSTER_STAGE_TTL_DAYS 覆盖；非法/非正数回退 7 */
function defaultTtlDays() {
  const raw = Number(process.env.POSTER_STAGE_TTL_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 7;
}

/* createdAt 为 ISO 字符串；超 TTL 即视为过期。 */
function isExpired(createdAt, nowMs, ttlDays) {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return true;
  return nowMs - created > ttlDays * 24 * 60 * 60 * 1000;
}

/* 校验 POST 请求体:合法结构为 { data, themeId },
 * data 即海报页 VSState.data,themeId 为主题 id(可缺省)。返回 null 表示合法,否则返回错误文案。 */
function validatePosterStagePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return '请求体必须是 JSON 对象';
  }
  if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
    return 'data 字段缺失或格式不正确';
  }
  if (typeof body.data.left !== 'object' || body.data.left === null) {
    return 'data.left 必须是选手对象';
  }
  if (typeof body.data.right !== 'object' || body.data.right === null) {
    return 'data.right 必须是选手对象';
  }
  if (body.themeId !== undefined && (typeof body.themeId !== 'string' || body.themeId.length === 0)) {
    return 'themeId 必须是非空字符串';
  }
  return null;
}

/* 存储层依赖注入：默认用 OSS；测试可传入内存实现。 */
function createHandler(storage, options) {
  const o = options || {};
  const read = (storage && storage.readJson) || readJsonCached;
  const write = (storage && storage.writeJson) || writeJson;
  const ttlDays = typeof o.ttlDays === 'number' ? o.ttlDays : defaultTtlDays();
  const now = typeof o.now === 'function' ? o.now : Date.now;

  return async function handler(req, res) {
    if (req.method === 'GET') {
      /* 匿名放行:32hex id 即唯一凭证(能力 URL),写接口(POST/PUT)仍需 admin/super */
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        sendJson(res, 400, { error: '非法请求地址' });
        return;
      }
      const id = url.searchParams.get('id') || '';
      if (!ID_RE.test(id)) {
        sendJson(res, 400, { error: 'id 必须是 32 位十六进制字符串' });
        return;
      }

      try {
        const stage = await read(stageKey(id));
        if (!stage || !stage.data) {
          sendJson(res, 404, { error: '舞台不存在' });
          return;
        }
        if (isExpired(stage.updatedAt || stage.createdAt, now(), ttlDays)) {
          sendJson(res, 404, { error: '舞台已过期' });
          return;
        }
        /* 能力 URL:private 防共享缓存存储,no-cache 每次回源校验;etag() 让
         * 轮询 If-None-Match 命中时 304(由 server.js apiResponse 判定) */
        res.cacheControl('private, no-cache').etag().status(200).json({
          data: stage.data,
          themeId: stage.themeId || null
        });
      } catch (error) {
        console.error('[poster-stage] GET 失败:', error.message);
        sendJson(res, 500, { error: '读取舞台失败' });
      }
      return;
    }

    if (req.method === 'PUT') {
      if (!(await requireRole(req, res, ['admin', 'super']))) return;

      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        sendJson(res, 400, { error: '非法请求地址' });
        return;
      }
      const id = url.searchParams.get('id') || '';
      if (!ID_RE.test(id)) {
        sendJson(res, 400, { error: 'id 必须是 32 位十六进制字符串' });
        return;
      }

      const body = await readBody(req, MAX_BODY);
      if (body === null) {
        sendJson(res, 413, { error: '数据过大' });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch (error) {
        sendJson(res, 400, { error: '请求体不是合法 JSON' });
        return;
      }

      const invalid = validatePosterStagePayload(payload);
      if (invalid) {
        sendJson(res, 400, { error: invalid });
        return;
      }

      try {
        const existing = await read(stageKey(id));
        if (!existing || !existing.data) {
          sendJson(res, 404, { error: '舞台不存在' });
          return;
        }
        /* 过期舞台复活:updatedAt 续命 TTL,URL 对操作员终身稳定;
         * 不写审计——编辑期防抖高频 PUT 会刷爆审计日志,创建(POST)仍留痕 */
        await write(stageKey(id), {
          data: payload.data,
          themeId: payload.themeId || null,
          createdAt: existing.createdAt || new Date(now()).toISOString(),
          updatedAt: new Date(now()).toISOString()
        });
        sendJson(res, 200, { ok: true });
      } catch (error) {
        console.error('[poster-stage] PUT 失败:', error.message);
        sendJson(res, 500, { error: '保存舞台失败' });
      }
      return;
    }

    if (req.method === 'POST') {
      if (!(await requireRole(req, res, ['admin', 'super']))) return;

      const body = await readBody(req, MAX_BODY);
      if (body === null) {
        sendJson(res, 413, { error: '数据过大' });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch (error) {
        sendJson(res, 400, { error: '请求体不是合法 JSON' });
        return;
      }

      const invalid = validatePosterStagePayload(payload);
      if (invalid) {
        sendJson(res, 400, { error: invalid });
        return;
      }

      const id = crypto.randomBytes(16).toString('hex');
      const stage = {
        data: payload.data,
        themeId: payload.themeId || null,
        createdAt: new Date(now()).toISOString()
      };
      try {
        await write(stageKey(id), stage);
        appendAudit('poster-stage.post', (payload.data && payload.data.matchName || '未命名') + ' → ' + id);
        sendJson(res, 200, { id, url: '/poster-stage.html?id=' + id });
      } catch (error) {
        console.error('[poster-stage] POST 失败:', error.message);
        sendJson(res, 500, { error: '保存舞台失败' });
      }
      return;
    }

    sendJson(res, 405, { error: 'Method Not Allowed' });
  };
}

const handler = createHandler();
handler.createHandler = createHandler;
handler.validatePosterStagePayload = validatePosterStagePayload;
handler.isExpired = isExpired;
handler.defaultTtlDays = defaultTtlDays;
handler.stageKey = stageKey;
handler.STAGE_KEY_PREFIX = STAGE_KEY_PREFIX;

module.exports = handler;
