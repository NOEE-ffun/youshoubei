'use strict';

/* 零依赖静态文件服务器：node server.js [端口] */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || process.argv[2] || 8000);

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

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  /* 前缀必须精确到目录分隔符：纯字符串前缀比较会放行同前缀的兄弟目录 */
  let filePath = path.normalize(path.join(ROOT, pathname));
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (filePath !== ROOT && !filePath.startsWith(rootWithSep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    if (fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch {
    // 文件不存在时继续走 readFile，返回 404
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('赛事网站已启动：http://localhost:' + PORT);
  console.log('按 Ctrl+C 停止服务器');
});
