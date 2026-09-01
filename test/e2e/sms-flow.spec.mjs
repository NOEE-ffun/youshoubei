import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, seedWorkspace, resetStore } from './helpers.mjs';

/* 短信登录全链路(2026-09-01 注册即选手合并后):
 * 注册即选手(自动建档,无需兑码)→ 选手码发放口停用(400)→ 管理员码升管理员。
 * 填码成功后前端 700ms 自动 reload 刷新 tab 门,等待要落在
 * #redeem-status 出结果之后再给足自动刷新时间(直接 reload 会与
 * 异步 POST 竞态,可能在跃迁落盘前就刷成旧身份)。 */

test('短信注册即选手→选手码停用→管理员码升管理员', async ({ page }) => {
  const context = page.context();
  test.setTimeout(60_000);
  await resetStore(context);

  /* 超管建工作区+发码;选手码发放口已停用(400) */
  await smsLogin(context, ADMIN_PHONE);
  await seedWorkspace(context, {
    tournaments: [],
    players: [{ id: 'p1', name: '选手一', createdAt: 1, updatedAt: 1 }],
    activeId: null
  });
  const gone = await context.request.post('/api/codes', { data: { kind: 'player' } });
  expect(gone.status()).toBe(400);
  const adminCode = await context.request.post('/api/codes', { data: { kind: 'admin' } });
  const { code: c2 } = await adminCode.json();
  await context.request.post('/api/auth/logout');

  /* 新手机登录(自动注册即 player,已带选手档案)→ 选手 tab 直接可见 */
  await smsLogin(context, '13800001111');
  await page.goto('/me.html');
  await expect(page.locator('#me-tab-decks')).toBeVisible();
  await expect(page.locator('#me-tab-codes')).toBeHidden();

  /* 资料页填管理员码 → admin(保留选手绑定) */
  await page.locator('#me-tab-profile').click();
  await page.locator('#redeem-code').fill(c2);
  await page.locator('#redeem-form button[type=submit]').click();
  await expect(page.locator('#redeem-status')).toContainText('已升级为管理员');
  await page.waitForTimeout(1200); /* 前端 700ms 后自动 reload 重算 tab 门 */
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
