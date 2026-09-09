#!/usr/bin/env node
'use strict';

/* 一次性幂等迁移(禁卡表按职业显示第7步):给存量禁卡表卡(元组第6位 idx5)与
 * 卡组构成快照卡(元组第7位 idx6)补 class,数据源 = 官方 cardList 全卡表
 * id→class。用法:
 *   node scripts/backfill-banlist-class.js --dry-run   只统计,不写入
 *   node scripts/backfill-banlist-class.js             执行迁移(写前 backupData 备份)
 * 必须在新代码部署之后跑(旧端 normalizeBanLists 会把第6位整位抹掉)。
 * 官方 cardList 分页实测(2026-09-09):limit 参数被忽略,任意 offset 恒回
 * 30-40 张的窗口且窗口间不规则重叠(data.count 也失真:class=0 声称 69、实际
 * 76,class=2 声称 106、实际 120,含 token)。同一 URL 返回确定不变,故采用
 * 小步扫描:offset 每 +10 请求一次、全量去重,连续 PLATEAU 次零新增即认为该
 * 职业收满(实测 8 职业最后新增都在 offset≤80,深扫到 400 无新增);总卡表
 * 904 张。幂等:第6/7位已有非 null class 的卡跳过;查不到的 id 落 null 并
 * 计入 unknown 清单(再次运行该卡零变更零计数)。逻辑纯函数导出便于本地冒烟。 */

const CARDLIST_URL = 'https://shadowverse-wb.com/web/CardList/cardList';
const FETCH_TIMEOUT_MS = 15000;
const OFFSET_STEP = 10;
const OFFSET_MAX = 300; /* 实测 offset≤80 后全零,300 为防异常响应的保险丝 */
const PLATEAU = 6; /* 连续 N 个 offset 零新增 = 该职业收满 */

/** 拉官方全卡表:class=0(中立)..7 各自小步扫 offset 去重收集,平台期早停。
 * 返回 Map<cardId, class>;common.class 非法(缺/越界)的卡不入表(视同查不到)。 */
async function fetchAllCards(fetchImpl, log) {
  const info = typeof log === 'function' ? log : () => {};
  const byId = new Map();
  for (let cls = 0; cls <= 7; cls++) {
    let zero = 0;
    let added = 0;
    let count = null;
    for (let offset = 0; offset <= OFFSET_MAX; offset += OFFSET_STEP) {
      const url = CARDLIST_URL + '?class=' + cls + '&limit=100&offset=' + offset;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let data;
      try {
        const res = await fetchImpl(url, { headers: { Lang: 'chs' }, signal: controller.signal });
        if (!res.ok) throw new Error('http-' + res.status + ' ' + url);
        data = (await res.json()).data;
      } finally {
        clearTimeout(timer);
      }
      if (count == null && data) count = data.count;
      const det = (data && data.card_details) || {};
      let fresh = 0;
      for (const id of Object.keys(det)) {
        const common = det[id] && det[id].common;
        const n = Number(common && common.class);
        if (!Number.isInteger(n) || n < 0 || n > 7) continue;
        if (!byId.has(Number(id))) fresh += 1;
        byId.set(Number(id), n);
      }
      if (fresh > 0) {
        added += fresh;
        zero = 0;
      } else {
        zero += 1;
        if (zero >= PLATEAU) break;
      }
    }
    info('class=' + cls + ' 官方 count=' + (count == null ? 0 : count) + ',实收 ' + added + ' 张');
  }
  return byId;
}

/** 卡组链接按 a/b 分组取条目;兼容历史扁平数组形态(整体视作 a 组) */
function classLinkSideEntries(classLinks) {
  if (Array.isArray(classLinks)) return { a: classLinks, b: [] };
  const g = classLinks && typeof classLinks === 'object' ? classLinks : {};
  return { a: Array.isArray(g.a) ? g.a : [], b: Array.isArray(g.b) ? g.b : [] };
}

