'use strict';

const crypto = require('node:crypto');
const { isAuthorized } = require('./auth');
const { sessionOf } = require('./session');
const { sendJson, readBody } = require('./helpers');
const { uploadImageBuffer, publicUrl, appendAudit } = require('./oss');

const MAX_SIZE = 5 * 1024 * 1024;

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

/* 鉴权:管理口令(三态)或登录会话(选手上传自己的头像/队标) */
function uploadGate(req, res) {
  const authed = isAuthorized(req);
  if (authed === true) return true;
  if (sessionOf(req)) return true;
  if (authed === null) {
    res.status(403).json({ error: '上传功能未配置(ADMIN_TOKEN)或未登录' });
  } else {
    res.status(401).json({ error: '需要管理员口令或登录会话' });
  }
  return false;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  if (!uploadGate(req, res)) return;

  const buffer = await readBody(req, MAX_SIZE);
  if (buffer === null) {
    sendJson(res, 413, { error: '图片过大' });
    return;
  }
  if (!buffer.length) {
    sendJson(res, 400, { error: '空文件' });
    return;
  }

  const imageType = sniffImageType(buffer);
  if (!imageType) {
    sendJson(res, 415, { error: '仅支持 PNG/JPEG/WebP/GIF 图片' });
    return;
  }

  const key = 'images/' + crypto.randomUUID() + EXT_BY_TYPE[imageType];

  try {
    await uploadImageBuffer(key, buffer, imageType);
    appendAudit('upload', imageType.replace('image/', '') + ' ' + (buffer.length >> 10) + 'KB → ' + key);
    sendJson(res, 200, { url: publicUrl(key) });
  } catch (error) {
    console.error('[upload] 失败:', error.message);
    sendJson(res, 500, { error: '图片上传失败' });
  }
};
