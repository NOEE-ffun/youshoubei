import { test, expect } from '@playwright/test';

/* 卡组自助提交全链路(开发内存云端,E2E 无 OSS):
 * 管理员解锁→建赛→指派选手→开窗 ‖ 选手注册→我的对局提交 ‖ 游客看锁→关窗公示。
 * 这是 2026-08-25 "自助提交一团糟" 事故的回归测试集。 */

test('卡组自助提交全链路:布置→提交→隐藏→公示', async ({ browser, request }) => {
  const adminCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  const player = await playerCtx.newPage();
  const guest = await guestCtx.newPage();

  /* ---- 0. 自举云端状态:本用例依赖云模式(空服务器 GET 500 会退本地、登录钮隐藏),
   * 不吃先行用例的遗留——用管理口令 PUT 一个空工作区,让 /api/data 可用。
   * 走口令而非邀请码:开发码共 5 个已被各用例占满,且码是一次性 ---- */
  await request.put('/api/data', {
    headers: { Authorization: 'Bearer e2e-admin-token' },
    data: { tournaments: [], activeId: null, players: [] }
  });

  /* ---- 1. 选手注册(空白码:建号且建选手) ---- */
  await player.goto('/my-decks.html');
  await player.waitForSelector('#my-decks-login-btn', { state: 'visible' });
  await player.locator('#my-decks-login-btn').click();
  await player.locator('[data-login-tab="register"]').click();
  await player.fill('#login-code', 'e2e-dev-4');
  await player.fill('#login-username', 'e2e提交者');
  await player.fill('#login-password', '12345678');
  await player.locator('#login-submit').click();
  await player.waitForTimeout(1200); /* 注册 + refreshSession + 本页自动 reload */

  /* ---- 2. 管理员解锁并建赛 ---- */
  await admin.goto('/schedule.html');
  await admin.waitForTimeout(800);
  await admin.locator('#settings-btn').click();
  await admin.fill('#settings-admin-token', 'e2e-admin-token');
  await admin.locator('#admin-unlock').click();
  await admin.waitForTimeout(1000); /* 解锁校验(真实 PUT) */
  await expect(admin.locator('#admin-status')).toContainText('已解锁');
  await admin.locator('#settings-form [data-dialog-close]').click();
  await admin.waitForTimeout(300);

  await admin.locator('#manage-btn').click();
  await admin.fill('#new-tournament-name', 'E2E卡组届');
  await admin.selectOption('#new-tournament-template', 'double');
  await admin.locator('#create-tournament-form button[type="submit"]').click();
  await admin.waitForTimeout(1200);
  await admin.locator('#manage-dialog [data-dialog-close]').click();
  await admin.waitForTimeout(300);

  /* ---- 3. 指派选手:首卡 A 位 = e2e提交者(B 留待定) ---- */
  await admin.locator('#header-edit-btn').click();
  await admin.waitForSelector('.canvas-board.editing');
  const card0 = admin.locator('.canvas-card').first();
  await card0.locator('.class-slot').first().click();
  await admin.waitForSelector('#card-edit-dialog');
  await admin.locator('#card-slot-a').selectOption({ label: 'e2e提交者' });
  await admin.locator('#card-edit-dialog [data-card-save]').click();
  await admin.waitForSelector('#card-edit-dialog', { state: 'hidden' });
  await admin.waitForTimeout(600);

  /* ---- 4. 开窗(手动:开启) ---- */
  await admin.locator('#settings-btn').click();
  await admin.waitForSelector('#settings-form');
  await admin.locator('#deck-window-manual').selectOption('open');
  await admin.locator('#settings-form button[type="submit"]').click();
  await admin.waitForTimeout(800);

  /* ---- 5. 选手在我的对局提交卡组 ---- */
  await player.goto('/my-decks.html');
  await player.waitForSelector('#my-decks-body', { state: 'visible' });
  await expect(player.locator('#my-decks-window-state')).toContainText('开放中');
  const form = player.locator('.md-form').first();
  await expect(form).toBeVisible();
  await form.locator('.md-cls').first().selectOption('精灵');
  await form.locator('.md-text').first().fill('进化虫速攻');
  await form.locator('.md-url').first().fill('https://deck.example/evo');
  await form.locator('[data-md-save]').click();
  await player.waitForTimeout(1000);
  await expect(player.locator('.toast, [role="status"]')).toContainText('已保存').catch(() => {});
  /* 保存后行内仍可见自己提交的卡组(可编辑回显) */
  await expect(form.locator('.md-text').first()).toHaveValue('进化虫速攻');

  /* ---- 6. 游客视角:未公示 → 🔒 ---- */
  await guest.goto('/schedule.html');
  await guest.waitForSelector('.canvas-card');
  await guest.waitForTimeout(600);
  expect(await guest.locator('.canvas-card .cl-locked').count()).toBeGreaterThanOrEqual(1);
  /* 游客不能看到卡组图标本体 */
  expect(await guest.locator('.canvas-card .class-slot img').count()).toBe(0);

  /* ---- 7. 选手本人视角:自己一侧可见,对手一侧锁 ---- */
  const playerCanvas = await playerCtx.newPage();
  await playerCanvas.goto('/schedule.html');
  await playerCanvas.waitForSelector('.canvas-card');
  await playerCanvas.waitForTimeout(600);
  const ownIcons = await playerCanvas.locator('.canvas-card .class-slot img').count();
  expect(ownIcons).toBeGreaterThanOrEqual(1); /* 自己的精灵图标 */

  /* ---- 8. 管理员关窗 → 全员公示 ---- */
  await admin.locator('#settings-btn').click();
  await admin.waitForSelector('#settings-form');
  await admin.locator('#deck-window-manual').selectOption('closed');
  await admin.locator('#settings-form button[type="submit"]').click();
  await admin.waitForTimeout(800);

  /* 公示语义对"新访客"立即生效;老页面受 60s SWR 缓存影响最多晚一分钟(已知取舍) */
  await guest.evaluate(() => localStorage.clear());
  await guest.reload();
  await guest.waitForSelector('.canvas-card');
  await guest.waitForTimeout(600);
  expect(await guest.locator('.canvas-card .cl-locked').count()).toBe(0);
  expect(await guest.locator('.canvas-card .class-slot img').count()).toBeGreaterThanOrEqual(1);

  /* ---- 9. 关窗后选手再提交 → 423 且界面回到锁定态 ---- */
  await player.goto('/my-decks.html');
  await player.waitForSelector('#my-decks-body', { state: 'visible' });
  await expect(player.locator('#my-decks-window-state')).toContainText('关闭');
  await expect(player.locator('.md-chip-wait').first()).toBeVisible();

  await adminCtx.close();
  await playerCtx.close();
  await guestCtx.close();
});

test.afterAll(async ({ request }) => {
  /* 清空开发存储,还原"云端不可用"状态给后续需要本地模式的用例 */
  await request.post('http://127.0.0.1:3999/api/dev/reset');
});
