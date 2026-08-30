import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, resetStore } from './helpers.mjs';

/* 画布边界回归:双指抬起发生在画布外(指针泄漏)、弹窗打开时的键盘撤销、
 * 恢复缩放后数据变更的重定中。均为 2026-08 批次新交互的边界。 */

test.setTimeout(60_000);

test.beforeEach(async ({ page }) => {
  /* 登录墙:先 API 登录(cookie 进上下文);reset 清内存存储,
   * 让 /api/data 500 → 页面回落本机模式(默认画布,不从先行用例继承云数据) */
  const context = page.context();
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);
});

/* 在画布上合成双指手势;liftOutside=true 时 pointerup 派发到 body(画布外);
 * idBase 让两轮手势使用不同 pointerId——真实触摸的 id 递增,泄漏条目不会被覆盖 */
async function pinch(page, spread, liftOutside, idBase) {
  await page.evaluate((args) => {
    const { steps, liftOutside, idBase } = args;
    const el = document.getElementById('canvas-scroll');
    const target = liftOutside ? document.body : el;
    const a = idBase;
    const b = idBase + 1;
    const fire = (target0, type, id, x, y) => target0.dispatchEvent(new PointerEvent(type, {
      pointerId: id,
      pointerType: 'touch',
      isPrimary: id === a,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true
    }));
    fire(el, 'pointerdown', a, 200, 300);
    fire(el, 'pointerdown', b, 260, 300);
    for (let i = 1; i <= steps; i += 1) {
      fire(el, 'pointermove', a, 200 - i * 10, 300);
      fire(el, 'pointermove', b, 260 + i * 10, 300);
    }
    fire(target, 'pointerup', a, 60, 300);
    fire(target, 'pointerup', b, 400, 300);
  }, { steps: spread, liftOutside, idBase });
  await page.waitForTimeout(200);
}

test('手指在画布外抬起不破坏后续捏合(指针泄漏回归)', async ({ page }) => {
  await page.goto('/schedule.html');
  await page.waitForSelector('.canvas-card');
  await page.waitForTimeout(400);
  const zoom = () => page.locator('#zoom-level').textContent();

  const before = Number.parseInt(await zoom(), 10);
  await pinch(page, 7, true, 1); // 抬起派发在 body 上
  const first = Number.parseInt(await zoom(), 10);
  expect(first).toBeGreaterThan(before);

  // 泄漏时 activeTouches 残留 2 条,第二次捏合(新 pointerId)永远不触发
  await pinch(page, 7, false, 3);
  const second = Number.parseInt(await zoom(), 10);
  expect(second).toBeGreaterThan(first);
});

test('卡片弹窗打开时 Cmd+Z 不触发画布撤销', async ({ page }) => {
  await page.goto('/schedule.html');
  await page.waitForSelector('.canvas-card');
  await page.locator('#header-edit-btn').click();
  await page.waitForSelector('.canvas-board.editing');

  const card0 = page.locator('.canvas-card').first();
  await card0.dblclick();
  const dlg = page.locator('#card-edit-dialog');
  await dlg.waitFor({ state: 'visible' });
  await page.locator('#card-label').fill('弹窗守卫卡');
  await page.locator('#card-edit-dialog [data-card-save]').click();
  await dlg.waitFor({ state: 'hidden' });
  await page.waitForTimeout(400);
  await expect(page.locator('.canvas-card').first()).toContainText('弹窗守卫卡');

  // 重开弹窗,焦点移到非输入区(标题),Cmd+Z 不应穿透到画布
  await card0.dblclick();
  await dlg.waitFor({ state: 'visible' });
  await page.locator('#card-edit-title').click();
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(400);
  await expect(page.locator('.canvas-card').first()).toContainText('弹窗守卫卡');
  await page.keyboard.press('Escape');
  await dlg.waitFor({ state: 'hidden' });

  // 云模式下本用例把改名写入开发存储:清场,不污染后续用例
  await page.request.post('/api/dev/reset');
});

test('恢复缩放后数据变更重新居中(不卡在旧平移位置)', async ({ page }) => {
  await page.goto('/schedule.html');
  await page.waitForSelector('.canvas-card');
  await page.evaluate(() => localStorage.removeItem('ts:canvasZoom'));
  await page.reload();
  await page.waitForSelector('.canvas-card');
  await page.waitForTimeout(400);

  const zoomIn = page.locator('.zoom-btn[data-zoom="in"]');
  await zoomIn.click();
  await zoomIn.click();
  await page.waitForTimeout(300);
  const zoomed = Number.parseInt(await page.locator('#zoom-level').textContent(), 10);
  expect(zoomed).toBeGreaterThan(40);

  const boardTy = () => page.evaluate(() => {
    const m = document.getElementById('canvas-board').style.transform
      .match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/);
    return Number.parseFloat(m[2]);
  });

  // 滚轮竖向平移(查看态普通滚轮=平移),量 ty
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -320);
  await page.waitForTimeout(200);
  const panned = await boardTy();

  // 数据变更(切届/刷新)后应按记忆缩放级别重新居中,而非停在旧平移
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('ts:changed')));
  await page.waitForTimeout(400);
  const refocused = await boardTy();
  expect(Math.abs(refocused - panned)).toBeGreaterThan(50);
  // 缩放级别仍保留(不被 fit 打回 28%)
  expect(Number.parseInt(await page.locator('#zoom-level').textContent(), 10)).toBe(zoomed);
});
