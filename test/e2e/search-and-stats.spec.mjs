import { test, expect } from '@playwright/test';

/* 查找定位 + 统计页(先在赛程页布置一局已赛数据,统计页断言其联动) */

test('查找:高亮计数、Enter 跳转、Esc 清除', async ({ page }) => {
  await page.goto('/schedule.html');
  await page.waitForSelector('.canvas-card');
  const search = page.locator('#match-search');
  await search.fill('决赛');
  await page.waitForTimeout(600);
  const hits = await page.locator('.canvas-card.search-hit').count();
  expect(hits).toBeGreaterThan(0);
  await expect(page.locator('#match-search-count')).toContainText('/');
  await expect(page.locator('.canvas-board.searching')).toHaveCount(1);
  await search.press('Enter');
  await page.waitForTimeout(300);
  await expect(page.locator('.canvas-card.search-current')).toHaveCount(1);
  await search.press('Escape');
  await page.waitForTimeout(300);
  await expect(page.locator('.canvas-card.search-hit')).toHaveCount(0);
  await expect(page.locator('.canvas-board.searching')).toHaveCount(0);
});

test('统计页:多选范围与选手职业视图', async ({ page }) => {
  // 布置数据:首卡设选手 + 比分 2:0
  await page.goto('/schedule.html');
  await page.waitForSelector('.canvas-card');
  await page.locator('#header-edit-btn').click();
  await page.waitForSelector('.canvas-board.editing');
  const card0 = page.locator('.canvas-card').first();
  await card0.locator('.class-slot').first().click();
  await page.waitForSelector('#card-edit-dialog');
  await page.locator('#card-slot-a').selectOption({ label: '选手 1' });
  await page.locator('#card-slot-b').selectOption({ label: '选手 2' });
  await page.locator('#card-edit-dialog [data-card-save]').click();
  await page.waitForSelector('#card-edit-dialog', { state: 'hidden' });
  await card0.locator('.score-open').click();
  await page.waitForSelector('#score-dialog');
  await page.locator('[data-score-preset]').nth(1).click(); // 2:1
  await page.locator('[data-score-save]').click();
  await page.waitForSelector('#score-dialog', { state: 'hidden' });
  await page.waitForTimeout(500);

  // 统计页:默认全选 → 有选手行(选手1 一胜)
  await page.goto('/stats.html');
  await page.waitForSelector('#stats-check-all');
  await page.waitForTimeout(600);
  const rows = page.locator('#stats-player-table .stats-player-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('选手 1');
  await expect(rows.first().locator('td').nth(1)).toHaveText('1');

  // 小局归属:胜者 2-1、败者 1-2(胜者丢的局与败者赢的局都要入账)
  await expect(rows.first().locator('td').nth(4)).toHaveText('2-1');
  await expect(rows.nth(1).locator('td').nth(4)).toHaveText('1-2');

  // 取消全选 → 空态;恢复 → 行回来
  await page.locator('#stats-check-all').uncheck();
  await page.waitForTimeout(500);
  await expect(page.locator('#stats-player-table .stats-empty')).toHaveCount(1);
  await page.locator('#stats-check-all').check();
  await page.waitForTimeout(500);
  await expect(rows).toHaveCount(2);

  // 职业条形固定顺序
  const alts = [];
  for (const el of await page.locator('.class-bar img').all()) {
    alts.push(await el.getAttribute('alt'));
  }
  expect(alts).toEqual(['精灵', '皇家', '法师', '龙族', '梦魇', '主教', '复仇者']);
});
