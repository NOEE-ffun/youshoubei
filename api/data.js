'use strict';

const crypto = require('node:crypto');
const { list, put } = require('@vercel/blob');

const DATA_PATH = 'data.json';
/* data.json 只含文本数据（图片存 Blob 为 URL），1MB 上限绰绰有余，防内存被打爆 */
const MAX_BODY = 1024 * 1024;

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

async function readWorkspace() {
  const result = await list({ prefix: DATA_PATH });
  const blob = result.blobs && result.blobs[0];
  if (!blob) return null;
  const response = await fetch(blob.url);
  if (!response.ok) throw new Error('读取 data.json 失败');
  return response.json();
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const workspace = await readWorkspace();
      sendJson(res, 200, workspace || { tournaments: [], activeId: null });
    } catch (error) {
      console.error('[data] GET 失败:', error.message);
      sendJson(res, 500, { error: '读取云端数据失败：' + error.message });
    }
    return;
  }

  if (req.method === 'PUT') {
    const authed = isAuthorized(req);
    if (authed === null) {
      sendJson(res, 403, { error: '管理功能未配置（ADMIN_TOKEN）' });
      return;
    }
    if (!authed) {
      sendJson(res, 401, { error: '管理口令错误' });
      return;
    }

    /* 逐块收集 Buffer 后一次性解码：中文等多字节字符跨 chunk 时，
     * 逐块 utf8 解码会产生 U+FFFD 替换符损坏数据 */
    const chunks = [];
    let bodySize = 0;
    for await (const chunk of req) {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) {
        sendJson(res, 413, { error: '数据过大' });
        return;
      }
      chunks.push(chunk);
    }
    let workspace;
    try {
      workspace = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!workspace || !Array.isArray(workspace.tournaments)) throw new Error('数据格式不正确');
    } catch (error) {
      sendJson(res, 400, { error: '数据格式不正确' });
      return;
    }

    try {
      await put(DATA_PATH, JSON.stringify(workspace), {
        access: 'public',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/json; charset=utf-8'
      });
      sendJson(res, 200, { ok: true });
    } catch (error) {
      console.error('[data] PUT 失败:', error.message);
      sendJson(res, 500, { error: '保存云端数据失败：' + error.message });
    }
    return;
  }

  sendJson(res, 405, { error: 'Method Not Allowed' });
};
