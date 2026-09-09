(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CanvasModel = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ========== 基础工具 ========== */

  const AVATAR_COLORS = [
    '#3563e9', '#6d28d9', '#047857', '#92400e',
    '#b91c1c', '#0e7490', '#be185d', '#3f6212'
  ];

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function avatarColor(seed) {
    let hash = 0;
    const str = String(seed || '');
    for (let i = 0; i < str.length; i += 1) {
      hash = (hash * 31 + str.charCodeAt(i)) | 0;
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  }

  /* ========== 画布创建 ========== */

  const DEFAULT_CANVAS_COLS = 40;
  const DEFAULT_CANVAS_ROWS = 24;
  const MAX_CANVAS_COLS = 200;
  const MAX_CANVAS_ROWS = 200;

/* 画布几何唯一真源:点阵点距、卡片尺寸(每卡 10×7 点)、连接点布局,
 * bracket.js(渲染)与 canvas-editor.js(编辑)统一引用,改这里即可全局生效 */
const DOT = 28;
const CARD_WIDTH = DOT * 10;
const CARD_HEIGHT = DOT * 7;
/* 四侧连接点对的点间距离(沿用原左右口 A/B 行间距) */
const PORT_SPAN = 38;
/* 旧格制间距,仅供格→点迁移换算,勿在新代码中使用 */
const LEGACY_COL_GAP = 320;
const LEGACY_ROW_GAP = 210;

/* 八连接点(参考 Obsidian 白板):四侧各一对、每对以边中点居中、对间距 PORT_SPAN。
 * 上排四点(topLeft/topRight/leftTop/rightTop)默认输出胜者、拖入进 A 位;
 * 下排四点(bottomLeft/bottomRight/leftBottom/rightBottom)默认输出败者、拖入进 B 位。
 * 端口不落盘,renderEdges/临时线均按 pickPort/portOffset 现算。 */
const PORT_NORMALS = {
  topLeft: [0, -1],
  topRight: [0, -1],
  bottomLeft: [0, 1],
  bottomRight: [0, 1],
  leftTop: [-1, 0],
  leftBottom: [-1, 0],
  rightTop: [1, 0],
  rightBottom: [1, 0]
};

/* 连接点相对卡片左上角的偏移(全部居中分布) */
function portOffset(port) {
  const half = PORT_SPAN / 2;
  switch (port) {
    case 'topLeft': return { x: CARD_WIDTH / 2 - half, y: 0 };
    case 'topRight': return { x: CARD_WIDTH / 2 + half, y: 0 };
    case 'bottomLeft': return { x: CARD_WIDTH / 2 - half, y: CARD_HEIGHT };
    case 'bottomRight': return { x: CARD_WIDTH / 2 + half, y: CARD_HEIGHT };
    case 'leftTop': return { x: 0, y: CARD_HEIGHT / 2 - half };
    case 'leftBottom': return { x: 0, y: CARD_HEIGHT / 2 + half };
    case 'rightTop': return { x: CARD_WIDTH, y: CARD_HEIGHT / 2 - half };
    default: return { x: CARD_WIDTH, y: CARD_HEIGHT / 2 + half };
  }
}

/* 按两卡相对方位自动选连接点(白板式路由,卡片移动后连线自动跟随):
 * 横向错开超半卡宽走左右边;纵向连接在上/下对里按水平偏移选左右点,减少斜跨。
 * band 'upper'=上排四点(胜者出/A 位入),'lower'=下排四点 */
function pickPort(fromCard, toCard, band) {
  const dx = ((Number(toCard.x) || 0) - (Number(fromCard.x) || 0)) * DOT;
  const side = band === 'lower' ? 'Bottom' : 'Top';
  if (dx < -CARD_WIDTH / 2) return 'left' + side;
  if (dx > CARD_WIDTH / 2) return 'right' + side;
  const lr = dx < 0 ? 'Left' : 'Right';
  return (band === 'lower' ? 'bottom' : 'top') + lr;
}

/* 连接点法线 stub 贝塞尔:两端各自沿连接点法线伸出 stub 再相互弯接 */
function edgePath(p1, n1, p2, n2) {
  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const stub = Math.min(120, Math.max(24, dist / 2));
  return 'M ' + p1.x + ' ' + p1.y +
    ' C ' + (p1.x + n1[0] * stub) + ' ' + (p1.y + n1[1] * stub) +
    ', ' + (p2.x + n2[0] * stub) + ' ' + (p2.y + n2[1] * stub) +
    ', ' + p2.x + ' ' + p2.y;
}

  function clampCanvasSize(cols, rows) {
    const c = Number(cols);
    const r = Number(rows);
    return {
      cols: Math.max(1, Math.min(MAX_CANVAS_COLS, Number.isFinite(c) ? Math.round(c) : DEFAULT_CANVAS_COLS)),
      rows: Math.max(1, Math.min(MAX_CANVAS_ROWS, Number.isFinite(r) ? Math.round(r) : DEFAULT_CANVAS_ROWS))
    };
  }

  function getCanvasSize(canvas) {
    const size = canvas && canvas.size ? clampCanvasSize(canvas.size.cols, canvas.size.rows) : { cols: DEFAULT_CANVAS_COLS, rows: DEFAULT_CANVAS_ROWS };
    return size;
  }

  /* 无限画布原点(DOT 网格单位):卡片坐标四向可负,渲染层把包围盒左上
   * 归一到 DOM(0,0)——origin = min(0, 各轴最左卡坐标);全正时为 0,
   * 旧行为(原点即世界原点)完全不变。编辑器拖拽外扩时与之保持同源。 */
  function canvasOrigin(canvas) {
    let x = 0;
    let y = 0;
    for (const card of (canvas && canvas.cards) || []) {
      const cx = Number(card && card.x);
      const cy = Number(card && card.y);
      if (Number.isFinite(cx) && cx < x) x = cx;
      if (Number.isFinite(cy) && cy < y) y = cy;
    }
    return { x, y };
  }

  function createEmptyCanvas() {
    return { cards: [], size: { cols: DEFAULT_CANVAS_COLS, rows: DEFAULT_CANVAS_ROWS } };
  }

  /* 卡片玻璃样式:不透明度 0.3-1,模糊 0-24px;缺省 0.7/8 */
  function normalizeCardStyle(style) {
    const s = style || {};
    const opacity = Number(s.opacity);
    const blur = Number(s.blur);
    return {
      opacity: Number.isFinite(opacity) ? Math.min(1, Math.max(0.3, opacity)) : 0.7,
      blur: Number.isFinite(blur) ? Math.min(24, Math.max(0, Math.round(blur))) : 8
    };
  }

  const CARD_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

  /* 职业 svg 名单(icons/classes/<名>.svg),卡片职业槽引用 */
  const CLASS_LIST = ['精灵', '皇家', '法师', '龙族', '梦魇', '主教', '复仇者'];
  /* 禁卡表职业顺序:中立在前拼接 7 职业,class id 0-7 与下标对齐 */
  const BANLIST_CLASSES = ['中立'].concat(CLASS_LIST);

  /* ========== WB 卡组码提取与规范链接(国服牌组码 → 官网卡组链接) ==========
   * 国服《影之诗:超凡世界》客户端导出的牌组码是带 # 注释行的整段文本:
   *   #梦魇#\n#指定系列#\n#梦魇#\n1.5.cM8E.fPCm…(40 token)\n#在游戏中点击…
   * 其 hash 段与官网链接 shadowverse-wb.com/…/?hash=… 完全同码。
   * 单行 <input> 粘贴会剥掉换行,故按卡牌码字符集切段提取、不依赖换行;
   * 多段命中取最长(40 token 的 hash 远长于注释里的偶然数字)。
   * api/deck-resolve.js parseDeckHash 的国服码分支与本处同规则源。 */
  const DECK_CODE_SPLIT_RE = /[^0-9A-Za-z._\-]+/;
  /* 与 api/deck-resolve.js BARE_HASH_RE 同语言:版本.职业(1-7).卡牌码…(至少一段,单 token 拒判) */
  const DECK_CODE_RE = /^1\.[1-7]\.[0-9A-Za-z._\-]+(?:\.[0-9A-Za-z._\-]+)+$/;
  const CANONICAL_DECK_URL_PREFIX = 'https://shadowverse-wb.com/chs/deck/detail/?hash=';
  /* 带协议头的已是链接(含其他站点),不是卡组码,原样保留 */
  const URL_SCHEME_RE = /^[a-z][a-z0-9+.\-]*:/i;

  function extractDeckCode(text) {
    if (typeof text !== 'string') return null;
    let best = null;
    for (const chunk of text.split(DECK_CODE_SPLIT_RE)) {
      if (DECK_CODE_RE.test(chunk) && (!best || chunk.length > best.length)) best = chunk;
    }
    return best;
  }

  /* 卡组链接栏统一归一化:官网链接原样;国服牌组码/裸 hash → 规范官网链接;
   * 其他链接与非卡组文本原样返回,去留由上层协议白名单决定 */
  function normalizeDeckUrl(url) {
    if (typeof url !== 'string') return '';
    const t = url.trim();
    if (!t) return '';
    if (URL_SCHEME_RE.test(t)) return t.slice(0, 500);
    const code = extractDeckCode(t);
    return (code ? CANONICAL_DECK_URL_PREFIX + code : t).slice(0, 500);
  }

  /* 单条职业卡组链接:cls 在名单内、url/text 截断字符串;无效项返回 null */
  /* 卡组构成分析快照:紧凑结构做边界校验,非法整体丢弃(降级为无快照,不阻塞链接本身) */
  function normalizeDeckSnapshot(deck) {
    if (!deck || typeof deck !== 'object' || Number(deck.v) !== 1) return null;
    const classId = Number(deck.classId);
    if (!(classId >= 1 && classId <= 7)) return null;
    if (!Array.isArray(deck.cards)) return null;
    const cards = [];
    for (const row of deck.cards.slice(0, 60)) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const name = String(row[1] || '').trim().slice(0, 60);
      if (!name) continue;
      cards.push([
        Number(row[0]) || 0,
        name,
        Number(row[2]) || 0,
        Math.min(4, Math.max(1, Number(row[3]) || 1)),
        Number(row[4]) || 0,
        Math.min(3, Math.max(1, Number(row[5]) || 1)),
        normalizeCls(row[6])
      ]);
    }
    if (!cards.length) return null;
    return {
      v: 1,
      resolvedAt: typeof deck.resolvedAt === 'string' ? deck.resolvedAt.slice(0, 40) : null,
      classId,
      format: Number(deck.format) || null,
      cards
    };
  }

  function normalizeClassLink(entry) {
    if (!entry && entry !== null) entry = null;
    if (!entry || typeof entry !== 'object') return null;
    if (!CLASS_LIST.includes(entry.cls)) return null;
    const url = typeof entry.url === 'string' ? normalizeDeckUrl(entry.url) : '';
    const text = typeof entry.text === 'string' ? entry.text.trim().slice(0, 60) : '';
    if (!url && !text) return null;
    const out = { cls: entry.cls, url, text };
    const deck = normalizeDeckSnapshot(entry.deck);
    if (deck) out.deck = deck;
    return out;
  }

  function normalizeClassLinkGroup(list) {
    /* null = 显式清空(阻断继承);undefined/非数组 = 未填(可继承) */
    if (list === null) return null;
    if (!Array.isArray(list)) return [];
    return list.slice(0, 12).map(normalizeClassLink).filter(Boolean);
  }

  /* 职业卡组按选手位分组:a = A 位(上行/左侧),b = B 位(下行/右侧)。
   * 为之后的数据统计页预留:统计直接遍历 cards 的 classLinks.a/b 即可。
   * 兼容旧扁平数组:整体迁入 a 组。 */
  function normalizeClassLinks(raw) {
    if (Array.isArray(raw)) return { a: normalizeClassLinkGroup(raw), b: [] };
    const g = raw && typeof raw === 'object' ? raw : {};
    return { a: normalizeClassLinkGroup(g.a), b: normalizeClassLinkGroup(g.b) };
  }

  function normalizeCard(card, index) {
    const c = card || {};
    return {
      id: c.id || uid('c'),
      label: c.label || '第 ' + ((index || 0) + 1) + ' 场',
      phase: c.phase || '',
      format: c.format || 'BO3',
      x: Number.isFinite(Number(c.x)) ? Number(c.x) : 0,
      y: Number.isFinite(Number(c.y)) ? Number(c.y) : 0,
      slots: Array.isArray(c.slots) && c.slots.length >= 2
        ? c.slots.slice(0, 2).map((s) => normalizeSlot(s))
        : [{ type: 'empty' }, { type: 'empty' }],
      exitRanks: c.exitRanks && typeof c.exitRanks === 'object'
        ? { winner: c.exitRanks.winner, loser: c.exitRanks.loser }
        : {},
      deckCount: c.deckCount && Number.isFinite(Number(c.deckCount)) ? Number(c.deckCount) : null,
      /* 单卡染色(null = 不染色,跟随玻璃默认) */
      color: CARD_COLOR_RE.test(c.color || '') ? c.color : null,
      /* 职业卡组链接(按 A/B 选手位分组,各无上限,合理性截到 12 条) */
      classLinks: normalizeClassLinks(c.classLinks),
      /* 生效禁卡表 id(届 banLists 内的表 id;悬空 id 渲染时过滤) */
      banListIds: normalizeBanListIds(c.banListIds)
    };
  }

  function normalizeSlot(slot) {
    if (!slot) return { type: 'empty' };
    if (slot.type === 'player') {
      return { type: 'player', playerId: slot.playerId || null };
    }
    if (slot.type === 'flow') {
      return { type: 'flow', cardId: slot.cardId || '', outcome: slot.outcome === 'loser' ? 'loser' : 'winner' };
    }
    return { type: 'empty' };
  }

  function normalizeCanvas(canvas) {
    const c = canvas || {};
    const cards = Array.isArray(c.cards) ? c.cards : [];
    return { cards: cards.map(normalizeCard), size: getCanvasSize(c), style: normalizeCardStyle(c.style) };
  }

  /* 方案 A：参赛名单自动从画布直接引用选手的槽位推导 */
  function deriveRoster(canvas) {
    const ids = [];
    const seen = new Set();
    for (const card of (canvas && canvas.cards) || []) {
      for (const slot of card.slots || []) {
        if (slot && slot.type === 'player' && slot.playerId && !seen.has(slot.playerId)) {
          seen.add(slot.playerId);
          ids.push(slot.playerId);
        }
      }
    }
    return ids;
  }

  /* 入场卡:没有任何箭头指入的比赛卡。箭头完全由 flow 槽派生,
   * 所以两个槽都不是 flow 的卡就是选手直接上场的入口(首轮卡)。 */
  function entryCards(canvas) {
    return ((canvas && canvas.cards) || []).filter((card) =>
      !(card.slots || []).some((slot) => slot && slot.type === 'flow')
    );
  }

  /* 报名自动填入:ids 为入选名单(调用方已按报名顺序截取),
   * Fisher-Yates 洗牌后覆盖所有入场卡的两个槽,人数不足留空、多余清空。
   * rng 可注入(测试确定性)。返回实际填入人数。 */
  function autoFillEntries(canvas, ids, rng) {
    const rand = typeof rng === 'function' ? rng : Math.random;
    const list = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string');
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = list[i]; list[i] = list[j]; list[j] = t;
    }
    const capacity = entryCards(canvas).length * 2;
    let k = 0;
    for (const card of entryCards(canvas)) {
      card.slots = [0, 1].map(() => (k < list.length
        ? { type: 'player', playerId: list[k++] }
        : { type: 'empty' }));
    }
    return Math.min(k, capacity);
  }

  /* 默认 8 人双败淘汰画布，卡片 id 沿用旧版场次 id，便于旧数据迁移 */
  function createDefaultCanvas(roster) {
    const p = roster || [];
    const get = (i) => (p[i] ? { type: 'player', playerId: p[i] } : { type: 'empty' });
    const flow = (cardId, outcome) => ({ type: 'flow', cardId, outcome });
    const cards = [
      // 胜者组 R1
      { id: 'wb_r1_1', label: '胜者组 1/4 决赛 1', phase: '胜者组', format: 'BO3', x: 0, y: 0, slots: [get(0), get(1)] },
      { id: 'wb_r1_2', label: '胜者组 1/4 决赛 2', phase: '胜者组', format: 'BO3', x: 0, y: 2, slots: [get(2), get(3)] },
      { id: 'wb_r1_3', label: '胜者组 1/4 决赛 3', phase: '胜者组', format: 'BO3', x: 0, y: 4, slots: [get(4), get(5)] },
      { id: 'wb_r1_4', label: '胜者组 1/4 决赛 4', phase: '胜者组', format: 'BO3', x: 0, y: 6, slots: [get(6), get(7)] },
      // 胜者组 R2
      { id: 'wb_r2_1', label: '胜者组半决赛 1', phase: '胜者组', format: 'BO3', x: 2, y: 1, slots: [flow('wb_r1_1', 'winner'), flow('wb_r1_2', 'winner')] },
      { id: 'wb_r2_2', label: '胜者组半决赛 2', phase: '胜者组', format: 'BO3', x: 2, y: 5, slots: [flow('wb_r1_3', 'winner'), flow('wb_r1_4', 'winner')] },
      // 胜者组决赛
      { id: 'wb_final', label: '胜者组决赛', phase: '胜者组', format: 'BO5', x: 4, y: 3, slots: [flow('wb_r2_1', 'winner'), flow('wb_r2_2', 'winner')] },
      // 败者组 R1
      { id: 'lb_r1_1', label: '败者组第一轮 1', phase: '败者组', format: 'BO3', x: 1, y: 1, slots: [flow('wb_r1_1', 'loser'), flow('wb_r1_2', 'loser')] },
      { id: 'lb_r1_2', label: '败者组第一轮 2', phase: '败者组', format: 'BO3', x: 1, y: 5, slots: [flow('wb_r1_3', 'loser'), flow('wb_r1_4', 'loser')] },
      // 败者组 R2
      { id: 'lb_r2_1', label: '败者组第二轮 1', phase: '败者组', format: 'BO3', x: 3, y: 0, slots: [flow('wb_r2_1', 'loser'), flow('lb_r1_1', 'winner')] },
      { id: 'lb_r2_2', label: '败者组第二轮 2', phase: '败者组', format: 'BO3', x: 3, y: 4, slots: [flow('wb_r2_2', 'loser'), flow('lb_r1_2', 'winner')] },
      // 败者组 R3
      { id: 'lb_r3', label: '败者组半决赛', phase: '败者组', format: 'BO3', x: 5, y: 2, slots: [flow('lb_r2_1', 'winner'), flow('lb_r2_2', 'winner')] },
      // 败者组决赛
      { id: 'lb_final', label: '败者组决赛', phase: '败者组', format: 'BO5', x: 7, y: 1, slots: [flow('wb_final', 'loser'), flow('lb_r3', 'winner')], exitRanks: { loser: 3 } },
      // 总决赛
      { id: 'grand_final', label: '总决赛', phase: '总决赛', format: 'BO5', x: 9, y: 1, slots: [flow('wb_final', 'winner'), flow('lb_final', 'winner')], exitRanks: { winner: 1, loser: 2 } }
    ];
    /* 模板坐标以旧格值书写便于对齐阅读,统一经格→点迁移换算 */
    const canvas = { cards: cards.map(normalizeCard), size: { cols: DEFAULT_CANVAS_COLS, rows: DEFAULT_CANVAS_ROWS } };
    migrateCanvasToDot(canvas);
    return canvas;
  }

  /* 连线箭头 marker 定义(正式线与编辑器临时线共用;id 前缀区分避免 document 内撞车) */
