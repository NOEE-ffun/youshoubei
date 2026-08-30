import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, resetStore } from './helpers.mjs';

/* 登录系统 API 级冒烟(E2E 服务无 OSS,走内存降级存储 + 开发测试码):
 * 短信登录自动注册 → 会话读取 → 登出失效 → 错验证码 401 → 越权写 401/403。
 * 旧「注册 tab/开发码注册/Bearer 口令」体系已随权限重构退役,断言语义等价迁移到新链路。 */

test('短信登录 API:自动注册/会话/登出/错码 401', async ({ request }) => {
  await request.post('/api/dev/reset');

  // 1. 未注册手机验码登录 → 自动建号(user 级),不回传敏感字段
  const login = await request.post('/api/auth/sms/login', {
    data: { phone: '13811112222', code: '000000' }
  });
  expect(login.status()).toBe(200);
  const body = await login.json();
  expect(body.user.role).toBe('user');
  expect(body.user.username).toBe('13811112222');
  expect(body.user).not.toHaveProperty('passHash');

  // 2. 会话有效(同 request 上下文自动携带 cookie)
  const me = await request.get('/api/me');
  expect(me.status()).toBe(200);
  const meBody = await me.json();
  expect(meBody.user.username).toBe('13811112222');

  // 3. 登出后 401
  const out = await request.post('/api/auth/logout');
  expect(out.status()).toBe(200);
  const meAfter = await request.get('/api/me');
  expect(meAfter.status()).toBe(401);

  // 4. 错验证码 401(开发后门码之外的码一律拒绝)
  const bad = await request.post('/api/auth/sms/login', {
    data: { phone: '13811112222', code: '000001' }
  });
  expect(bad.status()).toBe(401);

  // 5. 手机号格式不合法 400
  const badPhone = await request.post('/api/auth/sms/login', {
    data: { phone: '123', code: '000000' }
  });
  expect(badPhone.status()).toBe(400);

  await request.post('/api/dev/reset');
});

test('越权回归:非管理员会话 PUT /api/data 被拒(2026-08-30 权限重构)', async ({ request }) => {
  await request.post('/api/dev/reset');

  // 1. 无会话 → 401(旧 Bearer 口令通道已退役,不再有「仅口令放行」)
  const anon = await request.put('/api/data', {
    data: { tournaments: [], activeId: null }
  });
  expect(anon.status()).toBe(401);

  // 2. 超管会话 → 200(自举通道)
  const admin = await request.post('/api/auth/sms/login', {
    data: { phone: ADMIN_PHONE, code: '000000' }
  });
  expect(admin.status()).toBe(200);
  expect((await admin.json()).user.role).toBe('super');
  const seed = await request.put('/api/data', {
    data: { tournaments: [], players: [], activeId: null }
  });
  expect(seed.status()).toBe(200);

  // 3. 普通用户会话 → 403,身份按角色算
  const user = await request.post('/api/auth/sms/login', {
    data: { phone: '13833334444', code: '000000' }
  });
  expect(user.status()).toBe(200);
  const denied = await request.put('/api/data', { data: { tournaments: [] } });
  expect(denied.status()).toBe(403);
  const deniedBody = await denied.json();
  expect(deniedBody.error).toContain('权限不足');

  await request.post('/api/dev/reset');
});
