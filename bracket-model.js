(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BracketModel = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 8 人标准双败淘汰赛（BO3，无总决赛加赛），共 14 场。
   * 所有晋级结果都由比分派生：scores[matchId] = { a, b }，
   * a/b 分别是该场 A 位、B 位选手赢下的小局数。
   * 败者组结构：R1(2场) → R2(2场) → R3(1场) → 决赛(1场)；
   * 胜者组决赛的败者进入败者组决赛，继续争夺总决赛资格。
   */

  const MATCHES = [
    // 胜者组 R1：4 场，直接使用选手列表顺序配对（1v2、3v4、5v6、7v8）
    { id: 'wb_r1_1', phase: 'wb', round: 1, label: '胜者组 1/4 决赛 1', slots: [{ type: 'seed', index: 0 }, { type: 'seed', index: 1 }] },
    { id: 'wb_r1_2', phase: 'wb', round: 1, label: '胜者组 1/4 决赛 2', slots: [{ type: 'seed', index: 2 }, { type: 'seed', index: 3 }] },
    { id: 'wb_r1_3', phase: 'wb', round: 1, label: '胜者组 1/4 决赛 3', slots: [{ type: 'seed', index: 4 }, { type: 'seed', index: 5 }] },
    { id: 'wb_r1_4', phase: 'wb', round: 1, label: '胜者组 1/4 决赛 4', slots: [{ type: 'seed', index: 6 }, { type: 'seed', index: 7 }] },
    // 胜者组 R2：2 场
    { id: 'wb_r2_1', phase: 'wb', round: 2, label: '胜者组半决赛 1', slots: [{ type: 'winner', match: 'wb_r1_1' }, { type: 'winner', match: 'wb_r1_2' }] },
    { id: 'wb_r2_2', phase: 'wb', round: 2, label: '胜者组半决赛 2', slots: [{ type: 'winner', match: 'wb_r1_3' }, { type: 'winner', match: 'wb_r1_4' }] },
    // 胜者组决赛：1 场
    { id: 'wb_final', phase: 'wb', round: 3, label: '胜者组决赛', slots: [{ type: 'winner', match: 'wb_r2_1' }, { type: 'winner', match: 'wb_r2_2' }] },
    // 败者组 R1：2 场
    { id: 'lb_r1_1', phase: 'lb', round: 1, label: '败者组第一轮 1', slots: [{ type: 'loser', match: 'wb_r1_1' }, { type: 'loser', match: 'wb_r1_2' }] },
    { id: 'lb_r1_2', phase: 'lb', round: 1, label: '败者组第一轮 2', slots: [{ type: 'loser', match: 'wb_r1_3' }, { type: 'loser', match: 'wb_r1_4' }] },
    // 败者组 R2：2 场
    { id: 'lb_r2_1', phase: 'lb', round: 2, label: '败者组第二轮 1', slots: [{ type: 'loser', match: 'wb_r2_1' }, { type: 'winner', match: 'lb_r1_1' }] },
    { id: 'lb_r2_2', phase: 'lb', round: 2, label: '败者组第二轮 2', slots: [{ type: 'loser', match: 'wb_r2_2' }, { type: 'winner', match: 'lb_r1_2' }] },
    // 败者组 R3（半决赛）：1 场
    { id: 'lb_r3', phase: 'lb', round: 3, label: '败者组半决赛', slots: [{ type: 'winner', match: 'lb_r2_1' }, { type: 'winner', match: 'lb_r2_2' }] },
    // 败者组决赛：胜者组决赛败者对阵败者组半决赛胜者，共 1 场
    { id: 'lb_final', phase: 'lb', round: 4, label: '败者组决赛', slots: [{ type: 'loser', match: 'wb_final' }, { type: 'winner', match: 'lb_r3' }] },
    // 总决赛：1 场
    { id: 'grand_final', phase: 'gf', round: 1, label: '总决赛', slots: [{ type: 'winner', match: 'wb_final' }, { type: 'winner', match: 'lb_final' }] }
  ];

  const MATCH_BY_ID = Object.fromEntries(MATCHES.map((m) => [m.id, m]));

  function isScoreValid(a, b) {
    const valid = [
      [2, 0],
      [2, 1],
      [1, 2],
      [0, 2]
    ];
    return valid.some(([va, vb]) => va === a && vb === b);
  }

  function getResult(scores, matchId) {
    const score = scores[matchId];
    if (!score || !isScoreValid(score.a, score.b)) return null;
    return { a: score.a, b: score.b, winnerSide: score.a > score.b ? 0 : 1 };
  }

  function resolveSlot(slot, seeds, scores, memo) {
    if (slot.type === 'seed') {
      return seeds[slot.index] || null;
    }
    const sourceMatch = MATCH_BY_ID[slot.match];
    const result = getResult(scores, slot.match);
    if (!result) return null;
    const winnerIndex = result.winnerSide;
    const wantedIndex = slot.type === 'winner' ? winnerIndex : 1 - winnerIndex;
    const source = sourceMatch.slots[wantedIndex];
    const key = slot.match + ':' + slot.type + ':' + wantedIndex;
    if (memo.has(key)) return memo.get(key);
    memo.set(key, null);
    const resolved = resolveSlot(source, seeds, scores, memo);
    memo.set(key, resolved);
    return resolved;
  }

  function resolveMatch(match, seeds, scores) {
    const memo = new Map();
    const a = resolveSlot(match.slots[0], seeds, scores, memo);
    const b = resolveSlot(match.slots[1], seeds, scores, memo);
    const result = getResult(scores, match.id);
    return {
      id: match.id,
      phase: match.phase,
      round: match.round,
      label: match.label,
      a,
      b,
      scoreA: result ? result.a : null,
      scoreB: result ? result.b : null,
      winner: result ? (result.winnerSide === 0 ? a : b) : null,
      loser: result ? (result.winnerSide === 0 ? b : a) : null,
      played: Boolean(result)
    };
  }

  function resolveAll(seeds, scores) {
    return MATCHES.map((match) => resolveMatch(match, seeds || [], scores || {}));
  }

  function deriveStandings(seeds, scores) {
    const resolved = resolveAll(seeds, scores);
    const grandFinal = resolved.find((m) => m.id === 'grand_final');
    const lbFinal = resolved.find((m) => m.id === 'lb_final');
    return {
      champion: grandFinal && grandFinal.played ? grandFinal.winner : null,
      runnerUp: grandFinal && grandFinal.played ? grandFinal.loser : null,
      thirdPlace: lbFinal && lbFinal.played ? lbFinal.loser : null,
      grandFinal
    };
  }

  function groupByPhase(matches) {
    const groups = { wb: [], lb: [], gf: [] };
    for (const match of matches) {
      groups[match.phase].push(match);
    }
    return groups;
  }

  return {
    MATCHES,
    MATCH_BY_ID,
    isScoreValid,
    getResult,
    resolveMatch,
    resolveAll,
    deriveStandings,
    groupByPhase
  };
});
