'use strict';

/* 发码中心:鉴权矩阵(admin 发 player 码/super 发 admin 码)、生成格式、幂等列表。
 * codes 用 createHandler(store) 注入内存存储;requireRole 走全局 account 单例,
 * users 种子须落模块级 dev-store(同 login-wall.test.js)。
 * 会话真实签发:passHash null 的 pv 是空串;issueFor 不带第三参 now(防 1970 过期)。
 * 末段并发互斥:create×2 与 redeem 交错(写延迟放大窗口),验核销不复活、新码不丢。 */

const assert = require('node:assert');
const session = require('../api/session');
const codesApi = require('../api/codes');
const account = require('../api/account');
const { createSmsService } = require('../api/sms');
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

  /* ---- 并发互斥:create×2 与 redeem 交错,核销状态不得复活、新码不得丢 ---- */
  {
    /* 独立种子:C0 待兑空白码;u9/u10 两个 user 级账号(redeem 走注入 store 的 account 实例,
     * create 的 requireRole 仍走全局 dev-store——上面已种 u5 super) */
    const seed2 = {
      'users.json': [
        { id: 'u9', username: 'user9', usernameLower: 'user9', phone: '13900000009', passHash: null, role: 'user', playerId: null, status: 'active', createdAt: 't' },
        { id: 'u10', username: 'user10', usernameLower: 'user10', phone: '13900000010', passHash: null, role: 'user', playerId: null, status: 'active', createdAt: 't' }
      ],
      'data.json': { tournaments: [], players: [], activeId: null },
      'invite-codes.json': [
        { code: 'C0', kind: 'player', playerId: null, used: false, usedBy: null, usedAt: null, issuedBy: 'u5', createdAt: 't' }
      ]
    };
    const base = memoryStorage(seed2);
    /* 写延迟 25ms:放大读-改-写窗口,复现生产 OSS 往返下的交错 */
    const store = {
      readJson: base.readJson,
      writeJson: async (key, value) => {
        await new Promise((r) => setTimeout(r, 25));
        base.writeJson(key, value);
      },
      _map: base._map
    };
    const codesH = codesApi.createHandler(store);
    const acc = account.createHandlers(store, {
      sms: createSmsService({ devResolver: () => '000000', sender: async () => ({ ok: true }) })
    });
    const ckk = (uid) => 'sess=' + session.issueFor(uid, '');

    const [rc1, rc2, rr] = await Promise.all([
      call(codesH, mockReq('POST', { body: JSON.stringify({ kind: 'player' }), headers: { cookie: ckk('u5') } })),
      call(codesH, mockReq('POST', { body: JSON.stringify({ kind: 'player' }), headers: { cookie: ckk('u5') } })),
      call(acc.redeem, mockReq('POST', { body: JSON.stringify({ code: 'C0' }), headers: { cookie: ckk('u9') } }))
    ]);
    assert.strictEqual(rc1.status, 200, 'create A 200');
    assert.strictEqual(rc2.status, 200, 'create B 200');
    assert.strictEqual(rr.status, 200, 'redeem 200');

    const codes = store._map.get('invite-codes.json');
    assert.strictEqual(codes.length, 3, '两张新码都不丢(旧快照覆盖会只剩 2)');
    const used = codes.find((c) => c.code === 'C0');
    assert.strictEqual(used.used, true, '已核销码不得被并发 create 的旧快照复活成 used:false');
    assert.strictEqual(used.usedBy, 'user9', '核销人标记保留');
    assert.strictEqual(codes.filter((c) => c.code !== 'C0' && c.used === false).length, 2, '两张新码均在且未用');

    const users = store._map.get('users.json');
    assert.strictEqual(users.filter((u) => u.role === 'player').length, 1, '仅一个账号升格');
    assert.ok(users.find((u) => u.id === 'u9').playerId, '升格者 u9 已绑新选手');

    /* 复活即双消费:若 used 被覆盖回 false,u10 可再兑 C0。锁下必须拒绝 */
    const again = await call(acc.redeem, mockReq('POST', { body: JSON.stringify({ code: 'C0' }), headers: { cookie: ckk('u10') } }));
    assert.strictEqual(again.status, 400, '已核销码二次兑换必须 400(不复活)');
    console.log('✓ 并发互斥:create×2+redeem 交错不复活不丢码');
  }

  delete process.env.SESSION_SECRET;
  console.log('✓ codes-api: 13 断言通过');
})().catch((e) => { console.error(e); process.exit(1); });
