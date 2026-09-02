'use strict';

const { isOssConfigured, readJson, writeJson } = require('./oss');
const devStore = require('./dev-store');

/* api/ 共享工具:JSON 响应与请求体收集。
 * 逐块收集后一次性 concat 再解码:中文等多字节字符跨 chunk 时,
 * 逐块 utf8 解码会产生 U+FFFD 替换符损坏数据。 */

function sendJson(res, status, payload) {
  res.status(status).json(payload);
}

/** 收集请求体并限流;超过 maxBytes 返回 null(调用方应答 413),空体返回空 Buffer */
async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** 收集并解析 JSON 对象请求体;校验失败已应答并返回 undefined */
async function readJsonBody(req, res, maxBytes) {
  const buffer = await readBody(req, maxBytes);
  if (buffer === null) {
    sendJson(res, 413, { error: '数据过大' });
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    sendJson(res, 400, { error: '请求体不是合法 JSON' });
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { error: '请求体必须是 JSON 对象' });
    return undefined;
  }
  return parsed;
}

/** 存储三态解析:注入存储(测试)> 开发共享内存(无 OSS 环境)> OSS。
 * data/account/decks/signup 四模块的读-改-写共用,别再手抄漂移 */
function createStorage(storage) {
  return {
    async read(key) {
      if (storage && storage.readJson) return storage.readJson(key);
      if (!isOssConfigured()) return devStore.readJson(key);
      return readJson(key);
    },
    async write(key, value) {
      if (storage && storage.writeJson) return storage.writeJson(key, value);
      if (!isOssConfigured()) return devStore.writeJson(key, value);
      return writeJson(key, value);
    }
  };
}

/** 审计脱敏:11 位手机号形态的账号名只留末 4 位(短信注册用户 username 即手机号,
 * 全文落盘等于手机号明文进日志;非手机号形态原样返回不过度打码) */
function maskUser(name) {
  const s = String(name == null ? '' : name);
  return /^1\d{10}$/.test(s) ? '***' + s.slice(-4) : s;
}

module.exports = { sendJson, readBody, readJsonBody, createStorage, maskUser };
