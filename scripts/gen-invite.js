#!/usr/bin/env node
'use strict';

/* 邀请码生成器(本地或 ECS 上运行,需 OSS 环境变量):
 *   node scripts/gen-invite.js --list                 查看码状态 + 未认领选手(换绑参考)
 *   node scripts/gen-invite.js 2 --kind admin [--push]  生成 2 个管理员码(仅应急;日常走网页发码中心)
 * 选手码(空白/绑定)已随「注册即选手」退役(2026-09-01):不再生成,历史码自然作废。
 * 码生成函数与发码中心 API 共用 api/codes 的 generateCode。 */

const { generateCode: newCode } = require('../api/codes');

const args = process.argv.slice(2);
/* 数量取第一个纯数字参数(允许 --kind/--push 出现在任意位置) */
const count = Math.max(1, Math.min(50, parseInt(args.find((a) => /^\d+$/.test(a)), 10) || 1));
const push = args.includes('--push');
const kindAdmin = (args.includes('--kind') && args[args.indexOf('--kind') + 1]) === 'admin';

async function main() {
  /* 选手码(空白/绑定)已停用:生成仅剩 admin 码一条路(此守卫先于 OSS 依赖,
   * 无 OSS 环境变量的机器也能得到明确提示而非配置报错) */
  if (!args.includes('--list') && !kindAdmin) {
    console.error('选手码已停用,仅支持 --kind admin');
    process.exit(1);
  }

  const oss = require('../api/oss');

  /* --list:只读查看——码状态、绑定归属、未认领选手(后台换绑老选手时参考) */
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

  console.log('提示:admin 码请由超管在网页发码中心生成,此脚本仅供应急。');
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push({ code: newCode(), kind: 'admin', playerId: null, note: '', used: false, playerName: '' });
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
  }
}

main().catch((e) => {
  console.error('[gen-invite] ' + e.message);
  process.exit(1);
});
