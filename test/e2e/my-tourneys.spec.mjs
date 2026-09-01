import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, seedWorkspace, makePlayer, resetStore } from './helpers.mjs';

/* 报名全链路(开发内存云端):管理员开报名 → 选手报名/退报 → 关闭后只读;
 * 注册即选手回归:新手机登录无需兑码直接报名。
 * 2026-08-30 权限重构后:自举 = 超管会话 PUT /api/data + 换绑通道造选手会话,
 * 2026-09-01 注册即选手合并后换绑走后台端点(绑定码通道退役)。 */

test.setTimeout(90_000);

test('报名:开窗→报名→退报→关闭只读', async ({ browser, request }) => {
  await request.post('/api/dev/reset');

  /* 0. 自举云端状态:超管直写工作区(种子选手 e2e报名者)+ 换绑通道造选手会话 */
  const adminCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  const player = await playerCtx.newPage();

  await smsLogin(adminCtx, ADMIN_PHONE);
  await seedWorkspace(adminCtx, {
    tournaments: [], activeId: null,
    players: [{ id: 'q1', name: 'e2e报名者', createdAt: 1, updatedAt: 1 }]
  });
  await makePlayer(playerCtx, '13800004444', 'q1');

  /* 1. 管理员:建届(空白模板)→ 开报名(会话即身份,旧解锁口令已退役) */
  await admin.goto('/schedule.html');
  await admin.waitForTimeout(800);
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

  /* 2. 选手进入我的比赛(会话已由换绑通道就绪) */
  await player.goto('/me.html#tourneys');
  await player.waitForSelector('#my-tourneys-body', { state: 'visible' });

  /* 3. 开放报名区显示该届,报名成功 */
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
  /* 侧栏选手中心入口可见(云模式 + 已绑选手) */
  await expect(player.locator('#app-sidebar .side-link[data-page="me"]')).toBeVisible();

  await adminCtx.close();
  await playerCtx.close();
});

test('注册即选手:新手机登录无需兑码直接报名', async ({ browser, request }) => {
  await request.post('/api/dev/reset');
  const adminCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  const player = await playerCtx.newPage();

  await smsLogin(adminCtx, ADMIN_PHONE);
  await seedWorkspace(adminCtx, { tournaments: [], activeId: null, players: [] });
  await smsLogin(playerCtx, '13800007777');
  const me = await playerCtx.request.get('/api/me');
  const meBody = await me.json();
  expect(meBody.user.role).toBe('player');
  expect(meBody.user.playerId).toBeTruthy();
  expect(meBody.player.name).toBe('用户7777');

  await admin.goto('/schedule.html');
  await admin.waitForTimeout(800);
  await admin.locator('#manage-btn').click();
  await admin.fill('#new-tournament-name', 'E2E注册即报名届');
  await admin.locator('#create-tournament-form button[type="submit"]').click();
  await admin.waitForTimeout(1200);
  await admin.locator('#manage-dialog [data-dialog-close]').click();
  await admin.waitForTimeout(300);
  await admin.locator('#settings-btn').click();
  await admin.waitForSelector('#settings-form');
  await admin.locator('#signup-open').selectOption('open');
  await admin.locator('#settings-form button[type="submit"]').click();
  await admin.waitForTimeout(800);

  await player.goto('/me.html#tourneys');
  await player.waitForSelector('#my-tourneys-body', { state: 'visible' });
  const card = player.locator('.mt-card', { hasText: 'E2E注册即报名届' });
  await expect(card).toBeVisible();
  await card.locator('[data-signup="join"]').click();
  await player.waitForTimeout(1200);
  await expect(card.locator('[data-signup="leave"]')).toBeVisible();

  await adminCtx.close();
  await playerCtx.close();
  await request.post('/api/dev/reset');
});

test.afterAll(async ({ request }) => {
  await request.post('http://127.0.0.1:3999/api/dev/reset');
});
