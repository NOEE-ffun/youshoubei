import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, seedWorkspace, resetStore, DEFAULT_PLAYERS } from './helpers.mjs';

/* 二期冒烟:选手中心注册即选手边界、卡组公示锁渲染(云端种子,设置手动开)。
 * 2026-09-01 注册即选手合并后:旧「未绑选手 user 空态/侧栏隐藏」语义退役
 * (登录即自动建档案,本地模式空态在登录墙 E2E 下不可达),等价边界改为
 * player 恒见对局 tab、发码中心(adminOnly)仍隐藏;公示锁的「观看者」
 * 视角改为非 admin 选手账号(stripHiddenDecks 语义不变)。 */

test('选手中心:注册即选手,登录即见对局 tab,发码中心仍隐藏', async ({ page }) => {
  const context = page.context();
  await resetStore(context);
  await smsLogin(context, '13800006666');

  await page.goto('/me.html');
  await expect(page.locator('#me-shell')).toBeVisible();
  await expect(page.locator('#me-empty')).toBeHidden();
  /* 注册即选手:无需兑码,对局/比赛 tab 直接可见 */
  await expect(page.locator('#me-tab-decks')).toBeVisible();
  await expect(page.locator('#me-tab-codes')).toBeHidden();
  /* 云模式 + 登录即显:侧栏「选手中心」入口可见 */
  await expect(page.locator('#app-sidebar .side-link[data-page="me"]')).toBeVisible();
});

test('我的对局 API:未登录提交 401', async ({ request }) => {
  const resp = await request.put('http://127.0.0.1:3999/api/me/classlinks', {
    data: { tournamentId: 't', cardId: 'c', side: 'a', links: [] }
  });
  expect(resp.status()).toBe(401);
});

test('卡组公示锁:开关手动开启后,未开始的卡显示锁占位', async ({ page }) => {
  const context = page.context();
  await resetStore(context);
  /* 合并后登录即写云工作区(本地模式在登录墙 E2E 下不可达):布置/设置走超管会话,
   * 锁断言用全新 context 的普通选手账号(非 admin)保持「观看者」断言语义;
   * 种子预置「选手 N」保持卡位下拉可选 */
  await smsLogin(context, ADMIN_PHONE);
  await seedWorkspace(context, { tournaments: [], activeId: null, players: DEFAULT_PLAYERS });

  await page.goto('/schedule.html');
  await page.waitForSelector('.canvas-card');

  /* 布置数据:首卡指派选手(默认画布首轮卡无选手) */
  await page.locator('#header-edit-btn').click();
  await page.waitForSelector('.canvas-board.editing');
  const card0 = page.locator('.canvas-card').first();
  await card0.locator('.class-slot').first().click();
  await page.waitForSelector('#card-edit-dialog');
  await page.locator('#card-edit-dialog .cf-slot-a').selectOption({ label: '选手 1' });
  await page.locator('#card-edit-dialog .cf-slot-b').selectOption({ label: '选手 2' });
  await page.locator('#card-edit-dialog [data-card-save]').click();
  await page.waitForSelector('#card-edit-dialog', { state: 'hidden' });
  /* 退出编辑模式(编辑态=管理员视角,按设计可见全部卡组,不出锁) */
  await page.locator('#header-edit-btn').click();
  await page.waitForTimeout(500);

  /* 打开赛事设置,切到「手动:开启」并保存 */
  await page.locator('#settings-btn').click();
  await page.waitForSelector('#settings-form');
  await page.locator('#deck-window-manual').selectOption('open');
  await page.locator('#settings-form button[type="submit"]').click();
  await page.waitForTimeout(600);

  /* 观看者视角:非 admin 选手会话(全新 context,缓存干净拿服务端剥离视图) */
  const viewerCtx = await context.browser().newContext();
  await smsLogin(viewerCtx, '13800006667');
  const viewer = await viewerCtx.newPage();
  await viewer.goto('/schedule.html');
  await viewer.waitForSelector('.canvas-card');

  /* 首卡双方选手齐、未录比分 → 两侧都应出现 🔒 占位 */
  const locks = viewer.locator('.canvas-card .cl-locked');
  await expect(locks.first()).toBeVisible();
  expect(await locks.count()).toBeGreaterThanOrEqual(2);

  /* 改回「手动:关闭」→ 锁消失(公示;观看者清 SWR 缓存再刷新) */
  await page.locator('#settings-btn').click();
  await page.waitForSelector('#settings-form');
  await page.locator('#deck-window-manual').selectOption('closed');
  await page.locator('#settings-form button[type="submit"]').click();
  await page.waitForTimeout(600);
  await viewer.evaluate(() => localStorage.clear());
  await viewer.reload();
  await viewer.waitForSelector('.canvas-card');
  await expect(viewer.locator('.canvas-card .cl-locked')).toHaveCount(0);

  await viewerCtx.close();
});
