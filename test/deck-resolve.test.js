'use strict';

/* deck-resolve 纯函数测试(注入 fetchImpl/readFile,不联网):
 * 链接/裸 hash 识别与拒判、响应→快照映射与规则校验、超时重试、fixture 后门与生产硬闸。 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseDeckHash, resolveDeck, mapResponse, fixtureFileFor } = require('../api/deck-resolve');

const HASH = '1.2.cEZs.cEZs.cEZs.cEaA.dmyk.dmyk.dmyk.e9NO.eXnk.eXnu.eXnu.eXnu.evTW.evTW.evTW.evi-.evi-.evi-.evj8.evj8.evj8.evm6.evm6.evm6.evyc.evyc.evyc.ewCE.ewCE.ewCE.ewCO.ewCO.ewCO.fIAc.fIck.fIck.fIck.fIcu.fIcu.fh1O';

function okRes(cardList, classId) {
  const deck_card_num = {};
  const card_details = {};
  for (const [id, name, cost, rarity, type, n] of cardList) {
    deck_card_num[id] = n;
    card_details[id] = { common: { card_id: id, name, cost, rarity, type } };
  }
  return { data: { class_id: classId === undefined ? 2 : classId, battle_format: 1, deck_card_num, card_details } };
}

/* 13 种 ×3 + 1 种 ×1 = 40 */
function stdCards() {
  const cards = [];
  for (let i = 0; i < 13; i++) cards.push([10021110 + i, '卡' + i, (i % 8) + 1, (i % 4) + 1, (i % 3) + 1, 3]);
  cards.push([10924120, '武皇的变貌·贝尔铁佐', 8, 4, 1, 1]);
  return cards;
}

const jsonResponse = (payload) => ({ ok: true, json: async () => payload });

