'use strict';

const OSS = require('ali-oss');

const DATA_PATH = 'data.json';

/* 历史上 Vercel 函数在境外、OSS 在杭州,跨境连接偶发被重置/挂起。
 * 迁移到 ECS 后要求与 OSS 同地域;这里保留显式短超时 + 新建客户端重试,
 * 作为同地域内网/公网抖动的兜底。 */
const REQUEST_TIMEOUT_MS = 4000;
const RETRY_DELAYS = [250, 600];

function getClient() {
  const region = process.env.OSS_REGION;
  const bucket = process.env.OSS_BUCKET;
  const accessKeyId = process.env.OSS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET;
  if (!region || !bucket || !accessKeyId || !accessKeySecret) {
    throw new Error('OSS 配置不完整：需要 OSS_REGION / OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET');
  }
  return new OSS({
    region,
    bucket,
    accessKeyId,
    accessKeySecret,
    secure: true,
    timeout: REQUEST_TIMEOUT_MS
  });
}

function isRetriable(error) {
  if (!error) return false;
  const code = error.code || '';
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN'].includes(code)) return true;
  if (error.status >= 500) return true;
  return /timeout|timed\s*out|socket hang up/i.test(String(error.message || ''));
}

async function withRetry(task) {
  let lastError = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt - 1]));
    }
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (!isRetriable(error)) throw error;
    }
  }
  const message = lastError && lastError.message ? lastError.message : String(lastError);
  throw new Error(message + '（已重试 ' + RETRY_DELAYS.length + ' 次仍失败）');
}

async function readJson(key) {
  try {
    const result = await withRetry(() => getClient().get(key));
    const content = result.content;
    if (!content) return null;
    return JSON.parse(content.toString('utf8'));
  } catch (error) {
    if (error && (error.code === 'NoSuchKey' || error.status === 404)) return null;
    throw error;
  }
}

async function writeJson(key, value) {
  await withRetry(() => getClient().put(key, Buffer.from(JSON.stringify(value), 'utf8'), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  }));
}

async function uploadImageBuffer(key, buffer, contentType) {
  await withRetry(async () => {
    const client = getClient();
    await client.put(key, buffer, {
      headers: {
        'Content-Type': contentType,
        /* key 是 UUID,内容不会变,可放心长缓存 */
        'Cache-Control': 'public, max-age=31536000, immutable'
      }
    });
    // data.json 保持私有；图片对象单独设为公共读
    await client.putACL(key, 'public-read');
  });
}

function publicUrl(key) {
  const base = (process.env.OSS_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (base) return base + '/' + key;
  return 'https://' + process.env.OSS_BUCKET + '.' + process.env.OSS_REGION + '.aliyuncs.com/' + key;
}

module.exports = {
  DATA_PATH,
  readJson,
  writeJson,
  uploadImageBuffer,
  publicUrl,
  withRetry,
  isRetriable
};
