#!/usr/bin/env node
'use strict';

/* 邀请码生成器(本地或 ECS 上运行):
 *   node scripts/gen-invite.js 8                     生成 8 个空白码
 *   node scripts/gen-invite.js 3 --player 雨橘        生成 3 个绑定到「雨橘」的码
 *   node scripts/gen-invite.js 5 --push               生成后直接写入 OSS invite-codes.json(需 env)
 * 未 --push 时只打印,由管理员手工粘贴进 OSS 控制台的 invite-codes.json。
 * 绑定码为老选手过渡方案,三期将整体删除。 */

const crypto = require('node:crypto');

const args = process.argv.slice(2);
const count = Math.max(1, Math.min(50, parseInt(args[0], 10) || 1));
const playerArg = (args.includes('--player') && args[args.indexOf('--player') + 1]) || null;
const push = args.includes('--push');

function newCode() {
  /* 12 位分组易读码,去掉易混淆字符 */
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += alphabet[bytes[i] % alphabet.length];
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12);
}

async function resolvePlayerId(nameOrId) {
  const oss = require('../api/oss');
  const workspace = await oss.readJson('data.json');
  const players = (workspace && workspace.players) || [];
  const byId = players.find((p) => p.id === nameOrId);
  if (byId) return { id: byId.id, name: byId.name };
  const byName = players.filter((p) => p && p.name === nameOrId);
  if (byName.length === 1) return { id: byName[0].id, name: byName[0].name };
  if (byName.length > 1) throw new Error('重名选手:' + byName.map((p) => p.id).join(', ') + ',请用选手 id 指定');
  throw new Error('选手不存在:' + nameOrId);
}

async function main() {
  let player = null;
  if (playerArg) {
    player = await resolvePlayerId(playerArg);
  }

  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push({ code: newCode(), playerId: player ? player.id : null, note: player ? '绑定:' + player.name : '', used: false });
  }

  if (push) {
    const oss = require('../api/oss');
    const codes = (await oss.readJson('invite-codes.json')) || [];
    const existing = new Set(codes.map((c) => c && c.code));
    let n = 0;
    for (const e of entries) {
      if (!existing.has(e.code)) { codes.push(e); n++; }
    }
    await oss.writeJson('invite-codes.json', codes);
    console.log('已写入 OSS invite-codes.json(+' + n + ')');
  }

  console.table ? console.table(entries) : console.log(JSON.stringify(entries, null, 2));
  if (!push) {
    console.log('提示:加 --push 直接写入 OSS;或把上表粘进 OSS 的 invite-codes.json 数组。');
    console.log('绑定码使用者登录后即继承选手「' + (player ? player.name : '-') + '」的全部数据。');
  }
}

main().catch((e) => {
  console.error('[gen-invite] ' + e.message);
  process.exit(1);
});
