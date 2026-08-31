import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, seedWorkspace, resetStore, makeAdmin } from './helpers.mjs';

/* 超管后台页(admin.html)E2E:
 * 1) 权限门:匿名跳登录、非 super 管理员无权提示、super 见四 tab。
 * 2) 封禁降级:封禁 → 该账号短信登录 403;解封恢复;admin 降 player 后失去码表权;
 *    账号表手机号全程脱敏(不见完整 11 位)。
 * 3) 健康与备份:健康块计数渲染;dev 无 OSS → 一键备份红字降级提示、
 *    恢复输入非法 key → 400 红字提示(断言降级形态而非成功形态)。 */

test.setTimeout(60_000);

const PHONE_ADMIN = '13800002222';
const PHONE_USER = '13800003333';

test('权限门:匿名跳登录,非超管无权提示,超管四 tab 可见', async ({ page, context, browser }) => {
  await resetStore(context);

  /* 匿名 → 跳登录页并带 returnTo */
  await page.goto('/admin.html');
  await page.waitForURL(/login\.html\?returnTo=/);
  expect(decodeURIComponent(page.url())).toContain('admin.html');
  await expect(page.locator('#sms-phone')).toBeVisible();

  /* admin(非 super)→ 无权提示,不见后台壳 */
  const contextA = await browser.newContext();
  await makeAdmin(contextA, PHONE_ADMIN);
  const pageA = await contextA.newPage();
  await pageA.goto('/admin.html');
  await expect(pageA.locator('#admin-shell')).toBeHidden();
  await expect(pageA.locator('#admin-empty-text')).toContainText('仅超级管理员可访问后台');
  await expect(pageA.locator('#admin-login-btn')).toBeHidden();
  await pageA.close();
  await contextA.close();

  /* super → 后台壳 + 四个 tab,默认审计面板可见 */
  await smsLogin(context, ADMIN_PHONE);
  await page.goto('/admin.html');
  await expect(page.locator('#admin-shell')).toBeVisible();
  for (const id of ['admin-tab-audit', 'admin-tab-users', 'admin-tab-tourneys', 'admin-tab-health']) {
    await expect(page.locator('#' + id)).toBeVisible();
  }
  await expect(page.locator('#admin-panel-audit')).toBeVisible();

  await resetStore(context);
});

test('封禁降级链路:封禁后登录 403,解封恢复,admin 降 player 失去码表权;手机号脱敏', async ({ page, context, browser }) => {
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);

  /* 造账号:admin(将被降级)+ 普通用户(将被封禁) */
  const contextA = await browser.newContext();
  await makeAdmin(contextA, PHONE_ADMIN);
  const contextU = await browser.newContext();
  await smsLogin(contextU, PHONE_USER);

  /* 超管后台账号表:找到目标行;全表不见完整手机号 */
  await page.goto('/admin.html#users');
  await page.waitForSelector('#admin-users-tbody tr');
  const tableText = await page.locator('#admin-users-tbody').innerText();
  expect(tableText).toContain('138****3333');
  expect(tableText).toContain('138****2222');
  expect(tableText).not.toContain(PHONE_USER);
  expect(tableText).not.toContain(PHONE_ADMIN);

  const rowU = page.locator('#admin-users-tbody tr', { hasText: '138****3333' });
  const statusBtnU = rowU.locator('button[data-act="status"]');
  await expect(statusBtnU).toHaveText('封禁');

  /* 封禁(confirm)→ 该手机短信登录 403 */
  page.once('dialog', (d) => d.accept());
  await statusBtnU.click();
  await expect(statusBtnU).toHaveText('解封');
  const bannedLogin = await contextU.request.post('/api/auth/sms/login', {
    data: { phone: PHONE_USER, code: '000000' }
  });
  expect(bannedLogin.status(), '被封账号登录应 403').toBe(403);

  /* 解封 → 登录恢复 200 */
  page.once('dialog', (d) => d.accept());
  await statusBtnU.click();
  await expect(statusBtnU).toHaveText('封禁');
  const okLogin = await contextU.request.post('/api/auth/sms/login', {
    data: { phone: PHONE_USER, code: '000000' }
  });
  expect(okLogin.status(), '解封后登录应 200').toBe(200);

  /* admin 降级 player → GET /api/codes 403 */
  const rowA = page.locator('#admin-users-tbody tr', { hasText: '138****2222' });
  const roleBtnA = rowA.locator('button[data-act="role"]');
  await expect(roleBtnA).toHaveText('降为选手');
  page.once('dialog', (d) => d.accept());
  await roleBtnA.click();
  await expect(roleBtnA).toHaveText('升为管理员');
  const codes = await contextA.request.get('/api/codes');
  expect(codes.status(), '降级后码表应 403').toBe(403);

  await contextA.close();
  await contextU.close();
  await resetStore(context);
});

test('健康与备份:健康块渲染计数,无 OSS 环境备份降级提示,非法恢复 key 报 400', async ({ page, context }) => {
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);
  await seedWorkspace(context, {
    series: [{ id: 'sr-h', name: '健康系列', description: null }],
    tournaments: [
      { id: 'h-1', name: '健康测试届一', seriesId: 'sr-h' },
      { id: 'h-2', name: '健康测试届二', seriesId: 'sr-h' }
    ],
    players: [],
    activeId: 'h-1'
  });

  await page.goto('/admin.html#health');
  await page.waitForSelector('#admin-health-kv .admin-kv-item');

  /* 健康块:OSS 未配置(红字降级)+ 数据量计数 */
  const kv = page.locator('#admin-health-kv');
  await expect(kv).toContainText('OSS 状态');
  await expect(kv.locator('.admin-kv-item', { hasText: 'OSS 状态' }).locator('dd')).toHaveText('未配置 / 异常');
  await expect(kv.locator('.admin-kv-item', { hasText: '账号数' }).locator('dd')).toHaveText('1');
  await expect(kv.locator('.admin-kv-item', { hasText: '届数' }).locator('dd')).toHaveText('2');
  await expect(kv.locator('.admin-kv-item', { hasText: '系列数' }).locator('dd')).toHaveText('1');
  await expect(page.locator('#admin-health-status')).toContainText('未配置 OSS');

  /* 一键备份:dev 无 OSS → 三件全败 500 → 红字提示(降级形态) */
  await page.locator('#admin-backup-btn').click();
  const backupStatus = page.locator('#admin-backup-status');
  await expect(backupStatus).toContainText('备份失败');
  await expect(backupStatus).toHaveClass(/is-danger/);

  /* 恢复:非法 key(非 backups/ 前缀)→ 400 红字提示 */
  await page.locator('#admin-restore-key').fill('hacker/steal.json');
  page.once('dialog', (d) => d.accept('RESTORE'));
  await page.locator('#admin-restore-form button[type=submit]').click();
  const restoreStatus = page.locator('#admin-restore-status');
  await expect(restoreStatus).toContainText('恢复失败');
  await expect(restoreStatus).toHaveClass(/is-danger/);

  await resetStore(context);
});
