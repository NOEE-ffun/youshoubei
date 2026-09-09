'use strict';

/* POST /api/admin/decks/preview:禁卡表录入辅助端点(只解析不落库)。
 * 鉴权/审计/注入范式与 test/admin-api.test.js 一致;resolveDeck 注入假实现不出网。 */
const assert = require('node:assert');
const session = require('../api/session');
const devStore = require('../api/dev-store');
const apiAdmin = require('../api/admin');

function memoryStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return { readJson: async (k) => (map.has(k) ? map.get(k) : null), writeJson: async (k, v) => { map.set(k, v); }, _map: map };
}
function mockReq(method, opts) {
  const o = opts || {};
  const chunks = o.body === undefined ? [] : [Buffer.from(o.body, 'utf-8')];
  return { method, url: o.url || '/api/x', headers: o.headers || {}, socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]() { let i = 0; return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }) }; } };
}
function mockRes() {
  const c = { status: 0, headers: {}, body: null };
  return { status(code) { c.status = code; return this; }, cacheControl() { return this; },
    setHeader(n, v) { c.headers[n] = v; return this; }, json(p) { c.body = p; return this; }, _captured: c };
}
async function call(handler, req) { const res = mockRes(); await handler(req, res); return res._captured; }

const FAKE_DECK = { v: 1, resolvedAt: 1, classId: 2, format: null,
  cards: [[501, '禁卡A', 2, 3, 0, 3], [502, '限卡B', 3, 2, 0, 1]] };

(async () => {
  process.env.SESSION_SECRET = 'test-secret';
  await devStore.writeJson('users.json', [
    { id: 'u1', username: 'root', usernameLower: 'root', phone: '13800000000', passHash: null, role: 'super', playerId: null, status: 'active', createdAt: 't1' },
    { id: 'u2', username: 'boss', usernameLower: 'boss', phone: '13900000002', passHash: null, role: 'admin', playerId: null, status: 'active', createdAt: 't2' },
    { id: 'u3', username: 'p1', usernameLower: 'p1', phone: '13900000003', passHash: null, role: 'player', playerId: 'p1', status: 'active', createdAt: 't3' }
  ]);
  await devStore.writeJson('data.json', { tournaments: [], series: [], players: [], activeId: null });

  const audits = [];
  let failNext = false;
  const handler = apiAdmin.createHandlers({
    storage: memoryStorage(),
    appendAudit: (a, d) => audits.push(a + ' ' + d),
    resolveDeck: async () => (failNext ? { ok: false, reason: 'bad-shape' } : { ok: true, deck: FAKE_DECK })
  });
  const ck = (uid) => 'sess=' + session.issueFor(uid, '');
  const post = (uid, q) => call(handler, mockReq('POST', { url: '/api/admin/decks/preview',
    headers: { cookie: ck(uid), 'content-type': 'application/json' }, body: JSON.stringify({ q }) }));

  let r = await post('u2', 'https://shadowverse-wb.com/chs/deck/detail/?hash=1.2.aaa');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.deepStrictEqual(r.body.deck, FAKE_DECK);
  assert.ok(audits.some((line) => line.startsWith('admin.deckPreview') && line.includes('by=boss')));
  r = await post('u1', '1.2.aaa.bbb');
  assert.strictEqual(r.status, 200);
  /* 权限:player 403;匿名 401;GET 405 */
  assert.strictEqual((await post('u3', '1.2.aaa')).status, 403);
  assert.strictEqual((await call(handler, mockReq('POST', { url: '/api/admin/decks/preview',
    headers: { 'content-type': 'application/json' }, body: '{"q":"1.2.aaa"}' }))).status, 401);
  assert.strictEqual((await call(handler, mockReq('GET', { url: '/api/admin/decks/preview', headers: { cookie: ck('u1') } }))).status, 405);
  /* 非法输入 400;解析失败 502 */
  assert.strictEqual((await post('u2', 'not a deck at all https://x.com')).status, 400);
  failNext = true;
  r = await post('u2', '1.2.aaa.bbb');
  assert.strictEqual(r.status, 502);
  assert.ok(String(r.body.error).includes('解析失败'));

  console.log('banlist-preview tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
