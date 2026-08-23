#!/usr/bin/env node
'use strict';

/* 查看审计日志:node scripts/read-audit.js [月份 yyyy-mm](缺省当月)
 * 环境变量与 server 相同(OSS 四项)。 */

const { appendAudit, auditKeyNow } = require('../api/oss');

function getEnv() {
  const client = new (require('ali-oss'))({
    region: process.env.OSS_REGION,
    bucket: process.env.OSS_BUCKET,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    secure: true,
    timeout: 8000
  });
  return client;
}

async function main() {
  const month = process.argv[2] || new Date().toISOString().slice(0, 7);
  const key = 'audit/log-' + month + '.json';
  const client = getEnv();
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

/* 读 .env(与 restore-data 相同的极简版) */
const fs = require('fs');
const path = require('path');
try {
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch (error) { /* 无 .env 时用现有环境变量 */ }

main().catch((error) => {
  console.error('读取失败:', error.message);
  process.exit(1);
});
