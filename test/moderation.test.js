'use strict';

/* 审查词库核心:种子灌入(OSS 真源回写)、归一化命中(NFKC 全角/去空白/小写)、
 * 拒绝文案不回显命中词、wordsApi 鉴权矩阵(super-only)+add/remove 即时生效、
 * 词校验(去重/空词/超长>32)、正则转义、空库恒放行、真源优先于种子、导出形态。
 * 合成词纪律:全文件只用「测试违禁甲/乙」与 'badword'/'a.b*c' 等合成词,
 * 不经 fs 碰 deploy/ 真实词表(seedWords 注入);拒绝文案固定不含命中词。 */

const assert = require('node:assert/strict');
const session = require('../api/session');
const devStore = require('../api/dev-store');
const moderation = require('../api/moderation.js');
const { createModeration } = moderation;

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

  delete process.env.SESSION_SECRET;
  console.log('✓ moderation: 54 断言通过');
})().catch((e) => { console.error(e); process.exit(1); });
