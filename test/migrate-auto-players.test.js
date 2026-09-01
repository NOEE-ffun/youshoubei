'use strict';

/* migrate-auto-players 纯函数:存量账号补建选手 + role user→player(幂等)。 */
const assert = require('node:assert');
const { planAutoPlayers } = require('../scripts/migrate-auto-players');

const genId = (p) => p + '_fixed';
const nowIso = () => '2026-09-01T00:00:00Z';
const mkUser = (over) => Object.assign(
  { id: 'u1', username: '13800000001', usernameLower: '13800000001', phone: '13800000001',
    passHash: null, role: 'player', playerId: 'p_ok', nickname: null, status: 'active', createdAt: 't' }, over);

let r = planAutoPlayers([mkUser({})], { tournaments: [], players: [{ id: 'p_ok', name: '既有' }] }, genId, nowIso);
assert.strictEqual(r.changed, false, '完整库零变更');

/* 未绑账号补建:名取昵称优先,回填 playerId */
r = planAutoPlayers([mkUser({ id: 'u2', playerId: null, nickname: '老王' })],
  { tournaments: [], players: [{ id: 'p_ok', name: '既有' }] }, genId, nowIso);
assert.strictEqual(r.changed, true);
assert.strictEqual(r.created, 1);
const u2 = r.users.find((x) => x.id === 'u2');
assert.strictEqual(u2.playerId, 'p_fixed');
const created = r.workspace.players.find((p) => p.id === 'p_fixed');
assert.strictEqual(created.name, '老王');
assert.strictEqual(created.createdAt, '2026-09-01T00:00:00Z');

/* 悬空 playerId 重建;无名无昵称回落 username */
r = planAutoPlayers([mkUser({ id: 'u3', playerId: 'p_gone', nickname: null })],
  { tournaments: [], players: [] }, genId, nowIso);
assert.strictEqual(r.users.find((x) => x.id === 'u3').playerId, 'p_fixed');
assert.strictEqual(r.workspace.players.find((p) => p.id === 'p_fixed').name, '13800000001');

/* role:'user' 升 player,不重复建档案 */
r = planAutoPlayers([mkUser({ id: 'u4', role: 'user', playerId: 'p_ok' })],
  { tournaments: [], players: [{ id: 'p_ok', name: '既有' }] }, genId, nowIso);
assert.strictEqual(r.changed, true);
assert.strictEqual(r.upgraded, 1);
assert.strictEqual(r.created, 0);
assert.strictEqual(r.users.find((x) => x.id === 'u4').role, 'player');

/* 幂等:对迁移结果再跑零变更 */
r = planAutoPlayers(r.users, r.workspace, genId, nowIso);
assert.strictEqual(r.changed, false, '二次运行幂等');

/* 入参不被原地修改 */
const srcUsers = [mkUser({ id: 'u5', playerId: null })];
const srcWs = { tournaments: [], players: [] };
planAutoPlayers(srcUsers, srcWs, genId, nowIso);
assert.strictEqual(srcUsers[0].playerId, null, '入参 users 不被改');
assert.strictEqual(srcWs.players.length, 0, '入参 workspace 不被改');

console.log('✓ migrate-auto-players:补建/悬空重建/升格/幂等/无副作用');
