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

  /* 画布几何唯一真源:卡片尺寸、网格间距、连线端口纵向偏移,
   * bracket.js(渲染)与 canvas-editor.js(编辑)统一引用,改这里即可全局生效 */
  const CARD_WIDTH = 280;
  const CARD_HEIGHT = 176;
  const COL_GAP = 320;
  const ROW_GAP = 210;
  const PORT_Y = { winner: 70, loser: 108 };

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

  function createEmptyCanvas() {
    return { cards: [], size: { cols: DEFAULT_CANVAS_COLS, rows: DEFAULT_CANVAS_ROWS } };
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
      deckCount: c.deckCount && Number.isFinite(Number(c.deckCount)) ? Number(c.deckCount) : null
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
    return { cards: cards.map(normalizeCard), size: getCanvasSize(c) };
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
    return { cards: cards.map(normalizeCard), size: { cols: DEFAULT_CANVAS_COLS, rows: DEFAULT_CANVAS_ROWS } };
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

  function ensureCanvasDecks(record) {
    if (!record || !record.canvas) return record;
    if (!record.matchDecks || typeof record.matchDecks !== 'object') record.matchDecks = {};
    const scores = record.scores || {};
    const roster = record.roster || [];
    const resolved = resolveCanvas(record.canvas, roster, scores);
    const canonicalByPlayer = new Map();
    const seenDeckObjects = new WeakSet();
    const usedIds = new Set();

    for (const card of resolved.cards) {
      const cardDef = (record.canvas.cards || []).find((c) => c.id === card.id) || {};
      const count = getDeckCount(cardDef);
      if (!record.matchDecks[card.id]) record.matchDecks[card.id] = {};
      for (const playerId of [card.a, card.b]) {
        if (!playerId) continue;
        let canonical = canonicalByPlayer.get(playerId) || [];
        const existing = record.matchDecks[card.id][playerId];
        const decks = [];
        for (let i = 0; i < count; i += 1) {
          let candidate = (Array.isArray(existing) && existing[i] && typeof existing[i] === 'object') ? existing[i] : null;
          if (!canonical[i] && candidate) canonical[i] = candidate;
          if (!canonical[i]) {
            canonical[i] = { id: deckId(), name: '卡组 ' + (i + 1), images: [] };
          }
          const deck = canonical[i];
          if (!seenDeckObjects.has(deck)) {
            if (!deck.id || usedIds.has(deck.id)) deck.id = deckId();
            usedIds.add(deck.id);
            seenDeckObjects.add(deck);
          }
          if (!deck.name) deck.name = '卡组 ' + (i + 1);
          if (!Array.isArray(deck.images)) deck.images = [];
          decks.push(deck);
        }
        canonicalByPlayer.set(playerId, canonical);
        record.matchDecks[card.id][playerId] = decks;
      }
    }
    return record;
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
    avatarColor,
    uid,
    DEFAULT_CANVAS_COLS,
    DEFAULT_CANVAS_ROWS,
    MAX_CANVAS_COLS,
    MAX_CANVAS_ROWS,
    CARD_WIDTH,
    CARD_HEIGHT,
    COL_GAP,
    ROW_GAP,
    PORT_Y,
    createEmptyCanvas,
    createDefaultCanvas,
    createDefaultTournament,
    createBlankTournament,
    cloneCardsForPaste,
    normalizeCanvas,
    normalizeCard,
    deriveRoster,
    getCanvasSize,
    clampCanvasSize,
    getResult,
    getDeckCount,
    resolveCanvas,
    resolveCardById,
    deriveStandings,
    ensureCanvasDecks,
    migrateLegacyTournament
  };
});
