#!/usr/bin/env node
'use strict';

/* 灾难恢复 CLI:列出 OSS backups/ 里的 data.json 历史版本,选一个拷回 data.json。
 * 用法:
 *   node scripts/restore-data.js            # 列出备份
 *   node scripts/restore-data.js 3          # 把序号 3 的备份恢复为当前 data.json
 * 环境变量与 server 相同(OSS_REGION/OSS_BUCKET/OSS_ACCESS_KEY_ID/OSS_ACCESS_KEY_SECRET)。 */

const { listBackups, DATA_PATH, getClient } = require('../api/oss');
/* require server.js 顺带读取 .env(与线上进程同一套环境解析),须在 main() 执行前完成 */
require('../server');

async function main() {
  const pick = process.argv[2];
  const backups = await listBackups();
  if (!backups.length) {
    console.log('backups/ 下没有备份。');
    return;
  }
  if (pick === undefined) {
    console.log('可用备份(时间序,新在下):');
    backups.forEach((name, i) => console.log('  ' + i + '. ' + name));
    console.log('\n恢复:node scripts/restore-data.js <序号>');
    return;
  }
  const idx = Number(pick);
  if (!Number.isInteger(idx) || idx < 0 || idx >= backups.length) {
    console.error('序号无效:' + pick);
    process.exit(1);
  }
  const key = backups[idx];
  const client = getClient();
  /* 先把当前版本再备份一份,防恢复操作本身出错 */
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await client.copy('backups/data-' + stamp + '.json', DATA_PATH);
  await client.copy(DATA_PATH, key);
  console.log('已恢复 ' + key + ' → ' + DATA_PATH + '(恢复前版本已另存)');
}

main().catch((error) => {
  console.error('恢复失败:', error.message);
  process.exit(1);
});
