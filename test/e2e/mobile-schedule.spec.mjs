import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, resetStore } from './helpers.mjs';

/* 移动端适配:窄屏默认列表视图(同页画布/列表双视图,会话内可切)、
 * 底部 tab 导航、44px 触控目标、缩放持久化、双指捏合。视口 390×844 贯穿全组。 */

test.setTimeout(60_000);

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  /* 登录墙:先 API 登录;reset 清内存存储 → 本机模式默认画布,不吃先行用例遗留 */
  const context = page.context();
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);
});

test('窄屏进比赛页默认列表视图,切回画布后会话内保持', async ({ page }) => {
  await page.goto('/schedule.html');
  await expect(page.locator('#list-body')).toBeVisible();
  await expect(page.locator('#canvas-wrap')).toBeHidden();

  // 主动切回画布:视图切换按钮,会话偏好写入
  await page.locator('#view-toggle').click();
  await page.waitForSelector('.canvas-card');
  await expect(page.locator('#list-view')).toBeHidden();

  await page.reload();
  await page.waitForSelector('.canvas-card');
  await expect(page.locator('#list-view')).toBeHidden();
});

test('窄屏侧栏变底部 tab 栏,触控目标不小于 44px', async ({ page }) => {
  // 会话偏好画布,避免默认列表视图干扰
  await page.goto('/schedule.html');
  await page.evaluate(() => sessionStorage.setItem('ts:preferCanvas', '1'));
  await page.goto('/schedule.html');
  await page.waitForSelector('.canvas-card');

  const sidebar = page.locator('#app-sidebar');
  const bar = await sidebar.boundingBox();
  expect(bar).toBeTruthy();
  // 底栏贴近视口底部(而非左侧竖条)
  expect(bar.y + bar.height).toBeGreaterThan(844 - 80);
  expect(bar.x).toBeGreaterThanOrEqual(0);
  expect(bar.width).toBeGreaterThan(300);

  // 导航项 44px 最小触控
  const link = page.locator('.side-nav .side-link').first();
  const linkBox = await link.boundingBox();
  expect(linkBox.height).toBeGreaterThanOrEqual(44);

  // 缩放按钮 44px 最小触控
  const zoomBtn = page.locator('.zoom-btn[data-zoom="in"]');
  const zoomBox = await zoomBtn.boundingBox();
  expect(zoomBox.height).toBeGreaterThanOrEqual(44);

  // 展开汉堡在底栏形态下隐藏
  await expect(page.locator('#side-toggle')).toBeHidden();
});

test('画布缩放持久化:放大后刷新仍保持', async ({ page }) => {
  await page.goto('/schedule.html');
  await page.evaluate(() => sessionStorage.setItem('ts:preferCanvas', '1'));
  await page.goto('/schedule.html');
  await page.waitForSelector('.canvas-card');
  await page.waitForTimeout(400);

  const zoomIn = page.locator('.zoom-btn[data-zoom="in"]');
  await zoomIn.click();
  await zoomIn.click();
  await zoomIn.click();
  await page.waitForTimeout(300);
  const zoomed = await page.locator('#zoom-level').textContent();
  expect(Number.parseInt(zoomed, 10)).toBeGreaterThan(40);

  await page.reload();
  await page.waitForSelector('.canvas-card');
  await page.waitForTimeout(500);
  const afterReload = await page.locator('#zoom-level').textContent();
  expect(Number.parseInt(afterReload, 10)).toBe(Number.parseInt(zoomed, 10));
});

test('双指捏合放大画布', async ({ page }) => {
  await page.goto('/schedule.html');
  await page.evaluate(() => sessionStorage.setItem('ts:preferCanvas', '1'));
  await page.goto('/schedule.html');
  await page.waitForSelector('.canvas-card');
  await page.waitForTimeout(400);
  const before = Number.parseInt(await page.locator('#zoom-level').textContent(), 10);

  await page.evaluate(() => {
    const el = document.getElementById('canvas-scroll');
    const fire = (type, id, x, y) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: id,
      pointerType: 'touch',
      isPrimary: id === 1,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true
    }));
    fire('pointerdown', 1, 150, 300);
    fire('pointerdown', 2, 240, 300);
    for (let i = 1; i <= 12; i += 1) {
      fire('pointermove', 1, 150 - i * 7, 300);
      fire('pointermove', 2, 240 + i * 7, 300);
    }
    fire('pointerup', 1, 66, 300);
    fire('pointerup', 2, 324, 300);
  });
  await page.waitForTimeout(300);
  const after = Number.parseInt(await page.locator('#zoom-level').textContent(), 10);
  expect(after).toBeGreaterThan(before);
});
