import { expect } from '@playwright/test';

/* E2E 登录/自举 helpers(新登录体系):
 * - 短信开发后门码 000000(playwright.config webServer env AUTH_DEV_SMS_CODE),
 *   未注册手机号自动建号即 player 级(2026-09-01 注册即选手合并,登录即自动建档案);
 *   context.request 与浏览器上下文共享 cookie jar,API 登录即等于页面登录,无需 UI 走表单。
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

/* 管理员直写工作区(云模式自举;调用方 context 需已登录 admin/super)。
 * 注册即选手合并后:任何登录(含超管)都会自动建被账号绑定的选手档案,整库 PUT
 * 删掉被绑选手会被服务端 409 守卫拒——种子先 GET 现库,把 body 漏掉的现存选手
 * 并回 players 再 PUT(同 id 以种子为准),即「种子不删被绑档案」。 */
export async function seedWorkspace(context, workspace) {
  const cur = await context.request.get('/api/data');
  expect(cur.ok(), 'seedWorkspace GET /api/data').toBeTruthy();
  const body = Object.assign({}, workspace);
  const seedIds = new Set((body.players || []).map((p) => p && p.id));
  const kept = ((await cur.json()).players) || [];
  body.players = (body.players || []).concat(kept.filter((p) => p && p.id != null && !seedIds.has(p.id)));
  const r = await context.request.put('/api/data', { data: body });
  expect(r.ok(), 'seedWorkspace').toBeTruthy();
}

/* 本机模式默认 8 选手的云端等价种子(命名与前端 makeDefaultPlayers 一致):
 * 合并后登录即写云工作区,页面恒走云端 normalizeWorkspace 的默认画布,
 * 依赖「选手 N」标签的 UI 用例(卡位下拉/统计行)改由 API 预置同名选手;
 * 被绑档案(超管登录自动建)由 seedWorkspace 自动保留,只占选手库不上场。 */
export const DEFAULT_PLAYERS = Array.from({ length: 8 }, (_, i) => ({
  id: 'dp' + (i + 1), name: '选手 ' + (i + 1), createdAt: 1, updatedAt: 1
}));

/* 造一个选手会话(注册即选手,2026-09-01 合并后无需兑码):
 * playerId 省略 = 纯登录(注册时自动建档);指定 playerId = super 走后台换绑
 * 把该账号绑到种子选手(绑定码通道退役)。 */
export async function makePlayer(context, phone, playerId) {
  await smsLogin(context, phone);
  if (!playerId) return;
  const me = await context.request.get('/api/me');
  expect(me.ok(), 'makePlayer /api/me').toBeTruthy();
  const uid = (await me.json()).user.id;
  const admin = await context.browser().newContext();
  await smsLogin(admin, ADMIN_PHONE);
  const r = await admin.request.post('/api/admin/users/' + encodeURIComponent(uid) + '/player', {
    data: { playerId }
  });
  expect(r.ok(), 'makePlayer rebind ' + playerId).toBeTruthy();
  await admin.close();
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
