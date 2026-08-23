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
    stdout: 'ignore'
  }
});
