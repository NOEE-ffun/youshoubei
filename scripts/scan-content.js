#!/usr/bin/env node
'use strict';

/* 存量内容扫描(内容审查·方案甲 Task 4):对已落库数据跑违禁词检查,默认 dry-run。
 *   node scripts/scan-content.js           只读扫描,输出命中清单
 *   node scripts/scan-content.js --write-oss   预留未实现(见下)
 * 存储三态复用 api/helpers.createStorage:OSS 已配置走 OSS,否则开发内存
 * (同 scripts/read-audit.js 惯例,require server 顺带读 .env)。
 * 词源与线上完全一致:api/moderation 共享单例(OSS blocked-words.json 真源,
 * 缺文件回落 deploy/blocked-words.seed.json 种子)——不另建词表通道。
 * 扫描面与写入端拒审(Task 2)对齐:data.json 卡 label/phase/format +
 * classLinks[].text(比赛卡 {a,b} 对象与 roll 池数组两形态)+ 选手 name/tag/title;
 * 另补 users.json nickname 与 templates.json 模板名(个人库+市场快照)。
 * 真实词表纪律:输出只有 文件/记录定位/字段 与计数,绝不输出命中词与字段内容。 */

require('../server');

const { createStorage } = require('../api/helpers');
const { DATA_PATH, isOssConfigured } = require('../api/oss');
const { shared: moderation } = require('../api/moderation');

const USERS_KEY = 'users.json';
const TPL_KEY = 'templates.json';

/* classLinks 两形态归一(同 api/data.js scanBlockedText):数组=roll 池座位,
 * 对象=比赛卡 {a,b};统一拍平成待检 text 组 */
function classLinkGroups(classLinks) {
  if (Array.isArray(classLinks)) return classLinks;
  if (classLinks && typeof classLinks === 'object') return Object.values(classLinks);
  return [];
}

/** 扫 workspace(data.json);返回命中定位数组(不含任何词/字段值) */
async function scanWorkspace(workspace, check) {
  const hits = [];
  for (const record of (workspace && workspace.tournaments) || []) {
    if (!record || !record.canvas) continue;
    const tname = record.name || record.id || '?';
    for (const card of record.canvas.cards || []) {
      if (!card) continue;
      const where = '届「' + tname + '」卡 ' + card.id;
      for (const field of ['label', 'phase', 'format']) {
        if (!(await check(card[field])).ok) hits.push({ file: 'data.json', id: where, field });
      }
      for (const group of classLinkGroups(card.classLinks)) {
        for (const link of Array.isArray(group) ? group : []) {
          if (!(await check(link && link.text)).ok) hits.push({ file: 'data.json', id: where, field: 'classLinks.text' });
        }
      }
    }
  }
  for (const p of (workspace && workspace.players) || []) {
    if (!p) continue;
    for (const field of ['name', 'tag', 'title']) {
      if (!(await check(p[field])).ok) hits.push({ file: 'data.json', id: '选手 ' + (p.id || '?'), field });
    }
  }
  return hits;
}

/** 扫 users.json 昵称(username 是手机号/账号名,非用户发布内容,不扫) */
async function scanUsers(users, check) {
  const hits = [];
  for (const u of Array.isArray(users) ? users : []) {
    if (!u) continue;
    if (!(await check(u.nickname)).ok) hits.push({ file: 'users.json', id: '用户 ' + (u.id || '?'), field: 'nickname' });
  }
  return hits;
}

/** 扫 templates.json:个人库模板名 + 市场在架快照名(市场条目=深拷贝快照,单独扫) */
async function scanTemplates(file, check) {
  const hits = [];
  const doc = file && typeof file === 'object' ? file : {};
  for (const uid of Object.keys(doc.libraries || {})) {
    const lib = doc.libraries[uid];
    for (const t of (lib && lib.templates) || []) {
      if (!t) continue;
      if (!(await check(t.name)).ok) hits.push({ file: 'templates.json', id: '库 ' + uid + ' 模板 ' + (t.id || '?'), field: 'name' });
    }
  }
  for (const m of doc.market || []) {
    if (!m) continue;
    if (!(await check(m.snapshot && m.snapshot.name)).ok) {
      hits.push({ file: 'templates.json', id: '市场 ' + (m.id || '?'), field: 'snapshot.name' });
    }
  }
  return hits;
}

async function main() {
  if (process.argv.includes('--write-oss')) {
    console.error('--write-oss 未实现:命中内容留给人工处置(改名/清头像/下线),本工具只做只读扫描');
    process.exitCode = 1;
    return;
  }
  const storage = createStorage();
  console.log('存储模式:' + (isOssConfigured() ? 'OSS' : '开发内存(dev-store)') + ',词源:OSS blocked-words.json(缺省回落 deploy 种子)');

  /* 词库先证可用再扫:扫描器 fail-fast(与线上写入端 fail-open 相反——
   * 只读诊断宁可中止也不给"0 命中"的假阴性报告) */
  let words;
  try {
    words = await moderation.loadWords();
  } catch (error) {
    console.error('词库加载失败,中止扫描(不输出假阴性):', (error && (error.code || error.name)) || error);
    process.exitCode = 1;
    return;
  }
  console.log('词库已加载:' + words.length + ' 词条');
  if (!words.length) {
    console.log('词库为空(0 词条),扫描无意义,退出');
    return;
  }

  const readSafe = async (key, label) => {
    try {
      const doc = await storage.read(key);
      console.log(label + ':' + (doc === null ? '不存在' : '已读取'));
      return doc;
    } catch (error) {
      console.error(label + ' 读取失败(按缺失处理):', (error && (error.code || error.name)) || error);
      return null;
    }
  };
  const [workspace, users, templates] = await Promise.all([
    readSafe(DATA_PATH, 'data.json'),
    readSafe(USERS_KEY, 'users.json'),
    readSafe(TPL_KEY, 'templates.json')
  ]);

  const sections = [];
  if (workspace) {
    sections.push(await scanWorkspace(workspace, moderation.checkText));
    console.log('  data.json:' + ((workspace.tournaments || []).length) + ' 届 / ' + ((workspace.players || []).length) + ' 名选手');
  }
  if (users) {
    sections.push(await scanUsers(users, moderation.checkText));
    console.log('  users.json:' + users.length + ' 个账号');
  }
  if (templates) {
    sections.push(await scanTemplates(templates, moderation.checkText));
    console.log('  templates.json:' + Object.keys(templates.libraries || {}).length + ' 个个人库 / ' + ((templates.market || []).length) + ' 条在架');
  }

  const all = sections.flat();
  console.log('\n命中清单(dry-run,只列定位,不含命中词):');
  if (!all.length) {
    console.log('  (无)');
  } else {
    for (const h of all) console.log('  ' + h.file + '  ' + h.id + '  ' + h.field);
  }
  const byFile = {};
  for (const h of all) byFile[h.file] = (byFile[h.file] || 0) + 1;
  console.log('\n统计:' + (Object.keys(byFile).length
    ? Object.entries(byFile).map(([f, n]) => f + ' ' + n + ' 处').join(', ')
    : '各文件均无命中') + (all.length ? ';共 ' + all.length + ' 处命中,请人工核实处置(本工具不改写任何数据)' : ';共 0 处命中'));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('扫描失败:', error && (error.code || error.name || error.message));
    process.exit(1);
  });
}

module.exports = { scanWorkspace, scanUsers, scanTemplates };
