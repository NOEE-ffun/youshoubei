'use strict';

/* 报名接口行为测试(内存存储注入,不联网):
 * join/leave 走通与幂等、开关 423、已上场退报 409、名单保留、updatedAt bump、审计。 */

const assert = require('node:assert');
const session = require('../api/session');
const { createHandler, isSignupOpen, signupPlayers } = require('../api/signup');

function memoryStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    readJson: async (key) => (map.has(key) ? JSON.parse(JSON.stringify(map.get(key))) : null),
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
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }) };
    }
  };
}

function mockRes() {
  const captured = { status: 0, headers: {}, body: null };
  return {
    status(code) { captured.status = code; return this; },
    cacheControl() { return this; },
    setHeader(n, v) { captured.headers[n] = v; return this; },
    json(p) { captured.body = p; return captured; },
    _captured: captured
  };
}

async function call(handler, req) {
  const res = mockRes();
  await handler(req, res);
  return res._captured;
}

const json = (obj) => JSON.stringify(obj);
const P1 = 'p_1';

function seedWorld(signup) {
  return {
    'users.json': [{
      id: 'u1', username: 'alice', usernameLower: 'alice',
      passHash: 'scrypt:00112233445566778899aabb', role: 'player', playerId: P1, createdAt: '2026-01-01T00:00:00Z'
    }],
    'data.json': {
      activeId: 't1',
      players: [{ id: P1, name: '甲' }, { id: 'p_2', name: '乙' }],
      tournaments: [
        {
          id: 't1', name: '开放届', roster: [], canvas: { cards: [] }, scores: {},
          signup: signup || undefined, updatedAt: 1
        },
        {
          id: 't2', name: '上场届', canvas: { cards: [{ id: 'c1', slots: [{ type: 'player', playerId: P1 }, { type: 'empty' }] }] },
          scores: {}, signup: { open: true, players: [P1] }, updatedAt: 1
        }
      ]
    }
  };
}

function makeFindUser(storage) {
  const users = storage._map.get('users.json');
  return async (req) => {
    const payload = session.sessionOf(req);
    const u = users.find((x) => x.id === (payload && payload.uid));
    return (u && payload.pv === u.passHash.slice(-8)) ? u : null;
  };
}

async function main() {
  process.env.SESSION_SECRET = 'test-secret';
  const cookie = 'sess=' + session.issueFor('u1', 'scrypt:00112233445566778899aabb'.slice(-8), Date.now);
  const auth = { cookie };

  /* 纯函数 */
  assert.strictEqual(isSignupOpen({ signup: { open: true, players: [] } }), true, '开');
  assert.strictEqual(isSignupOpen({ signup: { open: false, players: [] } }), false, '关');
  assert.strictEqual(isSignupOpen({}), false, '无键恒关');
  assert.deepStrictEqual(signupPlayers({ signup: { open: true, players: [P1, 'x', 3] } }), [P1, 'x'], 'players 归一');
  console.log('✓ 纯函数:开关/名单归一');

  const audits = [];
  {
    const storage = memoryStorage(seedWorld({ open: true, players: ['p_2'] }));
    const h = createHandler(storage, { appendAudit: (a, d) => audits.push(a + ' ' + d), currentUser: makeFindUser(storage) });

    const join = await call(h.signup, mockReq('PUT', { headers: auth, body: json({ tournamentId: 't1', action: 'join' }) }));
    assert.strictEqual(join.status, 200, '报名 200');
    assert.strictEqual(join.body.players, 2, '人数含既有 1 人');
    const rec = storage._map.get('data.json').tournaments[0];
    assert.ok(rec.signup.players.includes(P1), '名单入档');
    assert.ok(rec.updatedAt > 1, 'bump updatedAt');
    assert.ok(audits.some((a) => a.startsWith('signup.join')), '审计 join');

    const again = await call(h.signup, mockReq('PUT', { headers: auth, body: json({ tournamentId: 't1', action: 'join' }) }));
    assert.strictEqual(again.status, 200, '重复报名幂等');
    assert.strictEqual(again.body.players, 2, '人数不变');

    const leave = await call(h.signup, mockReq('PUT', { headers: auth, body: json({ tournamentId: 't1', action: 'leave' }) }));
    assert.strictEqual(leave.status, 200, '退报 200');
    assert.strictEqual(leave.body.players, 1, '人数回落');
    assert.ok(audits.some((a) => a.startsWith('signup.leave')), '审计 leave');

    const leaveAgain = await call(h.signup, mockReq('PUT', { headers: auth, body: json({ tournamentId: 't1', action: 'leave' }) }));
    assert.strictEqual(leaveAgain.status, 200, '重复退报幂等');

    const noLogin = await call(h.signup, mockReq('PUT', { body: json({ tournamentId: 't1', action: 'join' }) }));
    assert.strictEqual(noLogin.status, 401, '未登录 401');

    const notFound = await call(h.signup, mockReq('PUT', { headers: auth, body: json({ tournamentId: 't9', action: 'join' }) }));
    assert.strictEqual(notFound.status, 404, '届不存在 404');
    console.log('✓ join/leave:走通/幂等/未登录/404');
  }

  {
    /* 关窗 423;开关切换不清名单 */
    const storage = memoryStorage(seedWorld({ open: false, players: [P1] }));
    const h = createHandler(storage, { currentUser: makeFindUser(storage) });
    const closed = await call(h.signup, mockReq('PUT', { headers: auth, body: json({ tournamentId: 't1', action: 'leave' }) }));
    assert.strictEqual(closed.status, 423, '关窗连退报都 423');
    assert.deepStrictEqual(storage._map.get('data.json').tournaments[0].signup.players, [P1], '名单保留');
  }

  {
    /* 已上场退报 409;已上场重复 join 幂等 200 */
    const storage = memoryStorage(seedWorld());
    const h = createHandler(storage, { currentUser: makeFindUser(storage) });
    const leave = await call(h.signup, mockReq('PUT', { headers: auth, body: json({ tournamentId: 't2', action: 'leave' }) }));
    assert.strictEqual(leave.status, 409, '已上场退报 409');
    const join = await call(h.signup, mockReq('PUT', { headers: auth, body: json({ tournamentId: 't2', action: 'join' }) }));
    assert.strictEqual(join.status, 200, '已上场 join 幂等');
  }
  console.log('✓ 关窗保留名单/上场锁定');

  delete process.env.SESSION_SECRET;
  console.log('signup-api 全部通过');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
