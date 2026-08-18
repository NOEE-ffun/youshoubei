'use strict';

/* /api/poster-stage 一次性舞台接口行为测试（内存存储注入，不联网）：
 * 鉴权门禁、payload 校验、创建-读取往返、过期逻辑、Cache-Control 指令。 */

const assert = require('node:assert');
const { isAuthorized } = require('../api/auth');
const {
  createHandler,
  validatePosterStagePayload,
  isExpired,
  defaultTtlDays,
  stageKey
} = require('../api/poster-stage');

const DAY_MS = 24 * 60 * 60 * 1000;

/* 内存存储，模拟 api/oss.js 的 readJson/writeJson（含 JSON null 语义） */
function memoryStorage() {
  const map = new Map();
  return {
    readJson: async (key) => (map.has(key) ? map.get(key) : null),
    writeJson: async (key, value) => { map.set(key, value); },
    _map: map
  };
}

/* 模拟 http.IncomingMessage（可异步迭代，与 handler 的 for await 兼容） */
function mockReq(method, opts) {
  const o = opts || {};
  const chunks = o.body === undefined ? [] : [Buffer.from(o.body, 'utf8')];
  return {
    method,
    url: o.url || '/api/poster-stage',
    headers: o.headers || {},
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => (i < chunks.length
          ? { value: chunks[i++], done: false }
          : { done: true })
      };
    }
  };
}

/* 模拟 res（server.js apiResponse 的最小适配：status().cacheControl().json()） */
function mockRes() {
  const captured = { status: 0, cacheControl: null, body: null };
  return {
    status(code) { captured.status = code; return this; },
    cacheControl(value) { captured.cacheControl = value; return this; },
    json(payload) { captured.body = payload; return captured; },
    _captured: captured
  };
}

async function call(handler, req) {
  const res = mockRes();
  await handler(req, res);
  return res._captured;
}

const VALID = {
  data: {
    matchName: '总决赛',
    left: { name: '烈焰', color: '#ff0000' },
    right: { name: '冰霜' }
  },
  themeId: 'ice-fire'
};

const ID_32 = 'a'.repeat(32);

