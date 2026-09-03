'use strict';

/* 一体化 Node 服务冒烟:静态站点可访问、/api 已接管、隐藏文件与 api 源码不可被当静态文件下载。 */

const assert = require('node:assert');
const http = require('node:http');
const { createServer } = require('../server.js');

function request(server, pathname, encoding) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: pathname,
      headers: { 'Accept-Encoding': encoding || 'identity' }
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

    /* 5. JS/CSS 引用恒带 ?v= → 一年 immutable;图片/字体一天强缓存 + SWR */
    const js = await request(server, '/canvas-model.js');
    assert.strictEqual(js.status, 200);
    assert(js.headers['cache-control'].includes('max-age=31536000'), 'js 应长缓存: ' + js.headers['cache-control']);
    assert(js.headers['cache-control'].includes('immutable'));
    const icon = await request(server, '/icons/home.svg');
    assert(icon.headers['cache-control'].includes('max-age=86400'), '图片应一天缓存: ' + icon.headers['cache-control']);
    assert(icon.headers['cache-control'].includes('stale-while-revalidate'));

    /* 5b. 带 br 的请求静态下发走 brotli 压缩 */
    const jsBr = await request(server, '/canvas-model.js', 'br');
    assert.strictEqual(jsBr.headers['content-encoding'], 'br');
    assert(jsBr.body.length > 0);

    /* 6. 不存在的静态文件 404 */
    const missing = await request(server, '/not-exists.html');
    assert.strictEqual(missing.status, 404);

    /* 7. 舞台接口已注册且登录墙前置：匿名 GET 被 401 拦截(id 校验在其后)，
     * 源码不可当静态文件下发 */
    const stageNoId = await request(server, '/api/poster-stage');
    assert.strictEqual(stageNoId.status, 401, '/api/poster-stage 匿名应被登录墙拦(401)');
    assert.strictEqual(JSON.parse(stageNoId.body).error, '未登录或账号已被停用');
    const stageSource = await request(server, '/api/poster-stage.js');
    assert.strictEqual(stageSource.status, 404, 'api/poster-stage.js 源码不可当静态文件下发');

    /* 8. null 字节路径返回 400 且进程存活(曾因 readFile 同步抛出击穿进程) */
    const nullByte = await request(server, '/%00');
    assert.strictEqual(nullByte.status, 400, '/%00 应返回 400 而不是击穿进程');
    const stillAlive = await request(server, '/api/health');
    assert.strictEqual(stillAlive.status, 200, 'null 字节请求后服务器应继续服务');

    /* 9. 内部目录/文件不作为静态资源下发(含大小写变体,防 /API/ 绕过) */
    for (const p of [
      '/node_modules/ali-oss/package.json',
      '/test/server-smoke.test.js',
      '/scripts/backfill-oss-cache.js',
      '/deploy/nginx.conf.example',
      '/server.js',
      '/package.json',
      '/API/oss.js',
      '/Api/data.js'
    ]) {
      const resp = await request(server, p);
      assert.notStrictEqual(resp.status, 200, p + ' 不应可被下载');
    }

    /* 10. 安全响应头:静态与 API 出口都要带 */
    assert.strictEqual(js.headers['x-frame-options'], 'DENY');
    assert.strictEqual(js.headers['referrer-policy'], 'strict-origin-when-cross-origin');
    assert.strictEqual(health.headers['x-frame-options'], 'DENY');
    assert.strictEqual(health.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=()');

    /* 11. 后台前缀分发:/api/admin/* 交给 admin 处理器(匿名先被登录墙 401 拦);
     * 裸 /api/admin 未注册,保持 404 语义(admin 内部对裸路径同样 404) */
    const adminUsers = await request(server, '/api/admin/users');
    assert.strictEqual(adminUsers.status, 401, '/api/admin/users 匿名应被登录墙拦(401)');
    assert.strictEqual(JSON.parse(adminUsers.body).error, '未登录或账号已被停用');
    const adminBare = await request(server, '/api/admin');
    assert.strictEqual(adminBare.status, 404, '裸 /api/admin 未注册应保持 404');

    console.log('server-smoke 全部 11 组测试通过 ✓');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error('server-smoke 失败:', error && error.message);
  process.exit(1);
});
