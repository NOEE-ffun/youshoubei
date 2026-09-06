import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, seedWorkspace, resetStore } from './helpers.mjs';

/* 选手中心-资料保存 E2E:队标上传链路(dataURL→Blob→POST /api/upload→PUT /api/me/player)。
 * 2026090052 修复回归锚,双重根因:①`await fetch(dataUrl).blob()` 成员访问优先于
 * await,实际调 Promise.blob→「队标上传失败:...blob is not a function」;
 * ②括号修对后 fetch(data:) 仍被全站 CSP connect-src 'self' 拦死——最终改为
 * dataURL 本地 base64 解码转 Blob。本地 e2e 无 OSS,/api/upload 由 route 拦截
 * 代答,并断言真图片字节(PNG 魔数)与 Blob 带出的 Content-Type。 */

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);
const FAKE_URL = 'https://img.example.com/tag-e2e.png';

test('队标上传后保存资料:发出真图片字节并落库 tagImg', async ({ context, page }) => {
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);
  await seedWorkspace(context, { tournaments: [], players: [], activeId: null });
  await smsLogin(context, '13800005555');

  const uploads = [];
  await page.route('**/api/upload', async (route) => {
    uploads.push({
      contentType: route.request().headers()['content-type'] || '',
      body: route.request().postDataBuffer()
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ url: FAKE_URL })
    });
  });

  await page.goto('/me.html#profile');
  await expect(page.locator('#profile-save')).toBeVisible();

  await page.setInputFiles('#profile-tagimg-file', {
    name: 'tag.png', mimeType: 'image/png', buffer: TINY_PNG
  });
  await expect(page.locator('.toast', { hasText: '队标已就绪' })).toBeVisible();
  await expect(page.locator('#profile-tagimg-preview')).toBeVisible();

  await page.locator('#profile-save').click();
  await expect(page.locator('.toast', { hasText: '资料已保存' })).toBeVisible({ timeout: 8000 });
  await expect(page.locator('.toast-danger', { hasText: '队标上传失败' })).toHaveCount(0);

  /* 上传的是真图片字节(PNG 魔数),Content-Type 由 Blob.type 带出 */
  expect(uploads.length).toBe(1);
  expect(uploads[0].contentType).toContain('image/png');
  expect(uploads[0].body?.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const me = await context.request.get('/api/me');
  expect(me.ok(), 'GET /api/me after save').toBeTruthy();
  const { player } = await me.json();
  expect(player?.tagImg).toBe(FAKE_URL);
  expect(player?.tagImgRatio).toBe(1);

  await resetStore(context);
});
