'use strict';

/* 一体化 Node 服务冒烟:静态站点可访问、/api 已接管、隐藏文件与 api 源码不可被当静态文件下载。 */

const assert = require('node:assert');
const http = require('node:http');
const { createServer } = require('../server.js');

function request(server, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: pathname,
      headers: { 'Accept-Encoding': 'identity' }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    /* 1. 健康检查走 api/health.js,返回 Vercel 同款 JSON */
    const health = await request(server, '/api/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(JSON.parse(health.body).ok, true);
    assert.strictEqual(health.headers['cache-control'], 'no-store');

    /* 2. 未注册的 /api/* 是 404,而不是把 api/oss.js 源码下发 */
    const apiSource = await request(server, '/api/oss.js');
    assert.strictEqual(apiSource.status, 404);

    /* 3. 隐藏文件拒绝访问(即使文件不存在也先拦截) */
    const envFile = await request(server, '/.env');
    assert.strictEqual(envFile.status, 403);

    /* 4. 首页/赛程页正常静态下发 */
    const index = await request(server, '/');
    assert.strictEqual(index.status, 200);
    assert(index.body.includes('<!DOCTYPE html>') || index.body.includes('<html'));
    const schedule = await request(server, '/schedule.html');
    assert.strictEqual(schedule.status, 200);
    assert.strictEqual(schedule.headers['cache-control'], 'no-cache');

    /* 5. JS/CSS 使用短缓存 + SWR */
    const js = await request(server, '/canvas-model.js');
    assert.strictEqual(js.status, 200);
    assert(js.headers['cache-control'].includes('max-age=300'));
    assert(js.headers['cache-control'].includes('stale-while-revalidate'));

    /* 6. 不存在的静态文件 404 */
    const missing = await request(server, '/not-exists.html');
    assert.strictEqual(missing.status, 404);

    /* 7. 舞台接口已注册：缺 id 参数走校验返回 400（不依赖 OSS），源码不可当静态文件下发 */
    const stageNoId = await request(server, '/api/poster-stage');
    assert.strictEqual(stageNoId.status, 400, '/api/poster-stage 应已注册(缺 id 应 400)');
    assert.strictEqual(JSON.parse(stageNoId.body).error, 'id 必须是 32 位十六进制字符串');
    const stageSource = await request(server, '/api/poster-stage.js');
    assert.strictEqual(stageSource.status, 404, 'api/poster-stage.js 源码不可当静态文件下发');

    console.log('server-smoke 全部 7 组测试通过 ✓');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error('server-smoke 失败:', error && error.message);
  process.exit(1);
});
