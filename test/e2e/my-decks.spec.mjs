import { test, expect } from '@playwright/test';

/* 二期冒烟:我的对局页游客/管理员空态、卡组公示锁渲染(本地模式设置手动开) */

test('选手中心:游客空态、导航项隐藏', async ({ page }) => {
  await page.goto('/me.html');
  await page.waitForSelector('#me-empty');
  /* E2E 环境无 OSS → 本地模式空态(云端环境为「未登录」,逻辑同一入口) */
  await expect(page.locator('#me-empty-text')).toContainText('本机数据模式');
  await expect(page.locator('#me-login-btn')).toBeHidden();
  /* 游客:侧栏「选手中心」入口隐藏 */
  await expect(page.locator('#app-sidebar .side-link[data-page="me"]')).toBeHidden();
});

test('我的对局 API:未登录提交 401', async ({ request }) => {
  const resp = await request.put('http://127.0.0.1:3999/api/me/classlinks', {
    data: { tournamentId: 't', cardId: 'c', side: 'a', links: [] }
  });
  expect(resp.status()).toBe(401);
});

test('卡组公示锁:开关手动开启后,未开始的卡显示锁占位', async ({ page }) => {
  await page.goto('/schedule.html');
  await page.waitForSelector('.canvas-card');

  /* 布置数据:首卡指派选手(默认画布首轮卡无选手) */
  await page.locator('#header-edit-btn').click();
  await page.waitForSelector('.canvas-board.editing');
  const card0 = page.locator('.canvas-card').first();
  await card0.locator('.class-slot').first().click();
  await page.waitForSelector('#card-edit-dialog');
  await page.locator('#card-slot-a').selectOption({ label: '选手 1' });
  await page.locator('#card-slot-b').selectOption({ label: '选手 2' });
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

  /* 首卡双方选手齐、未录比分 → 两侧都应出现 🔒 占位 */
  const locks = page.locator('.canvas-card .cl-locked');
  await expect(locks.first()).toBeVisible();
  expect(await locks.count()).toBeGreaterThanOrEqual(2);

  /* 改回「手动:关闭」→ 锁消失(公示) */
  await page.locator('#settings-btn').click();
  await page.waitForSelector('#settings-form');
  await page.locator('#deck-window-manual').selectOption('closed');
  await page.locator('#settings-form button[type="submit"]').click();
  await page.waitForTimeout(600);
  await expect(page.locator('.canvas-card .cl-locked')).toHaveCount(0);
});
