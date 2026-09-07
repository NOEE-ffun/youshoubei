import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, resetStore } from './helpers.mjs';

/* 队标透明度保真(2026090060):downscale 实测画布 alpha 决定编码——
 * 含透明像素的源(任意格式)必须走 PNG;JPEG 无 alpha,透明会被烘成
 * 黑底遮住背景(用户实测:透明 webp 队标全版式黑块)。纯前端用例,无数据写入 */

test('队标管线:透明图不丢 alpha(webp/png→PNG,不透明→JPEG)', async ({ page }) => {
  const context = page.context();
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);

  await page.goto('/poster.html');
  await page.waitForFunction(() => window.VSUpload);

  const out = await page.evaluate(async () => {
    const make = (type, transparent) => {
      const c = document.createElement('canvas');
      c.width = 40; c.height = 40;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#3366aa';
      if (transparent) ctx.fillRect(0, 0, 20, 40); /* 右半透明 */
      else ctx.fillRect(0, 0, 40, 40);
      return c.toDataURL(type, 0.9);
    };
    const r = {};
    r.webpTransparent = (await VSUpload.handleURL(make('image/webp', true))).slice(5, 14);
    r.pngTransparent = (await VSUpload.handleURL(make('image/png', true))).slice(5, 14);
    r.jpegOpaque = (await VSUpload.handleURL(make('image/jpeg', false))).slice(5, 15);
    return r;
  });
  expect(out.webpTransparent).toBe('image/png');
  expect(out.pngTransparent).toBe('image/png');
  expect(out.jpegOpaque).toContain('image/jpeg');

  await resetStore(context);
});
