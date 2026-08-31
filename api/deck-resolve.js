'use strict';

/* Shadowverse: Worlds Beyond 卡组链接解析(卡组构成分析一期)
 *
 * 仅在写入路径调用(选手提交 /api/me/classlinks、管理端回填 /api/admin/decks/backfill),
 * 统计与展示永远读快照离线渲染。官方接口无文档,按"解析一次落库"隔离风险;
 * 出网域名钉死 shadowverse-wb.com,hash 字符白名单校验后才进请求 URL。
 *
 * resolveDeck(hash) → { ok:true, deck } | { ok:false, reason }
 * deck 快照契约见 docs/superpowers/specs/2026-08-31-deck-composition-stats-design.md */

const fsPromises = require('node:fs/promises');
const path = require('node:path');

const WB_API_BASE = 'https://shadowverse-wb.com/web/DeckBuilder/deckHashDetail?hash=';
const FETCH_TIMEOUT_MS = 8000;
const FETCH_ATTEMPTS = 2;
const HASH_CHARS = /^[0-9A-Za-z.\-]+$/;
/* 官方卡组链接:https://shadowverse-wb.com/(chs|cht|en|ja|ko)?/deck/detail/?hash=… */
const DECK_URL_HOST_RE = /shadowverse-wb\.com\/(?:[a-z]{2,3}\/)?deck\/detail\//i;
const HASH_PARAM_RE = /[?&]hash=([^&#\s]+)/i;
/* 裸卡组码:版本.职业(1-7).卡牌码…(至少一张) */
const BARE_HASH_RE = /^1\.[1-7]\.[0-9A-Za-z.\-]+(?:\.[0-9A-Za-z.\-]+)+$/;

function parseDeckHash(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;
  let hash = null;
  if (DECK_URL_HOST_RE.test(text)) {
    const m = HASH_PARAM_RE.exec(text);
    if (m) hash = m[1];
  } else if (BARE_HASH_RE.test(text)) {
    hash = text;
  }
  if (!hash || !HASH_CHARS.test(hash)) return null;
  const parts = hash.split('.');
  if (parts.length < 3) return null;
  return { hash, classByte: Number(parts[1]) };
}

/* e2e/本地 fixture 后门(仿 AUTH_DEV_SMS_CODE):非生产 + 目录置位时读文件不出网 */
function fixtureDirFor() {
  if (!process.env.DECK_RESOLVE_FIXTURE_DIR) return null;
  if (process.env.NODE_ENV === 'production') return null;
  return process.env.DECK_RESOLVE_FIXTURE_DIR;
}

function fixtureFileFor(dir, hash) {
  /* hash 含 '.',文件名安全化后仍可逆(每 hash 唯一) */
  return path.join(dir, hash.replace(/[^0-9A-Za-z_-]/g, '_') + '.json');
}

/* 官方响应 → 快照;任何形状/规则不符返回 {ok:false},绝不抛错 */
function mapResponse(json, resolvedAt) {
  const d = json && json.data;
  if (!d || !d.deck_card_num || !d.card_details) return { ok: false, reason: 'bad-shape' };
  const classId = Number(d.class_id);
  if (!(classId >= 1 && classId <= 7)) return { ok: false, reason: 'class-id' };
  const cards = [];
  let total = 0;
  for (const [id, n] of Object.entries(d.deck_card_num)) {
    const common = d.card_details[id] && d.card_details[id].common;
    const name = common ? String(common.name || '').trim().slice(0, 60) : '';
    if (!name) return { ok: false, reason: 'card-detail-missing:' + id };
    const copies = Number(n);
    if (!(copies >= 1 && copies <= 3)) return { ok: false, reason: 'copies:' + id };
    cards.push([Number(id), name, Number(common.cost) || 0, Number(common.rarity) || 0, Number(common.type) || 0, copies]);
    total += copies;
  }
  if (total !== 40) return { ok: false, reason: 'not-40:' + total };
  cards.sort((x, y) => x[0] - y[0]);
  return {
    ok: true,
    deck: { v: 1, resolvedAt, classId, format: Number(d.battle_format) || null, cards }
  };
}

async function fetchOnce(hash, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(WB_API_BASE + encodeURIComponent(hash), {
      headers: { Lang: 'chs' },
      signal: controller.signal
    });
    if (!res.ok) throw new Error('http-' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function resolveDeck(hash, opts) {
  const o = opts || {};
  const now = typeof o.now === 'function' ? o.now : () => new Date().toISOString();

  const dir = typeof o.fixtureDir === 'string'
    ? (o.fixtureDir && process.env.NODE_ENV !== 'production' ? o.fixtureDir : null)
    : fixtureDirFor();
  if (dir) {
    try {
      const raw = await (o.readFile || fsPromises.readFile)(fixtureFileFor(dir, hash), 'utf8');
      return mapResponse(JSON.parse(raw), now());
    } catch (e) {
      return { ok: false, reason: 'fixture-missing' };
    }
  }

  const fetchImpl = typeof o.fetchImpl === 'function'
    ? o.fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  if (!fetchImpl) return { ok: false, reason: 'no-fetch' };

  let lastErr = null;
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    try {
      return mapResponse(await fetchOnce(hash, fetchImpl, o.timeoutMs || FETCH_TIMEOUT_MS), now());
    } catch (e) {
      lastErr = e;
    }
  }
  return { ok: false, reason: 'fetch-failed:' + (lastErr && lastErr.message ? String(lastErr.message).slice(0, 80) : 'unknown') };
}

/* 工厂:api 模块/测试注入 fetchImpl/now/readFile/fixtureDir */
function createResolver(deps) {
  const d = deps || {};
  return {
    parseDeckHash,
    resolveDeck: (hash) => resolveDeck(hash, d)
  };
}

module.exports = { parseDeckHash, resolveDeck, createResolver, mapResponse, fixtureFileFor };
