#!/usr/bin/env node
'use strict';

/* 邀请码生成器(本地或 ECS 上运行,需 OSS 环境变量):
 *   node scripts/gen-invite.js --list                查看所有码的绑定/使用状态 + 未认领选手
 *   node scripts/gen-invite.js 8                     生成 8 个空白码(新选手)
 *   node scripts/gen-invite.js 3 --player 雨橘        生成 3 个绑定到「雨橘」的码
 *   node scripts/gen-invite.js --all                 给每个未绑定的存量选手各生成 1 个绑定码(幂等,可反复跑)
 *   --push:生成后直接写入 OSS invite-codes.json;不加则只打印。
 * 绑定码为老选手过渡方案,三期将整体删除。 */

const crypto = require('node:crypto');

const args = process.argv.slice(2);
/* 数量取第一个纯数字参数(允许 --all/--player/--push 出现在任意位置) */
const count = Math.max(1, Math.min(50, parseInt(args.find((a) => /^\d+$/.test(a)), 10) || 1));
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
  const oss = require('../api/oss');

  /* --list:只读查看——码状态、绑定归属、未认领选手 */
  if (args.includes('--list')) {
    const [codes, workspace, users] = await Promise.all([
      oss.readJson('invite-codes.json'),
      oss.readJson('data.json'),
      oss.readJson('users.json')
    ]);
    const pmap = new Map((((workspace && workspace.players) || []).filter((p) => p && p.id)).map((p) => [p.id, p.name]));
    const boundIds = new Set((((users || []).filter((u) => u && u.playerId))).map((u) => u.playerId));
    const list = (codes || []).filter(Boolean);
    const unused = list.filter((c) => !c.used).length;
    console.log('邀请码共 ' + list.length + ' 个,未用 ' + unused + ' 个:');
    console.table(list.map((c) => ({
      code: c.code,
      选手: c.playerId ? (pmap.get(c.playerId) || c.playerId + '(已删)') : '(空白码)',
      状态: c.used ? '已用 → ' + (c.usedBy || '?') : '未用',
      使用时间: c.usedAt || ''
    })));
    const unclaimed = [...pmap.entries()].filter(([id]) => !boundIds.has(id));
    console.log('未被账号认领的老选手(' + unclaimed.length + '):' + (unclaimed.map(([, n]) => n).join('、') || '无'));
    return;
  }

  let entries = [];

  if (args.includes('--all')) {
    /* 给每个还没被账号绑定、且还没有未用绑定码的选手各生成一个绑定码(可重复执行) */
    const workspace = await oss.readJson('data.json');
    const players = ((workspace && workspace.players) || []).filter((p) => p && p.id);
    const users = (await oss.readJson('users.json')) || [];
    const boundIds = new Set(users.filter((u) => u && u.playerId).map((u) => u.playerId));
    const codes = (await oss.readJson('invite-codes.json')) || [];
    const hasOpenCode = new Set(codes.filter((c) => c && !c.used && c.playerId).map((c) => c.playerId));
    const pending = players.filter((p) => !boundIds.has(p.id) && !hasOpenCode.has(p.id));
    entries = pending.map((p) => ({ code: newCode(), playerId: p.id, note: '绑定:' + p.name, used: false, playerName: p.name }));
    console.log('选手总数 ' + players.length + ',已绑定 ' + boundIds.size + ',待发码 ' + entries.length + ':');
  } else {
    let player = null;
    if (playerArg) {
      player = await resolvePlayerId(playerArg);
    }
    for (let i = 0; i < count; i++) {
      entries.push({ code: newCode(), playerId: player ? player.id : null, note: player ? '绑定:' + player.name : '', used: false, playerName: player ? player.name : '' });
    }
  }

  if (push) {
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
    console.log('绑定码使用者登录后即继承选手的全部数据。');
  }
}

main().catch((e) => {
  console.error('[gen-invite] ' + e.message);
  process.exit(1);
});
