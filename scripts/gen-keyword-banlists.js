#!/usr/bin/env node
'use strict';
/* 词条禁卡表生成器(2026-09-10 首次用于第七届右手杯 13 词条批量导入):
 *   用法: node scripts/gen-keyword-banlists.js [词条1 词条2 ...] > banlists.json
 *   缺省词条=13 全家(疾驰 毁灭 守护 突进 灵气 威慑 潜行 爆能强化 瞬念召唤 虹吸 屏障 模式 启动)。
 * 口径(与站内禁卡表职业分组/「以任何形式出现」裁决一致):
 *   卡池 = 基础(10000) + 最新六包(全包序最大 6 个,当前 10004-10009);
 *   命中 = skill_text 含染色词条 <color=Keyword>词条</color>(完整闭合,排除『卡名引用』误报)
 *         或 related_card_ids 关联的卡/衍生物带该词条(召唤/生成/转变的传递)。
 * 输出 = 站内「导入JSON」可直接粘贴的数组:[{name:"词条禁卡表",cards:[[id,名,费,稀有度,0,职业],...]}]
 * 依赖官方 cardList API(免登录;limit 参数被忽略、offset 为不规则窗格 → 小步扫描去重)。 */
const KW_DEFAULT = ['疾驰', '毁灭', '守护', '突进', '灵气', '威慑', '潜行', '爆能强化', '瞬念召唤', '虹吸', '屏障', '模式', '启动'];
const BASIC_SET = 10000;
const LATEST_PACKS = 6;

async function fetchWindow(cls) {
  /* 单职业全部卡与 related 映射;plateau 早停防空窗格死扫 */
  const cards = new Map();
  const rel = {};
  let plateau = 0;
  for (let offset = 0; offset <= 300; offset += 10) {
    const url = 'https://shadowverse-wb.com/web/CardList/cardList?class=' + cls + '&offset=' + offset;
    const res = await fetch(url, { headers: { Lang: 'chs' } });
    if (!res.ok) throw new Error('http-' + res.status + ' ' + url);
    const data = (await res.json()).data;
    let added = 0;
    for (const [id, v] of Object.entries(data.card_details || {})) {
      if (!cards.has(Number(id))) { cards.set(Number(id), v.common); added += 1; }
    }
    for (const [k, v] of Object.entries(data.cards || {})) rel[k] = rel[k] || v;
    plateau = added > 0 ? 0 : plateau + 1;
    if (plateau >= 6) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  return { cards, rel };
}

(async () => {
  const kws = process.argv.slice(2).length ? process.argv.slice(2) : KW_DEFAULT;
  const allCards = new Map();
  const allRel = {};
  for (let cls = 0; cls <= 7; cls++) {
    const { cards, rel } = await fetchWindow(cls);
    for (const [id, c] of cards) if (!allCards.has(id)) allCards.set(id, c);
    Object.assign(allRel, rel);
  }
  /* 卡池 = 基础 + 最新六包 */
  const sets = [...new Set([...allCards.values()].map((c) => Number(c.card_set_id)).filter((s) => s >= 10000 && s < 20000))]
    .sort((a, b) => b - a);
  const poolSets = new Set([BASIC_SET, ...sets.slice(0, LATEST_PACKS)]);
  const mark = (kw) => '<color=Keyword>' + kw + '</color>';
  const has = (c, kw) => (((c && c.skill_text) || '').includes(mark(kw)));
  const inPool = (c) => c && poolSets.has(Number(c.card_set_id)) && !c.is_token;

  const out = kws.map((kw, n) => {
    const ids = new Set([...allCards.values()].filter((c) => inPool(c) && has(c, kw)).map((c) => Number(c.card_id)));
    for (const [k, v] of Object.entries(allRel)) {
      const cid = Number(k);
      const c = allCards.get(cid);
      if (!inPool(c) || ids.has(cid)) continue;
      if ((v.related_card_ids || []).some((r) => { const t = allCards.get(Number(r)); return t && has(t, kw); })) ids.add(cid);
    }
    const cards = [...ids].map((cid) => {
      const c = allCards.get(cid);
      return [cid, String(c.name).slice(0, 60), Number(c.cost) || 0,
        Math.min(4, Math.max(1, Number(c.rarity) || 1)), 0,
        (Number(c.class) >= 0 && Number(c.class) <= 7) ? Number(c.class) : null];
    }).sort((x, y) => (x[5] ?? 9) - (y[5] ?? 9) || x[2] - y[2] || x[3] - y[3] || x[1].localeCompare(y[1], 'zh'));
    return { id: 'blkw' + String(n + 1).padStart(2, '0'), name: kw + '禁卡表', cards };
  }).filter((t) => t.cards.length);
  process.stderr.write('卡池 sets=' + [...poolSets].sort().join(',') + ';输出 ' + out.length + ' 张表\n');
  for (const t of out) process.stderr.write('  ' + t.name + ': ' + t.cards.length + ' 张\n');
  process.stdout.write(JSON.stringify(out));
})().catch((e) => { console.error(e); process.exit(1); });
