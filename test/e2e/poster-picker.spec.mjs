import { test, expect } from '@playwright/test';

/* 海报页选手库驱动冒烟:未选态 → 打开列表 → 选中 → 摘要卡 + SVG 渲染名字 */

test('海报页:从选手库选择左右选手', async ({ page }) => {
  await page.goto('/poster.html');
  await page.waitForSelector('#left-slot .picker-empty');
  await expect(page.locator('#left-slot .picker-empty')).toContainText('选择左侧选手');

  // 打开左侧列表并选择第一位
  await page.locator('[data-pick="left"]').click();
  await page.waitForSelector('#left-list .roster__card');
  await page.locator('#left-list .roster__card').first().click();
  await page.waitForSelector('#left-slot .picker-card');

  const name = await page.locator('#left-slot .picker-card .roster__name').innerText();
  const playerName = name.trim().split(/\s+/)[0];
  expect(playerName.length).toBeGreaterThan(0);

  // 海报 SVG 渲染出选手名
  await page.waitForTimeout(300);
  const svg = await page.locator('#poster-slot svg').innerHTML();
  expect(svg).toContain(playerName);

  // 搜索过滤
  await page.locator('[data-pick="right"]').click();
  await page.waitForSelector('#right-list .roster__card');
  await page.locator('#right-search').fill('不存在的选手xyz');
  await page.waitForTimeout(200);
  await expect(page.locator('.roster__empty[data-side="right"]')).toBeVisible();
});
