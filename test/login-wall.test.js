'use strict';

/* 登录墙+角色门:data/upload/poster-stage 在新鉴权下的行为。
 * 数据面 handler(data/upload)与 requireUser→account 均为模块级单例,
 * 存储走共享 dev-store:users.json/data.json 种子直接写 dev-store;
 * poster-stage 无存储注入点的模块单例,用其 createHandler 工厂注入内存存储。
 * 会话用真实签发(种子账号 passHash 为 null,pv 为空串)。 */

const assert = require('node:assert');
const session = require('../api/session');
const apiData = require('../api/data');
const apiUpload = require('../api/upload');
const apiPosterStage = require('../api/poster-stage');
const devStore = require('../api/dev-store');
const { effectiveRole } = require('../api/rbac');

/* 本文件断言「配置好的服务器」的墙语义;设 E2E 压墙开关使 data.js 不触发
 * 本地开发免墙分支(纯本地进程=无 OSS 且无此开关时匿名放行,见文件末尾专项断言) */
process.env.YOUSHOUBEI_ENFORCE_WALL = process.env.YOUSHOUBEI_ENFORCE_WALL || '1';

function memoryStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    readJson: async (key) => (map.has(key) ? map.get(key) : null),
    writeJson: async (key, value) => { map.set(key, value); },
    _map: map
  };
}

function mockReq(method, opts) {
  const o = opts || {};
  const chunks = o.body === undefined ? [] : [Buffer.from(o.body, 'utf8')];
  return {
    method,
    url: o.url || '/api/x',
    headers: o.headers || {},
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true })
      };
    }
  };
}

function mockRes() {
  const captured = { status: 0, headers: {}, body: null };
  return {
    status(code) { captured.status = code; return this; },
    cacheControl() { return this; },
    setHeader(name, value) { captured.headers[name] = value; return this; },
    json(payload) { captured.body = payload; return captured; },
    _captured: captured
  };
}

async function call(handler, req) {
  const res = mockRes();
  await handler(req, res);
  return res._captured;
}

