'use strict';

/* 发码中心:鉴权矩阵(admin 发 player 码/super 发 admin 码)、生成格式、幂等列表。
 * codes 用 createHandler(store) 注入内存存储;requireRole 走全局 account 单例,
 * users 种子须落模块级 dev-store(同 login-wall.test.js)。
 * 会话真实签发:passHash null 的 pv 是空串;issueFor 不带第三参 now(防 1970 过期)。 */

const assert = require('node:assert');
const session = require('../api/session');
const codesApi = require('../api/codes');
const devStore = require('../api/dev-store');

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

  const seed = {
    'users.json': [
      { id: 'u2', username: 'p', usernameLower: 'p', phone: '13900000002', passHash: null, role: 'player', playerId: 'p1', status: 'active', createdAt: 't' },
      { id: 'u3', username: 'a', usernameLower: 'a', phone: '13900000003', passHash: null, role: 'admin', playerId: null, status: 'active', createdAt: 't' },
      { id: 'u5', username: 's', usernameLower: 's', phone: '13900000005', passHash: null, role: 'super', playerId: null, status: 'active', createdAt: 't' }
    ],
    'data.json': { tournaments: [], players: [{ id: 'p1', name: '选手一' }], activeId: null },
    'invite-codes.json': []
  };
  /* users 种子落全局 dev-store:requireRole → account 单例从这里读 */
  await devStore.writeJson('users.json', seed['users.json']);

  const store = memoryStorage(seed);
  const handler = codesApi.createHandler(store);
  const ck = (uid) => 'sess=' + session.issueFor(uid, '');

  /* 鉴权:匿名 401、player 403、admin/super 200 */
  assert.strictEqual((await call(handler, mockReq('GET'))).status, 401);
  assert.strictEqual((await call(handler, mockReq('GET', { headers: { cookie: ck('u2') } }))).status, 403);
  assert.strictEqual((await call(handler, mockReq('GET', { headers: { cookie: ck('u3') } }))).status, 200);

  /* admin 发空白 player 码 */
  let r = await call(handler, mockReq('POST', { body: JSON.stringify({ kind: 'player' }), headers: { cookie: ck('u3') } }));
  assert.strictEqual(r.status, 200);
  assert.match(r.body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  /* admin 发 admin 码 → 403 */
  r = await call(handler, mockReq('POST', { body: JSON.stringify({ kind: 'admin' }), headers: { cookie: ck('u3') } }));
  assert.strictEqual(r.status, 403);

  /* super 发 admin 码 OK;绑定码校验 playerId 存在 */
  r = await call(handler, mockReq('POST', { body: JSON.stringify({ kind: 'admin' }), headers: { cookie: ck('u5') } }));
  assert.strictEqual(r.status, 200);
  r = await call(handler, mockReq('POST', { body: JSON.stringify({ kind: 'player', playerId: 'p_no' }), headers: { cookie: ck('u3') } }));
  assert.strictEqual(r.status, 404);
  r = await call(handler, mockReq('POST', { body: JSON.stringify({ kind: 'player', playerId: 'p1' }), headers: { cookie: ck('u3') } }));
  assert.strictEqual(r.status, 200);

  /* 列表带 playerName 与 issuedBy */
  const lst = await call(handler, mockReq('GET', { headers: { cookie: ck('u5') } }));
  assert.strictEqual(lst.body.codes.length, 3);
  assert.strictEqual(lst.body.codes[2].playerName, '选手一');
  assert.strictEqual(lst.body.codes[2].issuedBy, 'u3');

  /* 非GET/POST → 405 */
  assert.strictEqual((await call(handler, mockReq('DELETE', { headers: { cookie: ck('u5') } }))).status, 405);

  delete process.env.SESSION_SECRET;
  console.log('✓ codes-api: 13 断言通过');
})().catch((e) => { console.error(e); process.exit(1); });
