import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:3999',
    headless: true
  },
  webServer: {
    command: 'node server.js 3999',
    port: 3999,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    /* 登录接口 E2E:管理员引导码 + 开发测试码(无 OSS 时走内存降级存储) */
    env: {
      ...process.env,
      ADMIN_TOKEN: 'e2e-admin-token',
      ADMIN_INVITE_CODE: 'e2e-admin-code',
      AUTH_DEV_INVITE_CODES: 'e2e-dev-1,e2e-dev-2,e2e-dev-3,e2e-dev-4,e2e-dev-5',
      SESSION_SECRET: 'e2e-session-secret'
    }
  }
});
