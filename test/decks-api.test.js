'use strict';

/* 卡组提交窗口行为测试(内存存储注入,不联网):
 * isWindowOpen 三态/跨零点、links 归一化、归属/锁定/窗口校验、
 * GET 未公示剥离(admin 全见/本人可见/对手被剥)。 */

const assert = require('node:assert');
const session = require('../api/session');
const decks = require('../api/decks');
const { isWindowOpen, normalizeLinks, createHandler } = decks;
const { stripHiddenDecks } = require('../api/data');

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

const P1 = 'p_1', P2 = 'p_2';
const PASS = 'scrypt:00112233445566778899aabb';

function seedWorld(deckWindow) {
  return {
    'users.json': [{
      id: 'u1', username: 'alice', usernameLower: 'alice',
      passHash: PASS, role: 'player', playerId: P1, createdAt: '2026-01-01T00:00:00Z'
    }],
    'data.json': {
      activeId: 't1',
      players: [{ id: P1, name: '甲' }, { id: P2, name: '乙' }],
      tournaments: [{
        id: 't1', name: '测试届',
        roster: [P1, P2],
        canvas: {
          cards: [
            { id: 'c1', label: '首场', format: 'BO3', slots: [{ type: 'player', playerId: P1 }, { type: 'player', playerId: P2 }], classLinks: { a: [], b: [] } },
            { id: 'c2', label: '已赛场', format: 'BO3', slots: [{ type: 'player', playerId: P1 }, { type: 'player', playerId: P2 }], classLinks: { a: [{ cls: '精灵', url: 'https://x', text: '旧' }], b: [] } }
          ]
        },
        scores: { c2: { a: 2, b: 0 } },
        deckWindow,
        updatedAt: 1
      }]
    }
  };
}

