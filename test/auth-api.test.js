'use strict';

/* 账号体系 API 行为测试(内存存储注入,不联网):
 * 会话签名、短信验证码登录/自动注册、存量用户归一化、登录限速、
 * /api/me 会话读取、资料白名单更新、修改密码、
 * 填码跃迁(redeem)、账号昵称(nickname)、绑定手机号(mePhone)。
 * 并发轮:写延迟放大读-改-写窗口——smsLogin 两手机号并发注册不丢号。 */

const assert = require('node:assert');
const session = require('../api/session');
const account = require('../api/account');
const { createSmsService } = require('../api/sms');
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

/* 恒 0 限速器:短信登录用例绕开登录锁,专测验码语义 */
const noopRate = () => ({ blocked: () => 0, recordFail() {}, reset() {} });

function seedWorld() {
  return {
    'users.json': [],
    /* 填码跃迁的三种码:空白码(无 playerId,兑后建新选手)、
     * 绑定码(playerId 指向既有选手)、admin 码(kind:'admin',仅 super 发放) */
    'invite-codes.json': [
      { code: 'BLANK1', playerId: null, used: false },
      { code: 'BOUND1', playerId: 'p_old', used: false },
      { code: 'ADMIN1', kind: 'admin', used: false }
    ],
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

  /* ---- 短信登录/自动注册(dev 后门注入) ---- */
  {
    const seed = seedWorld();
    /* 存量旧用户:无 phone/status/nickname,验证读出归一化 */
    seed['users.json'] = [{
      id: 'u_old', username: '老用户', usernameLower: '老用户',
      passHash: hashPassword('12345678'), role: 'player', playerId: null, createdAt: '2025-01-01T00:00:00Z'
    }];
    const store = memoryStorage(seed);
    const smsSvc = createSmsService({ devResolver: () => '000000', sender: async () => ({ ok: true }) });
    const acc = account.createHandlers(store, { sms: smsSvc, rateLimiter: noopRate() });

    const r1 = await call(acc.smsLogin, mockReq('POST', { body: jsonBody({ phone: '13900000001', code: '000000' }) }));
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r1.body.user.role, 'player');
    assert.strictEqual(r1.body.user.nickname, '用户0001');
    assert.ok(r1.body.user.id);
    assert.ok((r1.headers['Set-Cookie'] || '').includes('sess='), '验码登录应种会话 cookie');

    /* 手机号格式拒绝 */
    const r2 = await call(acc.smsLogin, mockReq('POST', { body: jsonBody({ phone: '12345', code: '000000' }) }));
    assert.strictEqual(r2.status, 400);

    /* 码错拒绝 */
    const r3 = await call(acc.smsLogin, mockReq('POST', { body: jsonBody({ phone: '13900000001', code: '111111' }) }));
    assert.strictEqual(r3.status, 401);

    /* 同手机再次登录=同一账号(不重复建) */
    const r4 = await call(acc.smsLogin, mockReq('POST', { body: jsonBody({ phone: '13900000001', code: '000000' }) }));
    assert.strictEqual(r4.body.user.id, r1.body.user.id);

    /* smsSend:格式校验+dev 透传 */
    const r5 = await call(acc.smsSend, mockReq('POST', { body: jsonBody({ phone: '13900000001' }) }));
    assert.strictEqual(r5.status, 200);
    assert.strictEqual(r5.body.dev, true, 'dev 后门应透传');
    const r6 = await call(acc.smsSend, mockReq('POST', { body: jsonBody({ phone: 'abc' }) }));
    assert.strictEqual(r6.status, 400);

    /* 存量归一化:旧用户登录链路读出即补 phone/status/nickname,写盘不丢 */
    const stored = store._map.get('users.json');
    const oldUser = stored.find((u) => u.id === 'u_old');
    assert.strictEqual(oldUser.phone, null, '旧用户补 phone:null');
    assert.strictEqual(oldUser.status, 'active', '旧用户补 status:active');
    assert.strictEqual(oldUser.nickname, null, '旧用户补 nickname:null');
    assert.strictEqual(stored.filter((u) => u.phone === '13900000001').length, 1, '同手机号只建一个账号');
    console.log('✓ sms:登录/自动注册/格式与码错/归一化');
  }

  /* ---- 并发注册互斥:两不同手机号同时 smsLogin,谁都不得丢 ---- */
  {
    const base = memoryStorage(seedWorld());
    /* 写延迟 25ms:放大读-改-写窗口,复现生产 OSS 往返下的交错 */
    const store = {
      readJson: base.readJson,
      writeJson: async (key, value) => {
        await new Promise((r) => setTimeout(r, 25));
        base.writeJson(key, value);
      },
      _map: base._map
    };
    const smsSvc = createSmsService({ devResolver: () => '000000', sender: async () => ({ ok: true }) });
    const acc = account.createHandlers(store, { sms: smsSvc, rateLimiter: noopRate() });

    const [ra, rb] = await Promise.all([
      call(acc.smsLogin, mockReq('POST', { body: jsonBody({ phone: '13911110001', code: '000000' }) })),
      call(acc.smsLogin, mockReq('POST', { body: jsonBody({ phone: '13911110002', code: '000000' }) }))
    ]);
    assert.strictEqual(ra.status, 200, 'A 注册登录 200');
    assert.strictEqual(rb.status, 200, 'B 注册登录 200');
    assert.notStrictEqual(ra.body.user.id, rb.body.user.id, '两手机号应是两个账号');
    const users = store._map.get('users.json');
    assert.strictEqual(users.length, 2, '两账号均落盘(无锁时后写旧快照覆盖前写只剩 1)');
    assert.ok(users.some((u) => u.phone === '13911110001'), 'A 在 users.json');
    assert.ok(users.some((u) => u.phone === '13911110002'), 'B 在 users.json');
    console.log('✓ 并发注册互斥:两手机号自动注册均落盘');
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

    console.log('✓ me/player/password:白名单/越权/备份/改密');
  }

  /* ---- redeem 填码跃迁 + 账号昵称 + 绑手机 ---- */
  {
    const seed = seedWorld();
    /* user2:用户名密码账号(user 级、未绑选手、未绑手机)——mePhone 绑手机用例要求账号尚无 phone,
     * 故不能经 smsLogin 造(短信注册账号天生带 phone);pv 取 passHash 尾 8 位 */
    const u2Seed = {
      id: 'u_2', username: 'user2', usernameLower: 'user2',
      passHash: hashPassword('pass12345'), role: 'user', playerId: null, createdAt: '2026-01-01T00:00:00Z'
    };
    seed['users.json'].push(u2Seed);
    const store = memoryStorage(seed);
    const smsSvc = createSmsService({ devResolver: () => '000000', sender: async () => ({ ok: true }) });
    const acc = account.createHandlers(store, { sms: smsSvc, rateLimiter: noopRate() });
    /* 会话 cookie 签发:seed 内账号按其 passHash 尾 8 位(pv);运行时短信注册账号 pv 为空串 */
    const sessCookie = (uid) => {
      const seeded = seed['users.json'].find((u) => u.id === uid);
      return 'sess=' + session.issueFor(uid, seeded ? String(seeded.passHash || '').slice(-8) : '');
    };

    /* r1:短信自动注册的 user 级账号(无 playerId) */
    const r1 = await call(acc.smsLogin, mockReq('POST', { body: jsonBody({ phone: '13900000001', code: '000000' }) }));
    assert.strictEqual(r1.status, 200);
    const user2Id = 'u_2';
    const anotherUserId = user2Id;

    /* ---- redeem 跃迁 ---- */
    /* blank: user → player,选手名取昵称 */
    const rb = await call(acc.redeem, mockReq('POST', {
      body: jsonBody({ code: 'BLANK1' }),
      headers: { cookie: sessCookie(r1.body.user.id) }
    }));
    assert.strictEqual(rb.status, 200);
    assert.strictEqual(rb.body.user.role, 'player');
    assert.ok(rb.body.player.id);
    assert.strictEqual(rb.body.player.name, '用户0001');
    /* 兑码即核销:码文件标记 used/usedBy */
    const usedEntry = store._map.get('invite-codes.json').find((c) => c.code === 'BLANK1');
    assert.strictEqual(usedEntry.used, true);
    assert.strictEqual(usedEntry.usedBy, '13900000001');

    /* 码单次使用 */
    const rb2 = await call(acc.redeem, mockReq('POST', {
      body: jsonBody({ code: 'BLANK1' }),
      headers: { cookie: sessCookie(anotherUserId) }
    }));
    assert.strictEqual(rb2.status, 400);

    /* 已是选手再兑 → 409 */
    const rb3 = await call(acc.redeem, mockReq('POST', {
      body: jsonBody({ code: 'BOUND1' }),
      headers: { cookie: sessCookie(r1.body.user.id) }
    }));
    assert.strictEqual(rb3.status, 409);

    /* bound: user2 继承 p_old */
    const rb4 = await call(acc.redeem, mockReq('POST', {
      body: jsonBody({ code: 'BOUND1' }),
      headers: { cookie: sessCookie(user2Id) }
    }));
    assert.strictEqual(rb4.status, 200);
    assert.strictEqual(rb4.body.user.playerId, 'p_old');

    /* admin 码:player → admin 保留 playerId */
    const rb5 = await call(acc.redeem, mockReq('POST', {
      body: jsonBody({ code: 'ADMIN1' }),
      headers: { cookie: sessCookie(r1.body.user.id) }
    }));
    assert.strictEqual(rb5.status, 200);
    assert.strictEqual(rb5.body.user.role, 'admin');
    assert.strictEqual(rb5.body.user.playerId, rb.body.player.id);

    /* 未登录 401;不存在码 400 */
    assert.strictEqual((await call(acc.redeem, mockReq('POST', { body: jsonBody({ code: 'X' }) }))).status, 401);
    assert.strictEqual((await call(acc.redeem, mockReq('POST', {
      body: jsonBody({ code: 'X' }),
      headers: { cookie: sessCookie(user2Id) }
    }))).status, 400);

    /* ---- 昵称 ---- */
    const rn = await call(acc.me, mockReq('PUT', {
      body: jsonBody({ nickname: '新昵称' }),
      headers: { cookie: sessCookie(user2Id) }
    }));
    assert.strictEqual(rn.status, 200);
    /* nickname 是账号展示名:落 users.json,选手档案名不动 */
    const storedU2 = store._map.get('users.json').find((u) => u.id === user2Id);
    assert.strictEqual(storedU2.nickname, '新昵称');
    assert.strictEqual(seed['data.json'].players.find((p) => p.id === 'p_old').name, '雨橘');
    assert.strictEqual(rn.body.user.nickname, '新昵称');
    /* 昵称与选手资料可同请求混改:两处各自落盘 */
    const rmix = await call(acc.me, mockReq('PUT', {
      body: jsonBody({ nickname: '混改昵称', name: '雨橘Pro' }),
      headers: { cookie: sessCookie(user2Id) }
    }));
    assert.strictEqual(rmix.status, 200);
    assert.strictEqual(rmix.body.user.nickname, '混改昵称');
    assert.strictEqual(rmix.body.player.name, '雨橘Pro');
    /* 空昵称 400 */
    const rbad = await call(acc.me, mockReq('PUT', {
      body: jsonBody({ nickname: '   ' }),
      headers: { cookie: sessCookie(user2Id) }
    }));
    assert.strictEqual(rbad.status, 400);

    /* 纯 user 账号(未兑码、无 playerId)也能改昵称:账号级字段写 users.json,与选手档案无关 */
    const r3 = await call(acc.smsLogin, mockReq('POST', { body: jsonBody({ phone: '13900000003', code: '000000' }) }));
    assert.strictEqual(r3.status, 200);
    const rnick = await call(acc.me, mockReq('PUT', {
      body: jsonBody({ nickname: '路人昵称' }),
      headers: { cookie: sessCookie(r3.body.user.id) }
    }));
    assert.strictEqual(rnick.status, 200);
    assert.strictEqual(store._map.get('users.json').find((u) => u.id === r3.body.user.id).nickname, '路人昵称');
    /* 选手字段守卫仍生效:无 playerId 的请求含选手字段 → 400,且昵称不得先落盘(不半写) */
    const rguard = await call(acc.me, mockReq('PUT', {
      body: jsonBody({ nickname: '不应生效', tag: 'Y' }),
      headers: { cookie: sessCookie(r3.body.user.id) }
    }));
    assert.strictEqual(rguard.status, 400);
    assert.strictEqual(store._map.get('users.json').find((u) => u.id === r3.body.user.id).nickname, '路人昵称');

    /* ---- 绑手机 ---- */
    const rp = await call(acc.mePhone, mockReq('PUT', {
      body: jsonBody({ phone: '13911112222', code: '000000' }),
      headers: { cookie: sessCookie(user2Id) }
    }));
    assert.strictEqual(rp.status, 200);
    assert.strictEqual(store._map.get('users.json').find((u) => u.id === user2Id).phone, '13911112222');
    /* 手机已被 r1 账号占用 → 409 */
    const rp2 = await call(acc.mePhone, mockReq('PUT', {
      body: jsonBody({ phone: '13900000001', code: '000000' }),
      headers: { cookie: sessCookie(user2Id) }
    }));
    assert.strictEqual(rp2.status, 409);

    console.log('✓ redeem/mePhone/nickname:跃迁/码核销/占用冲突/账号昵称');
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

  /* ---- banned 收口:currentUser 视为无会话;两条登录链 403;不污染限速 ---- */
  {
    const seed = seedWorld();
    /* banned 用户:同一账号同时具备密码与手机两条登录链 */
    const bannedUser = {
      id: 'u_banned', username: 'banned1', usernameLower: 'banned1', phone: '13900000004',
      passHash: hashPassword('password8'), role: 'player', playerId: null, status: 'banned', createdAt: 't'
    };
    seed['users.json'].push(bannedUser);
    /* 正常账号:验证 banned 命中不污染限速(连续 banned 尝试后仍可正常登录) */
    seed['users.json'].push({
      id: 'u_ok', username: 'okuser', usernameLower: 'okuser',
      passHash: hashPassword('password8'), role: 'user', playerId: null, status: 'active', createdAt: 't'
    });
    const audits = [];
    const smsSvc = createSmsService({ devResolver: () => '000000', sender: async () => ({ ok: true }) });
    const acc = account.createHandlers(memoryStorage(seed), {
      sms: smsSvc,
      appendAudit: (event, detail) => audits.push(event + ' ' + detail)
    });
    const pvOf = (u) => String(u.passHash || '').slice(-8);

    /* 密码链:密码正确但账号停用 → 403(非 200 非 401) */
    const banPw = await call(acc.login, mockReq('POST', { body: jsonBody({ username: 'banned1', password: 'password8' }) }));
    assert.strictEqual(banPw.status, 403, 'banned 密码登录 403');
    assert.strictEqual(banPw.body.error, '账号已被停用');

    /* 短信链:验码通过后的既有 banned 用户 → 403(新注册路径不可能 banned) */
    const banSms = await call(acc.smsLogin, mockReq('POST', { body: jsonBody({ phone: '13900000004', code: '000000' }) }));
    assert.strictEqual(banSms.status, 403, 'banned 短信登录 403');
    assert.strictEqual(banSms.body.error, '账号已被停用');

    /* 两条链各记一条 auth.login.banned */
    assert.strictEqual(audits.filter((a) => a.startsWith('auth.login.banned')).length, 2, 'audit: 两条链各记 auth.login.banned');

    /* banned 用户持有效签名会话 → /api/me 401(currentUser 拒) */
    assert.strictEqual((await call(acc.me, mockReq('GET', { headers: { cookie: 'sess=' + session.issueFor('u_banned', pvOf(bannedUser)) } }))).status, 401, 'banned 会话视为无效');

    /* banned 命中不计限速失败(身份已确认,非爆破):累计 5 次 banned 尝试后正常账号仍可登录 */
    for (let i = 0; i < 4; i++) {
      const again = await call(acc.login, mockReq('POST', { body: jsonBody({ username: 'banned1', password: 'password8' }) }));
      assert.strictEqual(again.status, 403);
    }
    const stillOk = await call(acc.login, mockReq('POST', { body: jsonBody({ username: 'okuser', password: 'password8' }) }));
    assert.strictEqual(stillOk.status, 200, 'banned 命中不得计入限速失败');

    /* logout 对 banned(currentUser null)按匿名登出,仍 200 */
    const banOut = await call(acc.logout, mockReq('POST', { headers: { cookie: 'sess=' + session.issueFor('u_banned', pvOf(bannedUser)) } }));
    assert.strictEqual(banOut.status, 200, 'logout 对 banned 仍可用');

    console.log('✓ banned:两条登录链 403/会话视为无效/不计限速/可登出');
  }

  /* ---- Task 1 收编:banned sms 命中不清限速计数 + banned audit 带 ip ---- */
  {
    const seed = seedWorld();
    seed['users.json'].push({
      id: 'u_banned2', username: 'banned2', usernameLower: 'banned2', phone: '13900000005',
      passHash: hashPassword('password8'), role: 'user', playerId: null, status: 'banned', createdAt: 't'
    });
    const audits = [];
    const smsSvc = createSmsService({ devResolver: () => '000000', sender: async () => ({ ok: true }) });
    /* 真限速器(非 noop):行为断言依赖失败计数跨请求保留 */
    const acc = account.createHandlers(memoryStorage(seed), {
      sms: smsSvc,
      appendAudit: (event, detail) => audits.push(event + ' ' + detail)
    });

    /* banned sms:audit detail 带 ip(与密码链 'user=xxx ip=1.2.3.4' 惯例一致) */
    const banSms = await call(acc.smsLogin, mockReq('POST', { body: jsonBody({ phone: '13900000005', code: '000000' }) }));
    assert.strictEqual(banSms.status, 403, 'banned 短信登录 403');
    assert.ok(
      audits.includes('auth.login.banned user=banned2 ip=127.0.0.1'),
      'sms 链 banned audit 应含 ip(实际:' + audits.join(' | ') + ')'
    );

    /* banned sms 命中不得清失败计数(旧实现在验码通过即 reset,会清零):
     * 4 次密码失败 → banned sms 命中(若曾 reset 则计数归 0)→ 第 5 次密码失败
     * 触发锁定 → 第 6 次尝试应 429;若 banned sms 曾 reset,此刻计数仅 1,
     * 第 6 次应答 403(banned2 密码正确但账号被封)而非 429,可判别 */
    for (let i = 0; i < 4; i++) {
      const f = await call(acc.login, mockReq('POST', { body: jsonBody({ username: 'banned2', password: 'wrong-' + i }) }));
      assert.strictEqual(f.status, 401, '错误密码 401');
    }
    const again = await call(acc.smsLogin, mockReq('POST', { body: jsonBody({ phone: '13900000005', code: '000000' }) }));
    assert.strictEqual(again.status, 403, 'banned sms 再次命中 403');
    const fifth = await call(acc.login, mockReq('POST', { body: jsonBody({ username: 'banned2', password: 'wrong-4' }) }));
    assert.strictEqual(fifth.status, 401, '第 5 次失败本身仍 401(锁在本次记录后生效)');
    const sixth = await call(acc.login, mockReq('POST', { body: jsonBody({ username: 'banned2', password: 'password8' }) }));
    assert.strictEqual(sixth.status, 429, '计数未被 banned sms 清零 → 第 6 次 429');

    console.log('✓ banned sms:不清限速计数/audit 带 ip');
  }

  delete process.env.SESSION_SECRET;
  console.log('auth-api 全部通过');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
