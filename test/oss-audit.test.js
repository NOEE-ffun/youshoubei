'use strict';

/* 审计日志纯函数单测(oss-retry 风格,不连 OSS) */

const assert = require('node:assert/strict');
const { auditKeyNow, buildAuditEntry, staleAuditKeys } = require('../api/oss');

// 1. 日志对象名:按月分文件
{
  const key = auditKeyNow(new Date('2026-08-23T12:00:00Z').getTime());
  assert.equal(key, 'audit/log-2026-08.json');
  assert.match(key, /^audit\/log-\d{4}-\d{2}\.json$/);
  const jan = auditKeyNow(new Date('2026-01-01T00:00:00Z').getTime());
  assert.equal(jan, 'audit/log-2026-01.json', '月份补零');
}

// 2. 审计条目:时间 ISO、action/detail 截断
{
  const now = new Date('2026-08-23T12:34:56.789Z').getTime();
  const e = buildAuditEntry('data.put', '3 届 / active=我的赛事', now);
  assert.equal(e.t, '2026-08-23T12:34:56.789Z');
  assert.equal(e.action, 'data.put');
  assert.equal(e.detail, '3 届 / active=我的赛事');

  const long = buildAuditEntry('x'.repeat(100), 'y'.repeat(500), now);
  assert.equal(long.action.length, 40, 'action 截到 40');
  assert.equal(long.detail.length, 200, 'detail 截到 200');

  const empty = buildAuditEntry(null, undefined, now);
  assert.equal(empty.action, '', 'null action 归空串');
  assert.equal(empty.detail, '');
}

// 3. 保留期甄别:满 12 个月的月文件过期,非命名规则条目不动(D-36 A 案)
{
  const now = new Date('2026-09-16T08:00:00Z').getTime();
  const names = [
    'audit/log-2025-09.json', // 恰满 12 个月 → 过期
    'audit/log-2025-10.json', // 11 个月 → 保留
    'audit/log-2026-08.json',
    'audit/log-2026-09.json',
    'audit/other.json',       // 非月文件命名 → 不动
    'backups/data-2026-01-01T00-00-00-000Z.json' // 非 audit 前缀 → 不动
  ];
  assert.deepEqual(staleAuditKeys(names, now), ['audit/log-2025-09.json']);

  /* 跨年边界:2025-01 距 2026-03 为 14 个月 → 过期;2025-04 为 11 个月 → 保留 */
  const mar = new Date('2026-03-01T00:00:00Z').getTime();
  assert.deepEqual(
    staleAuditKeys(['audit/log-2025-01.json', 'audit/log-2025-04.json'], mar),
    ['audit/log-2025-01.json']
  );
  assert.deepEqual(staleAuditKeys([], now), [], '空清单安全');
  assert.deepEqual(staleAuditKeys(null, now), [], 'null 安全');
}

console.log('oss-audit 全部 3 组测试通过 ✓');