async function main() {
  process.env.SESSION_SECRET = 'test-secret';

  /* ---- isWindowOpen ---- */
  assert.strictEqual(isWindowOpen({ deckWindow: { manual: 'open' } }), true, '手动开');
  assert.strictEqual(isWindowOpen({ deckWindow: { manual: 'closed' } }), false, '手动关');
  assert.strictEqual(isWindowOpen({}), false, '无配置恒关');
  assert.strictEqual(isWindowOpen({ deckWindow: { open: '09:00', close: '17:00' } }, new Date('2026-08-25T10:00:00')), true, '时段内');
  assert.strictEqual(isWindowOpen({ deckWindow: { open: '09:00', close: '17:00' } }, new Date('2026-08-25T18:00:00')), false, '时段外');
  assert.strictEqual(isWindowOpen({ deckWindow: { open: '20:00', close: '02:00' } }, new Date('2026-08-25T23:00:00')), true, '跨零点内');
  assert.strictEqual(isWindowOpen({ deckWindow: { open: '20:00', close: '02:00' } }, new Date('2026-08-25T10:00:00')), false, '跨零点外');
  assert.strictEqual(isWindowOpen({ deckWindow: { open: '09:00' } }), false, '时段缺失恒关');
  console.log('✓ isWindowOpen:手动/定时/跨零点/缺失');

  /* ---- normalizeLinks ---- */
  assert.deepStrictEqual(
    normalizeLinks([{ cls: '精灵', text: '进化虫' }, { cls: '不存在的职业', text: 'x' }, { cls: '法师' }, { cls: '龙族', url: 'https://d' }, 'junk']),
    [{ cls: '精灵', url: '', text: '进化虫' }, { cls: '龙族', url: 'https://d', text: '' }],
    '白名单归一化'
  );
  assert.strictEqual(normalizeLinks('x'), null, '非数组拒绝');
  assert.deepStrictEqual(normalizeLinks([]), [], '空数组=恢复继承');
  assert.strictEqual(normalizeLinks(new Array(20).fill({ cls: '精灵', text: 'x' })).length, 12, '上限 12 条');
  console.log('✓ normalizeLinks:白名单/空数组/上限');

  /* ---- submit:走通/归属/锁定/窗口 ---- */
  const pv = PASS.slice(-8);
  const cookie = 'sess=' + session.issueFor('u1', pv, Date.now);
  const auth = { cookie };
  const audits = [];

  /* 与内存 storage 同源的会话→用户解析(生产环境由全局 account 承担) */
  function makeFindUser(storage) {
    const users = storage._map.get('users.json');
    return async (req) => {
      const payload = session.sessionOf(req);
      const u = users.find((x) => x.id === (payload && payload.uid));
      return (u && payload.pv === u.passHash.slice(-8)) ? u : null;
    };
  }

  /* ---- 生产注入回归:now=Date.now(函数,返回毫秒数) ---- */
  {
    let threw = null;
    try {
      const v = isWindowOpen({ deckWindow: { open: '00:00', close: '23:59' } }, Date.now);
      assert.strictEqual(typeof v, 'boolean', 'now=Date.now 返回布尔');
    } catch (error) {
      threw = error;
    }
    assert.ok(!threw, 'now=Date.now(生产 data.js/submit 的注入形态)不得抛错: ' + (threw && threw.message));
    assert.strictEqual(
      typeof isWindowOpen({ deckWindow: { open: '00:00', close: '23:59' } }, () => 1788000000000),
      'boolean',
      'now 为返回毫秒数的函数同样生效'
    );
    console.log('✓ isWindowOpen:now=Date.now 函数形态(生产路径回归)');

    const storage = memoryStorage(seedWorld({ open: '00:00', close: '23:59' }));
    const h = createHandler(storage, { appendAudit: () => {}, currentUser: makeFindUser(storage) });
    let status = null;
    let err = null;
    try {
      const r = await call(h.submit, mockReq('PUT', {
        headers: auth,
        body: json({ tournamentId: 't1', cardId: 'c1', side: 'a', links: [{ cls: '皇家', text: '定时窗' }] })
      }));
      status = r.status;
    } catch (error) {
      err = error;
    }
    assert.ok(!err, '定时窗口提交不得抛错: ' + (err && err.message));
    assert.strictEqual(status, 200, '定时窗口(全时段开)提交 → 200');
    console.log('✓ submit:定时窗口 + 生产 now 注入走通');
  }

  /* ---- 并发提交互斥:两人同时提交同场不同侧,谁都不许丢 ---- */
  {
    const seed = seedWorld({ manual: 'open' });
    seed['users.json'].push({
      id: 'u2', username: 'bob', usernameLower: 'bob',
      passHash: PASS, role: 'player', playerId: P2, createdAt: '2026-01-01T00:00:00Z'
    });
    const base = memoryStorage(seed);
    /* 写延迟 25ms:放大读-改-写窗口,复现生产 OSS 往返下的交错 */
    const storage = {
      readJson: base.readJson,
      writeJson: async (key, value) => {
        await new Promise((r) => setTimeout(r, 25));
        base.writeJson(key, value);
      },
      _map: base._map
    };
    const h = createHandler(storage, { appendAudit: () => {}, backupData: async () => {}, currentUser: makeFindUser(storage) });
    const cookie2 = 'sess=' + session.issueFor('u2', pv, Date.now);
    const [ra, rb] = await Promise.all([
      call(h.submit, mockReq('PUT', {
        headers: { cookie },
        body: json({ tournamentId: 't1', cardId: 'c1', side: 'a', links: [{ cls: '法师', text: 'A套' }] })
      })),
      call(h.submit, mockReq('PUT', {
        headers: { cookie: cookie2 },
        body: json({ tournamentId: 't1', cardId: 'c1', side: 'b', links: [{ cls: '龙族', text: 'B套' }] })
      }))
    ]);
    assert.strictEqual(ra.status, 200, 'A 提交 200');
    assert.strictEqual(rb.status, 200, 'B 提交 200');
    const links = storage._map.get('data.json').tournaments[0].canvas.cards[0].classLinks;
    assert.deepStrictEqual(links.a.map((l) => l.text), ['A套'], '并发下 A 的提交不丢');
    assert.deepStrictEqual(links.b.map((l) => l.text), ['B套'], '并发下 B 的提交不丢');
    console.log('✓ 并发提交互斥:双方提交均落盘');
  }

  {
    const storage = memoryStorage(seedWorld({ manual: 'open' }));
    const h = createHandler(storage, { appendAudit: (a, d) => audits.push(a + ' ' + d), currentUser: makeFindUser(storage) });

    const ok = await call(h.submit, mockReq('PUT', {
      headers: auth,
      body: json({ tournamentId: 't1', cardId: 'c1', side: 'a', links: [{ cls: '皇家', text: '速攻', url: 'https://deck' }] })
    }));
    assert.strictEqual(ok.status, 200, '本人本侧窗口开 → 200');
    const card = storage._map.get('data.json').tournaments[0].canvas.cards[0];
    assert.deepStrictEqual(card.classLinks.a, [{ cls: '皇家', url: 'https://deck', text: '速攻' }], '写入 classLinks.a');
    assert.ok(storage._map.get('data.json').tournaments[0].updatedAt > 1, 'bump updatedAt');
    assert.ok(audits.some((a) => a.startsWith('deck.submit')), '写审计');

    const wrongSide = await call(h.submit, mockReq('PUT', {
      headers: auth,
      body: json({ tournamentId: 't1', cardId: 'c1', side: 'b', links: [{ cls: '皇家', text: 'x' }] })
    }));
    assert.strictEqual(wrongSide.status, 403, '不是自己的侧 → 403');

    const scored = await call(h.submit, mockReq('PUT', {
      headers: auth,
      body: json({ tournamentId: 't1', cardId: 'c2', side: 'a', links: [] })
    }));
    assert.strictEqual(scored.status, 423, '已录比分 → 423');

    const empty = await call(h.submit, mockReq('PUT', {
      headers: auth,
      body: json({ tournamentId: 't1', cardId: 'c1', side: 'a', links: [] })
    }));
    assert.strictEqual(empty.status, 200, '空提交 → 200');
    assert.deepStrictEqual(storage._map.get('data.json').tournaments[0].canvas.cards[0].classLinks.a, [], '空提交写 [](恢复继承)');

    const noLogin = await call(h.submit, mockReq('PUT', {
      body: json({ tournamentId: 't1', cardId: 'c1', side: 'a', links: [] })
    }));
    assert.strictEqual(noLogin.status, 401, '无会话 → 401');

    const notFound = await call(h.submit, mockReq('PUT', {
      headers: auth,
      body: json({ tournamentId: 't9', cardId: 'c1', side: 'a', links: [] })
    }));
    assert.strictEqual(notFound.status, 404, '届不存在 → 404');
    console.log('✓ submit:走通/归属/已赛/空提交/未登录/404');
  }

  {
    const storage = memoryStorage(seedWorld({ manual: 'closed' }));
    const h = createHandler(storage, { currentUser: makeFindUser(storage) });
    const closed = await call(h.submit, mockReq('PUT', {
      headers: auth,
      body: json({ tournamentId: 't1', cardId: 'c1', side: 'a', links: [{ cls: '皇家', text: 'x' }] })
    }));
    assert.strictEqual(closed.status, 423, '窗口关 → 423');
  }

  /* 旧 pv 会话被拒(密码改过) */
  {
    const storage = memoryStorage(seedWorld({ manual: 'open' }));
    const h = createHandler(storage, { currentUser: makeFindUser(storage) });
    const stale = await call(h.submit, mockReq('PUT', {
      headers: { cookie: 'sess=' + session.issueFor('u1', '00000000', Date.now) },
      body: json({ tournamentId: 't1', cardId: 'c1', side: 'a', links: [] })
    }));
    assert.strictEqual(stale.status, 401, '旧 pv 会话 → 401');
  }
  console.log('✓ submit:窗口关/旧会话');

  /* ---- WB 链接解析集成(注入 resolveDeck,不出网) ---- */
  const WB_URL = 'https://shadowverse-wb.com/chs/deck/detail/?hash=1.2.aaaa.bbbb.cccc';
  const SNAPSHOT = { v: 1, resolvedAt: 'T', classId: 2, format: 1, cards: [[10021110, '须臾剑士', 1, 1, 1, 3]] };

  {
    const storage = memoryStorage(seedWorld({ manual: 'open' }));
    const calls = [];
    const h = createHandler(storage, {
      appendAudit: (a, d) => audits.push(a + ' ' + d),
      currentUser: makeFindUser(storage),
      resolveDeck: async (hash) => { calls.push(hash); return { ok: true, deck: SNAPSHOT }; }
    });
    const r = await call(h.submit, mockReq('PUT', {
      headers: auth,
      body: json({ tournamentId: 't1', cardId: 'c1', side: 'a', links: [
        { cls: '精灵', url: WB_URL, text: '' },
        { cls: '法师', url: 'https://other', text: '' },
        { cls: '龙族', text: '备注' }
      ] })
    }));
    assert.strictEqual(r.status, 200, '解析成功也 200');
    const saved = storage._map.get('data.json').tournaments[0].canvas.cards[0].classLinks.a;
    assert.strictEqual(saved[0].cls, '皇家', 'cls 以解析结果纠错');
    assert.deepStrictEqual(saved[0].deck, SNAPSHOT, '快照内嵌');
    assert.ok(!('deck' in saved[1]) && !('deck' in saved[2]), '非 WB/无 url 条目无快照');
    assert.deepStrictEqual(calls, ['1.2.aaaa.bbbb.cccc'], '仅 WB hash 进解析器');
    assert.ok(audits.some((a) => a.includes('resolved=1/1')), '审计含 resolved');
    assert.ok(Array.isArray(r.body.links) && r.body.links[0].deck, '响应带快照');
    console.log('✓ submit:WB 解析成功/cls 纠错/非 WB 跳过/审计 resolved');
  }

  {
    const storage = memoryStorage(seedWorld({ manual: 'open' }));
    const h = createHandler(storage, {
      appendAudit: () => {},
      currentUser: makeFindUser(storage),
      resolveDeck: async () => { throw new Error('resolver boom'); }
    });
    const r = await call(h.submit, mockReq('PUT', {
      headers: auth,
      body: json({ tournamentId: 't1', cardId: 'c1', side: 'a', links: [{ cls: '皇家', url: WB_URL, text: '' }] })
    }));
    assert.strictEqual(r.status, 200, '解析器抛错不阻塞提交');
    const saved = storage._map.get('data.json').tournaments[0].canvas.cards[0].classLinks.a;
    assert.strictEqual(saved[0].cls, '皇家', '失败保留手选 cls');
    assert.ok(!('deck' in saved[0]), '失败无快照=静默降级');
    console.log('✓ submit:解析器异常静默降级');
  }

  {
    const storage = memoryStorage(seedWorld({ manual: 'closed' }));
    let called = 0;
    const h = createHandler(storage, {
      currentUser: makeFindUser(storage),
      resolveDeck: async () => { called++; return { ok: true, deck: SNAPSHOT }; }
    });
    const r = await call(h.submit, mockReq('PUT', {
      headers: auth,
      body: json({ tournamentId: 't1', cardId: 'c1', side: 'a', links: [{ cls: '皇家', url: WB_URL, text: '' }] })
    }));
    assert.strictEqual(r.status, 423, '窗口关仍 423(解析白做但语义不变)');
    assert.strictEqual(called, 1, '锁外解析确实执行');
    console.log('✓ submit:窗口关 423 不受解析影响');
  }

  /* ---- 快照复用:同届已存同 hash → 不再二次出网,表单丢快照也能续上 ---- */
  {
    const seed = seedWorld({ manual: 'open' });
    /* c2 b 侧预置一条已解析条目(同 WB_URL),模拟选手晋级后上游场次的存量快照 */
    seed['data.json'].tournaments[0].canvas.cards[0].classLinks.b = [
      { cls: '皇家', url: WB_URL, text: '', deck: SNAPSHOT }
    ];
    const storage = memoryStorage(seed);
    let called = 0;
    const audits2 = [];
    const h = createHandler(storage, {
      appendAudit: (a, d) => audits2.push(d),
      currentUser: makeFindUser(storage),
      resolveDeck: async () => { called++; return { ok: true, deck: SNAPSHOT }; }
    });
    const r = await call(h.submit, mockReq('PUT', {
      headers: auth,
      body: json({ tournamentId: 't1', cardId: 'c1', side: 'a', links: [
        { cls: '精灵', url: WB_URL, text: '同链接重交' },
        { cls: '皇家', url: 'https://shadowverse-wb.com/chs/deck/detail/?hash=1.3.newCard.x', text: '' }
      ] })
    }));
    assert.strictEqual(r.status, 200, '复用场景提交 200');
    assert.strictEqual(called, 1, '同 hash 走缓存,仅新 hash 出网一次');
    const saved = storage._map.get('data.json').tournaments[0].canvas.cards[0].classLinks.a;
    assert.deepStrictEqual(saved[0].deck, SNAPSHOT, '缓存快照续到新条目');
    assert.strictEqual(saved[0].cls, '皇家', '缓存命中同样纠错 cls');
    assert.ok(audits2.some((d) => d.includes('resolved=2/2 cached=1')), '审计含 cached 计数');
    console.log('✓ submit:同届同 hash 快照复用(不二次解析+cls 纠错+审计 cached)');
  }

  /* ---- stripHiddenDecks(GET 剥离) ---- */
  {
    const ws = seedWorld({ manual: 'open' })['data.json'];
    /* 本人(P1):两侧保留 */
    const mine = stripHiddenDecks(JSON.parse(JSON.stringify(ws)), P1);
    const c1m = mine.tournaments[0].canvas.cards[0];
    assert.deepStrictEqual(c1m.classLinks.a, [], '本人 a 侧原样');
    assert.deepStrictEqual(c1m.classLinks.b, [], '本人 b 侧原样');
    /* 他人/游客:未赛卡的已提交侧被剥 */
    ws.tournaments[0].canvas.cards[0].classLinks.a = [{ cls: '精灵', url: 'https://s', text: '秘密' }];
    const other = stripHiddenDecks(JSON.parse(JSON.stringify(ws)), P2);
    const c1o = other.tournaments[0].canvas.cards[0];
    assert.deepStrictEqual(c1o.classLinks.a, [], '对手视角:未赛卡已提交侧被剥为 []');
    assert.deepStrictEqual(c1o.classLinks.b, [], '对手自己侧(P2)不被剥');
    /* 已赛场不受影响 */
    const c2o = other.tournaments[0].canvas.cards[1];
    assert.strictEqual(c2o.classLinks.a.length, 1, '已赛场不剥');
    /* 窗口关:不剥 */
    const closedWs = seedWorld({ manual: 'closed' })['data.json'];
    closedWs.tournaments[0].canvas.cards[0].classLinks.a = [{ cls: '精灵', url: 'https://s', text: '公开' }];
    const closedView = stripHiddenDecks(JSON.parse(JSON.stringify(closedWs)), null);
    assert.strictEqual(closedView.tournaments[0].canvas.cards[0].classLinks.a.length, 1, '窗口关全员可见');
    /* null(显式阻断)与 [] 原样保留,不被误改 */
    const nullWs = seedWorld({ manual: 'open' })['data.json'];
    nullWs.tournaments[0].canvas.cards[0].classLinks.a = null;
    const nullView = stripHiddenDecks(JSON.parse(JSON.stringify(nullWs)), P2);
    assert.strictEqual(nullView.tournaments[0].canvas.cards[0].classLinks.a, null, 'null 阻断语义保留');
    console.log('✓ stripHiddenDecks:本人/对手/已赛/关闭/null');
  }

  delete process.env.SESSION_SECRET;
  console.log('decks-api 全部通过');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
