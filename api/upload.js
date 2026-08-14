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

const EXT_BY_TYPE = {
  'image/png': '.png',
  'image/webp': '.webp',
  'image/jpeg': '.jpg',
  'image/gif': '.gif'
};

/* 魔数嗅探：以文件内容判定真实类型，不信任客户端 Content-Type。
 * SVG 一律拒绝：其公共 URL 可被直接访问，允许上传等于留存储型 XSS 面。 */
function sniffImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const b = (i) => buffer[i];
  if (b(0) === 0xFF && b(1) === 0xD8 && b(2) === 0xFF) return 'image/jpeg';
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47) return 'image/png';
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) return 'image/gif';
  if (
    b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 &&
    b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50
  ) return 'image/webp';
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  const authed = isAuthorized(req);
  if (authed === null) {
    sendJson(res, 403, { error: '管理功能未配置（ADMIN_TOKEN）' });
    return;
  }
  if (!authed) {
    sendJson(res, 401, { error: '管理口令错误' });
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

  const imageType = sniffImageType(buffer);
  if (!imageType) {
    sendJson(res, 415, { error: '仅支持 PNG/JPEG/WebP/GIF 图片' });
    return;
  }

  const pathname = 'images/' + crypto.randomUUID() + EXT_BY_TYPE[imageType];

  try {
    const blob = await put(pathname, buffer, {
      access: 'public',
      addRandomSuffix: false,
      contentType: imageType
    });
    sendJson(res, 200, { url: blob.url });
  } catch (error) {
    console.error('[upload] 失败:', error.message);
    sendJson(res, 500, { error: '图片上传失败: ' + error.message });
  }
};
