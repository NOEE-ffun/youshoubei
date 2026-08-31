import { defineConfig } from '@playwright/test';
import path from 'node:path';

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
    /* 登录接口 E2E:短信开发后门码 + 超管名单手机号(无 OSS 时走内存降级存储)。
     * NODE_ENV 显式钉 development:防止宿主 shell 误 export production 触发后门硬闸;
     * YOUSHOUBEI_ENFORCE_WALL:E2E 需测「配置好的服务器」的登录墙语义,
     * 压掉纯本地进程(无 OSS)的免墙放行分支 */
    env: {
      ...process.env,
      NODE_ENV: 'development',
      YOUSHOUBEI_ENFORCE_WALL: '1',
      AUTH_DEV_SMS_CODE: '000000',
      SUPER_ADMIN_PHONES: '13900000000',
      SESSION_SECRET: 'e2e-session-secret',
      /* 卡组解析 fixture 后门:WB 链接读本地文件不出网(生产硬闸在 api/deck-resolve.js) */
      DECK_RESOLVE_FIXTURE_DIR: path.resolve('test/e2e/fixtures/decks')
    }
  }
});
