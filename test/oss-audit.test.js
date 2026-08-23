'use strict';

/* 审计日志纯函数单测(oss-retry 风格,不连 OSS) */

const assert = require('node:assert/strict');
const { auditKeyNow, buildAuditEntry } = require('../api/oss');

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

console.log('oss-audit 全部 2 组测试通过 ✓');
