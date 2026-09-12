'use strict';

/* 审查词库核心:种子灌入(OSS 真源回写)、归一化命中(NFKC 全角/去空白/小写/零宽字符)、
 * 拒绝文案不回显命中词、wordsApi 鉴权矩阵(super-only)+add/remove 即时生效、
 * 词校验(去重/空词/超长>32)、正则转义、空库恒放行、真源优先于种子、导出形态、
 * 评审裁定(零宽清除/超长丢弃 warn/存储故障 fail-open)、
 * Task 2 写入端拒审钩子(account/decks/templates/data,每端点一正一负)。
 * 合成词纪律:全文件只用「测试违禁甲/乙」与 'badword'/'a.b*c' 等合成词,
 * 不经 fs 碰 deploy/ 真实词表(seedWords 注入);拒绝文案固定不含命中词。 */

const assert = require('node:assert/strict');
const session = require('../api/session');
const devStore = require('../api/dev-store');
const moderation = require('../api/moderation.js');
const { createModeration } = moderation;
const account = require('../api/account');
const decks = require('../api/decks');
const templates = require('../api/templates');
const apiData = require('../api/data');

function boot(seedWords) {
  const store = new Map();
  const storage = {
    readJson: async (k) => (store.has(k) ? store.get(k) : null),
    writeJson: async (k, v) => { store.set(k, v); }
  };
  /* 种子文件注入:options.seedWords 直接给数组,绕开 deploy/ 真实文件 */
  const m = createModeration(storage, { seedWords, now: () => 7 });
  return { m, store };
}

