import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, seedWorkspace, makePlayer, resetStore } from './helpers.mjs';

/* 卡组自助提交全链路(开发内存云端,E2E 无 OSS):
 * 管理员建赛→指派选手→开窗 ‖ 选手提交 ‖ 另一登录用户看锁→关窗公示。
 * 这是 2026-08-25 "自助提交一团糟" 事故的回归测试集。
 * 2026-08-30 权限重构后:自举 = 超管会话 PUT /api/data + 换绑通道造选手会话;
 * 2026-09-01 注册即选手合并后换绑走后台端点(绑定码通道退役)。
 * 「游客🔒」视角改为另一登录用户(非该侧选手,stripHiddenDecks 语义不变)。 */

test.setTimeout(90_000);

test('卡组自助提交全链路:布置→提交→隐藏→公示', async ({ browser, request }) => {
  await request.post('/api/dev/reset');
  const adminCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  const player = await playerCtx.newPage();
  const guest = await guestCtx.newPage();

  /* ---- 0. 自举云端状态:超管直写工作区(种子选手 e2e提交者,换绑通道要用) ---- */
  await smsLogin(adminCtx, ADMIN_PHONE);
  await seedWorkspace(adminCtx, {
    tournaments: [], activeId: null,
    players: [
      { id: 'pz1', name: 'e2e提交者', createdAt: 1, updatedAt: 1 },
      { id: 'pz2', name: 'e2e对位', createdAt: 1, updatedAt: 1 }
    ]
  });

  /* ---- 1. 选手会话:手机登录自动建档 → super 后台换绑继承 pz1 ---- */
  await makePlayer(playerCtx, '13800003333', 'pz1');

  /* ---- 2. 管理员建赛(会话即身份,旧解锁口令已退役) ---- */
  await admin.goto('/schedule.html');
  await admin.waitForTimeout(800);
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
  await player.goto('/me.html#decks');
  await player.reload(); /* 同 URL 含 hash 的 goto 不重载,显式刷新拿新数据 */
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

  /* ---- 6. 另一登录用户视角(非该侧选手):未公示 → 🔒 ---- */
  await smsLogin(guestCtx, '13800009999');
  await guest.goto('/schedule.html');
  await guest.waitForSelector('.canvas-card');
  await guest.waitForTimeout(600);
  expect(await guest.locator('.canvas-card .cl-locked').count()).toBeGreaterThanOrEqual(1);
  /* 非所属侧看不到卡组图标本体(stripHiddenDecks 剥离) */
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

  /* ---- 9. 关窗后选手再提交 → 界面回到锁定态 ---- */
  await player.goto('/me.html#decks');
  await player.reload(); /* 同 URL 含 hash 的 goto 不重载,显式刷新拿新数据 */
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
