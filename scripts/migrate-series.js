#!/usr/bin/env node
'use strict';

/* 一次性幂等迁移:存量届挂默认系列「历届比赛」(二期 series 上线前的库无 series 概念)。
 * 用法:
 *   node scripts/migrate-series.js --dry    预览将要做的变更,不写入
 *   node scripts/migrate-series.js          执行迁移(写前自动 backupData 备份)
 * 规则:
 *   - 「无 createdBy 且无 seriesId」的届 = 存量届 → 挂到默认系列(key:'default',
 *     name「历届比赛」),createdBy 补超管 id(存量届的管理权归 NOEE,与规格一致);
 *   - 「无 createdBy 但有 seriesId」(已挂系列)/「有 createdBy 无 seriesId」(二期后
 *     新建未分组的届)一律不动;
 *   - superUserId 解析不到(users.json 无 env 超管名单账号)时照建,默认系列与届的
 *     createdBy 保持 null——系统资源,仅 env 超管可管;
 *   - 幂等:重复运行零变更;--dry 只打印不写。
 * 环境变量与 server 相同(OSS_* + SUPER_ADMIN_USERNAMES)。
 * 逻辑抽成纯函数 planMigration(workspace, superUserId) 导出,单测在 test/acl.test.js。 */

const crypto = require('node:crypto');

/* 与 api/account.js 的 newId 同约定:前缀 + 8 字节随机 hex */
function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

/** 纯函数:计算迁移后的工作区(不改入参,返回深拷贝)。
 * 返回 { changed, workspace, attached, createdSeries }:
 *   changed        是否有实际变更(无孤儿届则恒 false——空库/已迁移库不建空系列,
 *                  series 缺失由 acl 守卫按 [] 处理,无需在此补)
 *   workspace      规范化后的工作区(tournaments/series 保证为数组)
 *   attached       挂入默认系列的届数
 *   createdSeries  是否新建了默认系列(false=复用既有 key:'default') */
function planMigration(workspace, superUserId) {
  const ws = JSON.parse(JSON.stringify(workspace || {}));
  if (!Array.isArray(ws.tournaments)) ws.tournaments = [];
  if (!Array.isArray(ws.series)) ws.series = [];

  /* 孤儿届:无 createdBy 且无 seriesId(null/undefined/'' 均算无) */
  const orphans = ws.tournaments.filter((t) => t && !t.createdBy && !t.seriesId);
  if (!orphans.length) return { changed: false, workspace: ws, attached: 0, createdSeries: false };

  let def = ws.series.find((s) => s && s.key === 'default') || null;
  let createdSeries = false;
  if (!def) {
    def = {
      id: newId('s'),
      key: 'default',
      name: '历届比赛',
      createdBy: superUserId == null ? null : superUserId,
      createdAt: new Date().toISOString()
    };
    ws.series.push(def);
    createdSeries = true;
  }
  for (const t of orphans) {
    t.seriesId = def.id;
    t.createdBy = superUserId == null ? null : superUserId;
  }
  return { changed: true, workspace: ws, attached: orphans.length, createdSeries };
}

/** env 超管名单 SUPER_ADMIN_USERNAMES(逗号列表)按序在 users.json 里找第一条命中,
 * 返回其账号 id;找不到返回 null(默认系列照建为系统资源)。 */
function resolveSuperUserId(users) {
  const names = String(process.env.SUPER_ADMIN_USERNAMES || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const name of names) {
    const hit = (users || []).find(
      (u) => u && typeof u.usernameLower === 'string' && u.usernameLower.toLowerCase() === name);
    if (hit && hit.id != null) return hit.id;
  }
  return null;
}

async function main() {
  /* require server.js 顺带读 .env(与 restore-data.js 同模式),须在用 env 前完成 */
  require('../server');
  const oss = require('../api/oss');

  if (!oss.isOssConfigured()) {
    console.error('[migrate-series] OSS 配置不完整:需要 OSS_REGION / OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET');
    process.exit(1);
  }

  const dry = process.argv.includes('--dry');
  const workspace = await oss.readJson(oss.DATA_PATH);
  if (!workspace) {
    console.log('[migrate-series] data.json 不存在或为空,无需迁移。');
    return;
  }

  const users = (await oss.readJson('users.json')) || [];
  const superUserId = resolveSuperUserId(users);
  const result = planMigration(workspace, superUserId);

  if (!result.changed) {
    console.log('[migrate-series] 无变更(已迁移,或不存在待挂系列的存量届)。');
    return;
  }

  const def = result.workspace.series.find((s) => s && s.key === 'default');
  console.log((result.createdSeries ? '新建' : '复用') + '默认系列「历届比赛」:'
    + def.id + ',createdBy=' + (def.createdBy == null ? 'null(系统资源,仅 env 超管可管)' : def.createdBy));
  console.log('挂入存量届 ' + result.attached + ' 个(补 createdBy='
    + (superUserId == null ? 'null' : superUserId) + ')。');
  if (superUserId == null) {
    console.log('提示:users.json 中未找到 SUPER_ADMIN_USERNAMES 命中的账号,'
      + '默认系列与存量届的归属为 null(系统资源)。');
  }

  if (dry) {
    console.log('[migrate-series] --dry 预览,未写入。去掉 --dry 执行迁移(写前自动备份 data.json)。');
    return;
  }

  await oss.backupData();
  await oss.writeJson(oss.DATA_PATH, result.workspace);
  console.log('[migrate-series] 已备份 data.json 并写入迁移结果。');
}

module.exports = { planMigration, resolveSuperUserId };

if (require.main === module) {
  main().catch((error) => {
    console.error('[migrate-series] ' + (error && error.message ? error.message : error));
    process.exit(1);
  });
}
