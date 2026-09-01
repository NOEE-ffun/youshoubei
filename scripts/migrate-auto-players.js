#!/usr/bin/env node
'use strict';

/* 一次性幂等迁移(用户/选手合并,2026-09-01):
 *   node scripts/migrate-auto-players.js           dry-run 预览,不写入
 *   node scripts/migrate-auto-players.js --push    执行迁移(写前自动备份 users/data)
 * 规则:缺失/悬空 playerId 的账号补建选手(名取 昵称||用户名 前 24 字);
 *   role:'user' 全部升 'player'。幂等可重跑。
 * 部署顺序:先跑本迁移再重启服务(同 migrate-series 先例)。
 * 逻辑纯函数 planAutoPlayers 导出,单测 test/migrate-auto-players.test.js。 */

const crypto = require('node:crypto');

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

/** 纯函数(不改入参,返回深拷贝)。genId/nowIso 注入供测试定值。 */
function planAutoPlayers(users, workspace, genId, nowIso) {
  const us = JSON.parse(JSON.stringify(users || [])).filter(Boolean);
  const ws = JSON.parse(JSON.stringify(workspace || {}));
  if (!Array.isArray(ws.players)) ws.players = [];
  const ids = new Set(ws.players.filter((p) => p && p.id).map((p) => p.id));
  let created = 0;
  let upgraded = 0;
  for (const u of us) {
    if (u.role === 'user') { u.role = 'player'; upgraded++; }
    if (!u.playerId || !ids.has(u.playerId)) {
      const p = {
        id: genId('p'),
        name: String(u.nickname || u.username || u.id).slice(0, 24),
        tag: null, tagImg: null, tagImgRatio: null, tagImgSize: null,
        title: null, color: null, avatar: null,
        createdAt: nowIso(), updatedAt: nowIso()
      };
      ws.players.push(p);
      ids.add(p.id);
      u.playerId = p.id;
      created++;
    }
  }
  return { changed: created > 0 || upgraded > 0, users: us, workspace: ws, created, upgraded };
}

async function main() {
  require('../server'); /* 读 .env(同 migrate-series 模式) */
  const oss = require('../api/oss');
  if (!oss.isOssConfigured()) {
    console.error('[migrate-auto-players] OSS 配置不完整:需要 OSS_REGION / OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET');
    process.exit(1);
  }
  const push = process.argv.includes('--push');
  const users = (await oss.readJson('users.json')) || [];
  const workspace = await oss.readJson(oss.DATA_PATH);
  if (!workspace) {
    console.log('[migrate-auto-players] data.json 不存在或为空,无需迁移。');
    return;
  }
  const r = planAutoPlayers(users, workspace, newId, () => new Date().toISOString());
  if (!r.changed) {
    console.log('[migrate-auto-players] 无变更(已迁移,或没有待补建账号)。');
    return;
  }
  console.log('补建选手档案 ' + r.created + ' 个;role user→player ' + r.upgraded + ' 个。');
  if (!push) {
    console.log('[migrate-auto-players] dry-run 预览,未写入。加 --push 执行(写前自动备份 users.json 与 data.json)。');
    return;
  }
  await oss.backupJson('users.json', 'users');
  await oss.backupData();
  await oss.writeJson('users.json', r.users);
  await oss.writeJson(oss.DATA_PATH, r.workspace);
  console.log('[migrate-auto-players] 已备份并写入 users.json / data.json。');
}

module.exports = { planAutoPlayers };

if (require.main === module) {
  main().catch((error) => {
    console.error('[migrate-auto-players] ' + (error && error.message ? error.message : error));
    process.exit(1);
  });
}