/* Map 存储注入(钩子组各 api 工厂共用,同 decks-api/login-wall 惯例) */
function mapStorage(seed) {
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
    url: o.url || '/api/moderation/words',
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

  /* requireRole 走全局 account 单例:users 种子落模块级 dev-store(同 codes-api.test.js) */
  await devStore.writeJson('users.json', [
    { id: 'u2', username: 'p', usernameLower: 'p', phone: '13900000002', passHash: null, role: 'player', playerId: 'p1', status: 'active', createdAt: 't' },
    { id: 'u3', username: 'a', usernameLower: 'a', phone: '13900000003', passHash: null, role: 'admin', playerId: null, status: 'active', createdAt: 't' },
    { id: 'u5', username: 's', usernameLower: 's', phone: '13900000005', passHash: null, role: 'super', playerId: null, status: 'active', createdAt: 't' }
  ]);
  const ck = (uid) => 'sess=' + session.issueFor(uid, '');

  /* ---- 1) 种子灌入 + 归一化命中 ---- */
  const { m, store } = boot(['测试违禁甲', 'badword']);
  let words = await m.loadWords();
  assert.strictEqual(words.length, 2, '初始 words=2(种子灌入)');
  assert.ok(store.has('blocked-words.json'), '种子缺真源时回写 OSS blocked-words.json');
  assert.deepStrictEqual(store.get('blocked-words.json').words, ['测试违禁甲', 'badword'], '词表按种子顺序入真源');
  assert.strictEqual(store.get('blocked-words.json').updatedAt, '1970-01-01T00:00:00.007Z', 'now 注入落 updatedAt');

  assert.strictEqual((await m.checkText('正常文本')).ok, true, '正常文本放行');
  let r = await m.checkText('含 测 试 违 禁 甲 了');
  assert.strictEqual(r.ok, false, '去空白后命中');
  assert.strictEqual(r.reason, '内容包含不允许的词汇,请修改', '统一拒绝文案');
  assert.ok(!r.reason.includes('测试违禁甲'), '拒绝 reason 不含命中词本身');
  r = await m.checkText('前缀ｂａｄｗｏｒｄ后缀');
  assert.strictEqual(r.ok, false, '全角变体 NFKC 后命中');
  r = await m.checkText('x badWORD y');
  assert.strictEqual(r.ok, false, '大小写归一命中');
  r = await m.checkText('ｂ ａｄｗｏｒｄ');
  assert.strictEqual(r.ok, false, '全角+空白混合命中');
  r = await m.checkText(null);
  assert.strictEqual(r.ok, true, 'null/非字符串按空文本放行');
  r = await m.checkText('正常文本');
  assert.strictEqual(r.reason, null, '放行时 reason 为 null');

  /* wordsRegex:编译缓存,add/remove 后重建 */
  const re0 = m.wordsRegex();
  assert.ok(re0 instanceof RegExp, 'wordsRegex 返回编译缓存');
  assert.strictEqual(re0.test('测试违禁甲'), true);

  /* ---- 2) wordsApi:鉴权矩阵(super-only)---- */
  const api = m.wordsApi;
  assert.strictEqual((await call(api, mockReq('GET'))).status, 401, '匿名 401');
  assert.strictEqual((await call(api, mockReq('GET', { headers: { cookie: ck('u2') } }))).status, 403, 'player 403');
  assert.strictEqual((await call(api, mockReq('GET', { headers: { cookie: ck('u3') } }))).status, 403, 'admin 也 403(GET 仅 super)');
  assert.strictEqual((await call(api, mockReq('POST', { body: '{}', headers: { cookie: ck('u3') } }))).status, 403, 'admin POST 403');
  let g = await call(api, mockReq('GET', { headers: { cookie: ck('u5') } }));
  assert.strictEqual(g.status, 200);
  assert.deepStrictEqual(g.body.words, ['测试违禁甲', 'badword'], 'super GET 列词');

  /* ---- 3) add/remove 生命周期:即时生效 + 词校验 ---- */
  let p = await call(api, mockReq('POST', { body: JSON.stringify({ action: 'add', word: '测试违禁乙' }), headers: { cookie: ck('u5') } }));
  assert.strictEqual(p.status, 200, 'super add 200');
  assert.strictEqual((await m.checkText('中间夹测试违禁乙文本')).ok, false, 'add 后新词立即命中');
  const re1 = m.wordsRegex();
  assert.notStrictEqual(re1, re0, 'add 后正则重建');
  assert.strictEqual(re1.test('测试违禁乙'), true);

  /* 校验拒绝:重复/空词/纯空白/超长(>32)/未知 action/坏 JSON */
  p = await call(api, mockReq('POST', { body: JSON.stringify({ action: 'add', word: '测试违禁乙' }), headers: { cookie: ck('u5') } }));
  assert.strictEqual(p.status, 400, '重复词 400');
  p = await call(api, mockReq('POST', { body: JSON.stringify({ action: 'add', word: '' }), headers: { cookie: ck('u5') } }));
  assert.strictEqual(p.status, 400, '空词 400');
  p = await call(api, mockReq('POST', { body: JSON.stringify({ action: 'add', word: '   ' }), headers: { cookie: ck('u5') } }));
  assert.strictEqual(p.status, 400, '纯空白词 400');
  p = await call(api, mockReq('POST', { body: JSON.stringify({ action: 'add', word: '超'.repeat(33) }), headers: { cookie: ck('u5') } }));
  assert.strictEqual(p.status, 400, '超长词(33>32)400');
  p = await call(api, mockReq('POST', { body: JSON.stringify({ action: 'add', word: '边'.repeat(32) }), headers: { cookie: ck('u5') } }));
  assert.strictEqual(p.status, 200, '恰好 32 字放行');
  p = await call(api, mockReq('POST', { body: JSON.stringify({ action: 'frob', word: 'x' }), headers: { cookie: ck('u5') } }));
  assert.strictEqual(p.status, 400, '未知 action 400');
  p = await call(api, mockReq('POST', { body: 'not-json', headers: { cookie: ck('u5') } }));
  assert.strictEqual(p.status, 400, '坏 JSON 400');
  assert.strictEqual((await call(api, mockReq('DELETE', { headers: { cookie: ck('u5') } }))).status, 405, '非 GET/POST 405');

  /* 归一化去重:全角+空白变体与既有词视为同一个 */
  p = await call(api, mockReq('POST', { body: JSON.stringify({ action: 'add', word: 'ＢＡＤ ＷＯＲＤ' }), headers: { cookie: ck('u5') } }));
  assert.strictEqual(p.status, 400, '归一化后撞既有词 → 400 去重');

  /* 正则元字符转义:词按字面量匹配 */
  p = await call(api, mockReq('POST', { body: JSON.stringify({ action: 'add', word: 'a.b*c' }), headers: { cookie: ck('u5') } }));
  assert.strictEqual(p.status, 200, '含元字符词入库');
  assert.strictEqual((await m.checkText('a.b*c')).ok, false, '元字符词字面命中');
  assert.strictEqual((await m.checkText('aXbYc')).ok, true, '转义后 . 不当通配');

  /* remove:删后不命中、重复删 400 */
  p = await call(api, mockReq('POST', { body: JSON.stringify({ action: 'remove', word: '测试违禁乙' }), headers: { cookie: ck('u5') } }));
  assert.strictEqual(p.status, 200, 'super remove 200');
  assert.strictEqual((await m.checkText('中间夹测试违禁乙文本')).ok, true, 'remove 后不再命中');
  const re2 = m.wordsRegex();
  assert.notStrictEqual(re2, re1, 'remove 后正则重建');
  assert.strictEqual(re2.test('测试违禁乙'), false);
  p = await call(api, mockReq('POST', { body: JSON.stringify({ action: 'remove', word: '测试违禁乙' }), headers: { cookie: ck('u5') } }));
  assert.strictEqual(p.status, 400, '删除不存在的词 400');

  /* 真源持久化:内存态与存储态一致 */
  g = await call(api, mockReq('GET', { headers: { cookie: ck('u5') } }));
  assert.strictEqual(g.body.words.length, 4, 'add/remove 后真源同步(甲+badword+32字边+元字符)');
  assert.deepStrictEqual(store.get('blocked-words.json').words, g.body.words);

  /* ---- 4) 空库:readJson 缺失且无种子 → 恒放行 ---- */
  {
    const { m: mEmpty } = boot([]);
    const w0 = await mEmpty.loadWords();
    assert.strictEqual(w0.length, 0, '无真源无种子=空库');
    assert.strictEqual(mEmpty.wordsRegex(), null, '空库不编译正则');
    assert.strictEqual((await mEmpty.checkText('测试违禁甲')).ok, true, '空库恒放行');
  }

  /* ---- 5) 真源优先:OSS 已有 blocked-words.json 时忽略种子 ---- */
  {
    const store2 = new Map();
    const m2 = createModeration({
      readJson: async (k) => (store2.has(k) ? store2.get(k) : null),
      writeJson: async (k, v) => { store2.set(k, v); }
    }, { seedWords: ['测试违禁甲'] });
    store2.set('blocked-words.json', { words: ['库存合成词'] });
    const w = await m2.loadWords();
    assert.deepStrictEqual(w, ['库存合成词'], '真源存在时不灌种子');
  }

  /* ---- 6) exportForHooks + 模块导出形态 ---- */
  const hooks = m.exportForHooks();
  assert.strictEqual(typeof hooks.checkText, 'function', '钩子面给 checkText');
  assert.strictEqual(typeof hooks.loadWords, 'function', '钩子面给 loadWords');
  assert.strictEqual((await hooks.checkText('正常')).ok, true);
  assert.strictEqual(typeof moderation, 'function', '默认导出=createModeration 工厂');
  assert.strictEqual(typeof moderation.createModeration, 'function', '工厂自别名');
  assert.ok(moderation.shared && typeof moderation.shared.checkText === 'function' && typeof moderation.shared.wordsApi === 'function', 'shared 单例(供 server 挂路由与 Task 2 写入端消费)');

  /* ---- 7) 评审裁定:零宽字符清除 / 超长词条丢弃 warn / 存储故障 fail-open ---- */
  {
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...args) => warns.push(args.map(String).join(' '));
    try {
      /* 零宽字符(ZWSP/ZWLR/BOM)拆词绕不过归一化 */
      const { m: mZw } = boot(['测试违禁甲']);
      assert.strictEqual((await mZw.checkText('测\u200b试违禁甲')).ok, false, 'ZWSP 拆词命中');
      assert.strictEqual((await mZw.checkText('测试违禁\u200e甲')).ok, false, '零宽字符变体命中');
      assert.strictEqual((await mZw.checkText('\ufeff测试违禁甲')).ok, false, 'BOM 前缀命中');

      /* 超长词条丢弃:种子与存量同规则,warn 只记长度不回显词内容 */
      const { m: mLong } = boot(['超'.repeat(40), '好词']);
      assert.deepStrictEqual(await mLong.loadWords(), ['好词'], '超长种子词条被丢弃');
      assert.ok(warns.some((x) => x.includes('超长词条丢弃') && x.includes('len=40')), '丢弃有 warn 留痕(带长度)');
      assert.ok(!warns.join('\n').includes('超'.repeat(40)), 'warn 不回显词内容');
      const stExisting = mapStorage({ 'blocked-words.json': { words: ['x'.repeat(33), '好词'] } });
      const mExisting = createModeration(stExisting);
      assert.deepStrictEqual(await mExisting.loadWords(), ['好词'], '存量超长词条同样丢弃');
      assert.strictEqual(warns.filter((x) => x.includes('超长词条丢弃')).length, 2, '两处丢弃各一条 warn');

      /* 存储故障 fail-open:checkText 放行 + warn;失败自清 memo,下次调用重试 */
      let reads = 0;
      const mBroken = createModeration({
        readJson: async () => { reads += 1; throw new Error('storage boom'); },
        writeJson: async () => {}
      });
      let r2 = await mBroken.checkText('测试违禁甲');
      assert.strictEqual(r2.ok, true, '存储故障放行(fail-open)');
      assert.strictEqual(r2.reason, null, 'fail-open 时 reason 为 null');
      assert.ok(warns.some((x) => x.includes('fail-open')), 'fail-open 有 warn 留痕');
      assert.strictEqual(reads, 1, '本次读取失败');
      await mBroken.checkText('任意');
      assert.strictEqual(reads, 2, '失败自清 memo,下次调用重读');
    } finally {
      console.warn = origWarn;
    }
    console.log('✓ 评审裁定:零宽清除/超长丢弃 warn/存储故障 fail-open');
  }

  /* ---- 8) Task 2 写入端拒审钩子:每端点一正一负(合成词「测试违禁乙」)----
   * account/decks/templates 走各 createHandler/createHandlers 的 options.moderation
   * 注入口(默认 .shared);data.js 是模块级单例,走其 __setModeration 注入口。 */
  {
    const BAD = '测试违禁乙';
    const REJECT = '内容包含不允许的词汇,请修改';
    const modBad = () => boot([BAD]).m;

    /* 8a) account:me PUT 昵称 + 选手资料 name/tag/title 逐字段 */
    {
      const storage = mapStorage({
        'users.json': [{ id: 'u2', username: 'p', usernameLower: 'p', phone: '13900000002', passHash: null, role: 'player', playerId: 'p1', status: 'active', createdAt: 't' }],
        'data.json': { tournaments: [], players: [{ id: 'p1', name: '甲', tag: null, title: null }], activeId: null }
      });
      const acc = account.createHandlers(storage, { moderation: modBad() });
      const cookie = { cookie: 'sess=' + session.issueFor('u2', '') };
      const mePut = (body) => call(acc.me, mockReq('PUT', { body: JSON.stringify(body), headers: cookie }));

      let r = await mePut({ nickname: '昵称' + BAD });
      assert.strictEqual(r.status, 400, 'me PUT 昵称命中 → 400');
      assert.strictEqual(r.body.error, REJECT, '统一拒绝文案');
      assert.ok(!JSON.stringify(r.body).includes(BAD), '响应不回显命中词');
      r = await mePut({ nickname: '正常昵称' });
      assert.strictEqual(r.status, 200, '干净昵称 → 200');
      assert.strictEqual(storage._map.get('users.json')[0].nickname, '正常昵称', '昵称落库');

      r = await mePut({ name: '选' + BAD });
      assert.strictEqual(r.status, 400, 'me PUT 选手名命中 → 400');
      assert.strictEqual(storage._map.get('data.json').players[0].name, '甲', '选手名未落库');
      r = await mePut({ tag: BAD });
      assert.strictEqual(r.status, 400, 'me PUT 队伍 ID 命中 → 400');
      r = await mePut({ title: 'x' + BAD + 'y' });
      assert.strictEqual(r.status, 400, 'me PUT 垃圾话命中 → 400');
      r = await mePut({ name: '新名', tag: '正常队', title: '正常话' });
      assert.strictEqual(r.status, 200, '干净资料 → 200');
      assert.strictEqual(storage._map.get('data.json').players[0].name, '新名', '资料落库');

      /* fail-open 端到端:词库存储故障时写入放行(可用性优先) */
      const mBroken = createModeration({
        readJson: async () => { throw new Error('boom'); },
        writeJson: async () => {}
      });
      const acc2 = account.createHandlers(storage, { moderation: mBroken });
      r = await call(acc2.me, mockReq('PUT', { body: JSON.stringify({ nickname: '故障' + BAD }), headers: cookie }));
      assert.strictEqual(r.status, 200, 'fail-open:词库读失败 → 昵称写入放行');
      assert.strictEqual(storage._map.get('users.json')[0].nickname, '故障' + BAD, 'fail-open 落库');
      console.log('✓ 钩子·account:me PUT 昵称+资料四字段,一正一负+fail-open');
    }

    /* 8b) decks:classlinks 提交的 links[].text(校验段拒审,先于网络解析/锁/落库) */
    {
      const PASS = 'scrypt:00112233445566778899aabb';
      const storage = mapStorage({
        'users.json': [{ id: 'u1', username: 'alice', usernameLower: 'alice', passHash: PASS, role: 'player', playerId: 'P1', createdAt: '2026-01-01T00:00:00Z' }],
        'data.json': {
          activeId: 't1',
          players: [{ id: 'P1', name: '甲' }, { id: 'P2', name: '乙' }],
          tournaments: [{
            id: 't1', name: '测试届', roster: ['P1', 'P2'],
            canvas: { cards: [{ id: 'c1', label: '首场', format: 'BO3', slots: [{ type: 'player', playerId: 'P1' }, { type: 'player', playerId: 'P2' }], classLinks: { a: [], b: [] } }] },
            scores: {}, deckWindow: { manual: 'open' }, updatedAt: 1
          }]
        }
      });
      const users = storage._map.get('users.json');
      const findUser = async (req) => {
        const payload = session.sessionOf(req);
        const u = users.find((x) => x.id === (payload && payload.uid));
        return (u && payload.pv === u.passHash.slice(-8)) ? u : null;
      };
      const h = decks.createHandler(storage, { moderation: modBad(), currentUser: findUser, appendAudit: () => {}, backupData: async () => {} });
      const cookie = { cookie: 'sess=' + session.issueFor('u1', PASS.slice(-8)) };
      const submit = (links) => call(h.submit, mockReq('PUT', { body: JSON.stringify({ tournamentId: 't1', cardId: 'c1', side: 'a', links }), headers: cookie }));

      let r = await submit([{ cls: '皇家', text: '备注' + BAD }]);
      assert.strictEqual(r.status, 400, '卡组备注命中 → 400');
      assert.strictEqual(r.body.error, REJECT, '统一拒绝文案');
      assert.deepStrictEqual(storage._map.get('data.json').tournaments[0].canvas.cards[0].classLinks.a, [], '未落库');
      r = await submit([{ cls: '皇家', text: '速攻' }]);
      assert.strictEqual(r.status, 200, '干净备注 → 200');
      assert.deepStrictEqual(storage._map.get('data.json').tournaments[0].canvas.cards[0].classLinks.a, [{ cls: '皇家', url: '', text: '速攻' }], '落库');
      console.log('✓ 钩子·decks:classlinks links[].text,一正一负');
    }

    /* 8c) templates:个人库模板名 + 市场 adopt renameTo(normalizeTemplate 之后过检) */
    {
      const storage = mapStorage({});
      const th = templates.createHandler(storage, { moderation: modBad(), appendAudit: () => {}, backupJson: async () => {} });
      const cookie = { cookie: ck('u5') };
      const putLib = (templates_) => call(th.personal, mockReq('PUT', { url: '/api/templates', body: JSON.stringify({ templates: templates_ }), headers: cookie }));

      let r = await putLib([{ name: BAD, cards: [] }]);
      assert.strictEqual(r.status, 400, '个人库模板名命中 → 400');
      assert.strictEqual(r.body.error, REJECT, '统一拒绝文案');
      assert.strictEqual((await th.__getLibrary('u5')).length, 0, '未落库');
      r = await putLib([{ name: '正常模板', cards: [{ kind: 'match' }] }]);
      assert.strictEqual(r.status, 200, '干净模板名 → 200');
      assert.strictEqual((await th.__getLibrary('u5')).length, 1, '落库');

      /* 市场 adopt:renameTo 缺省沿用快照名同样过检 */
      const saved = (await th.__getLibrary('u5'))[0];
      await th.__marketAction({ id: 'u5', username: 's', role: 'super' }, { action: 'list', templateId: saved.id });
      const mid = (await th.__marketList()).market[0].id;
      const adopt = (renameTo) => call(th.market, mockReq('POST', { url: '/api/templates/market', body: JSON.stringify({ action: 'adopt', marketId: mid, renameTo }), headers: cookie }));
      r = await adopt('改' + BAD);
      assert.strictEqual(r.status, 400, 'adopt renameTo 命中 → 400');
      assert.strictEqual((await th.__getLibrary('u5')).length, 1, 'adopt 未落库');
      r = await adopt('正常新名');
      assert.strictEqual(r.status, 200, '干净 renameTo → 200');
      assert.strictEqual((await th.__getLibrary('u5')).length, 2, 'adopt 落库');
      console.log('✓ 钩子·templates:个人库名+adopt renameTo,各一正一负');
    }

    /* 8d) data:整库 PUT 扫描卡片 label/phase/format + 选手 name/tag/title
     * (管理端选手编辑无独立端点,走整库 PUT,在此覆盖);命中提示带届名+卡 id 不带词 */
    {
      apiData.__setModeration(modBad());
      const wsSeed = {
        tournaments: [{ id: 't1', name: '钩子届', canvas: { cards: [{ id: 'c1', label: '干净标题', phase: '胜者组', format: 'BO3' }] } }],
        series: [],
        players: [{ id: 'p1', name: '甲', tag: null, title: null }],
        activeId: 't1'
      };
      await devStore.writeJson('data.json', wsSeed);
      const put = (ws) => call(apiData, mockReq('PUT', { url: '/api/data', body: JSON.stringify(ws), headers: { cookie: ck('u5') } }));

      let bad = JSON.parse(JSON.stringify(wsSeed));
      bad.tournaments[0].canvas.cards[0].label = '标题' + BAD;
      let r = await put(bad);
      assert.strictEqual(r.status, 400, '整库 PUT 卡标题命中 → 400');
      assert.ok(r.body.error.includes('钩子届') && r.body.error.includes('c1'), '提示带届名+卡 id');
      assert.ok(!r.body.error.includes(BAD), '提示不带命中词');
      assert.strictEqual((await devStore.readJson('data.json')).tournaments[0].canvas.cards[0].label, '干净标题', '未落库');

      bad = JSON.parse(JSON.stringify(wsSeed));
      bad.players[0].name = '选手' + BAD;
      r = await put(bad);
      assert.strictEqual(r.status, 400, '整库 PUT 选手名命中 → 400(管理端选手编辑路径)');
      assert.ok(r.body.error.includes('p1'), '提示带选手 id');

      r = await put(JSON.parse(JSON.stringify(wsSeed)));
      assert.strictEqual(r.status, 200, '干净整库 → 200');
      assert.strictEqual((await devStore.readJson('data.json')).tournaments[0].canvas.cards[0].label, '干净标题', '落库');
      apiData.__setModeration(moderation.shared);
      console.log('✓ 钩子·data:整库 PUT 卡文本+选手字段,一正一负');
    }
  }

  /* ---- 9) Task 3:举报通道(reports)+ data 整库 PUT classLinks 绕面闭合 ---- */
  {
    const BAD = '测试违禁乙';
    const REJECT = '内容包含不允许的词汇,请修改';
    const reports = require('../api/reports');

    /* 9a) data:整库 PUT 卡 classLinks[].text(admin 绕面,比赛卡 {a,b} 与 roll 池数组两形态) */
    {
      apiData.__setModeration(boot([BAD]).m);
      const wsSeed = {
        tournaments: [{ id: 't1', name: '绕面届', canvas: { cards: [
          { id: 'c1', label: '干净标题', phase: '胜者组', format: 'BO3', classLinks: { a: [], b: [] } }
        ] } }],
        series: [],
        players: [{ id: 'p1', name: '甲', tag: null, title: null }],
        activeId: 't1'
      };
      await devStore.writeJson('data.json', wsSeed);
      const put = (ws) => call(apiData, mockReq('PUT', { url: '/api/data', body: JSON.stringify(ws), headers: { cookie: ck('u5') } }));

      const bad = JSON.parse(JSON.stringify(wsSeed));
      bad.tournaments[0].canvas.cards[0].classLinks.a = [{ cls: '皇家', url: '', text: '备注' + BAD }];
      let r = await put(bad);
      assert.strictEqual(r.status, 400, '整库 PUT 卡组备注命中 → 400');
      assert.ok(r.body.error.includes('绕面届') && r.body.error.includes('c1'), '提示带届名+卡 id');
      assert.ok(!r.body.error.includes(BAD), '提示不带命中词');
      assert.strictEqual((await devStore.readJson('data.json')).tournaments[0].canvas.cards[0].classLinks.a.length, 0, '未落库');

      const badPool = JSON.parse(JSON.stringify(wsSeed));
      badPool.tournaments[0].canvas.cards[0].classLinks = [[{ cls: '皇家', url: '', text: 'x' + BAD + 'y' }]];
      r = await put(badPool);
      assert.strictEqual(r.status, 400, 'roll 池数组形态备注命中 → 400');

      r = await put(JSON.parse(JSON.stringify(wsSeed)));
      assert.strictEqual(r.status, 200, '干净整库(含空 classLinks)→ 200');
      apiData.__setModeration(moderation.shared);
      console.log('✓ 绕面闭合:data 整库 PUT classLinks[].text(对象/数组两形态)');
    }

    /* 9b) reports:POST 权限/长度/违禁 detail 拒;GET super 倒序;PUT 三动作语义+409 */
    {
      const storage = mapStorage({
        'data.json': {
          tournaments: [], series: [], activeId: null,
          players: [
            { id: 'p12345678', name: '坏名字', tag: '队标字', title: null, avatar: 'https://x/a.png', tagImg: 'https://x/t.png', tagImgRatio: 2, tagImgSize: 64 },
            { id: 'p2', name: '乙', avatar: null, tagImg: null }
          ]
        },
        'users.json': [
          { id: 'u2', username: 'p', usernameLower: 'p', phone: '13900000002', passHash: null, role: 'player', playerId: 'p12345678', nickname: '旧昵称', status: 'active', createdAt: 't' },
          { id: 'u5', username: 's', usernameLower: 's', phone: '13900000005', passHash: null, role: 'super', playerId: null, nickname: null, status: 'active', createdAt: 't' }
        ]
      });
      const audits = [];
      const h = reports.createHandler(storage, {
        now: () => 42,
        appendAudit: (action, detail) => audits.push(action + ' | ' + detail),
        moderation: boot([BAD]).m
      });
      const post = (body, cookie) => call(h, mockReq('POST', { url: '/api/reports', body: JSON.stringify(body), headers: cookie || { cookie: ck('u2') } }));
      const put = (body, cookie) => call(h, mockReq('PUT', { url: '/api/reports', body: JSON.stringify(body), headers: cookie || { cookie: ck('u5') } }));
      const get = (cookie) => call(h, mockReq('GET', { url: '/api/reports', headers: cookie || { cookie: ck('u5') } }));

      /* POST:权限 */
      assert.strictEqual((await post({ kind: 'other', detail: 'x' }, {})).status, 401, '匿名 POST 401');
      assert.strictEqual((await get({})).status, 401, '匿名 GET 401');
      assert.strictEqual((await get({ cookie: ck('u3') })).status, 403, 'admin GET 403');
      assert.strictEqual((await put({ id: 'r_x', action: 'dismiss' }, { cookie: ck('u3') })).status, 403, 'admin PUT 403');

      /* POST:校验矩阵 */
      assert.strictEqual((await post({ kind: 'frob', detail: 'x' })).status, 400, '未知 kind 400');
      assert.strictEqual((await post({ kind: 'nickname', detail: '' })).status, 400, '空 detail 400');
      assert.strictEqual((await post({ kind: 'nickname', detail: 'x'.repeat(201) })).status, 400, 'detail 201 字 400');
      assert.strictEqual((await post({ kind: 'nickname', detail: 'x'.repeat(200) })).status, 200, 'detail 恰 200 字 200');
      let r = await post({ kind: 'nickname', detail: '选手昵称里有' + BAD });
      assert.strictEqual(r.status, 400, '违禁 detail 拒 400');
      assert.strictEqual(r.body.error, REJECT, '统一拒绝文案');
      assert.ok(!JSON.stringify(r.body).includes(BAD), '响应不回显命中词');

      /* POST:落库形态+审计 */
      const stored0 = storage._map.get('reports.json');
      assert.strictEqual(stored0.length, 1, '被拒的不落库,仅存 200 字那条');
      r = await post({ kind: 'nickname', detail: '选手 p12345678 昵称违规' });
      assert.strictEqual(r.status, 200, '干净举报 200');
      const list0 = storage._map.get('reports.json');
      assert.strictEqual(list0.length, 2, '追加一条');
      const entry = list0[1];
      assert.ok(/^r_/.test(entry.id), 'id 前缀 r_');
      assert.strictEqual(entry.uid, 'u2', 'uid 落举报人');
      assert.strictEqual(entry.username, 'p', 'username 落举报人');
      assert.strictEqual(entry.kind, 'nickname', 'kind 落库');
      assert.strictEqual(entry.at, '1970-01-01T00:00:00.042Z', 'at 走注入时钟');
      assert.strictEqual(entry.handled, null, 'handled 初始 null');
      assert.ok(audits.some((x) => x.startsWith('report.new | by=p')), 'audit report.new 带 by=');

      /* GET:super 最近 200 倒序 */
      r = await get();
      assert.strictEqual(r.status, 200, 'super GET 200');
      assert.strictEqual(r.body.reports.length, 2, '两条都在');
      assert.strictEqual(r.body.reports[0].id, entry.id, '新在前(倒序)');
      assert.ok(r.body.reports.every((x) => x.kind === 'nickname' && typeof x.detail === 'string'), '公共字段齐');

      /* PUT:dismiss 只标记 */
      r = await put({ id: list0[0].id, action: 'dismiss' });
      assert.strictEqual(r.status, 200, 'dismiss 200');
      const dismissed = storage._map.get('reports.json')[0];
      assert.strictEqual(dismissed.handled.action, 'dismiss', 'handled.action=dismiss');
      assert.strictEqual(dismissed.handled.by, 's', 'handled.by=操作超管');
      assert.strictEqual(dismissed.handled.at, '1970-01-01T00:00:00.042Z', 'handled.at 走注入时钟');
      assert.strictEqual(dismissed.detail, 'x'.repeat(200), 'dismiss 不动内容');
      assert.ok(audits.some((x) => x.startsWith('report.handle |') && x.includes('by=s')), 'audit report.handle');
      assert.strictEqual((await put({ id: list0[0].id, action: 'dismiss' })).status, 409, '重复处理 409');

      /* PUT:name-reset 双改(player.name 与 user.nickname 同改「选手」+尾4) */
      r = await put({ id: entry.id, action: 'name-reset', playerId: 'p12345678' });
      assert.strictEqual(r.status, 200, 'name-reset 200');
      const player = storage._map.get('data.json').players.find((x) => x.id === 'p12345678');
      assert.strictEqual(player.name, '选手5678', 'player.name 改为 选手+playerId 尾 4');
      const u2 = storage._map.get('users.json').find((x) => x.id === 'u2');
      assert.strictEqual(u2.nickname, '选手5678', '对应 user.nickname 同改');
      assert.strictEqual(storage._map.get('reports.json')[1].handled.action, 'name-reset', 'handled 标记');
      assert.ok(audits.some((x) => x.startsWith('mod.name-reset |') && x.includes('p12345678') && x.includes('by=s')), 'audit mod.name-reset 带 player+by=');
      assert.strictEqual((await put({ id: entry.id, action: 'name-reset', playerId: 'p12345678' })).status, 409, '再处理 409');

      /* PUT:avatar-clear 四字段清、其余不动 */
      r = await post({ kind: 'avatar', detail: '头像不当' });
      const id3 = storage._map.get('reports.json')[2].id;
      r = await put({ id: id3, action: 'avatar-clear', playerId: 'p12345678' });
      assert.strictEqual(r.status, 200, 'avatar-clear 200');
      const player2 = storage._map.get('data.json').players.find((x) => x.id === 'p12345678');
      assert.strictEqual(player2.avatar, null, 'avatar 置 null');
      assert.strictEqual(player2.tagImg, null, 'tagImg 置 null');
      assert.strictEqual(player2.tagImgRatio, null, 'tagImgRatio 置 null');
      assert.strictEqual(player2.tagImgSize, null, 'tagImgSize 置 null');
      assert.strictEqual(player2.name, '选手5678', 'name 不动');
      assert.strictEqual(player2.tag, '队标字', 'tag 不动');
      assert.strictEqual(player2.title, null, 'title 不动');
      assert.ok(audits.some((x) => x.startsWith('mod.avatar-clear |') && x.includes('p12345678') && x.includes('by=s')), 'audit mod.avatar-clear');

      /* PUT:校验矩阵(未处理举报一条 + 已处理语义在上) */
      r = await post({ kind: 'other', detail: 'y' });
      const id4 = storage._map.get('reports.json')[3].id;
      assert.strictEqual((await put({ id: 'r_missing', action: 'dismiss' })).status, 404, '举报不存在 404');
      assert.strictEqual((await put({ id: id4, action: 'frob' })).status, 400, '未知 action 400');
      assert.strictEqual((await put({ id: id4, action: 'name-reset' })).status, 400, 'name-reset 缺 playerId 400');
      assert.strictEqual((await put({ id: id4, action: 'avatar-clear' })).status, 400, 'avatar-clear 缺 playerId 400');
      assert.strictEqual((await put({ id: id4, action: 'name-reset', playerId: 'p404' })).status, 404, 'playerId 不存在 404');
      assert.strictEqual((await call(h, mockReq('DELETE', { url: '/api/reports', headers: { cookie: ck('u5') } }))).status, 405, '非 GET/POST/PUT 405');

      /* GET:最近 200 截断 */
      for (let i = 0; i < 205; i++) await post({ kind: 'other', detail: '压测' + i });
      r = await get();
      assert.strictEqual(r.body.reports.length, 200, '超 200 条截到最近 200');
      assert.strictEqual(r.body.reports[0].detail, '压测204', '最新在前');
      console.log('✓ reports:POST 矩阵/GET 倒序截断/PUT 三动作语义+409');
    }
  }

  delete process.env.SESSION_SECRET;
  console.log('✓ moderation: 163 断言通过');
})().catch((e) => { console.error(e); process.exit(1); });
