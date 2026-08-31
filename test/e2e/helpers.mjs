import { expect } from '@playwright/test';

/* E2E 登录/自举 helpers(新登录体系):
 * - 短信开发后门码 000000(playwright.config webServer env AUTH_DEV_SMS_CODE),
 *   未注册手机号自动建号(user 级);context.request 与浏览器上下文共享 cookie jar,
 *   API 登录即等于页面登录,无需 UI 走表单。
 * - SUPER_ADMIN_PHONES=13900000000:该手机号登录即 super(env 动态升格,全新环境引导通道)。
 * - PUT /api/data 需 admin/super 会话(云模式自举);/api/dev/reset 清内存存储(测试间自清)。 */

export const ADMIN_PHONE = '13900000000';
export const DEV_CODE = '000000';

/* 短信登录(API 通道,cookie 进 context;未注册自动建号) */
export async function smsLogin(context, phone) {
  const r = await context.request.post('/api/auth/sms/login', {
    data: { phone, code: DEV_CODE }
  });
  expect(r.ok(), 'smsLogin ' + phone).toBeTruthy();
  return r.json();
}

/* 管理员直写工作区(云模式自举;调用方 context 需已登录 admin/super) */
export async function seedWorkspace(context, workspace) {
  const r = await context.request.put('/api/data', { data: workspace });
  expect(r.ok(), 'seedWorkspace').toBeTruthy();
}

/* 造一个选手会话:超管发绑定码 → 该手机登录 → 兑换。
 * playerId 省略时发空白码(建号并新建选手档案)。 */
export async function makePlayer(context, phone, playerId) {
  const admin = await context.browser().newContext();
  await smsLogin(admin, ADMIN_PHONE);
  const gen = await admin.request.post('/api/codes', { data: { kind: 'player', playerId } });
  expect(gen.ok()).toBeTruthy();
  const { code } = await gen.json();
  await admin.close();
  await smsLogin(context, phone);
  const redeem = await context.request.post('/api/me/redeem', { data: { code } });
  expect(redeem.ok(), 'redeem ' + code).toBeTruthy();
}

/* 造一个管理员会话:超管发管理员码(仅 super 可发)→ 该手机登录 → 兑换升 admin。
 * 返回 /api/me 的 user(含 id——归属种子里作 createdBy 的真实用户 id)。 */
export async function makeAdmin(context, phone) {
  const admin = await context.browser().newContext();
  await smsLogin(admin, ADMIN_PHONE);
  const gen = await admin.request.post('/api/codes', { data: { kind: 'admin' } });
  expect(gen.ok(), 'makeAdmin 发管理员码').toBeTruthy();
  const { code } = await gen.json();
  await admin.close();
  await smsLogin(context, phone);
  const redeem = await context.request.post('/api/me/redeem', { data: { code } });
  expect(redeem.ok(), 'makeAdmin 兑换 ' + code).toBeTruthy();
  const me = await context.request.get('/api/me');
  expect(me.ok()).toBeTruthy();
  return (await me.json()).user;
}

export async function resetStore(context) {
  await context.request.post('/api/dev/reset');
}
