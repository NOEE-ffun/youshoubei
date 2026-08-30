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
    /* 登录接口 E2E:短信开发后门码 + 超管名单手机号(无 OSS 时走内存降级存储) */
    env: {
      ...process.env,
      AUTH_DEV_SMS_CODE: '000000',
      SUPER_ADMIN_PHONES: '13900000000',
      SESSION_SECRET: 'e2e-session-secret'
    }
  }
});
