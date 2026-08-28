#!/usr/bin/env node
'use strict';

/* 查看审计日志:node scripts/read-audit.js [月份 yyyy-mm](缺省当月)
 * 环境变量与 server 相同(OSS 四项)。 */

const { getClient } = require('../api/oss');
/* require server.js 顺带读取 .env(与线上进程同一套环境解析),须在 main() 执行前完成 */
require('../server');

async function main() {
  const month = process.argv[2] || new Date().toISOString().slice(0, 7);
  const key = 'audit/log-' + month + '.json';
  const client = getClient();
  let list;
  try {
    const result = await client.get(key);
    list = JSON.parse(result.content.toString('utf8'));
  } catch (error) {
    if (error.code === 'NoSuchKey' || error.status === 404) {
      console.log(key + ' 不存在(该月无审计记录)');
      return;
    }
    throw error;
  }
  if (!Array.isArray(list) || !list.length) {
    console.log(key + ' 为空');
    return;
  }
  console.log(key + ' 共 ' + list.length + ' 条:\n');
  for (const e of list) {
    console.log('  ' + e.t + '  [' + e.action + ']  ' + (e.detail || ''));
  }
}

main().catch((error) => {
  console.error('读取失败:', error.message);
  process.exit(1);
});
