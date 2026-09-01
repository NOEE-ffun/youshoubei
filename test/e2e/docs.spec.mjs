import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, resetStore } from './helpers.mjs';

/* 官方文档读侧:登录墙/分类分组渲染/hash 直链/服务端剥离 adminOnly/渲染净化。 */

test.setTimeout(60_000);

async function createDoc(ctx, body) {
  const r = await ctx.request.post('/api/admin/docs', { data: body });
  expect(r.ok(), '建文档').toBeTruthy();
  return r.json();
}

test('游客访问跳登录,登录后按分类分组渲染并可直链', async ({ browser }) => {
  const anon = await browser.newContext();
  const page = await anon.newPage();
  await page.goto('/docs.html');
  await expect(page).toHaveURL(/login\.html/);
  await anon.close();

  const adminCtx = await browser.newContext();
  await resetStore(adminCtx);
  await smsLogin(adminCtx, ADMIN_PHONE);
  await createDoc(adminCtx, { title: '第六届规则', category: 'rules', body: '## 报名\n- 组队', sort: 1 });
  await createDoc(adminCtx, { title: '如何交卡组', category: 'guide', body: '## 步骤', sort: 1 });
  await createDoc(adminCtx, { title: '内部规程', category: 'internal', body: '机密', adminOnly: true });

  const userCtx = await browser.newContext();
  await smsLogin(userCtx, '13800001234');
  const list = await (await userCtx.request.get('/api/docs')).json();
  expect(list.docs.length).toBe(2, '普通账号只见公开两篇');

  const up = await userCtx.newPage();
  await up.goto('/docs.html');
  await up.waitForSelector('#docs-list');
  /* 分组标题按固定顺序,空 internal 组整节不见 */
  await expect(up.locator('.stats-section[aria-label="赛事规则"] .doc-item')).toHaveCount(1);
  await expect(up.locator('.stats-section[aria-label="新手指南"] .doc-item')).toHaveCount(1);
  await expect(up.locator('.stats-section[aria-label="内部规程"]')).toHaveCount(0);
  /* hash 直链直接进入单篇(## 为 h2,降级渲染为 h3) */
  await up.goto('/docs.html#doc-' + list.docs[0].id);
  await up.reload(); /* 同 URL 含 hash 不重载 */
  await expect(up.locator('#doc-view-body h3')).toContainText('报名');
  await expect(up.locator('#doc-view-meta')).toContainText('赛事规则');
  await up.locator('.doc-back').click();
  await expect(up.locator('#docs-list-view')).toBeVisible();
  await up.close();
  await userCtx.close();
  await adminCtx.close();
});

test('渲染净化:script/事件属性不执行,图片与外链属性正常', async ({ browser }) => {
  const adminCtx = await browser.newContext();
  await resetStore(adminCtx);
  await smsLogin(adminCtx, ADMIN_PHONE);
  await createDoc(adminCtx, {
    title: '净化验证', category: 'notice',
    body: '# 标题\n\n<script>window.__pwn = 1;</script>\n\n<img src="x" onerror="window.__pwn = 2">\n\n![插图](https://example.com/a.png)\n\n[外链](https://example.com/)'
  });
  const id = (await (await adminCtx.request.get('/api/docs')).json()).docs[0].id;

  const userCtx = await browser.newContext();
  await smsLogin(userCtx, '13800001234');
  const up = await userCtx.newPage();
  await up.goto('/docs.html#doc-' + id);
  await up.reload();
  await up.waitForSelector('#doc-view-body');
  await expect(up.locator('#doc-view-body h2')).toContainText('标题', 'md h1 降级 h2');
  await expect(up.locator('#doc-view-body script')).toHaveCount(0, 'script 被剥');
  await expect(up.locator('#doc-view-body img[src="https://example.com/a.png"]')).toHaveCount(1, '图片保留');
  const link = up.locator('#doc-view-body a[href="https://example.com/"]');
  await expect(link).toHaveAttribute('target', '_blank', '外链新窗口');
  await expect(link).toHaveAttribute('rel', 'noopener', 'noopener');
  expect(await up.evaluate(() => window.__pwn), '载荷未执行').toBeUndefined();
  await up.close();
  await userCtx.close();
  await adminCtx.close();
});