function arrowDefs(prefix) {
  const marker = function (cls) {
    return '<marker id="' + prefix + '-arrow-' + cls + '" class="edge-arrow ' + cls + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="12" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker>';
  };
  return '<defs>' + marker('winner') + marker('loser') + '</defs>';
}

/* 格制→点制:坐标单位从 1 格(320×210px)换算为 1 点(DOT px),视觉位置不变;
   * grid 标记保证幂等——迁移一次落盘后不再重算 */
  function migrateCanvasToDot(canvas) {
    if (!canvas || canvas.grid === 'dot') return false;
    for (const card of Array.isArray(canvas.cards) ? canvas.cards : []) {
      card.x = Math.max(0, Math.round(((Number(card.x) || 0) * LEGACY_COL_GAP) / DOT));
      card.y = Math.max(0, Math.round(((Number(card.y) || 0) * LEGACY_ROW_GAP) / DOT));
    }
    canvas.grid = 'dot';
    return true;
  }

  /* ========== 比分语义 ========== */

  function getResult(score) {
    if (!score) return null;
    const a = Number(score.a);
    const b = Number(score.b);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    if (a < 0 && b < 0) {
      return { valid: false, reason: 'both-forfeit', a, b, draw: false, winnerSide: null, forfeit: true };
    }
    if (a < 0 || b < 0) {
      const winnerSide = a < 0 ? 1 : 0;
      return { valid: true, reason: 'forfeit', a, b, draw: false, winnerSide, forfeit: true };
    }
    if (a === b) {
      return { valid: true, reason: 'draw', a, b, draw: true, winnerSide: null, forfeit: false };
    }
    return {
      valid: true,
      reason: 'score',
      a,
      b,
      draw: false,
      winnerSide: a > b ? 0 : 1,
      forfeit: false
    };
  }

  function getDeckCount(card) {
    const c = normalizeCard(card);
    if (c.deckCount && c.deckCount > 0) return c.deckCount;
    const match = String(c.format || '').match(/(\d+)/);
    if (match) {
      const n = Number(match[1]);
      if (n >= 1) return Math.max(1, Math.ceil(n / 2));
    }
    return 2;
  }

  /* ========== 卡组提交窗口(服务端判定与客户端展示共用一份) ========== */

  function parseHHMM(value) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  /* 生效状态:true=开(可提交+隐藏),false=关(锁定+公示)。now 可注入供测试:
   * Date 实例 / 毫秒数 / 返回任一者的函数均可(生产注入的是 Date.now 本身)。
   * 开关语义:record.deckWindow = { open:"HH:MM", close:"HH:MM", manual: null|'open'|'closed' }
   * manual 优先;无 manual 且时段齐全时按本地时间每日循环判定(支持跨零点);否则恒关 */
  function isWindowOpen(record, now) {
    const w = record && record.deckWindow;
    if (!w || typeof w !== 'object') return false;
    if (w.manual === 'open') return true;
    if (w.manual === 'closed') return false;
    const openMin = parseHHMM(w.open);
    const closeMin = parseHHMM(w.close);
    if (openMin === null || closeMin === null || openMin === closeMin) return false;
    const raw = typeof now === 'function' ? now() : now;
    const t = raw instanceof Date ? raw : new Date(Number.isFinite(raw) ? raw : Date.now());
    const cur = t.getHours() * 60 + t.getMinutes();
    return openMin < closeMin ? (cur >= openMin && cur < closeMin) : (cur >= openMin || cur < closeMin);
  }

  /* ========== 画布解析 ========== */

  function buildResolved(card, a, b, result) {
    const played = Boolean(result && result.valid && !result.draw);
    let state = 'waiting';
    if (a && b) state = 'ready';
    if (result && result.valid && result.draw) state = 'draw';
    if (result && !result.valid) state = 'invalid';
    if (played) state = 'finished';
    if (!a || !b) state = 'waiting';
    return {
      id: card.id,
      label: card.label,
      phase: card.phase,
      format: card.format,
      x: card.x,
      y: card.y,
      a,
      b,
      scoreA: result ? result.a : null,
      scoreB: result ? result.b : null,
      state,
      played,
      draw: Boolean(result && result.draw),
      invalid: Boolean(result && !result.valid),
      forfeit: Boolean(result && result.forfeit),
      winner: played ? (result.winnerSide === 0 ? a : b) : null,
      loser: played ? (result.winnerSide === 0 ? b : a) : null,
      winnerSide: result ? result.winnerSide : null,
      cycle: false
    };
  }

  function resolveCanvas(canvas, roster, scores) {
    const norm = normalizeCanvas(canvas);
    const byId = new Map(norm.cards.map((c) => [c.id, c]));
    const resolvedMap = new Map();
    const visiting = new Set();
    const cycleIds = new Set();

    function resolveSlot(slot) {
      if (!slot) return null;
      if (slot.type === 'player') return slot.playerId || null;
      if (slot.type === 'flow') {
        if (!byId.has(slot.cardId)) return null;
        const source = resolveCard(slot.cardId);
        if (!source) return null;
        if (source.cycle) cycleIds.add(source.id);
        if (slot.outcome === 'winner') return source.winner;
        if (slot.outcome === 'loser') return source.loser;
        return null;
      }
      return null;
    }

    function resolveCard(id) {
      if (resolvedMap.has(id)) return resolvedMap.get(id);
      const card = byId.get(id);
      if (!card) return null;
      if (visiting.has(id)) {
        cycleIds.add(id);
        resolvedMap.set(id, null);
        return null;
      }
      visiting.add(id);
      const a = resolveSlot(card.slots[0]);
      const b = resolveSlot(card.slots[1]);
      const result = getResult(scores && scores[id]);
      const resolved = buildResolved(card, a, b, result);
      visiting.delete(id);
      resolvedMap.set(id, resolved);
      return resolved;
    }

    // 先全部解析一遍，让环上的卡片也有对象
    const cards = norm.cards.map((card) => resolveCard(card.id) || buildResolved(card, null, null, null));
    // 标记环
    for (const id of cycleIds) {
      const item = resolvedMap.get(id);
      if (item) item.cycle = true;
    }
    for (const c of cards) {
      if (cycleIds.has(c.id)) c.cycle = true;
    }

    const byIdResolved = new Map(cards.map((c) => [c.id, c]));
    const standings = deriveStandingsFromResolved(norm, cards, byIdResolved);

    return { cards, standings, cycleIds: [...cycleIds], size: norm.size };
  }

  function resolveCardById(canvas, roster, scores, cardId) {
    const resolved = resolveCanvas(canvas, roster, scores);
    return resolved.cards.find((c) => c.id === cardId) || null;
  }

  /* ========== 卡组继承(读取时派生) ==========
   * 卡片某侧自己填了 classLinks 用自己的;没填且该侧是连线槽,则沿连线
   * 继承来源卡中该选手所在一侧的卡组(递归多跳)。
   * 与未来的选手端"提交/更新卡组"互补:写自己、读时派生,互不冲突。 */
  function resolveEffectiveClassLinks(canvas, scores) {
    const norm = normalizeCanvas(canvas);
    const byId = new Map(norm.cards.map((c) => [c.id, c]));
    const resolved = resolveCanvas(canvas, [], scores);
    const resolvedById = new Map(resolved.cards.map((c) => [c.id, c]));
    const memo = new Map(); // cardId:sideIdx -> 链接数组(环守卫:先置空)

    function sideLinks(cardId, sideIdx) {
      const key = cardId + ':' + sideIdx;
      if (memo.has(key)) return memo.get(key);
      memo.set(key, []);
      const card = byId.get(cardId);
      if (!card) return [];
      const own = (card.classLinks || {})[sideIdx === 0 ? 'a' : 'b'];
      /* null = 显式清空,阻断继承 */
      if (own === null) return [];
      if (Array.isArray(own) && own.length) {
        memo.set(key, own);
        return own;
      }
      const slot = card.slots && card.slots[sideIdx];
      if (!slot || slot.type !== 'flow' || !byId.has(slot.cardId)) return [];
      const src = resolvedById.get(slot.cardId);
      if (!src) return [];
      const player = slot.outcome === 'winner' ? src.winner : src.loser;
      if (!player) return [];
      const srcSide = src.a === player ? 0 : src.b === player ? 1 : -1;
      if (srcSide < 0) return [];
      const links = sideLinks(slot.cardId, srcSide);
      memo.set(key, links);
      return links;
    }

    const out = new Map();
    for (const card of norm.cards) {
      out.set(card.id, { a: sideLinks(card.id, 0), b: sideLinks(card.id, 1) });
    }
    return out;
  }

  /* ========== 禁卡表(2026-09 设计:docs/superpowers/specs/2026-09-09-banlist-design.md) ========== */

  const MAX_BAN_LISTS = 32;
  const MAX_BAN_CARDS = 200;
  /* class 归一化:0-7 整数有效,非法(含字符串数字)/缺失→null(禁卡表第 6 位与快照第 7 位共用) */
  function normalizeCls(v){ const n = Number(v); return (Number.isInteger(v) && n >= 0 && n <= 7) ? n : null; }

  function normalizeBanListIds(ids) {
    if (!Array.isArray(ids)) return [];
    const out = [];
    for (const id of ids) {
      if (typeof id !== 'string' || !id || out.includes(id)) continue;
      out.push(id);
      if (out.length >= 8) break;
    }
    return out;
  }

  /* 届级禁卡表归一化:cards 元组 [cardId, name, cost, rarity, limit],
   * limit 三档 0=禁用 1|2=限 N;name/cost/rarity 录入时定格冗余,展示零依赖 */
  function normalizeBanLists(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const bl of value.slice(0, MAX_BAN_LISTS)) {
      if (!bl || typeof bl !== 'object') continue;
      const id = typeof bl.id === 'string' ? bl.id : '';
      const name = String(bl.name || '').trim().slice(0, 40);
      if (!id || !name) continue;
      const cards = [];
      const seen = new Set();
      for (const row of Array.isArray(bl.cards) ? bl.cards.slice(0, MAX_BAN_CARDS) : []) {
        if (!Array.isArray(row) || row.length < 5) continue;
        const cardId = Number(row[0]);
        const limit = Number(row[4]);
        if (!(cardId > 0) || seen.has(cardId)) continue;
        if (limit !== 0 && limit !== 1 && limit !== 2) continue;
        seen.add(cardId);
        cards.push([cardId, String(row[1] || '?').slice(0, 60), Number(row[2]) || 0,
          Math.min(4, Math.max(1, Number(row[3]) || 1)), limit, normalizeCls(row[5])]);
      }
      out.push({ id, name, cards });
    }
    return out;
  }

  /* 届级职业记忆:全局改职业落到这里,后续加同卡沿用(键 String 化) */
  function normalizeBanListClassMap(value) {
    const out = {};
    if (!value || typeof value !== 'object') return out;
    for (const [k, v] of Object.entries(value)) {
      const id = Number(k);
      const n = Number(v);
      if (!(id > 0) || v == null || !(n >= 0 && n <= 7)) continue;
      out[String(id)] = n;
    }
    return out;
  }

  /* 违规判定(纯展示用,不拦截提交):对该卡生效的各表 × 有效链接(含沿连线
   * 继承)× 已解析快照逐一比对;copies 大于 limit 即违规(limit=0 出现即违规)。
   * 同 side 同表同卡只留 copies 最大一条;无快照条目不判定(与统计页口径一致)。 */
  function checkBanViolations(record, cardId) {
    const lists = normalizeBanLists(record && record.banLists);
    if (!lists.length || !(record && record.canvas)) return [];
    const card = (record.canvas.cards || []).find((c) => c && c.id === cardId);
    const bound = new Set(normalizeBanListIds(card && card.banListIds));
    const active = lists.filter((l) => bound.has(l.id));
    if (!active.length) return [];
    const eff = resolveEffectiveClassLinks(record.canvas, record.scores || {});
    const sides = eff.get(cardId) || { a: [], b: [] };
    const out = [];
    for (const side of ['a', 'b']) {
      const worst = new Map(); /* key: listId:cardId -> violation */
      for (const entry of Array.isArray(sides[side]) ? sides[side] : []) {
        const deck = entry && entry.deck;
        if (!deck || !Array.isArray(deck.cards)) continue;
        for (const list of active) {
          for (const row of list.cards) {
            const found = deck.cards.find((r) => r[0] === row[0]);
            if (!found) continue;
            const copies = found[5];
            if (!(copies > row[4])) continue;
            const key = list.id + ':' + row[0];
            const prev = worst.get(key);
            if (prev && prev.copies >= copies) continue;
            worst.set(key, { side, cls: String(entry.cls || ''), cardId: row[0], name: row[1],
              cost: row[2], rarity: row[3], copies, limit: row[4], listId: list.id, listName: list.name });
          }
        }
      }
      out.push(...worst.values());
    }
    return out;
  }

  /* ========== 自动排名 ========== */

  function usedExits(canvas) {
    const used = new Set();
    for (const card of canvas.cards || []) {
      for (const slot of card.slots || []) {
        if (slot && slot.type === 'flow') {
          used.add(slot.cardId + ':' + slot.outcome);
        }
      }
    }
    return used;
  }

  function deriveStandingsFromResolved(canvas, cards, byId) {
    const used = usedExits(canvas);
    const rankMap = new Map(); // rank -> playerId
    const playerRanks = new Map(); // playerId -> rank
    for (const card of cards) {
      const cardDef = (canvas.cards || []).find((c) => c.id === card.id) || {};
      const exitRanks = cardDef.exitRanks || {};
      if (exitRanks.winner != null && card.winner && !used.has(card.id + ':winner')) {
        const rank = Number(exitRanks.winner);
        if (Number.isFinite(rank) && !rankMap.has(rank)) {
          rankMap.set(rank, card.winner);
          playerRanks.set(card.winner, rank);
        }
      }
      if (exitRanks.loser != null && card.loser && !used.has(card.id + ':loser')) {
        const rank = Number(exitRanks.loser);
        if (Number.isFinite(rank) && !rankMap.has(rank)) {
          rankMap.set(rank, card.loser);
          playerRanks.set(card.loser, rank);
        }
      }
    }
    const standings = [...rankMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([rank, playerId]) => ({ rank, playerId }));
    return {
      standings,
      rankMap,
      playerRanks,
      champion: rankMap.get(1) || null,
      runnerUp: rankMap.get(2) || null,
      thirdPlace: rankMap.get(3) || null
    };
  }

  function deriveStandings(record) {
    if (!record || !record.canvas) return { standings: [], rankMap: new Map(), playerRanks: new Map(), champion: null, runnerUp: null, thirdPlace: null };
    const resolved = resolveCanvas(record.canvas, record.roster || [], record.scores || {});
    return resolved.standings;
  }

  /* ========== 卡组补齐 ========== */

  function deckId() {
    return 'd_' + Math.random().toString(36).slice(2, 10);
  }

  /* ========== 迁移 ========== */

  /* 将旧版 tournament（内嵌 players、固定 scores/matchDecks）转换为新画布模型。
   * globalPlayers 是 Map/对象：旧选手 id -> 全局选手对象；若不存在会自动创建。 */
  function migrateLegacyTournament(record, globalPlayers) {
    if (!record) return record;
    const legacyPlayers = Array.isArray(record.players) ? record.players : null;

    if (!legacyPlayers) {
      if (!record.canvas) record.canvas = createEmptyCanvas();
      if (!record.canvas.size) record.canvas.size = { cols: DEFAULT_CANVAS_COLS, rows: DEFAULT_CANVAS_ROWS };
      if (!Array.isArray(record.roster)) record.roster = [];
      if (!record.scores) record.scores = {};
      if (!record.matchDecks) record.matchDecks = {};
      return record;
    }

    const players = legacyPlayers;
    const roster = (Array.isArray(record.roster) && record.roster.length) ? record.roster.slice() : [];
    for (const oldPlayer of players) {
      let player = globalPlayers.get ? globalPlayers.get(oldPlayer.id) : null;
      if (!player) {
        player = {
          id: oldPlayer.id || uid('p'),
          name: oldPlayer.name || '选手',
          title: typeof oldPlayer.title === 'string'
            ? oldPlayer.title
            : (oldPlayer.title && typeof oldPlayer.title === 'object' && typeof oldPlayer.title.text === 'string'
              ? oldPlayer.title.text
              : ''),
          color: oldPlayer.color || null,
          avatar: oldPlayer.avatar || null,
          createdAt: oldPlayer.createdAt || Date.now(),
          updatedAt: oldPlayer.updatedAt || Date.now()
        };
        if (globalPlayers.set) globalPlayers.set(player.id, player);
      }
      if (!roster.includes(player.id)) roster.push(player.id);
    }

    record.roster = roster;
    if (!record.canvas) record.canvas = createDefaultCanvas(roster);
    if (!record.canvas.size) record.canvas.size = { cols: DEFAULT_CANVAS_COLS, rows: DEFAULT_CANVAS_ROWS };
    record.scores = record.scores || {};
    record.matchDecks = record.matchDecks || {};
    if (globalPlayers && globalPlayers.get) {
      const legacyByPlayer = new Map(players.map((p) => [p.id, Array.isArray(p.decks) ? p.decks : null]));
      for (const card of record.canvas.cards) {
        const resolved = resolveCardById(record.canvas, roster, record.scores, card.id);
        const count = getDeckCount(card);
        if (!record.matchDecks[card.id]) record.matchDecks[card.id] = {};
        for (const playerId of [resolved && resolved.a, resolved && resolved.b]) {
          if (!playerId) continue;
          if (!record.matchDecks[card.id][playerId]) {
            const legacy = legacyByPlayer.get(playerId) || [];
            const decks = [];
            for (let i = 0; i < count; i += 1) {
              if (legacy[i]) {
                decks.push({
                  id: legacy[i].id || deckId(),
                  name: legacy[i].name || '卡组 ' + (i + 1),
                  images: Array.isArray(legacy[i].images) ? legacy[i].images.slice() : []
                });
              } else {
                decks.push({ id: deckId(), name: '卡组 ' + (i + 1), images: [] });
              }
            }
            record.matchDecks[card.id][playerId] = decks;
          }
        }
      }
    }
    delete record.players;
    record.updatedAt = Date.now();
    return record;
  }

  function createDefaultTournament(name, roster) {
    const now = Date.now();
    return {
      id: uid('t'),
      name: (name && name.trim()) || '我的赛事',
      status: 'upcoming',
      startTime: null,
      liveUrl: '',
      rules: '',
      background: null,
      createdAt: now,
      updatedAt: now,
      // 新建比赛不再自动填入选手，所有种子位保持待定
      roster: [],
      canvas: createDefaultCanvas([]),
      scores: {},
      matchDecks: {}
    };
  }

  function createBlankTournament(name) {
    const now = Date.now();
    return {
      id: uid('t'),
      name: (name && name.trim()) || '我的赛事',
      status: 'upcoming',
      startTime: null,
      liveUrl: '',
      rules: '',
      background: null,
      createdAt: now,
      updatedAt: now,
      roster: [],
      canvas: createEmptyCanvas(),
      scores: {},
      matchDecks: {}
    };
  }

  /* ========== 列表排序(列表视图编辑用) ==========
   * 列表顺序唯一真源 = cards 数组序:阶段按首次出现分组、组内按数组序。
   * listGroups 只派生不改入参;applyListOrder 把分组序写回并做集合一致性守卫
   * (多/少/重/换卡一律拒绝返回 false,数据不动),调用方据此回滚。 */
  function listGroups(cards) {
    const groups = [];
    const index = new Map();
    for (const card of Array.isArray(cards) ? cards : []) {
      const phase = String((card && card.phase) || '');
      const key = phase === '' ? '__other__' : phase;
      if (!index.has(key)) {
        index.set(key, []);
        groups.push({ key, phase, cards: index.get(key) });
      }
      index.get(key).push(card);
    }
    return groups;
  }

  function applyListOrder(canvas, groups) {
    const flat = [];
    const seen = new Set();
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const card of (group && group.cards) || []) {
        if (!card || !card.id || seen.has(card.id)) return false;
        seen.add(card.id);
        flat.push(card);
      }
    }
    const current = canvas && Array.isArray(canvas.cards) ? canvas.cards : [];
    if (seen.size !== current.length || current.some((c) => !seen.has(c.id))) return false;
    canvas.cards = flat;
    return true;
  }

  /* ========== 多卡剪贴板 ========== */

  /* 深拷贝一组卡片用于粘贴：全部换新 id、整体平移 (dx, dy) 格、label 加「副本」后缀；
   * 卡片之间的连线（flow 槽引用被复制集内的旧 id）重映射到对应新 id，
   * 指向集外卡片的引用原样保留（Figma/CAD 的粘贴语义）。
   * makeId 可注入（测试传确定性函数），默认用 uid。 */
  function cloneCardsForPaste(cards, dx, dy, makeId) {
    const list = (Array.isArray(cards) ? cards : []).filter(Boolean);
    const idOf = typeof makeId === 'function' ? makeId : uid;
    const idMap = new Map();
    const clones = list.map((card) => {
      const clone = JSON.parse(JSON.stringify(card));
      idMap.set(clone.id, idOf('c'));
      return clone;
    });
    clones.forEach((clone) => {
      clone.id = idMap.get(clone.id);
      clone.label = (clone.label || '未命名对局') + ' 副本';
      clone.x = (Number(clone.x) || 0) + (Number(dx) || 0);
      clone.y = (Number(clone.y) || 0) + (Number(dy) || 0);
      clone.slots = (clone.slots || []).map((slot) => {
        if (slot && slot.type === 'flow' && idMap.has(slot.cardId)) {
          return Object.assign({}, slot, { cardId: idMap.get(slot.cardId) });
        }
        return slot ? Object.assign({}, slot) : { type: 'empty' };
      });
    });
    return clones;
  }

  return {
    AVATAR_COLORS,
    CLASS_LIST,
    BANLIST_CLASSES,
    resolveEffectiveClassLinks,
    extractDeckCode,
    normalizeDeckUrl,
    avatarColor,
    uid,
    DEFAULT_CANVAS_COLS,
    DEFAULT_CANVAS_ROWS,
    MAX_CANVAS_COLS,
    MAX_CANVAS_ROWS,
    DOT,
    CARD_WIDTH,
    CARD_HEIGHT,
    PORT_SPAN,
    PORT_NORMALS,
    portOffset,
    pickPort,
    edgePath,
    arrowDefs,
    migrateCanvasToDot,
    createEmptyCanvas,
    createDefaultCanvas,
    createDefaultTournament,
    createBlankTournament,
    cloneCardsForPaste,
    normalizeCanvas,
    normalizeCard,
    canvasOrigin,
    deriveRoster,
    entryCards,
    autoFillEntries,
    getCanvasSize,
    clampCanvasSize,
    getResult,
    getDeckCount,
    isWindowOpen,
    parseHHMM,
    normalizeBanLists,
    normalizeBanListClassMap,
    normalizeDeckSnapshot,
    normalizeBanListIds,
    checkBanViolations,
    resolveCanvas,
    resolveCardById,
    deriveStandings,
    listGroups,
    applyListOrder,
    migrateLegacyTournament
  };
});
