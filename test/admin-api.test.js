'use strict';

/* 后台读接口(users/audit/health):super 守卫矩阵 + 数据形状 + 降级信号。
 * 模块默认 handler 读 dev-store(种子模式同 login-wall.test.js):
 * requireRole 走全局 account 单例 → users 种子必须落全局 dev-store;
 * createHandlers({storage,listBackups}) 工厂注入内存存储/假备份列表。
 * 会话真实签发:种子账号 passHash 为 null,pv 为空串。 */

const assert = require('node:assert');
const session = require('../api/session');
const devStore = require('../api/dev-store');
const apiAdmin = require('../api/admin');

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
    { id: 'u1', username: 'boss', usernameLower: 'boss', nickname: '老板', phone: '13812341234', passHash: null, role: 'admin', playerId: null, status: 'active', createdAt: 't1' },
    { id: 'u2', username: 'admin1', usernameLower: 'admin1', phone: '13900000002', passHash: null, role: 'admin', playerId: 'p1', status: 'active', createdAt: 't2' },
    { id: 'u3', username: 'shortphone', usernameLower: 'shortphone', phone: '12345', passHash: null, role: 'player', playerId: null, status: 'banned', createdAt: 't3' },
    { id: 'u4', username: 'nophone', usernameLower: 'nophone', phone: null, passHash: null, role: 'user', playerId: null, status: 'active', createdAt: 't4' },
    { id: 'u5', username: 'root', usernameLower: 'root', phone: '13800000000', passHash: null, role: 'super', playerId: null, status: 'active', createdAt: 't5' }
  ];
  /* 种子落全局 dev-store:requireRole→account 单例与模块默认 handler 都从这里读 */
  await devStore.writeJson('users.json', users);
  await devStore.writeJson('data.json', {
    tournaments: [{ id: 't1' }, { id: 't2' }],
    series: [{ id: 's1' }],
    players: [{ id: 'p1', name: '选手一' }],
    activeId: 't1'
  });

  const ck = (uid) => 'sess=' + session.issueFor(uid, '');
  let r;

  /* ---- GET /api/admin/users:super 过门 + 形状 ---- */
  process.env.SUPER_ADMIN_USERNAMES = 'boss'; /* u1 存档 role=admin,env 升格 super */
  try {
    r = await call(apiAdmin, mockReq('GET', { url: '/api/admin/users', headers: { cookie: ck('u1') } }));
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body.users));
    assert.strictEqual(r.body.users.length, 5);
    const by = Object.fromEntries(r.body.users.map((u) => [u.id, u]));
    /* role 用 effectiveRole:env 升格回 'super'(非存档 'admin') */
    assert.strictEqual(by.u1.role, 'super');
    /* phoneMasked:11 位 → 138****1234;非 11 位/无手机 → null */
    assert.match(by.u1.phoneMasked, /^\d{3}\*{4}\d{4}$/);
    assert.strictEqual(by.u1.phoneMasked, '138****1234');
    assert.strictEqual(by.u3.phoneMasked, null); /* 5 位 → null */
    assert.strictEqual(by.u4.phoneMasked, null); /* 无手机 → null */
    /* 原始手机号绝不下发 */
    assert.ok(!JSON.stringify(r.body).includes('13812341234'));
    /* playerName 从 data.json players 映射;未绑定选手 → null */
    assert.strictEqual(by.u2.playerName, '选手一');
    assert.strictEqual(by.u1.playerName, null);
    /* 状态(含 banned)与基础字段 */
    assert.strictEqual(by.u3.status, 'banned');
    assert.strictEqual(by.u2.playerId, 'p1');
    assert.strictEqual(by.u1.nickname, '老板');
    assert.strictEqual(by.u4.createdAt, 't4');
  } finally { delete process.env.SUPER_ADMIN_USERNAMES; }

  /* 守卫:admin 403;匿名 401;banned 账号会话直接失效 401 */
  assert.strictEqual((await call(apiAdmin, mockReq('GET', { url: '/api/admin/users', headers: { cookie: ck('u2') } }))).status, 403);
  assert.strictEqual((await call(apiAdmin, mockReq('GET', { url: '/api/admin/users' }))).status, 401);
  assert.strictEqual((await call(apiAdmin, mockReq('GET', { url: '/api/admin/users', headers: { cookie: ck('u3') } }))).status, 401);

  /* 子路径分发:裸 /api/admin、未知段、多段 → 404;非 GET → 405 */
  assert.strictEqual((await call(apiAdmin, mockReq('GET', { url: '/api/admin', headers: { cookie: ck('u5') } }))).status, 404);
  assert.strictEqual((await call(apiAdmin, mockReq('GET', { url: '/api/admin/', headers: { cookie: ck('u5') } }))).status, 404);
  assert.strictEqual((await call(apiAdmin, mockReq('GET', { url: '/api/admin/nope', headers: { cookie: ck('u5') } }))).status, 404);
  assert.strictEqual((await call(apiAdmin, mockReq('GET', { url: '/api/admin/users/extra', headers: { cookie: ck('u5') } }))).status, 404);
  assert.strictEqual((await call(apiAdmin, mockReq('POST', { url: '/api/admin/users', headers: { cookie: ck('u5') } }))).status, 405);

  /* ---- GET /api/admin/audit:注入 storage(种子审计流水) ---- */
  const month = '2026-08';
  const entries = [
    { t: '2026-08-01T00:00:00.000Z', action: 'data.put', detail: '1 届' },
    { t: '2026-08-02T00:00:00.000Z', action: 'me.player', detail: 'x' },
    { t: '2026-08-03T00:00:00.000Z', action: 'sms.send', detail: 'y' }
  ];
  const adminAudit = apiAdmin.createHandlers({
    storage: memoryStorage({ ['audit/log-' + month + '.json']: entries })
  });
  r = await call(adminAudit, mockReq('GET', { url: '/api/admin/audit?month=' + month, headers: { cookie: ck('u5') } }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.month, month);
  /* 最新在前;条目形状 {action,detail,at}(at 取存档 t) */
  assert.strictEqual(r.body.items.length, 3);
  assert.strictEqual(r.body.items[0].action, 'sms.send');
  assert.strictEqual(r.body.items[0].at, '2026-08-03T00:00:00.000Z');
  assert.deepStrictEqual(Object.keys(r.body.items[0]).sort(), ['action', 'at', 'detail']);

  /* limit 钳制:2 → 最新 2 条;0/-5 → 钳 1;99999 → 钳 1000(全部) */
  r = await call(adminAudit, mockReq('GET', { url: '/api/admin/audit?month=' + month + '&limit=2', headers: { cookie: ck('u5') } }));
  assert.strictEqual(r.body.items.length, 2);
  assert.strictEqual(r.body.items[0].action, 'sms.send');
  assert.strictEqual(r.body.items[1].action, 'me.player');
  r = await call(adminAudit, mockReq('GET', { url: '/api/admin/audit?month=' + month + '&limit=0', headers: { cookie: ck('u5') } }));
  assert.strictEqual(r.body.items.length, 1);
  r = await call(adminAudit, mockReq('GET', { url: '/api/admin/audit?month=' + month + '&limit=-5', headers: { cookie: ck('u5') } }));
  assert.strictEqual(r.body.items.length, 1);
  r = await call(adminAudit, mockReq('GET', { url: '/api/admin/audit?month=' + month + '&limit=99999', headers: { cookie: ck('u5') } }));
  assert.strictEqual(r.body.items.length, 3);

  /* 非法 month 400(13 月/缺零填充);空月(文件不存在)空数组 + 降级信号 */
  assert.strictEqual((await call(adminAudit, mockReq('GET', { url: '/api/admin/audit?month=2026-13', headers: { cookie: ck('u5') } }))).status, 400);
  assert.strictEqual((await call(adminAudit, mockReq('GET', { url: '/api/admin/audit?month=2026-1', headers: { cookie: ck('u5') } }))).status, 400);
  r = await call(adminAudit, mockReq('GET', { url: '/api/admin/audit?month=2020-01', headers: { cookie: ck('u5') } }));
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.items, []);
  assert.strictEqual(r.body.oss, false); /* 测试环境未配 OSS(env) */

  /* month 缺省当月(UTC):种子挂当前月键,断言缺省参数命中它 */
  const curMonth = new Date().toISOString().slice(0, 7);
  const adminCurMonth = apiAdmin.createHandlers({
    storage: memoryStorage({ ['audit/log-' + curMonth + '.json']: entries })
  });
  r = await call(adminCurMonth, mockReq('GET', { url: '/api/admin/audit', headers: { cookie: ck('u5') } }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.month, curMonth);
  assert.strictEqual(r.body.items.length, 3);

  /* audit 守卫:admin 403;匿名 401 */
  assert.strictEqual((await call(adminAudit, mockReq('GET', { url: '/api/admin/audit', headers: { cookie: ck('u2') } }))).status, 403);
  assert.strictEqual((await call(adminAudit, mockReq('GET', { url: '/api/admin/audit' }))).status, 401);

  /* ---- GET /api/admin/health:注入假 listBackups ---- */
  const fakeKeys = [
    'backups/data-2026-08-20T00-00-00-000Z.json',
    'backups/data-2026-08-28T10-20-30-400Z.json',
    'backups/data-2026-08-30T09-08-07-006Z.json'
  ];
  const adminHealth = apiAdmin.createHandlers({
    storage: memoryStorage({
      'users.json': [null, { id: 'u1' }], /* null 脏条目不计 */
      'data.json': { tournaments: [{}, {}, {}], series: [{}, {}], players: [] }
    }),
    listBackups: async () => fakeKeys.slice()
  });
  r = await call(adminHealth, mockReq('GET', { url: '/api/admin/health', headers: { cookie: ck('u5') } }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.oss, true);
  assert.strictEqual(r.body.backups.count, 3);
  assert.strictEqual(r.body.backups.latest, fakeKeys[2]);
  assert.deepStrictEqual(r.body.backups.keys, fakeKeys);
  /* lastBackupAt 从备份名时间戳解析(名字里 : 与 . 被换成 -) */
  assert.strictEqual(r.body.lastBackupAt, '2026-08-30T09:08:07.006Z');
  assert.strictEqual(r.body.users, 1);
  assert.strictEqual(r.body.tournaments, 3);
  assert.strictEqual(r.body.series, 2);

  /* keys 只回最近 20 条(count 仍是全量) */
  const many = Array.from({ length: 25 }, (_, i) => 'backups/data-2026-01-01T00-00-' + String(i).padStart(2, '0') + '-000Z.json');
  const adminMany = apiAdmin.createHandlers({
    storage: memoryStorage({}),
    listBackups: async () => many.slice()
  });
  r = await call(adminMany, mockReq('GET', { url: '/api/admin/health', headers: { cookie: ck('u5') } }));
  assert.strictEqual(r.body.backups.count, 25);
  assert.strictEqual(r.body.backups.keys.length, 20);
  assert.strictEqual(r.body.backups.keys[19], many[24]);
  assert.strictEqual(r.body.backups.latest, many[24]);

  /* health 守卫:admin 403;匿名 401 */
  assert.strictEqual((await call(adminHealth, mockReq('GET', { url: '/api/admin/health', headers: { cookie: ck('u2') } }))).status, 403);
  assert.strictEqual((await call(adminHealth, mockReq('GET', { url: '/api/admin/health' }))).status, 401);

  /* ---- 降级分支:env 未配 OSS → listBackups throw → 捕获置 oss:false ---- */
  const ossEnvKeys = ['OSS_REGION', 'OSS_BUCKET', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET'];
  const ossEnvSaved = ossEnvKeys.map((k) => [k, process.env[k]]);
  for (const k of ossEnvKeys) delete process.env[k];
  try {
    r = await call(apiAdmin, mockReq('GET', { url: '/api/admin/health', headers: { cookie: ck('u5') } }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.oss, false);
    assert.deepStrictEqual(r.body.backups, { count: 0, latest: null, keys: [] });
    assert.strictEqual(r.body.lastBackupAt, null);
    /* 数据量照常(dev-store 种子) */
    assert.strictEqual(r.body.users, 5);
    assert.strictEqual(r.body.tournaments, 2);
    assert.strictEqual(r.body.series, 1);
  } finally {
    for (const [k, v] of ossEnvSaved) { if (v !== undefined) process.env[k] = v; }
  }

  delete process.env.SESSION_SECRET;
  console.log('✓ admin-api: 后台读接口(users 脱敏/audit 流水/health 备份)通过');
})().catch((e) => { console.error(e); process.exit(1); });
