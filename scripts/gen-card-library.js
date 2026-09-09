#!/usr/bin/env node
'use strict';
/* 生成全卡库静态资产 cards.json(禁卡表搜索候选池的数据源之一):
 * 拉官方 cardList 全表 -> [{id,name,cost,rarity,class}...] 按职业/费用/稀有度排序。
 * 幂等可重跑;官方出新包后重跑并部署即可。 */
const fs = require('node:fs');
const path = require('node:path');

async function fetchCls(cls) {
  const byId = new Map();
  let plateau = 0;
  for (let offset = 0; offset <= 300; offset += 10) {
    const url = 'https://shadowverse-wb.com/web/CardList/cardList?class=' + cls + '&offset=' + offset;
    const res = await fetch(url, { headers: { Lang: 'chs' } });
    if (!res.ok) throw new Error('http-' + res.status + ' ' + url);
    const data = (await res.json()).data;
    const det = data.card_details || {};
    let added = 0;
    for (const [id, v] of Object.entries(det)) {
      if (!byId.has(Number(id))) { byId.set(Number(id), v.common); added += 1; }
    }
    plateau = added > 0 ? 0 : plateau + 1;
    if (plateau >= 6) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  return byId;
}

(async () => {
  const all = new Map();
  for (let cls = 0; cls <= 7; cls++) {
    for (const [id, c] of await fetchCls(cls)) if (!all.has(id)) all.set(id, c);
  }
  const rows = [...all.values()]
    .filter((c) => !c.is_token && Number.isFinite(Number(c.cost)) && String(c.name || '').trim())
    .map((c) => [Number(c.card_id), String(c.name).slice(0, 60), Number(c.cost) || 0,
      Math.min(4, Math.max(1, Number(c.rarity) || 1)),
      (Number(c.class) >= 0 && Number(c.class) <= 7) ? Number(c.class) : null])
    .sort((x, y) => (x[4] ?? 9) - (y[4] ?? 9) || x[2] - y[2] || x[3] - y[3] || x[1].localeCompare(y[1], 'zh'));
  const out = path.join(__dirname, '..', 'cards.json');
  fs.writeFileSync(out, JSON.stringify(rows));
  console.log('cards.json:', rows.length, '张(非token),已写', out);
})().catch((e) => { console.error(e); process.exit(1); });
