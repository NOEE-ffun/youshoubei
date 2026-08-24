'use strict';

/* 一体化生产服务:静态站点 + /api/*(原 Vercel Serverless 迁移到自有 Node 进程)。
 * 静态逻辑与 Vercel 版一致;API 通过轻量 res.status().json() 适配器复用 api/ 下原处理函数。 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;

/* 本地开发/单机部署允许读 .env(生产推荐 systemd EnvironmentFile,两者都支持) */
function loadEnvFile(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[env] 读取 .env 失败:', error.message);
  }
}
loadEnvFile(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || process.argv[2] || 8000);

/* Vercel 的 api/*.js 迁移到 Node 进程后仍是普通 CJS,直接复用 */
const apiData = require('./api/data');
const apiUpload = require('./api/upload');
const apiHealth = require('./api/health');
const apiPosterStage = require('./api/poster-stage');
const apiAccount = require('./api/account');
const API_ROUTES = {
  '/api/data': apiData,
  '/api/upload': apiUpload,
  '/api/health': apiHealth,
  '/api/poster-stage': apiPosterStage,
  '/api/auth/register': apiAccount.register,
  '/api/auth/login': apiAccount.login,
  '/api/auth/logout': apiAccount.logout,
  '/api/me': apiAccount.me,
  '/api/me/player': apiAccount.me,
  '/api/me/password': apiAccount.mePassword
};

/* 不对外下发的内部目录与根级文件;比对前统一转小写,顺带堵住 /API/ 这类大小写变体 */
const BLOCKED_SEGMENTS = new Set(['api', 'node_modules', 'test', 'scripts', 'deploy', 'docs', 'design-system', 'kb']);
const BLOCKED_ROOT_FILES = new Set(['server.js', 'package.json', 'package-lock.json', 'playwright.config.mjs', 'vercel.json']);

/* 点击劫持/引用裁剪/权限收敛。frame-ancestors 无法写进 meta CSP,只能走响应头 */
const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

/* 静态资源允许短缓存 + SWR;页面与数据文件保持每次校验 */
function cacheControlFor(filePath) {
  return /\.(js|css|svg)$/i.test(filePath)
    ? 'public, max-age=300, stale-while-revalidate=604800'
    : 'no-cache';
}

/* 本站文件都是小文本,同步压缩足够;按 Accept-Encoding 优先 br */
function encodeBody(req, data) {
  const accept = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(accept)) return { body: zlib.brotliCompressSync(data), encoding: 'br' };
  if (/\bgzip\b/.test(accept)) return { body: zlib.gzipSync(data), encoding: 'gzip' };
  return { body: data, encoding: '' };
}

/* Vercel res 的最小适配:api/*.js 只用 status().json()。
 * 默认 Cache-Control no-store;个别公开只读接口(如 /api/poster-stage GET)
 * 可用 .cacheControl('public, max-age=300') 覆盖;setHeader 供登录接口写 Set-Cookie。 */
function apiResponse(rawRes) {
  let statusCode = 200;
  let cacheControl = 'no-store';
  const extraHeaders = [];
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    cacheControl(value) {
      cacheControl = value;
      return this;
    },
    setHeader(name, value) {
      extraHeaders.push([String(name), String(value)]);
      return this;
    },
    json(payload) {
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      rawRes.statusCode = statusCode;
      rawRes.setHeader('Content-Type', 'application/json; charset=utf-8');
      rawRes.setHeader('Cache-Control', cacheControl);
      rawRes.setHeader('X-Content-Type-Options', 'nosniff');
      for (const [key, value] of Object.entries(SECURITY_HEADERS)) rawRes.setHeader(key, value);
      for (const [key, value] of extraHeaders) rawRes.setHeader(key, value);
      rawRes.setHeader('Content-Length', body.length);
      rawRes.end(body);
    }
  };
}

