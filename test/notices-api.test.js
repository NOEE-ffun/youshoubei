'use strict';

/* 通知横幅:公共读过滤/字段剥离、超管 CRUD 鉴权矩阵、归一化拒判、
 * 状态派生(pending/expired/disabled/active)、并发互斥(写延迟放大窗口)。
 * 范式同 codes-api.test.js:users 种子落全局 dev-store(requireUser 走全局单例),
 * notices.json 注入内存存储;now 固定注入防时间漂移。 */

const assert = require('node:assert');
const session = require('../api/session');
const noticesApi = require('../api/notices');
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
  const chunks = o.body === undefined ? [] : [Buffer.from(o.body, 'utf-8')];
  return {
    method,
    url: o.url || '/api/notices',
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

  const NOW = Date.parse('2026-09-01T12:00:00Z');
  const auditLog = [];
  const opts = { now: () => NOW, appendAudit: (action, detail) => auditLog.push(action + ' ' + detail) };

  await devStore.writeJson('users.json', [
    { id: 'u2', username: 'p', usernameLower: 'p', phone: '13900000002', passHash: null, role: 'player', playerId: 'p1', status: 'active', createdAt: 't' },
    { id: 'u3', username: 'a', usernameLower: 'a', phone: '13900000003', passHash: null, role: 'admin', playerId: null, status: 'active', createdAt: 't' },
    { id: 'u5', username: 's', usernameLower: 's', phone: '13900000005', passHash: null, role: 'super', playerId: null, status: 'active', createdAt: 't' }
  ]);

  const base = {
    id: 'n0', text: '第一条通知', level: 'info', dismissible: true, enabled: true,
    linkUrl: null, linkText: null, qrImage: null, startAt: null, endAt: null,
    sortOrder: 0, createdBy: 'u5', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z'
  };
  const n = (over) => Object.assign({}, base, over);
  const seed = {
    'notices.json': [
      n({ id: 'n0', text: '第一条通知', sortOrder: 0 }),
      n({ id: 'n1', text: '报名开启', sortOrder: 1, linkUrl: 'https://example.com/join' }),
      n({ id: 'n2', text: '未开始', sortOrder: 2, startAt: '2026-09-02T00:00:00.000Z' }),
      n({ id: 'n3', text: '已过期', sortOrder: 3, endAt: '2026-08-31T00:00:00.000Z' }),
      n({ id: 'n4', text: '已撤下', sortOrder: 4, enabled: false })
    ]
  };

  const store = memoryStorage(seed);
  const pub = noticesApi.createPublicHandler(store, opts);
  const adm = noticesApi.createAdminHandler(store, opts);
  const ck = (uid) => 'sess=' + session.issueFor(uid, '');

  /* ---- 公共读 /api/notices ---- */
  assert.strictEqual((await call(pub, mockReq('GET'))).status, 401, '匿名 401');
  let r = await call(pub, mockReq('GET', { headers: { cookie: ck('u2') } }));
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.notices.map((x) => x.id), ['n0', 'n1'], '只见生效条目且按 sortOrder');
  const item = r.body.notices[1];
  assert.deepStrictEqual(Object.keys(item).sort(),
    ['dismissible', 'id', 'level', 'linkText', 'linkUrl', 'qrImage', 'text'], '公共字段剥离管理元数据');
  assert.strictEqual(item.linkUrl, 'https://example.com/join');
  assert.strictEqual((await call(pub, mockReq('DELETE', { headers: { cookie: ck('u2') } }))).status, 405, '非 GET 405');

  /* ---- 管理列表 GET /api/admin/notices ---- */
  assert.strictEqual((await call(adm, mockReq('GET', { url: '/api/admin/notices', headers: { cookie: ck('u2') } }))).status, 403, 'player 403');
  assert.strictEqual((await call(adm, mockReq('GET', { url: '/api/admin/notices', headers: { cookie: ck('u3') } }))).status, 403, 'admin 403');
  r = await call(adm, mockReq('GET', { url: '/api/admin/notices', headers: { cookie: ck('u5') } }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.notices.length, 5);
  const st = new Map(r.body.notices.map((x) => [x.id, x.status]));
  assert.strictEqual(st.get('n0'), 'active');
  assert.strictEqual(st.get('n2'), 'pending');
  assert.strictEqual(st.get('n3'), 'expired');
  assert.strictEqual(st.get('n4'), 'disabled');

  /* ---- 新建 POST /api/admin/notices ---- */
  r = await call(adm, mockReq('POST', {
    url: '/api/admin/notices',
    body: JSON.stringify({ text: '  新公告  ', linkUrl: 'https://a.b/c' }),
    headers: { cookie: ck('u5') }
  }));
  assert.strictEqual(r.status, 200);
  assert.match(r.body.notice.id, /^n_[0-9a-f]{16}$/, 'id 形态');
  assert.strictEqual(r.body.notice.text, '新公告', 'text trim');
  assert.strictEqual(r.body.notice.level, 'info', 'level 缺省');
  assert.strictEqual(r.body.notice.dismissible, true, 'dismissible 缺省');
  assert.strictEqual(r.body.notice.enabled, true, 'enabled 缺省');
  assert.strictEqual(r.body.notice.sortOrder, 0, 'sortOrder 缺省');
  assert.strictEqual(r.body.notice.linkText, '查看', 'linkText 缺省');
  assert.strictEqual(r.body.notice.createdBy, 'u5');
  assert.ok(auditLog.some((s) => s.startsWith('admin.noticeCreate')), '审计 noticeCreate');

  assert.strictEqual((await call(adm, mockReq('POST', {
    url: '/api/admin/notices', body: JSON.stringify({ text: 'x' }), headers: { cookie: ck('u3') }
  }))).status, 403, 'admin 发通知 403');

  for (const [body, why] of [
    [{}, '空 text'],
    [{ text: 'a'.repeat(121) }, '超 120 字'],
    [{ text: 'x', linkUrl: 'ftp://a.b/' }, '非 http 链接'],
    [{ text: 'x', startAt: 'abc' }, '非法时间'],
    [{ text: 'x', startAt: '2026-09-05T00:00:00Z', endAt: '2026-09-05T00:00:00Z' }, 'endAt<=startAt']
  ]) {
    const rr = await call(adm, mockReq('POST', {
      url: '/api/admin/notices', body: JSON.stringify(body), headers: { cookie: ck('u5') }
    }));
    assert.strictEqual(rr.status, 400, '拒判:' + why);
  }

  /* ---- 编辑 POST /api/admin/notices/:id/update ---- */
  r = await call(adm, mockReq('POST', {
    url: '/api/admin/notices/n0/update',
    body: JSON.stringify({ text: '改', level: 'important', enabled: false }),
    headers: { cookie: ck('u5') }
  }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.notice.createdBy, 'u5', 'createdBy 保留');
  assert.strictEqual(r.body.notice.updatedAt, new Date(NOW).toISOString(), 'updatedAt 刷新');
  const saved0 = store._map.get('notices.json').find((x) => x.id === 'n0');
  assert.strictEqual(saved0.text, '改');
  assert.strictEqual(saved0.level, 'important');
  assert.strictEqual(saved0.enabled, false, '撤下走 update 翻 enabled');
  assert.ok(auditLog.some((s) => s.startsWith('admin.noticeUpdate')), '审计 noticeUpdate');
  assert.strictEqual((await call(adm, mockReq('POST', {
    url: '/api/admin/notices/n_no/update', body: JSON.stringify({ text: 'x' }), headers: { cookie: ck('u5') }
  }))).status, 404, '改不存在的通知 404');

  /* ---- 删除 POST /api/admin/notices/:id/delete ---- */
  assert.strictEqual((await call(adm, mockReq('POST', {
    url: '/api/admin/notices/n1/delete', headers: { cookie: ck('u5') }
  }))).status, 200);
  assert.ok(!store._map.get('notices.json').some((x) => x.id === 'n1'), '已删除');
  assert.ok(auditLog.some((s) => s.startsWith('admin.noticeDelete')), '审计 noticeDelete');
  assert.strictEqual((await call(adm, mockReq('POST', {
    url: '/api/admin/notices/n1/delete', headers: { cookie: ck('u5') }
  }))).status, 404, '重复删除 404');

  assert.strictEqual((await call(adm, mockReq('POST', {
    url: '/api/admin/notices/n0/what', body: '{}', headers: { cookie: ck('u5') }
  }))).status, 404, '未知子路径 404');

  /* ---- 并发互斥:写延迟放大读改写窗口,两建不得丢 ---- */
  {
    const delayed = {
      readJson: store.readJson,
      writeJson: async (key, value) => {
        await new Promise((res2) => setTimeout(res2, 25));
        store.writeJson(key, value);
      },
      _map: store._map
    };
    const adm2 = noticesApi.createAdminHandler(delayed, opts);
    const before = store._map.get('notices.json').length;
    const [ra, rb] = await Promise.all([
      call(adm2, mockReq('POST', { url: '/api/admin/notices', body: JSON.stringify({ text: '并发A' }), headers: { cookie: ck('u5') } })),
      call(adm2, mockReq('POST', { url: '/api/admin/notices', body: JSON.stringify({ text: '并发B' }), headers: { cookie: ck('u5') } }))
    ]);
    assert.strictEqual(ra.status, 200);
    assert.strictEqual(rb.status, 200);
    const list = store._map.get('notices.json');
    assert.strictEqual(list.length, before + 2, '并发两建都在(旧快照覆盖会丢一条)');
    assert.strictEqual(new Set(list.map((x) => x.id)).size, list.length, 'id 无重复');
    console.log('✓ 并发互斥:并发 create 不丢条目');
  }

  delete process.env.SESSION_SECRET;
  console.log('✓ notices-api: 33 断言通过');
})().catch((e) => { console.error(e); process.exit(1); });
