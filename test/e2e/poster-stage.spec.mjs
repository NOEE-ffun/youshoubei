import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, resetStore } from './helpers.mjs';

/* OBS 舞台实时链路(2026-09-07 实时化):
 * 按钮建固定舞台 → 匿名可读可渲染 → 动效 CSS 命中 → 编辑轮询跟随 */

test('OBS 源:免登录渲染+动效+实时跟随', async ({ page }) => {
  const context = page.context();
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);

  await page.goto('/poster.html');
  await page.waitForSelector('#match-name');
  await page.waitForSelector('#poster-obs'); /* 页头按钮由 common.js ts:ready 后注入 */

  const name1 = 'OBSE2E-' + Date.now();
  await page.locator('#match-name').fill(name1);

  /* 点 OBS 源:首次走 POST(本地无舞台 id),捕获响应里的舞台 URL */
  const post = page.waitForResponse((r) =>
    r.url().includes('/api/poster-stage') && r.request().method() === 'POST');
  await page.locator('#poster-obs').click();
  const postResp = await post;
  expect(postResp.ok()).toBeTruthy();
  const stageUrl = new URL(postResp.url()).origin + (await postResp.json()).url;

  /* 匿名新 context 打开舞台:渲染成功、无登录遮罩、动效 CSS 生效 */
  const anon = await page.context().browser().newContext();
  const stage = await anon.newPage();
  await stage.goto(stageUrl);
  await stage.waitForSelector('#poster-slot svg');
  await expect(stage.locator('#poster-slot')).toHaveClass(/poster-app/);
  await expect(stage.locator('#stage-error')).toBeHidden();
  expect(await stage.locator('.stage-login-required').count()).toBe(0);
  expect(await stage.locator('#poster-slot svg').innerHTML()).toContain(name1);
  const anim = await stage.evaluate(() => {
    const el = document.querySelector(
      '.p-particle, .p-sparkle, .p-vs, .p-live, .p-ring, .p-diamond, .p-scan, .p-title, .p-ray, .p-bolt');
    return el ? getComputedStyle(el).animationName : 'none';
  });
  expect(anim).not.toBe('none');

  /* 编辑跟随:改名 → 防抖 1.5s PUT → 舞台 5s 轮询,15s 内更新 */
  const name2 = name1 + '-R2';
  await page.locator('#match-name').fill(name2);
  await expect.poll(async () => {
    const html = await stage.locator('#poster-slot svg').innerHTML().catch(() => '');
    return html.includes(name2);
  }, { timeout: 15000 }).toBe(true);

  await anon.close();
  await resetStore(context);
});
