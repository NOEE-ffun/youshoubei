import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, seedWorkspace, resetStore, DEFAULT_PLAYERS } from './helpers.mjs';

/* 办赛主链路:编辑→选手→职业卡组→比分→下游继承与连锁重算。
 * 每个用例全新 context;2026-09-01 注册即选手合并后登录即写云工作区,页面恒走
 * 云端 normalizeWorkspace 默认画布(本地模式默认 8 选手不可再达),故 API 预置
 * 同名「选手 N」种子保持卡位下拉/下游断言;reset 保证不吃先行用例的云数据。 */

test.setTimeout(60_000);

test('首卡比分后下游继承选手与职业卡组,改比分连锁重算', async ({ page }) => {
  const context = page.context();
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);
  await seedWorkspace(context, { tournaments: [], activeId: null, players: DEFAULT_PLAYERS });

  await page.goto('/schedule.html');
  await page.waitForSelector('.canvas-card');
  // 进入编辑
  await page.locator('#header-edit-btn').click();
  await page.waitForSelector('.canvas-board.editing');

  const card0 = page.locator('.canvas-card').first();
  // 打开卡片编辑:设 A=选手1 B=选手2,A 组填法师
  await card0.locator(".class-slot[data-cl-group='a']").first().click();
  await page.waitForSelector('#card-edit-dialog');
  await page.locator('#card-edit-dialog .cf-slot-a').selectOption({ label: '选手 1' });
  await page.locator('#card-edit-dialog .cf-slot-b').selectOption({ label: '选手 2' });
  const lastA = page.locator('#card-edit-dialog .cf-cl-a .cl-row').last();
  await lastA.locator('.cl-cls').selectOption('法师');
  await lastA.locator('.cl-url').fill('https://example.com/mage');
  await lastA.locator('.cl-text').fill('E2E继承卡组');
  await page.locator('#card-edit-dialog [data-card-save]').click();
  await page.waitForSelector('#card-edit-dialog', { state: 'hidden' });

  // 填比分 2:0(选手1 胜)
  await card0.locator('.score-open').click();
  await page.waitForSelector('#score-dialog');
  await page.locator('[data-score-preset]').first().click(); // 2:0
  await page.locator('[data-score-save]').click();
  await page.waitForSelector('#score-dialog', { state: 'hidden' });
  await page.waitForTimeout(600);

  // 下游半决赛1 的 A 位应为选手1,且显示继承的法师卡组
  const semi = page.locator('.canvas-card', { hasText: '胜者组半决赛 1' });
  await expect(semi.locator('.match-player').first()).toContainText('选手 1');
  await expect(semi.locator(".class-slot[data-cl-group='a']:not(.empty) img")).toHaveAttribute('alt', '法师');

  // 改比分 0:2(选手2 胜)→ 修改确认弹窗 → 半决赛 A 位连锁变选手2
  await card0.locator('.score-open').click();
  await page.waitForSelector('#score-dialog');
  await page.locator('#score-a').fill('0');
  await page.locator('#score-b').fill('2');
  await page.locator('[data-score-save]').click();
  // 修改已有比分出确认框
  const confirmDialog = page.locator('dialog[open]').last();
  await confirmDialog.getByRole('button', { name: '确定' }).click();
  await page.waitForSelector('#score-dialog', { state: 'hidden' });
  await page.waitForTimeout(600);
  await expect(semi.locator('.match-player').first()).toContainText('选手 2');
  // 选手 2 在 c1 无卡组 → 半决赛 A 侧无继承;选手 1(法师)落入败者组,卡组跟随
  await expect(semi.locator('.class-slot:not(.empty)')).toHaveCount(0);
  const lb = page.locator('.canvas-card', { hasText: '败者组第一轮 1' });
  await expect(lb.locator('.match-player').filter({ hasText: '选手 1' })).toHaveCount(1);
  await expect(lb.locator('.class-slot:not(.empty) img')).toHaveAttribute('alt', '法师');
});
