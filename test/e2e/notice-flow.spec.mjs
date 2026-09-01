'use strict';

import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, resetStore } from './helpers.mjs';

/* 通知横幅全链路:超管发布 → 主页展示/轮播/点选 → 关闭记忆(刷新不再现)
 * → 强插(dismissible:false)无关闭钮且无视 dismissed 历史。
 * 通知存独立 notices.json(dev-store 内存),收尾 reset 清场防泄漏给后续用例。 */

test.setTimeout(60_000);

test('超管发布通知,主页横幅展示并轮播点选', async ({ page }) => {
  const context = page.context();
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);

  const create = async (body) => {
    const r = await context.request.post('/api/admin/notices', { data: body });
    expect(r.ok(), '发布通知').toBeTruthy();
    return r.json();
  };
  await create({ text: '第三届右手杯报名已开启', level: 'important', linkUrl: 'https://example.com/join', linkText: '去报名', sortOrder: 0 });
  await create({ text: '比赛日 20:00 开播', level: 'info', sortOrder: 1 });

  await page.goto('/');
  const banner = page.locator('#notice-banner');
  await expect(banner).toBeVisible();
  await expect(page.locator('.notice-slide .notice-text', { hasText: '第三届右手杯报名已开启' })).toBeVisible();
  await expect(page.locator('.notice-action', { hasText: '去报名' })).toHaveAttribute('href', 'https://example.com/join');
  await expect(page.locator('.notice-dot')).toHaveCount(2);

  /* 点第 2 个指示点直达第 2 条 */
  await page.locator('.notice-dot').nth(1).click();
  await expect(page.locator('.notice-slide.is-active .notice-text')).toHaveText('比赛日 20:00 开播');

  await resetStore(context);
});

test('可关闭通知:关闭后同条刷新不再现', async ({ page }) => {
  const context = page.context();
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);
  const r = await context.request.post('/api/admin/notices', { data: { text: '站务维护通知' } });
  expect(r.ok()).toBeTruthy();

  await page.goto('/');
  await expect(page.locator('.notice-slide .notice-text', { hasText: '站务维护通知' })).toBeVisible();
  await page.locator('[data-notice-close]').click();
  await expect(page.locator('#notice-banner')).toBeHidden();

  await page.reload();
  await expect(page.locator('#notice-banner')).toBeHidden();
  /* dismissed 记忆落地 */
  const ids = await page.evaluate(() => JSON.parse(localStorage.getItem('ts:dismissedNotices') || '[]'));
  expect(ids.length).toBe(1);

  await resetStore(context);
});

test('强插通知:无关闭钮,预置 dismissed 仍显示', async ({ page }) => {
  const context = page.context();
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);
  const r = await context.request.post('/api/admin/notices', {
    data: { text: '比赛因网络故障延迟 30 分钟', level: 'important', dismissible: false }
  });
  expect(r.ok()).toBeTruthy();
  const { notice } = await r.json();

  /* 预置 dismissed 塞入强插 id:常驻语义=无视历史关闭记录 */
  await page.goto('/');
  await page.evaluate((id) => {
    localStorage.setItem('ts:dismissedNotices', JSON.stringify([id]));
  }, notice.id);
  await page.reload();

  const slide = page.locator('.notice-slide', { hasText: '比赛因网络故障延迟 30 分钟' });
  await expect(slide).toBeVisible();
  await expect(slide.locator('[data-notice-close]')).toHaveCount(0);

  await resetStore(context);
});
