import { test, expect } from '@playwright/test';

/* 登录系统 API 级冒烟(E2E 服务无 OSS,走内存降级存储 + 开发测试码):
 * 管理员码注册 → 会话读取 → 登出失效 → 开发码注册选手账号 → 码一次性 → 错密码 401 */

const BASE = 'http://127.0.0.1:3999';

test('登录 API:注册/会话/登出/开发码/一次性', async ({ request }) => {
  // 1. 管理员码注册
  const reg = await request.post(BASE + '/api/auth/register', {
    data: { code: 'e2e-admin-code', username: 'e2e-admin', password: '12345678' }
  });
  expect(reg.status()).toBe(200);
  const regBody = await reg.json();
  expect(regBody.user.role).toBe('admin');

  // 2. 会话有效(同 request 上下文自动携带 cookie)
  const me = await request.get(BASE + '/api/me');
  expect(me.status()).toBe(200);
  const meBody = await me.json();
  expect(meBody.user.username).toBe('e2e-admin');
  expect(meBody.user).not.toHaveProperty('passHash');

  // 3. 登出后 401
  const out = await request.post(BASE + '/api/auth/logout');
  expect(out.status()).toBe(200);
  const meAfter = await request.get(BASE + '/api/me');
  expect(meAfter.status()).toBe(401);

  // 4. 开发码注册选手账号(无 OSS:建号不建选手)
  const regPlayer = await request.post(BASE + '/api/auth/register', {
    data: { code: 'e2e-dev-1', username: 'e2e-player', password: '12345678' }
  });
  expect(regPlayer.status()).toBe(200);
  const playerBody = await regPlayer.json();
  expect(playerBody.user.role).toBe('player');
  expect(playerBody.user.playerId).toBeNull();

  // 5. 未绑选手账号编辑资料 → 400
  const upd = await request.put(BASE + '/api/me/player', { data: { name: 'x' } });
  expect(upd.status()).toBe(400);

  // 6. 开发码一次性
  const again = await request.post(BASE + '/api/auth/register', {
    data: { code: 'e2e-dev-1', username: 'e2e-player2', password: '12345678' }
  });
  expect(again.status()).toBe(400);
});

test('登录 API:错密码 401、正确登录 200', async ({ request }) => {
  // 先注册(用第二个开发码)
  await request.post(BASE + '/api/auth/register', {
    data: { code: 'e2e-dev-2', username: 'e2e-login-user', password: 'correct-pass-1' }
  });
  await request.post(BASE + '/api/auth/logout');

  const bad = await request.post(BASE + '/api/auth/login', {
    data: { username: 'e2e-login-user', password: 'wrong-pass-123' }
  });
  expect(bad.status()).toBe(401);

  const ok = await request.post(BASE + '/api/auth/login', {
    data: { username: 'E2E-LOGIN-USER', password: 'correct-pass-1' }
  });
  expect(ok.status()).toBe(200);
  const body = await ok.json();
  expect(body.user.username).toBe('e2e-login-user');
});
