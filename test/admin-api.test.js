'use strict';

/* 后台接口:读(users/audit/health)+ 写(users/:id/status|role、backup、restore)。
 * 模块默认 handler 读 dev-store(种子模式同 login-wall.test.js):
 * requireRole 走全局 account 单例 → users 种子必须落全局 dev-store;
 * createHandlers({storage,...}) 工厂注入内存存储/假备份列表/假审计。
 * 会话真实签发:种子账号 passHash 为 null,pv 为空串。
 * 写接口另注入共享 store 的 account 实例验证封禁 → 登录 403 链路。 */

const assert = require('node:assert');
const session = require('../api/session');
const devStore = require('../api/dev-store');
const apiAdmin = require('../api/admin');
const account = require('../api/account');
const { createSmsService } = require('../api/sms');
const { hashPassword } = account;

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
    { id: 'u5', username: 'root', usernameLower: 'root', phone: '13800000000', passHash: null, role: 'super', playerId: null, status: 'active', createdAt: 't5' },
    /* 短信自动注册形态:username 即完整手机号(account.js smsLogin),不得原样下发 */
    { id: 'u6', username: '13899990000', usernameLower: '13899990000', phone: '13899990000', passHash: null, role: 'user', playerId: null, status: 'active', createdAt: 't6' }
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
    assert.strictEqual(r.body.users.length, 6);
    const by = Object.fromEntries(r.body.users.map((u) => [u.id, u]));
    /* role 用 effectiveRole:env 升格回 'super'(非存档 'admin') */
    assert.strictEqual(by.u1.role, 'super');
    /* phoneMasked:11 位 → 138****1234;非 11 位/无手机 → null */
    assert.match(by.u1.phoneMasked, /^\d{3}\*{4}\d{4}$/);
    assert.strictEqual(by.u1.phoneMasked, '138****1234');
    assert.strictEqual(by.u3.phoneMasked, null); /* 5 位 → null */
    assert.strictEqual(by.u4.phoneMasked, null); /* 无手机 → null */
    /* username 即手机号(短信自动注册)→ 同规则脱敏,不得抵消 phoneMasked */
    assert.strictEqual(by.u6.username, '138****0000');
    /* 原始手机号绝不下发(任何字段) */
    assert.ok(!JSON.stringify(r.body).includes('13812341234'));
    assert.ok(!JSON.stringify(r.body).includes('13899990000'));
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
    { t: '2026-08-03T00:00:00.000Z', action: 'sms.send', detail: 'y' },
    /* appendAudit 既有写入模式 user=<username>:短信用户即完整手机号 → 读侧须脱敏 */
    { t: '2026-08-04T00:00:00.000Z', action: 'auth.login', detail: 'user=13899990000 ip=1.2.3.4' }
  ];
  const adminAudit = apiAdmin.createHandlers({
    storage: memoryStorage({ ['audit/log-' + month + '.json']: entries })
  });
  r = await call(adminAudit, mockReq('GET', { url: '/api/admin/audit?month=' + month, headers: { cookie: ck('u5') } }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.month, month);
  /* 最新在前;条目形状 {action,detail,at}(at 取存档 t) */
  assert.strictEqual(r.body.items.length, 4);
  assert.strictEqual(r.body.items[0].action, 'auth.login');
  assert.strictEqual(r.body.items[0].at, '2026-08-04T00:00:00.000Z');
  assert.deepStrictEqual(Object.keys(r.body.items[0]).sort(), ['action', 'at', 'detail']);
  /* detail 读侧脱敏:手机形态子串 → 138****0000;ip 原样保留 */
  assert.strictEqual(r.body.items[0].detail, 'user=138****0000 ip=1.2.3.4');
  assert.ok(!JSON.stringify(r.body).includes('13899990000'));

  /* limit 钳制:2 → 最新 2 条;0/-5 → 钳 1;99999 → 钳 1000(全部) */
  r = await call(adminAudit, mockReq('GET', { url: '/api/admin/audit?month=' + month + '&limit=2', headers: { cookie: ck('u5') } }));
  assert.strictEqual(r.body.items.length, 2);
  assert.strictEqual(r.body.items[0].action, 'auth.login');
  assert.strictEqual(r.body.items[1].action, 'sms.send');
  r = await call(adminAudit, mockReq('GET', { url: '/api/admin/audit?month=' + month + '&limit=0', headers: { cookie: ck('u5') } }));
  assert.strictEqual(r.body.items.length, 1);
  r = await call(adminAudit, mockReq('GET', { url: '/api/admin/audit?month=' + month + '&limit=-5', headers: { cookie: ck('u5') } }));
  assert.strictEqual(r.body.items.length, 1);
  r = await call(adminAudit, mockReq('GET', { url: '/api/admin/audit?month=' + month + '&limit=99999', headers: { cookie: ck('u5') } }));
  assert.strictEqual(r.body.items.length, 4);

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
  assert.strictEqual(r.body.items.length, 4);

  /* audit 守卫:admin 403;匿名 401 */
  assert.strictEqual((await call(adminAudit, mockReq('GET', { url: '/api/admin/audit', headers: { cookie: ck('u2') } }))).status, 403);
  assert.strictEqual((await call(adminAudit, mockReq('GET', { url: '/api/admin/audit' }))).status, 401);

  /* ---- GET /api/admin/health:注入假 listBackups ---- */
  /* 顺序刻意打乱:字典序先比前缀('backups/data-' < 'backups/manual-'),
   * 会把 manual-data-28 排到最后、latest 错指它——按时间排序才正确 */
  const fakeKeys = [
    'backups/data-2026-08-20T00-00-00-000Z.json',
    'backups/data-2026-08-30T09-08-07-006Z.json',
    'backups/manual-data-2026-08-28T10-20-30-400Z.json'
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
  /* keys 时间序(旧→新):manual-data-28 插在 data-20 与 data-30 之间 */
  assert.deepStrictEqual(r.body.backups.keys, [fakeKeys[0], fakeKeys[2], fakeKeys[1]]);
  assert.strictEqual(r.body.backups.latest, fakeKeys[1]);
  /* lastBackupAt 从备份名时间戳解析(名字里 : 与 . 被换成 -;含 manual- 前缀) */
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
    assert.strictEqual(r.body.users, 6);
    assert.strictEqual(r.body.tournaments, 2);
    assert.strictEqual(r.body.series, 1);
  } finally {
    for (const [k, v] of ossEnvSaved) { if (v !== undefined) process.env[k] = v; }
  }

  /* ==================== 写接口:封禁/角色/手工备份/快照恢复 ==================== */

  const jsonBody = (obj) => JSON.stringify(obj);

  /* 写接口用种子:u3=victim(可登录的被封对象)、u5=root(super,操作者,
   * 会话仍由全局 dev-store 验签)、u7=存档 super、u1=boss(env 名单升格用) */
  const writeSeed = () => [
    { id: 'u1', username: 'boss', usernameLower: 'boss', nickname: '老板', phone: '13812341234', passHash: null, role: 'admin', playerId: null, status: 'active', createdAt: 't1' },
    { id: 'u3', username: 'victim', usernameLower: 'victim', phone: '13900000009', passHash: hashPassword('pass12345'), role: 'player', playerId: null, status: 'active', createdAt: 't3' },
    { id: 'u5', username: 'root', usernameLower: 'root', phone: '13800000000', passHash: null, role: 'super', playerId: null, status: 'active', createdAt: 't5' },
    { id: 'u7', username: 'root2', usernameLower: 'root2', phone: '13800000001', passHash: null, role: 'super', playerId: null, status: 'active', createdAt: 't7' }
  ];

  /* ---- POST /api/admin/users/:id/status:封禁→两条登录链 403,解封恢复 ---- */
  {
    const audits = [];
    const store = memoryStorage({
      'users.json': writeSeed(),
      'data.json': { tournaments: [], series: [], players: [], activeId: null },
      'invite-codes.json': []
    });
    const admin = apiAdmin.createHandlers({ storage: store, appendAudit: (a, d) => audits.push(a + ' ' + d) });
    /* 共享同一 store 的 account 实例:封禁落盘后立即在登录链可见 */
    const smsSvc = createSmsService({ devResolver: () => '000000', sender: async () => ({ ok: true }) });
    const acc = account.createHandlers(store, { sms: smsSvc });
    const su = ck('u5');
    const post = (url, body, cookie) =>
      call(admin, mockReq('POST', { url, headers: cookie ? { cookie } : undefined, body: jsonBody(body) }));
    const row = (id) => store._map.get('users.json').find((u) => u.id === id);

    /* ban 普通用户:200 + 落盘 + 审计 */
    let r = await post('/api/admin/users/u3/status', { banned: true }, su);
    assert.strictEqual(r.status, 200, 'ban 200');
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.user.status, 'banned');
    assert.strictEqual(r.body.user.username, 'victim');
    assert.strictEqual(row('u3').status, 'banned', 'users.json 落盘 status=banned');
    assert.ok(audits.includes('admin.ban user=victim by=root'), 'audit admin.ban');

    /* 被封账号:密码/短信两条登录链都 403(Task 1 链路收口) */
    const pwBan = await call(acc.login, mockReq('POST', { body: jsonBody({ username: 'victim', password: 'pass12345' }) }));
    assert.strictEqual(pwBan.status, 403, 'banned 密码登录 403');
    const smsBan = await call(acc.smsLogin, mockReq('POST', { body: jsonBody({ phone: '13900000009', code: '000000' }) }));
    assert.strictEqual(smsBan.status, 403, 'banned 短信登录 403');

    /* unban:200 + 落盘 + 登录恢复 */
    r = await post('/api/admin/users/u3/status', { banned: false }, su);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.user.status, 'active');
    assert.strictEqual(row('u3').status, 'active');
    assert.ok(audits.includes('admin.unban user=victim by=root'), 'audit admin.unban');
    const pwOk = await call(acc.login, mockReq('POST', { body: jsonBody({ username: 'victim', password: 'pass12345' }) }));
    assert.strictEqual(pwOk.status, 200, '解封后登录恢复 200');

    /* 超管保护:存档 super / env 名单升格 / 操作者本人 → 400,不落盘不审计 */
    const auditsBefore = audits.length;
    r = await post('/api/admin/users/u7/status', { banned: true }, su);
    assert.strictEqual(r.status, 400, '存档 super 不可封');
    assert.strictEqual(r.body.error, '超管账号不可在此操作');
    r = await post('/api/admin/users/u5/status', { banned: true }, su);
    assert.strictEqual(r.status, 400, '不可封自己');
    try {
      process.env.SUPER_ADMIN_USERNAMES = 'boss';
      r = await post('/api/admin/users/u1/status', { banned: true }, su);
      assert.strictEqual(r.status, 400, 'env 名单升格(effectiveRole=super)不可封');
    } finally { delete process.env.SUPER_ADMIN_USERNAMES; }
    assert.strictEqual(audits.length, auditsBefore, '保护命中不写审计');
    assert.strictEqual(row('u7').status, 'active', '保护命中不落盘');

    /* 404 不存在;banned 非布尔/缺失 400;守卫 admin 403/匿名 401 */
    assert.strictEqual((await post('/api/admin/users/ghost/status', { banned: true }, su)).status, 404, '账号不存在 404');
    assert.strictEqual((await post('/api/admin/users/u3/status', { banned: 'yes' }, su)).status, 400, 'banned 非布尔 400');
    assert.strictEqual((await post('/api/admin/users/u3/status', {}, su)).status, 400, '缺 banned 400');
    assert.strictEqual((await post('/api/admin/users/u3/status', { banned: true }, ck('u2'))).status, 403, 'admin 角色 403');
    assert.strictEqual((await post('/api/admin/users/u3/status', { banned: true })).status, 401, '匿名 401');

    console.log('✓ admin 写:ban/unban(超管保护)/登录链 403');
  }

  /* ---- POST /api/admin/users/:id/role:player↔admin 往返,置 super 400 ---- */
  {
    const audits = [];
    const store = memoryStorage({ 'users.json': writeSeed(), 'data.json': { tournaments: [], series: [], players: [] }, 'invite-codes.json': [] });
    const admin = apiAdmin.createHandlers({ storage: store, appendAudit: (a, d) => audits.push(a + ' ' + d) });
    const su = ck('u5');
    const post = (url, body, cookie) =>
      call(admin, mockReq('POST', { url, headers: cookie ? { cookie } : undefined, body: jsonBody(body) }));
    const row = (id) => store._map.get('users.json').find((u) => u.id === id);

    /* admin → player → admin 往返 */
    let r = await post('/api/admin/users/u1/role', { role: 'player' }, su);
    assert.strictEqual(r.status, 200, '降级 200');
    assert.strictEqual(r.body.user.role, 'player');
    assert.strictEqual(row('u1').role, 'player', '落盘 role=player');
    assert.ok(audits.includes('admin.role user=boss role=player by=root'), 'audit admin.role');
    r = await post('/api/admin/users/u1/role', { role: 'admin' }, su);
    assert.strictEqual(r.status, 200, '升级 200');
    assert.strictEqual(row('u1').role, 'admin', '落盘 role=admin');

    /* 非法 role:super 不支持,user/数字/null 均 400,且不落盘 */
    for (const bad of ['super', 'user', 42, null]) {
      r = await post('/api/admin/users/u1/role', { role: bad }, su);
      assert.strictEqual(r.status, 400, '非法 role ' + JSON.stringify(bad) + ' → 400');
    }
    assert.strictEqual(row('u1').role, 'admin', '非法请求不落盘');

    /* banned 账号可改角色(封禁与角色正交) */
    row('u3').status = 'banned';
    r = await post('/api/admin/users/u3/role', { role: 'admin' }, su);
    assert.strictEqual(r.status, 200, 'banned 账号可改角色');
    assert.strictEqual(row('u3').role, 'admin');

    /* 保护:存档 super / 本人 / env 名单 → 400;404;守卫;方法 */
    assert.strictEqual((await post('/api/admin/users/u7/role', { role: 'player' }, su)).status, 400, '存档 super 不可改角色');
    assert.strictEqual((await post('/api/admin/users/u5/role', { role: 'player' }, su)).status, 400, '不可改自己角色');
    try {
      process.env.SUPER_ADMIN_USERNAMES = 'boss';
      assert.strictEqual((await post('/api/admin/users/u1/role', { role: 'player' }, su)).status, 400, 'env 名单升格不可改角色');
    } finally { delete process.env.SUPER_ADMIN_USERNAMES; }
    assert.strictEqual((await post('/api/admin/users/ghost/role', { role: 'player' }, su)).status, 404, '账号不存在 404');
    assert.strictEqual((await post('/api/admin/users/u1/role', { role: 'player' }, ck('u2'))).status, 403, 'admin 角色 403');
    assert.strictEqual((await post('/api/admin/users/u1/role', { role: 'player' })).status, 401, '匿名 401');
    assert.strictEqual((await call(admin, mockReq('GET', { url: '/api/admin/users/u3/status', headers: { cookie: su } }))).status, 405, 'status 仅 POST');
    assert.strictEqual((await call(admin, mockReq('GET', { url: '/api/admin/users/u3/role', headers: { cookie: su } }))).status, 405, 'role 仅 POST');

    console.log('✓ admin 写:role 降级/升级(player↔admin)');
  }

  /* ---- POST /api/admin/backup:三件套手工快照,返回 keys ---- */
  {
    const audits = [];
    const calls = [];
    const TS = 1756543200000;
    const admin = apiAdmin.createHandlers({
      storage: memoryStorage({}),
      appendAudit: (a, d) => audits.push(a + ' ' + d),
      now: () => TS,
      backupManual: async (source, ts) => {
        calls.push([source, ts]);
        const kind = { 'data.json': 'data', 'users.json': 'users', 'invite-codes.json': 'codes' }[source];
        return 'backups/manual-' + kind + '-' + ts + '.json';
      }
    });
    const su = ck('u5');
    const r = await call(admin, mockReq('POST', { url: '/api/admin/backup', headers: { cookie: su } }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.keys.length, 3, 'data/users/invite-codes 各一份');
    assert.deepStrictEqual(r.body.keys, [
      'backups/manual-data-' + TS + '.json',
      'backups/manual-users-' + TS + '.json',
      'backups/manual-codes-' + TS + '.json'
    ]);
    assert.deepStrictEqual(calls.map((c) => c[0]), ['data.json', 'users.json', 'invite-codes.json'], '按序备份三件套');
    assert.deepStrictEqual(calls.map((c) => c[1]), [TS, TS, TS], '三件共用同一时间戳(成套)');
    assert.ok(audits.some((a) => a.startsWith('admin.backup ')), 'audit admin.backup');

    /* 部分成功(data 件 throw):仍 200,失败件以 null 占位 */
    const TS2 = 1756543300000;
    const adminPartial = apiAdmin.createHandlers({
      storage: memoryStorage({}),
      appendAudit: () => {},
      now: () => TS2,
      backupManual: async (source) => {
        if (source === 'data.json') throw new Error('oss down');
        const kind = { 'users.json': 'users', 'invite-codes.json': 'codes' }[source];
        return 'backups/manual-' + kind + '-' + TS2 + '.json';
      }
    });
    let rp = await call(adminPartial, mockReq('POST', { url: '/api/admin/backup', headers: { cookie: su } }));
    assert.strictEqual(rp.status, 200, '部分成功仍 200');
    assert.deepStrictEqual(rp.body.keys, [
      null,
      'backups/manual-users-' + TS2 + '.json',
      'backups/manual-codes-' + TS2 + '.json'
    ], '失败件 null 占位');

    /* 全败(keys 全 null,默认真实现未配 OSS 时三件均回 null 同此分支)→ 500 */
    for (const impl of [
      async () => null,                     /* 静默跳过 */
      async () => { throw new Error('oss down'); } /* 抛错 */
    ]) {
      const noneAudits = [];
      const adminNone = apiAdmin.createHandlers({
        storage: memoryStorage({}),
        appendAudit: (a, d) => noneAudits.push(a + ' ' + d),
        now: () => TS2,
        backupManual: impl
      });
      const rn = await call(adminNone, mockReq('POST', { url: '/api/admin/backup', headers: { cookie: su } }));
      assert.strictEqual(rn.status, 500, '全败 500(impl ' + String(impl) + ')');
      assert.strictEqual(rn.body.error, '备份全部失败');
      assert.deepStrictEqual(rn.body.keys, undefined, '500 不带 keys');
      assert.ok(noneAudits.some((a) => a.startsWith('admin.backup ')), '全败仍写审计(留痕)');
    }

    /* 守卫与方法 */
    assert.strictEqual((await call(admin, mockReq('POST', { url: '/api/admin/backup', headers: { cookie: ck('u2') } }))).status, 403);
    assert.strictEqual((await call(admin, mockReq('POST', { url: '/api/admin/backup' }))).status, 401);
    assert.strictEqual((await call(admin, mockReq('GET', { url: '/api/admin/backup', headers: { cookie: su } }))).status, 405);

    console.log('✓ admin 写:backup 手工三件套(部分成功 200/全败 500)');
  }

  /* ---- POST /api/admin/restore:key 白名单 + 先留底后拷贝 ---- */
  {
    const audits = [];
    const seq = [];
    const listed = [
      'backups/data-2026-08-20T00-00-00-000Z.json',
      'backups/manual-data-2026-08-28T00-00-00-000Z.json',
      /* 假列表混入的非 data 类(真 listBackups 会滤掉,此处专测服务端再校验) */
      'backups/users-2026-08-20T00-00-00-000Z.json'
    ];
    const admin = apiAdmin.createHandlers({
      storage: memoryStorage({}),
      appendAudit: (a, d) => audits.push(a + ' ' + d),
      listBackups: async () => listed.slice(),
      backupData: async () => { seq.push('backupData'); },
      restoreCopy: async (key) => { seq.push('copy:' + key); }
    });
    const su = ck('u5');
    const post = (body, cookie) =>
      call(admin, mockReq('POST', { url: '/api/admin/restore', headers: cookie ? { cookie } : undefined, body: jsonBody(body) }));

    /* 守卫 */
    assert.strictEqual((await post({ key: listed[0] }, ck('u2'))).status, 403, 'admin 角色 403');
    assert.strictEqual((await post({ key: listed[0] })).status, 401, '匿名 401');
    /* key 白名单:非 backups/ 前缀 / 路径穿越 / 不在备份列表 → 400 */
    assert.strictEqual((await post({ key: 'users.json' }, su)).status, 400, '非 backups/ 前缀 400');
    assert.strictEqual((await post({ key: 'backups/../../data.json' }, su)).status, 400, '路径穿越不命中列表 400');
    assert.strictEqual((await post({ key: 'backups/data-2026-09-01T00-00-00-000Z.json' }, su)).status, 400, '不在列表 400');
    /* 命中列表但非 data 类 → 400 */
    assert.strictEqual((await post({ key: listed[2] }, su)).status, 400, '非 data 类 400');
    /* 缺 key → 400 */
    assert.strictEqual((await post({}, su)).status, 400, '缺 key 400');
    /* 校验失败不得触发任何副作用 */
    assert.deepStrictEqual(seq, [], '校验阶段不触发留底/拷贝');

    /* 正常路径:先 backupData 留底,再 copy 恢复 */
    let r = await post({ key: listed[0] }, su);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.deepStrictEqual(seq, ['backupData', 'copy:' + listed[0]], '先留底后拷贝');
    /* 手工 data 快照同样可恢复(manual-data-* 含 data- 子串 → listBackups 可见) */
    r = await post({ key: listed[1] }, su);
    assert.strictEqual(r.status, 200, 'manual-data 快照可恢复');
    assert.deepStrictEqual(seq, ['backupData', 'copy:' + listed[0], 'backupData', 'copy:' + listed[1]]);
    assert.ok(audits.includes('admin.restore key=' + listed[0] + ' by=root'), 'audit admin.restore 含 key');
    /* GET → 405 */
    assert.strictEqual((await call(admin, mockReq('GET', { url: '/api/admin/restore', headers: { cookie: su } }))).status, 405);

    console.log('✓ admin 写:restore 白名单/先留底后拷贝');
  }

  /* ---- manualBackupKey 纯函数:命名与自动备份同构,manual data 类可被恢复命中 ---- */
  {
    const t = Date.UTC(2026, 7, 30, 9, 8, 7, 6);
    assert.strictEqual(apiAdmin.manualBackupKey(t, 'data.json'), 'backups/manual-data-2026-08-30T09-08-07-006Z.json');
    assert.strictEqual(apiAdmin.manualBackupKey(t, 'users.json'), 'backups/manual-users-2026-08-30T09-08-07-006Z.json');
    assert.strictEqual(apiAdmin.manualBackupKey(t, 'invite-codes.json'), 'backups/manual-codes-2026-08-30T09-08-07-006Z.json');
    /* manual data 快照含 'data-' 子串 → 真 listBackups 可见 → 可过 restore 白名单 */
    assert.ok(apiAdmin.manualBackupKey(t, 'data.json').includes('data-'));
    /* backupTimeOf 覆盖 manual- 前缀(manual data/users/codes 均可解析,其余 null) */
    assert.strictEqual(apiAdmin.backupTimeOf(apiAdmin.manualBackupKey(t, 'data.json')), '2026-08-30T09:08:07.006Z');
    assert.strictEqual(apiAdmin.backupTimeOf(apiAdmin.manualBackupKey(t, 'users.json')), '2026-08-30T09:08:07.006Z');
    assert.strictEqual(apiAdmin.backupTimeOf(apiAdmin.manualBackupKey(t, 'invite-codes.json')), '2026-08-30T09:08:07.006Z');
    assert.strictEqual(apiAdmin.backupTimeOf('backups/manual-other-2026-08-30T09-08-07-006Z.json'), null, '未知 kind null');
    assert.strictEqual(apiAdmin.backupTimeOf('backups/data-not-a-ts.json'), null, '时间戳不合法 null');

    console.log('✓ admin 写:manualBackupKey 命名');
  }

  delete process.env.SESSION_SECRET;
  console.log('✓ admin-api: 后台读+写接口(users 脱敏/audit/health/封禁/角色/备份/恢复)通过');
})().catch((e) => { console.error(e); process.exit(1); });