async function main() {
  /* ---- validatePosterStagePayload 纯函数 ---- */
  assert.strictEqual(validatePosterStagePayload(VALID), null);
  assert.strictEqual(validatePosterStagePayload(null), '请求体必须是 JSON 对象');
  assert.strictEqual(validatePosterStagePayload([]), '请求体必须是 JSON 对象');
  assert.strictEqual(validatePosterStagePayload({}), 'data 字段缺失或格式不正确');
  assert.strictEqual(validatePosterStagePayload({ data: null }), 'data 字段缺失或格式不正确');
  assert.strictEqual(
    validatePosterStagePayload({ data: { left: {}, right: {} }, themeId: '' }),
    'themeId 必须是非空字符串'
  );
  assert.strictEqual(validatePosterStagePayload({ data: { left: null, right: {} } }), 'data.left 必须是选手对象');
  assert.strictEqual(validatePosterStagePayload({ data: { left: {}, right: null } }), 'data.right 必须是选手对象');

  /* ---- 过期/TTL 纯函数 ---- */
  const now = Date.UTC(2026, 7, 20, 12, 0, 0);
  assert.strictEqual(isExpired(new Date(now - 8 * DAY_MS).toISOString(), now, 7), true, '8 天前应过期');
  assert.strictEqual(isExpired(new Date(now - 7 * DAY_MS).toISOString(), now, 7), false, '恰好 7 天未过期');
  assert.strictEqual(isExpired(new Date(now - 1 * DAY_MS).toISOString(), now, 7), false);
  assert.strictEqual(isExpired('not-a-date', now, 7), true, '非法 createdAt 视为过期');
  assert.strictEqual(defaultTtlDays(), 7, '未配置 TTL 默认 7 天');
  process.env.POSTER_STAGE_TTL_DAYS = '3';
  assert.strictEqual(defaultTtlDays(), 3, '读环境变量 TTL');
  process.env.POSTER_STAGE_TTL_DAYS = 'bad';
  assert.strictEqual(defaultTtlDays(), 7, '非法 TTL 回退 7');
  delete process.env.POSTER_STAGE_TTL_DAYS;

  /* ---- 鉴权门禁 ---- */
  delete process.env.ADMIN_TOKEN;
  const storage = memoryStorage();
  const handler = createHandler(storage);

  let out = await call(handler, mockReq('POST', { body: JSON.stringify(VALID) }));
  assert.strictEqual(out.status, 403, '未配置 ADMIN_TOKEN 应 403');

  process.env.ADMIN_TOKEN = 'secret-token';
  out = await call(handler, mockReq('POST', { body: JSON.stringify(VALID) }));
  assert.strictEqual(out.status, 401, '缺口令应 401');

  out = await call(handler, mockReq('POST', { headers: { authorization: 'Bearer wrong' }, body: JSON.stringify(VALID) }));
  assert.strictEqual(out.status, 401, '错误口令应 401');

  /* ---- 创建-读取往返 ---- */
  out = await call(handler, mockReq('POST', { headers: { authorization: 'Bearer secret-token' }, body: JSON.stringify(VALID) }));
  assert.strictEqual(out.status, 200);
  assert.match(out.body.id, /^[0-9a-f]{32}$/, 'id 应为 32 位十六进制');
  assert.strictEqual(out.body.url, '/poster-stage.html?id=' + out.body.id);

  const id = out.body.id;
  assert.ok(storage._map.has(stageKey(id)), '应写入 poster-stages/<id>.json');
  const stored = storage._map.get(stageKey(id));
  assert.strictEqual(stored.data.matchName, '总决赛');
  assert.strictEqual(stored.themeId, 'ice-fire');
  assert.ok(stored.createdAt, '应记录 createdAt');

  out = await call(handler, mockReq('GET', { url: '/api/poster-stage?id=' + id }));
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(out.body, { data: VALID.data, themeId: 'ice-fire' });
  assert.strictEqual(out.cacheControl, 'public, max-age=300', 'GET 应公开缓存 300s');

  /* ---- GET 参数校验 ---- */
  out = await call(handler, mockReq('GET'));
  assert.strictEqual(out.status, 400, '缺 id 应 400');
  out = await call(handler, mockReq('GET', { url: '/api/poster-stage?id=xyz' }));
  assert.strictEqual(out.status, 400, '非 32hex id 应 400');
  out = await call(handler, mockReq('GET', { url: '/api/poster-stage?id=' + 'b'.repeat(32) }));
  assert.strictEqual(out.status, 404, '格式合法但不存在应 404');

  /* ---- 过期逻辑（注入固定时钟与 TTL） ---- */
  const fixedNow = Date.UTC(2026, 7, 20, 12, 0, 0);
  const fresh = 'c'.repeat(32);
  const expired = 'd'.repeat(32);
  const expStorage = memoryStorage();
  const expHandler = createHandler(expStorage, { ttlDays: 7, now: () => fixedNow });
  // 直接写入两个已知 id 的舞台（一个 1 天前、一个 8 天前）
  await expStorage.writeJson(stageKey(fresh), { data: VALID.data, themeId: 'ice-fire', createdAt: new Date(fixedNow - 1 * DAY_MS).toISOString() });
  await expStorage.writeJson(stageKey(expired), { data: VALID.data, themeId: 'ice-fire', createdAt: new Date(fixedNow - 8 * DAY_MS).toISOString() });

  out = await call(expHandler, mockReq('GET', { url: '/api/poster-stage?id=' + fresh }));
  assert.strictEqual(out.status, 200, '1 天前创建的舞台未过期');
  out = await call(expHandler, mockReq('GET', { url: '/api/poster-stage?id=' + expired }));
  assert.strictEqual(out.status, 404, '8 天前创建的舞台应 404');

  /* ---- 未支持方法 405 ---- */
  out = await call(handler, mockReq('PUT'));
  assert.strictEqual(out.status, 405);
  out = await call(handler, mockReq('DELETE'));
  assert.strictEqual(out.status, 405);

  /* ---- isAuthorized 三态 ---- */
  delete process.env.ADMIN_TOKEN;
  assert.strictEqual(isAuthorized(mockReq('GET')), null, '未配置应返回 null');
  process.env.ADMIN_TOKEN = 'secret-token';
  assert.strictEqual(isAuthorized(mockReq('GET', { headers: { authorization: 'Bearer secret-token' } })), true);
  assert.strictEqual(isAuthorized(mockReq('GET', { headers: { authorization: 'Bearer nope' } })), false);
  assert.strictEqual(isAuthorized(mockReq('GET')), false);

  console.log('poster-stage-api 全部测试通过 ✓');
}

main().catch((error) => {
  console.error('poster-stage-api 测试失败:', error);
  process.exit(1);
});
