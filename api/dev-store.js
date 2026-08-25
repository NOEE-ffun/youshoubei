'use strict';

/* 开发降级存储(单例):无 OSS 环境(E2E/本地联调)下,data/account/decks
 * 三个模块必须共享同一份内存 workspace/users/codes,否则注册建的选手
 * 在 /api/data 里永远不可见。生产(OSS 已配置)完全不经过此模块。 */
const store = new Map();

function readJson(key) {
  return Promise.resolve(store.has(key) ? JSON.parse(store.get(key)) : null);
}

function writeJson(key, value) {
  store.set(key, JSON.stringify(value === undefined ? null : value));
  return Promise.resolve();
}

/* 测试辅助:清空(仅测试用) */
function reset() {
  store.clear();
}

module.exports = { readJson, writeJson, reset };


/* 仅测试服务器可用的一键清空(OSS 已配置或未设开发码时 404),
 * E2E 用例收尾自清,避免把云端模式状态泄漏给后续需要本地模式的用例 */
function resetHandler(req, res) {
  const { sendJson } = require('./helpers');
  const { isOssConfigured } = require('./oss');
  if (isOssConfigured() || !process.env.AUTH_DEV_INVITE_CODES) {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }
  reset();
  sendJson(res, 200, { ok: true });
}
module.exports.resetHandler = resetHandler;
