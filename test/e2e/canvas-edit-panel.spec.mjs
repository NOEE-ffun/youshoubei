import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, resetStore } from './helpers.mjs';

/* 编辑模式更新回归:卡高统一、八端口居中、选中抽屉、工具栏精简。 */

test.setTimeout(60_000);

test.beforeEach(async ({ page }) => {
  const context = page.context();
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);
});

async function enterEdit(page) {
  /* 画布查看态默认 auto-fit 缩放(0.28~1)会整体缩放 getBoundingClientRect,
   * 几何断言按 100% 原生像素写死——先钉住记忆缩放为 100%(key 同 canvas-editor.js LS_ZOOM,
   * canvas-edges.spec.mjs 亦操作此 key) */
  await page.addInitScript(() =>
    localStorage.setItem('ts:canvasZoom', JSON.stringify({ scale: 1, user: true }))
  );
  await page.goto('/schedule.html');
  await page.waitForSelector('.canvas-card');
  await page.locator('#header-edit-btn').click();
  await page.waitForSelector('.canvas-board.editing');
}

test('卡高统一 196:未填与已填卡组的卡片同高', async ({ page }) => {
  await enterEdit(page);
  const heights = await page.evaluate(() =>
    [...document.querySelectorAll('.canvas-card')].map((el) => el.offsetHeight)
  );
  expect(heights.length).toBeGreaterThan(0);
  for (const h of heights) expect(h).toBe(196);
});

test('每卡八个连接点,四侧居中、对间距 38', async ({ page }) => {
  await enterEdit(page);
  const geo = await page.evaluate(() => {
    const el = document.querySelector('.canvas-card');
    const r = el.getBoundingClientRect();
    const out = {};
    el.querySelectorAll('.port-node').forEach((p) => {
      const b = p.getBoundingClientRect();
      out[p.dataset.port] = {
        x: Math.round(b.left + b.width / 2 - r.left),
        y: Math.round(b.top + b.height / 2 - r.top)
      };
    });
    return out;
  });
  expect(Object.keys(geo)).toHaveLength(8);
  // 上下对:以卡中线 x=140 居中,y 贴 0/196
  expect(geo.topLeft).toEqual({ x: 121, y: 0 });
  expect(geo.topRight).toEqual({ x: 159, y: 0 });
  expect(geo.bottomLeft).toEqual({ x: 121, y: 196 });
  expect(geo.bottomRight).toEqual({ x: 159, y: 196 });
  // 左右对:以卡中线 y=98 居中
  expect(geo.leftTop).toEqual({ x: 0, y: 79 });
  expect(geo.leftBottom).toEqual({ x: 0, y: 117 });
  expect(geo.rightTop).toEqual({ x: 280, y: 79 });
  expect(geo.rightBottom).toEqual({ x: 280, y: 117 });
  await page.request.post('/api/dev/reset');
});
