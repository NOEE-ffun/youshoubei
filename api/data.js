'use strict';

const crypto = require('node:crypto');
const { list, put } = require('@vercel/blob');

const DATA_PATH = 'data.json';

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
      sendJson(res, 500, { error: '读取云端数据失败: ' + error.message });
    }
    return;
  }

  if (req.method === 'PUT') {
    const authed = isAuthorized(req);
    if (authed === null) {
      sendJson(res, 500, { error: 'ADMIN_TOKEN 未配置' });
      return;
    }
    if (!authed) {
      sendJson(res, 401, { error: '管理口令错误' });
      return;
    }

    let raw = '';
    for await (const chunk of req) raw += chunk;
    let workspace;
    try {
      workspace = JSON.parse(raw);
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
      sendJson(res, 500, { error: '保存云端数据失败: ' + error.message });
    }
    return;
  }

  sendJson(res, 405, { error: 'Method Not Allowed' });
};
