'use strict';

const { adminGate } = require('./auth');
const { sendJson, readBody } = require('./helpers');
const { DATA_PATH, readJson, writeJson } = require('./oss');

/* data.json 只含文本数据（图片存 OSS 为 URL），1MB 上限绰绰有余，防内存被打爆 */
const MAX_BODY = 1024 * 1024;

async function readWorkspace() {
  return readJson(DATA_PATH);
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const workspace = await readWorkspace();
      sendJson(res, 200, workspace || { tournaments: [], activeId: null });
    } catch (error) {
      console.error('[data] GET 失败:', error.message);
      sendJson(res, 500, { error: '读取云端数据失败' });
    }
    return;
  }

  if (req.method === 'PUT') {
    if (!adminGate(req, res)) return;

    const body = await readBody(req, MAX_BODY);
    if (body === null) {
      sendJson(res, 413, { error: '数据过大' });
      return;
    }
    let workspace;
    try {
      workspace = JSON.parse(body.toString('utf8'));
      if (!workspace || !Array.isArray(workspace.tournaments)) throw new Error('数据格式不正确');
    } catch (error) {
      sendJson(res, 400, { error: '数据格式不正确' });
      return;
    }

    try {
      await writeJson(DATA_PATH, workspace);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      console.error('[data] PUT 失败:', error.message);
      sendJson(res, 500, { error: '保存云端数据失败' });
    }
    return;
  }

  sendJson(res, 405, { error: 'Method Not Allowed' });
};