async function main() {
  /* ---------- parseDeckHash ---------- */

  assert.deepEqual(
    parseDeckHash('https://shadowverse-wb.com/chs/deck/detail/?hash=' + HASH),
    { hash: HASH, classByte: 2 }, 'chs 链接识别'
  );
  for (const lang of ['cht', 'en', 'ja', 'ko', '']) {
    const url = 'https://shadowverse-wb.com/' + (lang ? lang + '/' : '') + 'deck/detail/?hash=' + HASH;
    assert.equal(parseDeckHash(url).hash, HASH, '语言路径 ' + (lang || '根路径'));
  }
  assert.equal(
    parseDeckHash('https://shadowverse-wb.com/chs/deck/detail/?foo=1&hash=' + HASH + '&x=2').hash,
    HASH, 'hash 参数不在末尾'
  );
  assert.deepEqual(parseDeckHash(HASH), { hash: HASH, classByte: 2 }, '裸卡组码识别');
  /* 官方卡牌码字符集含下划线(线上 ej_8 实证,2026-09-01 白名单曾漏导致复仇者永不解析) */
  {
    const withUnderscore = '1.7.dyRQ.eLN-.ej_8.ej_8.f5jk.f6PU.ftEe.ftEe.f69s.f6Pe.fUp-.fUq8.ej--.eLae.ejlM.ejG6.f5gc.f5wE';
    assert.equal(parseDeckHash('https://shadowverse-wb.com/chs/deck/detail/?hash=' + withUnderscore).classByte, 7, 'hash 含下划线(链接)识别');
    assert.equal(parseDeckHash(withUnderscore).classByte, 7, 'hash 含下划线(裸码)识别');
  }
  assert.equal(parseDeckHash('https://shadowverse-wb.com/ja/deck/detail/?hash=' + HASH + '#frag').hash, HASH, 'url 锚点不进 hash');
  assert.equal(parseDeckHash('https://shadowverse-portal.com/deck/1.2.abc'), null, '非 WB 域名拒判');
  assert.equal(parseDeckHash('https://shadowverse-wb.com/chs/deck/build/'), null, 'WB 非详情页拒判');
  assert.equal(parseDeckHash('https://shadowverse-wb.com/chs/deck/detail/?foo=1'), null, '无 hash 参数拒判');
  assert.equal(parseDeckHash('https://shadowverse-wb.com/chs/deck/detail/?hash=abc$def'), null, 'hash 非法字符拒判');
  assert.equal(parseDeckHash('1.9.aaaa.bbbb'), null, '裸码职业位越界拒判');
  assert.equal(parseDeckHash('1.2.cEZs'), null, '裸码无卡牌段拒判');
  assert.equal(parseDeckHash(''), null, '空串拒判');
  assert.equal(parseDeckHash(null), null, '非字符串拒判');

  /* ---------- mapResponse ---------- */

  const mapped = mapResponse(okRes(stdCards()), '2026-08-31T00:00:00.000Z');
  assert.equal(mapped.ok, true, '标准响应映射成功');
  assert.equal(mapped.deck.classId, 2);
  assert.equal(mapped.deck.format, 1);
  assert.equal(mapped.deck.resolvedAt, '2026-08-31T00:00:00.000Z');
  assert.equal(mapped.deck.cards.length, 14, '14 种卡');
  assert.equal(mapped.deck.cards.reduce((s, c) => s + c[5], 0), 40, '总张数 40');
  assert.ok(mapped.deck.cards.every((c) => Array.isArray(c) && c.length === 6), '紧凑六元组');
  assert.ok(mapped.deck.cards.every((c, i, a) => i === 0 || a[i - 1][0] <= c[0]), '按 cardId 升序');

  assert.equal(mapResponse({ data: null }, 't').reason, 'bad-shape', '缺 data 拒判');
  assert.equal(mapResponse({ data: { deck_card_num: {}, card_details: {}, class_id: 9 } }, 't').reason, 'class-id', '职业位越界拒判');
  assert.equal(mapResponse({ data: { class_id: 2, deck_card_num: { 10021110: 4 }, card_details: { 10021110: { common: { name: 'x' } } } } }, 't').reason, 'copies:10021110', '单卡超 3 张拒判');
  assert.equal(mapResponse({ data: { class_id: 2, deck_card_num: { 10021110: 1 }, card_details: {} } }, 't').reason, 'card-detail-missing:10021110', '缺卡详情拒判');
  {
    const cards = stdCards().slice(1); /* 少一张 ×3 卡 → 37 */
    assert.equal(mapResponse(okRes(cards), 't').reason, 'not-40:37', '非 40 张拒判');
  }
  {
    const long = '超长卡名' + 'x'.repeat(80);
    const cards = [[10021110, long, 1, 1, 1, 1]];
    for (let i = 1; i <= 13; i++) cards.push([10021110 + i, '卡' + i, 1, 1, 1, 3]); /* 1 + 13×3 = 40 */
    const m = mapResponse(okRes(cards), 't');
    assert.equal(m.ok, true);
    assert.equal(m.deck.cards.find((c) => c[0] === 10021110)[1].length, 60, '卡名截断 60');
  }

  /* ---------- resolveDeck:注入 fetchImpl ---------- */

  const runResolve = (opts) => resolveDeck(HASH, opts);

  {
    let calls = 0;
    const r = await runResolve({ fetchImpl: async () => { calls++; return jsonResponse(okRes(stdCards())); }, now: () => 'T' });
    assert.equal(r.ok, true, '注入 fetch 成功');
    assert.equal(calls, 1, '成功不重试');
  }
  {
    let calls = 0;
    const r = await runResolve({
      fetchImpl: async (url, init) => {
        calls++;
        if (calls === 1) throw new Error('boom');
        assert.ok(url.startsWith('https://shadowverse-wb.com/web/DeckBuilder/deckHashDetail?hash=1.2.'), '请求 URL 域名+编码固定');
        assert.equal(init.headers.Lang, 'chs', 'Lang 头');
        return jsonResponse(okRes(stdCards()));
      }
    });
    assert.equal(r.ok, true, '首次失败重试成功');
    assert.equal(calls, 2, '共两次尝试');
  }
  {
    let calls = 0;
    const r = await runResolve({ fetchImpl: async () => { calls++; throw new Error('timeout'); } });
    assert.equal(r.ok, false, '两次失败最终失败');
    assert.equal(calls, 2, '重试上限 1 次');
    assert.ok(r.reason.startsWith('fetch-failed:'), '失败原因透出: ' + r.reason);
  }
  {
    let calls = 0;
    const r = await runResolve({ fetchImpl: async () => { calls++; return { ok: false, status: 503, json: async () => ({}) }; } });
    assert.equal(r.ok, false, 'HTTP 非 2xx 失败');
    assert.equal(calls, 2, 'HTTP 失败也重试');
  }

  /* ---------- fixture 后门 ---------- */

  const envBackup = { dir: process.env.DECK_RESOLVE_FIXTURE_DIR, nodeEnv: process.env.NODE_ENV };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-fix-'));
  try {
    process.env.NODE_ENV = 'test';
    process.env.DECK_RESOLVE_FIXTURE_DIR = tmp;
    fs.writeFileSync(fixtureFileFor(tmp, HASH), JSON.stringify(okRes(stdCards())), 'utf8');

    {
      let net = 0;
      const r = await resolveDeck(HASH, { fetchImpl: async () => { net++; return jsonResponse(okRes(stdCards())); } });
      assert.equal(r.ok, true, 'fixture 模式读到文件');
      assert.equal(r.deck.cards.length, 14);
      assert.equal(net, 0, 'fixture 模式绝不出网');
    }
    {
      const r = await resolveDeck('1.2.noSuchHash.aaaa.bbbb', {});
      assert.equal(r.ok, false, '缺 fixture 文件失败');
      assert.equal(r.reason, 'fixture-missing');
    }
    {
      process.env.NODE_ENV = 'production';
      let net = 0;
      const r = await resolveDeck(HASH, { fetchImpl: async () => { net++; return jsonResponse(okRes(stdCards())); } });
      assert.equal(r.ok, true, '生产环境忽略 fixture 走真网');
      assert.equal(net, 1);
    }
  } finally {
    process.env.DECK_RESOLVE_FIXTURE_DIR = envBackup.dir;
    process.env.NODE_ENV = envBackup.nodeEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(
  () => console.log('deck-resolve.test: all passed'),
  (err) => { console.error(err); process.exit(1); }
);
