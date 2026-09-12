'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sendJson, readJsonBody, createStorage, maskUser } = require('./helpers');
const { backupJson, appendAudit } = require('./oss');
const { requireRole } = require('./auth');
const { withWorkspaceLock } = require('./workspace-lock');

/* 内容审查·方案甲(词库核心):
 *   GET  /api/moderation/words  super:词表全量
 *   POST /api/moderation/words  super:{action:'add'|'remove', word}
 * 真源 = OSS blocked-words.json({words:[...]});缺文件时读 deploy/blocked-words.seed.json
 * (gitignored 本地同步层,Task 4 生成)灌入并回写真源,此后只在真源上增删。
 * 命中判定:词与受检文本同走 normalize(NFKC 全角→半角 + 去全部空白 + 小写),
 * 词编译为转义字面量交替的 RegExp 缓存,增删后重建。
 * 真实词表纪律:词内容只允许存在于 deploy/ 与 OSS;代码/测试/日志一律合成词,
 * 拒绝文案固定为统一话术,绝不回显命中词。 */
const WORDS_KEY = 'blocked-words.json';
const SEED_PATH = path.join(__dirname, '..', 'deploy', 'blocked-words.seed.json');
const MAX_BODY = 4 * 1024;
const MAX_WORD_LEN = 32;
const REJECT_REASON = '内容包含不允许的词汇,请修改';

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 归一化:NFKC(全角→半角等兼容分解)→ 去所有空白 → 小写。词与文本同规则,
 * 空格混淆/全角变体/大小写绕不过。非字符串按空串(受检侧=放行,词侧=无效)。 */
function normalize(s) {
  return String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/* deploy 种子只此一处经 fs 进来(模块级缓存,进程内读一次):
 * ENOENT 静默 = 无本地同步层,属正常形态;其余错误也按无种子降级,
 * 错误信息只记 code/name,不带文件内容。 */
let seedCache;
function readSeedWords() {
  if (seedCache !== undefined) return seedCache;
  seedCache = [];
  try {
    const doc = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
    if (doc && Array.isArray(doc.words)) {
      seedCache = doc.words.filter((w) => typeof w === 'string');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[moderation] 种子文件读取失败(按无种子处理):', error.code || error.name);
    }
  }
  return seedCache;
}

function createModeration(storage, options) {
  const o = options || {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const audit = typeof o.appendAudit === 'function' ? o.appendAudit : appendAudit;
  const { read, write } = createStorage(storage);
  /* 测试注入的合成种子(数组);未注入时才回落 deploy/ 真实种子文件 */
  const injectedSeeds = Array.isArray(o.seedWords) ? o.seedWords : null;

  let words = [];
  let regex = null; // 词表为空时不编译:test 恒走放行分支
  let updatedAt = null;
  let loading = null; // 首载单飞:并发 checkText 只触发一次读真源

  function rebuild() {
    regex = words.length ? new RegExp(words.map(escapeRe).join('|'), 'i') : null;
  }

  /** 归一化+校验+去重(保序):存储/种子侧统一清洗,脏词条静默丢弃 */
  function sanitizeList(list) {
    const seen = new Set();
    const out = [];
    for (const w of list || []) {
      if (typeof w !== 'string') continue;
      const n = normalize(w);
      if (!n || n.length > MAX_WORD_LEN || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out;
  }

  async function doLoad() {
    const doc = await read(WORDS_KEY);
    if (doc && Array.isArray(doc.words)) {
      words = sanitizeList(doc.words);
      updatedAt = doc.updatedAt || null;
    } else {
      /* 真源缺失:种子(deploy 同步层或测试注入)灌入并回写真源 */
      const seeds = injectedSeeds !== null ? injectedSeeds : readSeedWords();
      words = sanitizeList(seeds);
      if (words.length) {
        updatedAt = new Date(now()).toISOString();
        await write(WORDS_KEY, { words: words.slice(), updatedAt });
      }
    }
    rebuild();
    return words.slice();
  }

  /** 惰性加载(幂等,失败可重试):首调触发真源读取/种子灌入 */
  function loadWords() {
    if (!loading) {
      loading = doLoad().catch((error) => {
        loading = null;
        throw error;
      });
    }
    return loading.then(() => words.slice());
  }

  /** 受检文本是否放行;命中拒绝文案固定,不回显命中词 */
  async function checkText(text) {
    await loadWords();
    if (!regex) return { ok: true, reason: null };
    return regex.test(normalize(text)) ? { ok: false, reason: REJECT_REASON } : { ok: true, reason: null };
  }

  /** 当前编译缓存(空库为 null);add/remove 后自动重建 */
  function wordsRegex() {
    return regex;
  }

  async function get(req, res) {
    const user = await requireRole(req, res, ['super']);
    if (!user) return;
    const list = await loadWords();
    sendJson(res, 200, { words: list, updatedAt });
  }

  async function post(req, res) {
    const user = await requireRole(req, res, ['super']);
    if (!user) return;
    const body = await readJsonBody(req, res, MAX_BODY);
    if (body === undefined) return;
    if (body.action !== 'add' && body.action !== 'remove') {
      return sendJson(res, 400, { error: "action 必须是 'add' 或 'remove'" });
    }
    if (typeof body.word !== 'string') {
      return sendJson(res, 400, { error: 'word 必须是字符串' });
    }
    const w = normalize(body.word);
    if (!w) return sendJson(res, 400, { error: '词条不能为空' });
    if (w.length > MAX_WORD_LEN) {
      return sendJson(res, 400, { error: '词条过长(最多 ' + MAX_WORD_LEN + ' 字)' });
    }

    /* 词表读改写(读→改→备份→写)整段上锁,同 codes.js 惯例:并发增删
     * 交错会旧快照整体覆盖丢词;锁内先确保真源已加载(含首载种子灌入) */
    return withWorkspaceLock(async () => {
      await loadWords();
      if (body.action === 'add') {
        if (words.includes(w)) return sendJson(res, 400, { error: '词条已存在' });
        words.push(w);
      } else {
        const i = words.indexOf(w);
        if (i < 0) return sendJson(res, 400, { error: '词条不存在' });
        words.splice(i, 1);
      }
      updatedAt = new Date(now()).toISOString();
      await backupJson(WORDS_KEY, 'words');
      await write(WORDS_KEY, { words: words.slice(), updatedAt });
      rebuild();
      audit('moderation.' + body.action, 'by=' + maskUser(user.username) + ' word=' + w);
      sendJson(res, 200, { ok: true, words: words.slice(), updatedAt });
    });
  }

  async function wordsApi(req, res) {
    if (req.method === 'GET') return get(req, res);
    if (req.method === 'POST') return post(req, res);
    sendJson(res, 405, { error: 'Method Not Allowed' });
  }

  /** 写入端钩子(Task 2 各 api 模块消费)的稳定面:只给检查能力,不给词表管理 */
  function exportForHooks() {
    return { checkText, loadWords };
  }

  return { checkText, loadWords, wordsRegex, wordsApi, exportForHooks };
}

/* 模块级单例:与 codes.js「默认导出=handler」不同,moderation 的主消费面是
 * 服务方法(checkText)而非路由,故默认导出工厂、.shared 挂共享实例——
 * server.js 挂 .shared.wordsApi,Task 2 写入端经 .shared/exportForHooks 消费;
 * 测试一律 createModeration(storage, {seedWords}) 自建实例,不碰真实词表。 */
const shared = createModeration();
module.exports = createModeration;
module.exports.createModeration = createModeration;
module.exports.shared = shared;
