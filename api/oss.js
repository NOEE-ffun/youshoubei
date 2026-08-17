'use strict';

const OSS = require('ali-oss');

const DATA_PATH = 'data.json';

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
    secure: true
  });
}

async function readJson(key) {
  const client = getClient();
  try {
    const result = await client.get(key);
    const content = result.content;
    if (!content) return null;
    return JSON.parse(content.toString('utf8'));
  } catch (error) {
    if (error && (error.code === 'NoSuchKey' || error.status === 404)) return null;
    throw error;
  }
}

async function writeJson(key, value) {
  const client = getClient();
  await client.put(key, Buffer.from(JSON.stringify(value), 'utf8'), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

async function uploadImageBuffer(key, buffer, contentType) {
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
  publicUrl
};
