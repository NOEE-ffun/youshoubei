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

/* ========== data.json 版本化备份 ==========
 * 写入前把当前版本 copy 到 backups/ 前缀,保留最近 N 份。
 * best-effort:备份失败只记日志,绝不阻塞主写入——不因备份让办赛保存失败。 */

const BACKUP_PREFIX = 'backups/';
const BACKUP_KEEP = 20;

function isOssConfigured() {
  return Boolean(process.env.OSS_REGION && process.env.OSS_BUCKET && process.env.OSS_ACCESS_KEY_ID && process.env.OSS_ACCESS_KEY_SECRET);
}

/** 纯函数:当前备份对象名(时间戳可注入,可单测) */
function backupKeyNow(now) {
  const ts = new Date(now).toISOString().replace(/[:.]/g, '-');
  return BACKUP_PREFIX + 'data-' + ts + '.json';
}

/** 纯函数:给定现有备份名列表,返回应删除的(超出保留数的最旧者)。
 * 名字即时间戳,字典序=时间序;非本命名规则的条目不动。 */
function pruneBackupKeys(names, keep) {
  const n = Number.isFinite(keep) ? keep : BACKUP_KEEP;
  const ours = (names || [])
    .filter((name) => /^backups\/data-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/.test(name))
    .sort();
  if (ours.length <= n) return [];
  return ours.slice(0, ours.length - n);
}

/** 把当前 data.json 备份一份并清理过期备份;失败只记日志 */
async function backupData() {
  if (!isOssConfigured()) return; // 本地/无配置环境跳过
  try {
    const client = getClient();
    const existing = await client.get(DATA_PATH);
    if (!existing.content) return;
    await client.copy(backupKeyNow(Date.now()), DATA_PATH);
    /* 分页列全量(>1000 份时单轮也只删第一页最旧的,多轮收敛) */
    let marker;
    const names = [];
    for (;;) {
      const query = { prefix: BACKUP_PREFIX, 'max-keys': 1000 };
      if (marker) query.marker = marker;
      const listed = await client.list(query);
      for (const obj of listed.objects || []) names.push(obj.name);
      if (!listed.isTruncated || !listed.nextMarker) break;
      marker = listed.nextMarker;
    }
    for (const stale of pruneBackupKeys(names, BACKUP_KEEP)) {
      await client.delete(stale);
    }
  } catch (error) {
    console.error('[backup] data.json 备份失败(不影响本次写入):', error.message);
  }
}

/* ========== 审计日志 ==========
 * 每次 admin 写操作(data PUT / upload / poster-stage POST)追加一行 JSON
 * 到 OSS audit/log-<yyyy-mm>.json(按月分文件,单文件内数组 append)。
 * best-effort:失败只记服务器日志,绝不阻塞业务写入。
 * 查看方式:控制台下载该文件,或用 scripts/read-audit.js。 */

const AUDIT_PREFIX = 'audit/';
const AUDIT_KEEP_PER_FILE = 2000; // 单文件条数上限,超出裁最旧

function auditKeyNow(now) {
  const d = new Date(now);
  return AUDIT_PREFIX + 'log-' + d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '.json';
}

/** 纯函数:构造审计条目(时间可注入,可单测) */
function buildAuditEntry(action, detail, now) {
  return {
    t: new Date(now).toISOString(),
    action: String(action || '').slice(0, 40),
    detail: String(detail || '').slice(0, 200)
  };
}

/** 追加审计条目;失败静默(只 console.error) */
async function appendAudit(action, detail) {
  if (!isOssConfigured()) return;
  try {
    const client = getClient();
    const key = auditKeyNow(Date.now());
    let list = [];
    try {
      const result = await client.get(key);
      if (result.content) {
        const parsed = JSON.parse(result.content.toString('utf8'));
        if (Array.isArray(parsed)) list = parsed;
      }
    } catch (error) {
      if (!(error.code === 'NoSuchKey' || error.status === 404)) throw error;
    }
    list.push(buildAuditEntry(action, detail, Date.now()));
    if (list.length > AUDIT_KEEP_PER_FILE) list = list.slice(list.length - AUDIT_KEEP_PER_FILE);
    await client.put(key, Buffer.from(JSON.stringify(list), 'utf8'), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  } catch (error) {
    console.error('[audit] 审计写入失败(不影响业务):', error.message);
  }
}

/** 列出现有备份名(时间序),恢复 CLI 用 */
async function listBackups() {
  const client = getClient();
  const listed = await client.list({ prefix: BACKUP_PREFIX, 'max-keys': 1000 });
  return (listed.objects || []).map((o) => o.name)
    .filter((name) => name.includes('data-'))
    .sort();
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
  isRetriable,
  backupData,
  backupKeyNow,
  pruneBackupKeys,
  listBackups,
  appendAudit,
  auditKeyNow,
  buildAuditEntry
};
