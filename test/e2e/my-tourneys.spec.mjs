import { test, expect } from '@playwright/test';

/* 报名全链路(开发内存云端):管理员开报名 → 选手报名/退报 → 关闭后只读 */

test('报名:开窗→报名→退报→关闭只读', async ({ browser, request }) => {
  /* 先经 API 注册选手:填充开发存储,使后续页面进入云端模式 */
  const reg = await request.post('http://127.0.0.1:3999/api/auth/register', {
    data: { code: 'e2e-dev-5', username: 'e2e报名者', password: '12345678' }
  });
  expect(reg.status()).toBe(200);

  const adminCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  const player = await playerCtx.newPage();

  /* 1. 管理员:解锁 → 建届(空白模板)→ 开报名 */
  await admin.goto('/schedule.html');
  await admin.waitForTimeout(800);
  await admin.locator('#settings-btn').click();
  await admin.fill('#settings-admin-token', 'e2e-admin-token');
  await admin.locator('#admin-unlock').click();
  await admin.waitForTimeout(1000);
  await expect(admin.locator('#admin-status')).toContainText('已解锁');
  await admin.locator('#settings-form [data-dialog-close]').click();

  await admin.locator('#manage-btn').click();
  await admin.fill('#new-tournament-name', 'E2E报名届');
  await admin.locator('#create-tournament-form button[type="submit"]').click();
  await admin.waitForTimeout(1200);
  await admin.locator('#manage-dialog [data-dialog-close]').click();
  await admin.waitForTimeout(300);

  await admin.locator('#settings-btn').click();
  await admin.waitForSelector('#settings-form');
  await admin.locator('#signup-open').selectOption('open');
  await admin.locator('#settings-form button[type="submit"]').click();
  await admin.waitForTimeout(800);

  /* 2. 选手登录并进入我的比赛(账号已在开头经 API 注册) */
  await player.goto('/me.html#tourneys');
  await player.waitForSelector('#me-login-btn', { state: 'visible' });
  await player.locator('#me-login-btn').click();
  await player.fill('#login-username', 'e2e报名者');
  await player.fill('#login-password', '12345678');
  await player.locator('#login-submit').click();
  await player.waitForTimeout(1500); /* 登录 + 自动 reload */

  /* 3. 开放报名区显示该届,报名成功 */
  await player.waitForSelector('#my-tourneys-body', { state: 'visible' });
  const card = player.locator('.mt-card', { hasText: 'E2E报名届' });
  await expect(card).toBeVisible();
  await card.locator('[data-signup="join"]').click();
  await player.waitForTimeout(1200);
  await expect(card.locator('[data-signup="leave"]')).toBeVisible();
  await expect(card).toContainText('报名 1 人');

  /* 4. 退报 → 人数回落,按钮回到报名 */
  await card.locator('[data-signup="leave"]').click();
  await player.waitForTimeout(1200);
  const card2 = player.locator('.mt-card', { hasText: 'E2E报名届' });
  await expect(card2.locator('[data-signup="join"]')).toBeVisible();
  await expect(card2).not.toContainText('报名 1 人');

  /* 5. 再报上(留给关闭场景验证保留) */
  await card2.locator('[data-signup="join"]').click();
  await player.waitForTimeout(1200);

  /* 6. 管理员关报名 → 选手刷新后只读(已报名·关闭) */
  await admin.locator('#settings-btn').click();
  await admin.waitForSelector('#settings-form');
  await admin.locator('#signup-open').selectOption('closed');
  await admin.locator('#settings-form button[type="submit"]').click();
  await admin.waitForTimeout(800);

  await player.goto('/me.html#tourneys');
  await player.reload(); /* 同 URL 含 hash 的 goto 不重载,显式刷新拿新数据 */
  await player.waitForSelector('#my-tourneys-body', { state: 'visible' });
  const card3 = player.locator('.mt-card', { hasText: 'E2E报名届' });
  await expect(card3).toBeVisible();
  await expect(card3).toContainText('已报名');
  await expect(card3.locator('[data-signup]')).toHaveCount(0);
  /* 侧栏选手中心入口可见 */
  await expect(player.locator('#app-sidebar .side-link[data-page="me"]')).toBeVisible();

  await adminCtx.close();
  await playerCtx.close();
});

test.afterAll(async ({ request }) => {
  await request.post('http://127.0.0.1:3999/api/dev/reset');
});
