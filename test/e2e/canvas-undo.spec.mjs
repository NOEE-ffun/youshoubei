import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, resetStore } from './helpers.mjs';

/* 画布编辑撤销/重做:改卡片属性→Cmd+Z 恢复→Cmd+Shift+Z 重做;
 * 删除卡片→撤销找回。另断言工具栏分组结构。 */

test.setTimeout(60_000);

test('卡片改名可撤销重做,删除可撤销找回', async ({ page }) => {
  /* 登录墙:先 API 登录(cookie 进上下文);reset 清内存存储,
   * 页面确定性回落本机模式(旧 ts:adminToken 口令机制已随权限重构退役)。
   * E2E 服务端常驻,API 登录不依赖页面存储模式,本机/云两分支统一走会话。 */
  const context = page.context();
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);

  await page.goto('/schedule.html');
  await page.waitForSelector('.canvas-card');

  // 工具栏分组:撤销 / 编辑操作 / 视图缩放 / 外观与保存
  await expect(page.locator('#edit-toolbar .tool-group[aria-label="撤销"]')).toHaveCount(1);
  await expect(page.locator('#edit-toolbar .tool-group[aria-label="编辑操作"]')).toHaveCount(1);
  await expect(page.locator('#edit-toolbar .tool-group[aria-label="视图缩放"]')).toHaveCount(1);
  await expect(page.locator('#edit-toolbar .tool-group[aria-label="外观与保存"]')).toHaveCount(1);
  await expect(page.locator('#edit-toolbar [data-tool="undo"]')).toBeDisabled();
  await expect(page.locator('#edit-toolbar [data-tool="redo"]')).toBeDisabled();

  // 进入编辑
  await page.locator('#header-edit-btn').click();
  await page.waitForSelector('.canvas-board.editing');

  const cardCount = await page.locator('.canvas-card').count();
  const card0 = page.locator('.canvas-card').first();
  const originalLabel = await card0.locator('.match-title').textContent();

  // 改名:双击卡片 → 弹窗改标题保存
  await card0.dblclick();
  await page.waitForSelector('#card-edit-dialog');
  await page.locator('#card-label').fill('撤销测试卡');
  await page.locator('#card-edit-dialog [data-card-save]').click();
  await page.waitForSelector('#card-edit-dialog', { state: 'hidden' });
  await page.waitForTimeout(400);
  await expect(page.locator('.canvas-card').first()).toContainText('撤销测试卡');

  // Cmd+Z 撤销改名
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(400);
  await expect(page.locator('.canvas-card').first()).toContainText(originalLabel.trim());
  await expect(page.locator('.canvas-card').first()).not.toContainText('撤销测试卡');

  // Cmd+Shift+Z 重做改名
  await page.keyboard.press('Meta+Shift+z');
  await page.waitForTimeout(400);
  await expect(page.locator('.canvas-card').first()).toContainText('撤销测试卡');

  // 选中该卡后 Delete 删除(带确认),数量 -1
  await page.locator('.canvas-card').first().click();
  await page.keyboard.press('Delete');
  const confirmDialog = page.locator('dialog[open]').last();
  await confirmDialog.getByRole('button', { name: '确定' }).click();
  await page.waitForTimeout(400);
  expect(await page.locator('.canvas-card').count()).toBe(cardCount - 1);

  // Cmd+Z 撤销删除,卡片与改名都找回
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(400);
  expect(await page.locator('.canvas-card').count()).toBe(cardCount);
  await expect(page.locator('.canvas-card').first()).toContainText('撤销测试卡');

  // 云模式下本用例会把改名写入开发存储:清场,不污染后续用例
  await page.request.post('/api/dev/reset');
});