(async () => {
  process.env.SESSION_SECRET = 'test-secret';

  const users = [
    { id: 'u1', username: 'guest1', usernameLower: 'guest1', phone: '13900000001', passHash: null, role: 'user', playerId: null, status: 'active', createdAt: 't' },
    { id: 'u2', username: 'player1', usernameLower: 'player1', phone: '13900000002', passHash: null, role: 'player', playerId: 'p1', status: 'active', createdAt: 't' },
    { id: 'u3', username: 'admin1', usernameLower: 'admin1', phone: '13900000003', passHash: null, role: 'admin', playerId: null, status: 'active', createdAt: 't' },
    { id: 'u4', username: 'banned1', usernameLower: 'banned1', phone: '13900000004', passHash: null, role: 'player', playerId: 'p2', status: 'banned', createdAt: 't' }
  ];
  /* 种子落全局 dev-store:data/upload 单例与 requireUser→account 单例都读这里 */
  await devStore.writeJson('users.json', users);
  await devStore.writeJson('data.json', { tournaments: [], players: [{ id: 'p1', name: '选手一' }], activeId: null });

  /* 会话真实签发:pv 空串与种子账号 passHash(null) 的 pvOf 一致 */
  const ck = (uid) => 'sess=' + session.issueFor(uid, '');

  /* poster-stage:工厂注入内存存储;门(requireUser/requireRole)仍走全局 account */
  const stageId = 'a'.repeat(32);
  const stage = apiPosterStage.createHandler(memoryStorage({
    ['poster-stages/' + stageId + '.json']: { data: { matchName: '测试' }, themeId: 'x', createdAt: new Date().toISOString() }
  }));
  const stageGet = (cookie) => mockReq('GET', { url: '/api/poster-stage?id=' + stageId, headers: cookie ? { cookie } : {} });
  const stageBody = JSON.stringify({ data: { left: { name: '甲' }, right: { name: '乙' } }, themeId: 'x' });

  /* GET /api/data:匿名 401;user 200;admin 200;banned 401 */
  assert.strictEqual((await call(apiData, mockReq('GET'))).status, 401);
  assert.strictEqual((await call(apiData, mockReq('GET', { headers: { cookie: ck('u1') } }))).status, 200);
  assert.strictEqual((await call(apiData, mockReq('GET', { headers: { cookie: ck('u3') } }))).status, 200);
  assert.strictEqual((await call(apiData, mockReq('GET', { headers: { cookie: ck('u4') } }))).status, 401);

  /* PUT /api/data:user 403;player 403;admin 200;匿名 401;旧 Bearer 口令彻底无效 */
  const putBody = JSON.stringify({ tournaments: [], players: [], activeId: null });
  assert.strictEqual((await call(apiData, mockReq('PUT', { body: putBody, headers: { cookie: ck('u1') } }))).status, 403);
  assert.strictEqual((await call(apiData, mockReq('PUT', { body: putBody, headers: { cookie: ck('u2') } }))).status, 403);
  assert.strictEqual((await call(apiData, mockReq('PUT', { body: putBody, headers: { cookie: ck('u3') } }))).status, 200);
  assert.strictEqual((await call(apiData, mockReq('PUT', { body: putBody }))).status, 401);
  assert.strictEqual((await call(apiData, mockReq('PUT', { body: putBody, headers: { authorization: 'Bearer anything' } }))).status, 401);

  /* upload:匿名 401;user 403;player/admin 过门后由 415(非法图片)兜底——非 401 即已过门 */
  const upReq = (cookie) => mockReq('POST', { body: 'x', headers: cookie ? { cookie } : {} });
  assert.strictEqual((await call(apiUpload, upReq(null))).status, 401);
  assert.strictEqual((await call(apiUpload, upReq(ck('u1')))).status, 403);
  assert.notStrictEqual((await call(apiUpload, upReq(ck('u2')))).status, 401);
  assert.notStrictEqual((await call(apiUpload, upReq(ck('u3')))).status, 401);

  /* poster-stage:GET 匿名 401/登录 200;POST 匿名 401、player 403、admin 200 */
  assert.strictEqual((await call(stage, stageGet(null))).status, 401);
  assert.strictEqual((await call(stage, stageGet(ck('u1')))).status, 200);
  assert.strictEqual((await call(stage, mockReq('POST', { body: stageBody }))).status, 401);
  assert.strictEqual((await call(stage, mockReq('POST', { body: stageBody, headers: { cookie: ck('u2') } }))).status, 403);
  assert.strictEqual((await call(stage, mockReq('POST', { body: stageBody, headers: { cookie: ck('u3') } }))).status, 200);

  /* rbac env 升格:u1 在 SUPER_ADMIN_PHONES 里 → PUT data 200 */
  process.env.SUPER_ADMIN_PHONES = '13900000001';
  try {
    assert.strictEqual(effectiveRole(users[0]), 'super');
    assert.strictEqual((await call(apiData, mockReq('PUT', { body: putBody, headers: { cookie: ck('u1') } }))).status, 200);
  } finally { delete process.env.SUPER_ADMIN_PHONES; }

  /* 归属守卫(集成):预置"他人届"(createdBy=u9)。
   * admin(u3)改名他人届且伪造 createdBy → 403 且不落盘;
   * 同 body 同会话,env 升格 super → 200,落盘的 createdBy 是回填的存档值非伪造值 */
  await devStore.writeJson('data.json', {
    tournaments: [{ id: 't1', name: '他人届', createdBy: 'u9' }],
    series: [],
    players: [],
    activeId: 't1'
  });
  const forgeBody = JSON.stringify({
    tournaments: [{ id: 't1', name: '改名届', createdBy: 'u3' }],
    series: [],
    players: [],
    activeId: 't1'
  });
  assert.strictEqual((await call(apiData, mockReq('PUT', { body: forgeBody, headers: { cookie: ck('u3') } }))).status, 403);
  assert.strictEqual((await devStore.readJson('data.json')).tournaments[0].name, '他人届', '403 时不得落盘');
  process.env.SUPER_ADMIN_PHONES = '13900000003';
  try {
    assert.strictEqual((await call(apiData, mockReq('PUT', { body: forgeBody, headers: { cookie: ck('u3') } }))).status, 200);
    const stored = await devStore.readJson('data.json');
    assert.strictEqual(stored.tournaments[0].name, '改名届');
    assert.strictEqual(stored.tournaments[0].createdBy, 'u9', 'createdBy 必须回填存档值,客户端伪造无效');
  } finally { delete process.env.SUPER_ADMIN_PHONES; }

  /* 本地开发免墙专项(2026-08-31):去掉压墙开关后,纯本地进程(无 OSS)
   * 对匿名放行——空存储返回 500「OSS 配置不完整」而非墙的 401,
   * 前端据此落本地模式并合成超管(本地超管模式) */
  {
    const savedWall = process.env.YOUSHOUBEI_ENFORCE_WALL;
    delete process.env.YOUSHOUBEI_ENFORCE_WALL;
    try {
      await devStore.writeJson('data.json', null);
      const r = await call(apiData, mockReq('GET'));
      assert.strictEqual(r.status, 500, '免墙放行后应走到空存储 500,而非登录墙 401');
      assert.match(r.body.error, /OSS 配置不完整/);
    } finally {
      process.env.YOUSHOUBEI_ENFORCE_WALL = savedWall;
    }
  }

  delete process.env.SESSION_SECRET;
  console.log('✓ login-wall: 数据面登录墙+角色门断言通过');
})().catch((e) => { console.error(e); process.exit(1); });
