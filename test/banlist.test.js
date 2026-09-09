'use strict';

/* 禁卡表:模型归一化 + checkBanViolations 判定纯函数(设计见
 * docs/superpowers/specs/2026-09-09-banlist-design.md) */
const assert = require('node:assert');
const CM = require('../canvas-model');

function deckEntry(cards, cls) {
  return { cls: cls || '皇家', url: 'https://shadowverse-wb.com/chs/deck/detail/?hash=1.2.aaa', text: '',
    deck: { v: 1, resolvedAt: 1, classId: 2, format: null, cards } };
}

function mkRecord(opts) {
  const o = opts || {};
  return {
    id: 't1',
    scores: {},
    banLists: o.banLists,
    canvas: {
      cards: [{
        id: 'k1', label: '决赛', phase: '', format: 'BO3', x: 0, y: 0,
        slots: [{ type: 'empty' }, { type: 'empty' }], exitRanks: {}, deckCount: null, color: null,
        classLinks: o.classLinks || { a: [], b: [] },
        banListIds: o.banListIds
      }]
    }
  };
}

const BL1 = [{ id: 'bl1', name: '第一周', cards: [[501, '禁卡A', 2, 3, 0], [502, '限卡B', 3, 2, 1]] }];

(async () => {
  /* ---- normalizeBanLists ---- */
  assert.deepStrictEqual(CM.normalizeBanLists(undefined), []);
  assert.deepStrictEqual(CM.normalizeBanLists('x'), []);
  assert.deepStrictEqual(CM.normalizeBanLists([{ id: 'bl1', name: 'X', cards: [[501, 'a', 2, 3, 0]] }]),
    [{ id: 'bl1', name: 'X', cards: [[501, 'a', 2, 3, 0]] }]);
  /* 非法 limit 剔除;重复 cardId 保首条;缺 id/name 剔除 */
  assert.deepStrictEqual(CM.normalizeBanLists([{ id: 'a', name: 'A', cards: [
    [501, 'x', 1, 1, 3], [501, 'y', 1, 1, 2], [502, 'z', 1, 1, 0], [502, 'z', 1, 1, 0]
  ] }]), [{ id: 'a', name: 'A', cards: [[501, 'y', 1, 1, 2], [502, 'z', 1, 1, 0]] }]);
  assert.deepStrictEqual(CM.normalizeBanLists([{ id: '', name: 'A', cards: [] }, { id: 'b', name: ' ', cards: [] }]), []);
  /* 表上限 12 */
  const many = Array.from({ length: 15 }, (_, i) => ({ id: 'b' + i, name: 'N' + i, cards: [[1, 'c', 1, 1, 0]] }));
  assert.strictEqual(CM.normalizeBanLists(many).length, 12);

  /* ---- normalizeBanListIds / normalizeCard 白名单 ---- */
  assert.deepStrictEqual(CM.normalizeBanListIds(['a', 'a', 3, '', 'b', undefined]), ['a', 'b']);
  const card = CM.normalizeCanvas({ cards: [{ id: 'k1', banListIds: ['bl1', 'bl1', 'bad'], classLinks: { a: [], b: [] } }] }).cards[0];
  assert.deepStrictEqual(card.banListIds, ['bl1', 'bad']);
  assert.deepStrictEqual(CM.normalizeCanvas({ cards: [{ id: 'k1' }] }).cards[0].banListIds, []);

  /* ---- checkBanViolations ---- */
  /* 禁用:出现即违规 */
  let r = CM.checkBanViolations(mkRecord({ banLists: BL1, banListIds: ['bl1'],
    classLinks: { a: [deckEntry([[501, '禁卡A', 2, 3, 0, 1], [999, '杂卡', 1, 1, 0, 3]])], b: [] } }), 'k1');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].cardId, 501); assert.strictEqual(r[0].limit, 0);
  assert.strictEqual(r[0].copies, 1); assert.strictEqual(r[0].side, 'a');
  assert.strictEqual(r[0].listName, '第一周'); assert.strictEqual(r[0].cost, 2); assert.strictEqual(r[0].rarity, 3);
  /* 限1带2=超限;限2带2=合规 */
  r = CM.checkBanViolations(mkRecord({ banLists: BL1, banListIds: ['bl1'],
    classLinks: { a: [deckEntry([[502, '限卡B', 3, 2, 0, 2]])], b: [] } }), 'k1');
  assert.strictEqual(r.length, 1); assert.strictEqual(r[0].copies, 2); assert.strictEqual(r[0].limit, 1);
  r = CM.checkBanViolations(mkRecord({ banLists: [{ id: 'bl1', name: 'X', cards: [[502, '限卡B', 3, 2, 2]] }], banListIds: ['bl1'],
    classLinks: { a: [deckEntry([[502, '限卡B', 3, 2, 0, 2]])], b: [] } }), 'k1');
  assert.strictEqual(r.length, 0);
  /* 未绑表 / 悬空表 id → 无违规 */
  assert.strictEqual(CM.checkBanViolations(mkRecord({ banLists: BL1, classLinks: { a: [deckEntry([[501, '禁卡A', 2, 3, 0, 3]])], b: [] } }), 'k1').length, 0);
  assert.strictEqual(CM.checkBanViolations(mkRecord({ banLists: BL1, banListIds: ['gone'],
    classLinks: { a: [deckEntry([[501, '禁卡A', 2, 3, 0, 3]])], b: [] } }), 'k1').length, 0);
  /* 有 url 无快照(未解析)不判定;无 banLists 不判定 */
  assert.strictEqual(CM.checkBanViolations(mkRecord({ banLists: BL1, banListIds: ['bl1'],
    classLinks: { a: [{ cls: '皇家', url: 'https://shadowverse-wb.com/chs/deck/detail/?hash=1.2.zzz', text: '' }], b: [] } }), 'k1').length, 0);
  assert.strictEqual(CM.checkBanViolations(mkRecord({ banListIds: ['bl1'], classLinks: { a: [deckEntry([[501, '禁卡A', 2, 3, 0, 3]])], b: [] } }), 'k1').length, 0);
  /* 多表同卡各自报;b side 独立 */
  r = CM.checkBanViolations(mkRecord({
    banLists: [BL1[0], { id: 'bl2', name: '第二周', cards: [[501, '禁卡A', 2, 3, 1]] }], banListIds: ['bl1', 'bl2'],
    classLinks: { a: [], b: [deckEntry([[501, '禁卡A', 2, 3, 0, 3]], '精灵')] } }), 'k1');
  assert.strictEqual(r.length, 2);
  assert.ok(r.every((v) => v.side === 'b' && v.cls === '精灵'));
  assert.ok(r.some((v) => v.listId === 'bl1' && v.limit === 0) && r.some((v) => v.listId === 'bl2' && v.limit === 1));
  /* 同 side 两副快照取 copies 最大 */
  r = CM.checkBanViolations(mkRecord({ banLists: BL1, banListIds: ['bl1'],
    classLinks: { a: [deckEntry([[502, '限卡B', 3, 2, 0, 1]]), deckEntry([[502, '限卡B', 3, 2, 0, 3]])], b: [] } }), 'k1');
  assert.strictEqual(r.length, 1); assert.strictEqual(r[0].copies, 3);
  /* 卡不存在 → [] */
  assert.strictEqual(CM.checkBanViolations(mkRecord({ banLists: BL1 }), 'nope').length, 0);

  console.log('banlist tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
