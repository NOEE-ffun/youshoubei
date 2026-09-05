import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, resetStore } from './helpers.mjs';

/* 列表视图编辑:就地编辑不跳画布、选择/设置抽屉、删除、拖拽排序、染色同步、新列布局。 */

test.setTimeout(60_000);

test.beforeEach(async ({ page }) => {
  const context = page.context();
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);
});

async function enterListEdit(page) {
  await page.addInitScript(() => {
    sessionStorage.setItem('ts:preferCanvas', '0');
  });
  await page.goto('/schedule.html');
  await page.waitForSelector('#list-body .list-row');
  await page.locator('#header-edit-btn').click();
  await page.waitForSelector('body.list-editing');
}

async function rows(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('#list-body .list-row')].map((el) => el.dataset.match)
  );
}

async function groups(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('#list-body .list-group')].map((g) => ({
      key: g.dataset.key,
      rows: [...g.querySelectorAll('.list-row')].map((el) => el.dataset.match)
    }))
  );
}

async function dragMouse(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  }
  await page.mouse.up();
}

test('列表视图进入编辑不切换到画布,手柄可见', async ({ page }) => {
  await enterListEdit(page);
  await expect(page.locator('#list-view')).toBeVisible();
  await expect(page.locator('#canvas-wrap')).toBeHidden();
  await expect(page.locator('.list-row .list-handle').first()).toBeVisible();
  await expect(page.locator('#edit-toolbar').locator('[data-tool="select"]')).toBeHidden();
  await page.request.post('/api/dev/reset');
});

test('点行选中并滑出设置抽屉,改标题实时生效', async ({ page }) => {
  await enterListEdit(page);
  const row = page.locator('.list-row').nth(1);
  await row.click();
  await expect(page.locator('#card-panel')).toBeVisible();
  await page.locator('#card-panel .cf-label').fill('首轮焦点战');
  await expect(page.locator('.list-row .list-title').nth(1)).toHaveText('首轮焦点战', { timeout: 4000 });
  await page.request.post('/api/dev/reset');
});

test('删除选中行(确认弹窗)', async ({ page }) => {
  await enterListEdit(page);
  const before = await rows(page);
  await page.locator('.list-row').nth(1).click();
  await page.locator('#edit-delete-selected-btn').click();
  await page.locator('#confirm-dialog [data-confirm-ok]').click();
  await page.waitForFunction((n) => document.querySelectorAll('#list-body .list-row').length === n - 1, before.length);
  const after = await rows(page);
  expect(after).toHaveLength(before.length - 1);
  expect(after).not.toContain(before[1]);
  await page.request.post('/api/dev/reset');
});

test('新列布局:赛制列直出、未开始对阵是 vs、比分并入对阵', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('ts:preferCanvas', '0'));
  await page.goto('/schedule.html');
  await page.waitForSelector('#list-body .list-row');
  const first = page.locator('.list-row').first();
  await expect(first.locator('.list-format')).toHaveText('BO3');
  await expect(first.locator('.list-title')).toBeVisible();
  await expect(first.locator('.list-vs .vs-vs')).toHaveText(' vs ');
  /* 落一局比分后比分嵌入对阵列 */
  await page.evaluate(() => {
    const app = window.TournamentApp;
    app.current.scores.wb_r1_1 = { a: 2, b: 1 };
    return window.TournamentUtils.save();
  });
  await page.reload();
  await page.waitForSelector('#list-body .list-row');
  await expect(page.locator('.list-row').first().locator('.vs-score')).toHaveText('2:1');
  await page.request.post('/api/dev/reset');
});
