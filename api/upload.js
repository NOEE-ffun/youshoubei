'use strict';

const crypto = require('node:crypto');
const { put } = require('@vercel/blob');

const MAX_SIZE = 5 * 1024 * 1024;

function sendJson(res, status, payload) {
  res.status(status).json(payload);
}

function isAuthorized(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return null;
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  const authed = isAuthorized(req);
  if (authed === null) {
    sendJson(res, 500, { error: 'ADMIN_TOKEN 未配置' });
    return;
  }
  if (!authed) {
    sendJson(res, 401, { error: '管理口令错误' });
    return;
  }

  const contentType = req.headers['content-type'] || '';
  if (!contentType.startsWith('image/')) {
    sendJson(res, 415, { error: '仅支持图片上传' });
    return;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_SIZE) {
      sendJson(res, 413, { error: '图片过大' });
      return;
    }
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  if (!buffer.length) {
    sendJson(res, 400, { error: '空文件' });
    return;
  }

  const extMap = {
    'image/png': '.png',
    'image/webp': '.webp',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/svg+xml': '.svg'
  };
  const pathname = 'images/' + crypto.randomUUID() + (extMap[contentType] || '.jpg');

  try {
    const blob = await put(pathname, buffer, {
      access: 'public',
      addRandomSuffix: false,
      contentType
    });
    sendJson(res, 200, { url: blob.url });
  } catch (error) {
    console.error('[upload] 失败:', error.message);
    sendJson(res, 500, { error: '图片上传失败: ' + error.message });
  }
};
