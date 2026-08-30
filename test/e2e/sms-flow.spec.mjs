import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, resetStore } from './helpers.mjs';

/* 短信登录全链路:注册 → 填码升选手 → 升管理员 → 发码中心权限边界。
 * 填码成功后前端 700ms 自动 reload 刷新 tab 门,等待要落在
 * #redeem-status 出结果之后再给足自动刷新时间(直接 reload 会与
 * 异步 POST 竞态,可能在跃迁落盘前就刷成旧身份)。 */

test('短信注册→空白码升选手→管理员码升管理员', async ({ page }) => {
  const context = page.context();
  test.setTimeout(60_000);
  await resetStore(context);

  /* 超管建工作区+发码 */
  await smsLogin(context, ADMIN_PHONE);
  await context.request.put('/api/data', {
    data: { tournaments: [], players: [{ id: 'p1', name: '选手一', createdAt: 1, updatedAt: 1 }], activeId: null }
  });
  const blank = await context.request.post('/api/codes', { data: { kind: 'player' } });
  const adminCode = await context.request.post('/api/codes', { data: { kind: 'admin' } });
  const { code: c1 } = await blank.json();
  const { code: c2 } = await adminCode.json();

  /* 新手机登录(自动注册 user)→ me 页只见资料 tab */
  await smsLogin(context, '13800001111');
  await page.goto('/me.html');
  await expect(page.locator('#me-tab-decks')).toBeHidden();
  await expect(page.locator('#me-tab-codes')).toBeHidden();

  /* 填空白码 → 选手 */
  await page.locator('#redeem-code').fill(c1);
  await page.locator('#redeem-form button[type=submit]').click();
  await expect(page.locator('#redeem-status')).toContainText(/已绑定|已升级/);
  await page.waitForTimeout(1200); /* 前端 700ms 后自动 reload 重算 tab 门 */
  await expect(page.locator('#me-tab-decks')).toBeVisible();

  /* 填管理员码 → admin(保留选手绑定) */
  await page.locator('#redeem-code').fill(c2);
  await page.locator('#redeem-form button[type=submit]').click();
  await expect(page.locator('#redeem-status')).toContainText('已升级为管理员');
  await page.waitForTimeout(1200);
  await expect(page.locator('#me-tab-codes')).toBeVisible();
  await expect(page.locator('#me-tab-decks')).toBeVisible();

  await resetStore(context);
});

test('管理员不能发管理员码(403)', async ({ context }) => {
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);
  const promote = await context.request.post('/api/codes', { data: { kind: 'admin' } });
  const { code } = await promote.json();
  await context.request.post('/api/auth/logout');
  const user = await context.browser().newContext();
  await smsLogin(user, '13800002222');
  const redeem = await user.request.post('/api/me/redeem', { data: { code } });
  expect(redeem.status()).toBe(200);
  const r = await user.request.post('/api/codes', { data: { kind: 'admin' } });
  expect(r.status()).toBe(403);
  await user.close();
  await resetStore(context);
});
