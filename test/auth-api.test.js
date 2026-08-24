'use strict';

/* 账号体系 API 行为测试(内存存储注入,不联网):
 * 会话签名、三种邀请码注册、码核销/重用、用户名冲突、登录限速、
 * /api/me 会话读取、资料白名单更新、修改密码。 */

const assert = require('node:assert');
const session = require('../api/session');
const account = require('../api/account');
const { hashPassword, verifyPassword, createRateLimiter } = account;

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

const jsonBody = (obj) => JSON.stringify(obj);

function seedWorld() {
  return {
    'invite-codes.json': [
      { code: 'BOUND1', playerId: 'p_old', used: false },
      { code: 'BOUND2', playerId: 'p_old', used: false },
      { code: 'BLANK1', playerId: null, used: false }
    ],
    'users.json': [],
    'data.json': {
      tournaments: [],
      activeId: null,
      players: [{ id: 'p_old', name: '雨橘', tag: null, title: null, color: null, avatar: null, tagImg: null }]
    }
  };
}

async function main() {
  process.env.SESSION_SECRET = 'test-secret';

  /* ---- session.js 纯函数 ---- */
  {
    const tok = session.issueFor('u_1', () => Date.now());
    const payload = session.verifySession(tok);
    assert.ok(payload && payload.uid === 'u_1', '签名往返应还原 uid');
    assert.strictEqual(session.verifySession(tok + 'x'), null, '篡改签名应拒绝');
    assert.strictEqual(session.verifySession('garbage'), null, '非法格式应拒绝');
    const expired = session.signSession({ uid: 'u_1', exp: Date.now() - 1000 });
    assert.strictEqual(session.verifySession(expired), null, '过期会话应拒绝');
    const cookies = session.parseCookies('a=1; sess="tok%2Fx"; b=2; a=9');
    assert.deepStrictEqual(cookies, { a: '1', sess: 'tok/x', b: '2' }, 'Cookie 解析(引号/编码/重复键)');
    console.log('✓ session:签名/校验/Cookie 解析');
  }

  /* ---- 密码哈希 ---- */
  {
    const h = hashPassword('password123');
    assert.ok(verifyPassword('password123', h), '正确密码通过');
    assert.ok(!verifyPassword('password124', h), '错误密码拒绝');
    assert.ok(!verifyPassword('x', 'bad-format'), '非法存储格式拒绝');
    assert.notStrictEqual(hashPassword('password123'), h, '每次加盐应不同');
    console.log('✓ password:scrypt 加盐哈希');
  }

  /* ---- 注册:三种码 ---- */
  const prevAdminCode = process.env.ADMIN_INVITE_CODE;
  process.env.ADMIN_INVITE_CODE = 'ADMIN-CODE-1';
  {
    const audits = [];
    const h = account.createHandlers(memoryStorage(seedWorld()), {
      appendAudit: (a, d) => audits.push(a + ' ' + d)
    });

    /* 空白码:建新选手 */
    const r1 = await call(h.register, mockReq('POST', { body: jsonBody({ code: 'BLANK1', username: '新星', password: '12345678' }) }));
    assert.strictEqual(r1.status, 200, '空白码注册 200');
    assert.ok(r1.body.user.playerId, '空白码应新建选手');
    assert.strictEqual(r1.body.user.role, 'player');
    assert.ok(r1.headers['Set-Cookie'].includes('sess='), '注册应种会话 cookie');
    assert.ok(r1.headers['Set-Cookie'].includes('HttpOnly'), 'cookie 需 HttpOnly');

    /* 绑定码:继承老选手 */
    const r2 = await call(h.register, mockReq('POST', { body: jsonBody({ code: 'BOUND1', username: 'yuju', password: '12345678' }) }));
    assert.strictEqual(r2.status, 200, '绑定码注册 200');
    assert.strictEqual(r2.body.user.playerId, 'p_old', '绑定码应挂到预写选手');
    assert.strictEqual(r2.body.player && r2.body.player.name, '雨橘', '/register 响应带继承选手');

    /* 码重用 */
    const r3 = await call(h.register, mockReq('POST', { body: jsonBody({ code: 'BLANK1', username: '别人', password: '12345678' }) }));
    assert.strictEqual(r3.status, 400, '已用码应 400');

    /* 同一选手被重复绑定 */
    const r4 = await call(h.register, mockReq('POST', { body: jsonBody({ code: 'BOUND2', username: '冒充者', password: '12345678' }) }));
    assert.strictEqual(r4.status, 409, '选手已被绑定时应 409');

    /* 管理员码 */
    const r5 = await call(h.register, mockReq('POST', { body: jsonBody({ code: 'ADMIN-CODE-1', username: 'admin', password: '12345678' }) }));
    assert.strictEqual(r5.status, 200);
    assert.strictEqual(r5.body.user.role, 'admin', '管理员码应授 admin 角色');
    assert.strictEqual(r5.body.user.playerId, null, '管理员不绑选手');

    /* 用户名冲突(忽略大小写) */
    const r6 = await call(h.register, mockReq('POST', { body: jsonBody({ code: 'ADMIN-CODE-1', username: 'ADMIN', password: '12345678' }) }));
    assert.strictEqual(r6.status, 409, '用户名忽略大小写去重');

    /* 弱密码/非法用户名 */
    assert.strictEqual((await call(h.register, mockReq('POST', { body: jsonBody({ code: 'X', username: 'okname', password: '123' }) }))).status, 400, '短密码 400');
    assert.strictEqual((await call(h.register, mockReq('POST', { body: jsonBody({ code: 'X', username: 'a', password: '12345678' }) }))).status, 400, '短用户名 400');

    assert.ok(audits.some((a) => a.startsWith('auth.register')), '注册应写审计');
    console.log('✓ register:空白码/绑定码/管理员码/重用/冲突/校验');
  }

  /* ---- 登录 + 限速 + 会话 ---- */
  {
    const seed = seedWorld();
    seed['users.json'] = [{
      id: 'u_1', username: 'Tester', usernameLower: 'tester',
      passHash: hashPassword('12345678'), role: 'player', playerId: 'p_old', createdAt: '2026-01-01T00:00:00Z'
    }];
    const h = account.createHandlers(memoryStorage(seed));

    const bad = await call(h.login, mockReq('POST', { body: jsonBody({ username: 'tester', password: 'wrong!!!' }) }));
    assert.strictEqual(bad.status, 401, '错密码 401');

    const ok = await call(h.login, mockReq('POST', { body: jsonBody({ username: 'TESTER', password: '12345678' }) }));
    assert.strictEqual(ok.status, 200, '登录用户名大小写不敏感');
    const cookie = (ok.headers['Set-Cookie'] || '').split(';')[0];

    const noCookie = await call(h.me, mockReq('GET'));
    assert.strictEqual(noCookie.status, 401, '无 cookie /api/me 401');
    const badCookie = await call(h.me, mockReq('GET', { headers: { cookie: 'sess=fake.sig' } }));
    assert.strictEqual(badCookie.status, 401, '伪 cookie 401');
    const good = await call(h.me, mockReq('GET', { headers: { cookie } }));
    assert.strictEqual(good.status, 200);
    assert.strictEqual(good.body.user.username, 'Tester');
    assert.strictEqual(good.body.player.name, '雨橘');
    assert.ok(!('passHash' in good.body.user), '响应用户不得带密码哈希');

    /* 限速:同 IP 连续 5 次失败后锁定(即使密码正确也 429) */
    for (let i = 0; i < 5; i++) {
      const f = await call(h.login, mockReq('POST', { body: jsonBody({ username: 'tester', password: 'nope!' + i }) }));
      assert.strictEqual(f.status, 401, '失败尝试应 401');
    }
    const locked = await call(h.login, mockReq('POST', { body: jsonBody({ username: 'tester', password: '12345678' }) }));
    assert.strictEqual(locked.status, 429, '第 5 次失败后正确密码也应 429');

    /* 登出:cookie 立即过期 */
    const out = await call(h.logout, mockReq('POST', { headers: { cookie } }));
    assert.strictEqual(out.status, 200);
    assert.ok((out.headers['Set-Cookie'] || '').includes('Max-Age=0'), '登出应清 cookie');
    console.log('✓ login/me/logout:大小写/限速/会话校验/登出');
  }

  /* ---- 资料白名单 + 改密 ---- */
  {
    const seed = seedWorld();
    seed['users.json'] = [{
      id: 'u_1', username: 'tester', usernameLower: 'tester',
      passHash: hashPassword('old12345'), role: 'player', playerId: 'p_old', createdAt: '2026-01-01T00:00:00Z'
    }];
    const seedAdmin = seed['users.json'][0];
    const backups = [];
    const h = account.createHandlers(memoryStorage(seed), { backupData: () => backups.push(1) });
    const login = await call(h.login, mockReq('POST', { body: jsonBody({ username: 'tester', password: 'old12345' }) }));
    const cookie = (login.headers['Set-Cookie'] || '').split(';')[0];
    const auth = { cookie };

    const upd = await call(h.me, mockReq('PUT', {
      headers: auth,
      body: jsonBody({ name: '雨橘Pro', tag: 'YG', title: '今天必胜', color: '#ff00e5', hack: 1 })
    }));
    assert.strictEqual(upd.status, 200, '白名单字段更新 200');
    assert.strictEqual(upd.body.player.name, '雨橘Pro');
    assert.strictEqual(upd.body.player.tag, 'YG');
    assert.ok(!('hack' in upd.body.player) || upd.body.player.hack === undefined, '白名单外字段忽略');
    assert.ok(backups.length >= 1, '资料写入前应备份');

    const badColor = await call(h.me, mockReq('PUT', { headers: auth, body: jsonBody({ color: 'red' }) }));
    assert.strictEqual(badColor.status, 400, '非法颜色 400');

    const noFields = await call(h.me, mockReq('PUT', { headers: auth, body: jsonBody({ playerId: 'p_hack', role: 'admin' }) }));
    assert.strictEqual(noFields.status, 400, '越权字段(playerId/role)全在白名单外 → 400');
    const world = seed['data.json'];
    assert.strictEqual(world.players[0].id, 'p_old', 'playerId 不可被改');

    /* 管理员(未绑选手)不能编辑资料 */
    seed['users.json'].push({ id: 'u_9', username: 'admin', usernameLower: 'admin', passHash: hashPassword('admin12345'), role: 'admin', playerId: null, createdAt: '2026-01-01T00:00:00Z' });
    const alogin = await call(h.login, mockReq('POST', { body: jsonBody({ username: 'admin', password: 'admin12345' }) }));
    const acookie = (alogin.headers['Set-Cookie'] || '').split(';')[0];
    const aupd = await call(h.me, mockReq('PUT', { headers: { cookie: acookie }, body: jsonBody({ name: 'x' }) }));
    assert.strictEqual(aupd.status, 400, '未绑选手账号编辑资料应 400');

    /* 改密:错当前密码 400;成功后新密码可登录 */
    const wrongCur = await call(h.mePassword, mockReq('PUT', { headers: auth, body: jsonBody({ current: 'bad', next: 'new12345' }) }));
    assert.strictEqual(wrongCur.status, 400);
    const changed = await call(h.mePassword, mockReq('PUT', { headers: auth, body: jsonBody({ current: 'old12345', next: 'new12345' }) }));
    assert.strictEqual(changed.status, 200);
    const relogin = await call(h.login, mockReq('POST', { body: jsonBody({ username: 'tester', password: 'new12345' }) }));
    assert.strictEqual(relogin.status, 200, '新密码可登录');
    /* 改密后旧 pv 会话必须失效(踢出其他浏览器) */
    const stale = await call(h.me, mockReq('GET', { headers: auth }));
    assert.strictEqual(stale.status, 401, '改密后旧 cookie 应 401');
    assert.notStrictEqual(seedAdmin.passHash, undefined, '用户表仍在');

    /* 标量 JSON 请求体 → 400 而非 500 */
    const scalar = await call(h.login, mockReq('POST', { body: '123' }));
    assert.strictEqual(scalar.status, 400, '标量 JSON 体应 400');

    /* 开发测试码(env) */
    process.env.AUTH_DEV_INVITE_CODES = 'DEV1';
    const dev = await call(h.register, mockReq('POST', { body: jsonBody({ code: 'DEV1', username: 'devuser', password: '12345678' }) }));
    assert.strictEqual(dev.status, 200, '开发码注册可用');
    const devAgain = await call(h.register, mockReq('POST', { body: jsonBody({ code: 'DEV1', username: 'devuser2', password: '12345678' }) }));
    assert.strictEqual(devAgain.status, 400, '开发码一次性');
    delete process.env.AUTH_DEV_INVITE_CODES;
    console.log('✓ me/player/password:白名单/越权/备份/改密/开发码');
  }

  /* ---- 限速器窗口语义(注入时钟) ---- */
  {
    let t = 1000000;
    const rl = createRateLimiter(() => t);
    for (let i = 0; i < 5; i++) rl.recordFail('ip1');
    assert.ok(rl.blocked('ip1') > 0, '第 5 次失败后锁定');
    assert.strictEqual(rl.blocked('ip2'), 0, '不影响其他 IP');
    rl.reset('ip1');
    assert.strictEqual(rl.blocked('ip1'), 0, 'reset 后解锁');
    console.log('✓ rateLimiter:窗口/隔离/重置');
  }

  if (prevAdminCode === undefined) delete process.env.ADMIN_INVITE_CODE;
  else process.env.ADMIN_INVITE_CODE = prevAdminCode;
  delete process.env.SESSION_SECRET;
  console.log('auth-api 全部通过');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
