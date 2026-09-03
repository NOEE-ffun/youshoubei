import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, resetStore } from './helpers.mjs';

/* 主页比赛总览回归:总览行按各届 status 渲染徽章。
 * 2026-09-03 修复:TournamentApp.list 摘要漏 status 字段,总览恒显「未开始」。 */

test.setTimeout(60_000);

test.beforeEach(async ({ page }) => {
  const context = page.context();
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);
});

test('总览行按各届 status 显示徽章与开赛时间', async ({ page }) => {
  const context = page.context();
  const cur = await (await context.request.get('/api/data')).json();
  const mk = (id, name, status, startTime) => ({
    id, name, status, startTime,
    roster: [], scores: {}, matchDecks: {},
    canvas: { cards: [], size: { cols: 40, rows: 24 } },
    createdAt: 1, updatedAt: 1
  });
  const seed = await context.request.put('/api/data', {
    data: {
      players: cur.players || [],
      tournaments: [
        mk('ov_a', '总览状态甲', 'finished', '2026-08-20T13:00:00.000Z'),
        mk('ov_b', '总览状态乙', 'ongoing', '2026-09-05T13:00:00.000Z'),
        mk('ov_c', '总览状态丙', 'upcoming', null)
      ],
      activeId: 'ov_a'
    }
  });
  expect(seed.ok(), 'seed').toBeTruthy();

  await page.goto('/index.html');
  await page.waitForSelector('.ov-t-row');
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.ov-t-row')].map((row) => ({
      name: row.querySelector('.ov-t-name').textContent,
      badge: row.querySelector('.status-badge').textContent.trim(),
      meta: row.querySelector('.ov-t-meta').textContent
    }))
  );
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  expect(byName['总览状态甲'].badge).toBe('已结束');
  expect(byName['总览状态乙'].badge).toBe('进行中');
  expect(byName['总览状态丙'].badge).toBe('未开始');
  expect(byName['总览状态乙'].meta).toContain('开赛'); // startTime 随摘要下发
  await page.request.post('/api/dev/reset');
});