/** 遍历工作区原地补 class(禁卡表卡补到第6位,快照卡补到第7位),返回统计。
 * 只对真实变更(补位或尾位值变化)计数,天然幂等;skip 规则=尾位已有非 null
 * class。查不到的 id 落 null 并进 unknown。 */
function classifyWorkspace(ws, byId) {
  const stat = { banlistCards: 0, snapshotCards: 0, unknown: [] };
  for (const record of (ws && ws.tournaments) || []) {
    if (!record) continue;
    for (const bl of record.banLists || []) {
      for (const row of (bl && bl.cards) || []) {
        if (!Array.isArray(row) || !row.length) continue;
        if (row.length >= 6 && row[5] !== null && row[5] !== undefined) continue;
        const prevLen = row.length;
        const prevCls = prevLen >= 6 ? row[5] : undefined;
        const found = byId.get(Number(row[0]));
        const cls = Number.isInteger(found) ? found : null;
        while (row.length < 6) row.push(null);
        if (prevLen >= 6 && prevCls === cls) continue; /* 此前已落过 null 且仍查不到:零变更 */
        row[5] = cls;
        stat.banlistCards += 1;
        if (cls === null) stat.unknown.push(Number(row[0]) + ':' + (row[1] || ''));
      }
    }
    for (const card of (record.canvas && record.canvas.cards) || []) {
      const sides = classLinkSideEntries(card && card.classLinks);
      for (const side of ['a', 'b']) {
        for (const entry of sides[side]) {
          for (const row of ((entry && entry.deck && entry.deck.cards) || [])) {
            if (!Array.isArray(row) || !row.length) continue;
            if (row.length >= 7 && row[6] !== null && row[6] !== undefined) continue;
            const prevLen = row.length;
            const prevCls = prevLen >= 7 ? row[6] : undefined;
            const found = byId.get(Number(row[0]));
            const cls = Number.isInteger(found) ? found : null;
            while (row.length < 7) row.push(null);
            if (prevLen >= 7 && prevCls === cls) continue;
            row[6] = cls;
            stat.snapshotCards += 1;
            if (cls === null) stat.unknown.push(Number(row[0]) + ':' + (row[1] || ''));
          }
        }
      }
    }
  }
  return stat;
}

async function main() {
  require('../server'); /* 顺带读 .env(同 migrate-series 模式;listen 有 require.main 守卫) */
  const oss = require('../api/oss');
  if (!oss.isOssConfigured()) {
    console.error('[backfill-banlist-class] OSS 配置不完整:需要 OSS_REGION / OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET');
    process.exit(1);
  }
  const dry = process.argv.includes('--dry-run');
  const byId = await fetchAllCards(fetch, (m) => console.log('[cardlist] ' + m));
  console.log('官方全卡表:id→class 共 ' + byId.size + ' 张');
  const ws = await oss.readJson(oss.DATA_PATH);
  if (!ws) {
    console.log('[backfill-banlist-class] data.json 不存在或为空,无需迁移。');
    return;
  }
  const stat = classifyWorkspace(ws, byId);
  console.log('待补:禁卡表卡 ' + stat.banlistCards + ' 张,快照卡 ' + stat.snapshotCards
    + ' 张;查不到落 null:' + (stat.unknown.length ? ' ' + stat.unknown.join(' ') : ' 无'));
  if (dry) {
    console.log('[backfill-banlist-class] --dry-run 只统计,未写入。去掉 --dry-run 执行(写前自动备份 data.json)。');
    return;
  }
  if (!stat.banlistCards && !stat.snapshotCards) {
    console.log('[backfill-banlist-class] 无变更,未写入。');
    return;
  }
  await oss.backupData();
  await oss.writeJson(oss.DATA_PATH, ws);
  console.log('[backfill-banlist-class] 已备份 data.json 并写回迁移结果。');
}

module.exports = { fetchAllCards, classifyWorkspace };

if (require.main === module) {
  main().catch((error) => {
    console.error('[backfill-banlist-class] ' + (error && error.message ? error.message : error));
    process.exit(1);
  });
}