function handleApi(handler, req, rawRes) {
  Promise.resolve()
    .then(() => handler(req, apiResponse(rawRes)))
    .catch((error) => {
      console.error('[api]', req.url, error);
      if (rawRes.headersSent) return;
      const body = Buffer.from(JSON.stringify({ error: '服务器内部错误' }), 'utf8');
      rawRes.statusCode = 500;
      rawRes.setHeader('Content-Type', 'application/json; charset=utf-8');
      rawRes.setHeader('Cache-Control', 'no-store');
      rawRes.setHeader('X-Content-Type-Options', 'nosniff');
      rawRes.setHeader('Content-Length', body.length);
      rawRes.end(body);
    });
}

function sendPlain(rawRes, statusCode, text, headers) {
  rawRes.writeHead(statusCode, Object.assign({
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...SECURITY_HEADERS
  }, headers || {}));
  rawRes.end(text);
}

function requestHandler(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    sendPlain(res, 400, 'Bad Request');
    return;
  }

  /* null 字节会让 fs 调用同步抛 ERR_INVALID_ARG_VALUE 击穿进程,必须在此拒绝 */
  if (pathname.includes('\0')) {
    sendPlain(res, 400, 'Bad Request');
    return;
  }

  /* API 先路由;未注册的 /api/* 一律 404,避免把 api/oss.js 等源码当静态文件下发。
   * 前缀比对走小写:大小写不敏感文件系统上 /API/oss.js 同样命中磁盘文件 */
  if (API_ROUTES[pathname]) {
    handleApi(API_ROUTES[pathname], req, res);
    return;
  }
  const lowerPathname = pathname.toLowerCase();
  if (lowerPathname.startsWith('/api/')) {
    sendPlain(res, 404, '404 Not Found');
    return;
  }

  /* 服务端内部目录/文件不作为静态资源下发(源码、依赖、测试与部署配置) */
  const segments = pathname.split('/').filter((seg) => seg && seg !== '.');
  const blocked =
    segments.some((seg) => BLOCKED_SEGMENTS.has(seg.toLowerCase())) ||
    (segments.length === 1 && BLOCKED_ROOT_FILES.has(segments[0].toLowerCase()));
  if (blocked) {
    sendPlain(res, 403, 'Forbidden');
    return;
  }

  /* 隐藏文件(.env/.git 等)不作为静态资源下发 */
  if (pathname.split('/').some((seg) => seg.startsWith('.') && seg !== '.')) {
    sendPlain(res, 403, 'Forbidden');
    return;
  }

  /* 前缀必须精确到目录分隔符：纯字符串前缀比较会放行同前缀的兄弟目录 */
  let filePath = path.normalize(path.join(ROOT, pathname));
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (filePath !== ROOT && !filePath.startsWith(rootWithSep)) {
    sendPlain(res, 403, 'Forbidden');
    return;
  }

  try {
    if (fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch {
    // 文件不存在时继续走 readFile，返回 404
  }

  /* readFile 对非法路径(如残留 \0)会同步抛出,包一层避免击穿进程 */
  try {
    fs.readFile(filePath, (err, data) => {
      if (err) {
        sendPlain(res, 404, '404 Not Found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': cacheControlFor(filePath),
        'X-Content-Type-Options': 'nosniff',
        ...SECURITY_HEADERS,
        'Vary': 'Accept-Encoding'
      };
      const { body, encoding } = encodeBody(req, data);
      if (encoding) headers['Content-Encoding'] = encoding;
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers);
      res.end(body);
    });
  } catch {
    sendPlain(res, 404, '404 Not Found');
  }
}

function createServer() {
  return http.createServer(requestHandler);
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log('赛事网站已启动：http://localhost:' + PORT);
    console.log('API 路由: /api/data /api/upload /api/health /api/poster-stage /api/auth/* /api/me');
    console.log('按 Ctrl+C 停止服务器');
  });
}

module.exports = { createServer, requestHandler };
