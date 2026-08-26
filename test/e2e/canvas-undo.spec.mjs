import { test, expect } from '@playwright/test';

/* 画布编辑撤销/重做:改卡片属性→Cmd+Z 恢复→Cmd+Shift+Z 重做;
 * 删除卡片→撤销找回。另断言工具栏分组结构。 */

test.setTimeout(60_000);

test('卡片改名可撤销重做,删除可撤销找回', async ({ page }) => {
  /* 先行用例(如 auth-flow)在服务器建过选手后,访客上下文会进云模式、编辑被密码锁拦;
   * 预置管理口令(playwright.config env ADMIN_TOKEN)绕开锁,云/本机两种模式都可编辑 */
  await page.addInitScript(() => sessionStorage.setItem('ts:adminToken', 'e2e-admin-token'));

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
});
