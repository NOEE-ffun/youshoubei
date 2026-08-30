import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, seedWorkspace, resetStore } from './helpers.mjs';

/* 登录墙 E2E:匿名页面跳登录、数据 401;登录后回跳 returnTo;
 * poster.html(墙覆盖页)同样被墙;logout 后整页跳回登录页并带 returnTo。 */

test('匿名访问被墙:页面跳登录、数据 401', async ({ page, request }) => {
  const r = await request.get('/api/data');
  expect(r.status()).toBe(401);
  await page.goto('/schedule.html');
  await page.waitForURL(/login\.html\?returnTo=/);
  await expect(page.locator('#sms-phone')).toBeVisible();
});

test('登录后回跳 returnTo', async ({ context, page }) => {
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);
  await page.goto('/login.html?returnTo=' + encodeURIComponent('/stats.html'));
  /* 已登录访问登录页直接回跳(returnTo 仅允许站内路径) */
  await page.waitForURL(/\/stats\.html(\?.*)?$/);
});

test('poster.html 匿名访问同样被墙(墙覆盖页)', async ({ page }) => {
  await page.goto('/poster.html');
  await page.waitForURL(/login\.html\?returnTo=/);
  /* returnTo 指向被墙的原页,而非丢失 */
  expect(decodeURIComponent(page.url())).toContain('/poster.html');
});

test('退出登录后整页跳回登录页并带 returnTo', async ({ context, page }) => {
  await resetStore(context);
  /* profile 面板(退出按钮所在)要求云模式:先管理员自举再换普通用户会话 */
  await smsLogin(context, ADMIN_PHONE);
  await seedWorkspace(context, { tournaments: [], players: [], activeId: null });
  await smsLogin(context, '13800005555');

  await page.goto('/me.html#profile');
  await page.locator('#profile-logout').click();
  await page.waitForURL(/login\.html\?returnTo=/);
  expect(decodeURIComponent(page.url())).toContain('/me.html');
  /* 会话已失效:同 cookie jar 的 API 请求也回到未登录态 */
  const me = await context.request.get('/api/me');
  expect(me.status()).toBe(401);
  await resetStore(context);
});
