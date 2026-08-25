'use strict';

/* data.json 备份纯函数单测:命名/保留策略(oss-retry 风格,不连 OSS) */

const assert = require('node:assert/strict');
const { backupKeyNow, pruneBackupKeys } = require('../api/oss');

// 1. 备份对象名:时间戳格式稳定,冒号/点替换为 -
{
  const key = backupKeyNow(new Date('2026-08-23T12:34:56.789Z').getTime());
  assert.equal(key, 'backups/data-2026-08-23T12-34-56-789Z.json');
  assert.match(key, /^backups\/data-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/);
}

// 2. 未超保留数 → 不删
{
  const names = Array.from({ length: 20 }, (_, i) =>
    'backups/data-2026-08-' + String(10 + i) + 'T00-00-00-000Z.json');
  assert.deepEqual(pruneBackupKeys(names, 20), []);
}

// 3. 超出保留数 → 删最旧的
{
  const names = Array.from({ length: 25 }, (_, i) =>
    'backups/data-2026-08-' + String(10 + i) + 'T00-00-00-000Z.json');
  const del = pruneBackupKeys(names, 20);
  assert.equal(del.length, 5);
  assert.equal(del[0], names[0], '最旧的排最前');
  assert.equal(del[4], names[4]);
  assert.ok(!del.includes(names[5]));
}

// 4. 非本命名规则的条目不动
{
  const names = [
    'backups/manual.json',
    'backups/not-a-backup.txt',
    'data.json',
    'backups/data-2026-08-01T00-00-00-000Z.json'
  ];
  assert.deepEqual(pruneBackupKeys(names, 0), ['backups/data-2026-08-01T00-00-00-000Z.json'],
    'keep=0 只删自己命名规则的,其他条目不动');
}

// 5. keep 缺省回 20
{
  const names = Array.from({ length: 22 }, (_, i) =>
    'backups/data-2026-08-' + String(10 + i) + 'T00-00-00-000Z.json');
  assert.equal(pruneBackupKeys(names).length, 2);
}

console.log('oss-backup 全部 5 组测试通过 ✓');

/* 前缀隔离:users/codes 备份与 data 备份互不干扰(2026-08-25 账号数据保护) */
{
  const names = [
    'backups/data-2026-08-01T00-00-00-000Z.json',
    'backups/users-2026-08-01T00-00-00-000Z.json',
    'backups/codes-2026-08-01T00-00-00-000Z.json',
    'backups/manual-2026-08-01T00-00-00-000Z-data.json'
  ];
  assert.deepEqual(pruneBackupKeys(names, 0, 'users'), ['backups/users-2026-08-01T00-00-00-000Z.json'], 'users 前缀只删自己的');
  assert.deepEqual(pruneBackupKeys(names, 0, 'data'), ['backups/data-2026-08-01T00-00-00-000Z.json'], 'data 前缀只删自己的');
  assert.deepEqual(pruneBackupKeys(names, 0, 'codes'), ['backups/codes-2026-08-01T00-00-00-000Z.json'], 'codes 前缀只删自己的');
  assert.equal(backupKeyNow(0, 'users'), 'backups/users-1970-01-01T00-00-00-000Z.json', '带前缀命名');
  console.log('✓ 备份前缀隔离(users/codes/data/manual)');
}
