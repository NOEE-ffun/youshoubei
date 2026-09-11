#!/usr/bin/env node
'use strict';

/* kb 知识库 → 官方文档发布(2026-09-11 首次用于「技术文档」分类上线):
 *   node scripts/import-kb.js [目录=kb] [--category=技术文档] [--push]
 *   默认 dry-run 只打印计划;--push 写入(写前 backupJson('docs.json','docs')+审计)。
 * 规则:
 *   - 目录内 *.md 按文件名升序;「NN-标题.md」的数字前缀作组内 sort,前缀剥掉作标题;
 *   - Obsidian 维基链 [[NN-标题]] / [[NN-标题|显示名]] 转为站内 md 链接 [#doc-<id>]
 *     (锚点 = 本次导入集内同名词条的最终 id,命中既有沿用;围栏代码块与行内反引号
 *      内的 [[..]] 不动,kb 代码样例里有 cards:[[id,名,费…]] 形态;解析不到的目标
 *      退化为纯文字;转换在 planKbImport 内完成,锚点先于转换定好);
 *   - adminOnly 恒 false(全员可读);
 *   - 幂等:按「分类+标题」匹配既有文档,命中则原位更新 body/sort(保留
 *     id/createdBy/createdAt),未命中追加新篇;重复运行零变更。
 * 环境变量与 server 相同(OSS_*);本地对生产 OSS 跑时先 export 服务器 env。
 * 逻辑抽成纯函数(parseKbEntry/convertWikilinks/planKbImport)导出,单测在 test/docs-api.test.js。 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DOCS_KEY = 'docs.json';
const DEFAULT_CATEGORY = '技术文档';
const WIKI_RE = /^(\d+)[-.](.+)$/;
/* 三类 token 一次扫过:围栏代码块 / 行内反引号 / 维基链;前两类原样保留 */
const CODE_OR_WIKI = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)|(\[\[([^\]\n]+)\]\])/g;

/** 文件名 → 词条:NN-标题.md 取数字前缀为 sort、余下为标题;不符命名规则返回 null */
function parseKbEntry(fileName) {
  const base = fileName.replace(/\.md$/i, '');
  const m = WIKI_RE.exec(base);
  if (!m) return base ? { stem: base, title: base, sort: 0 } : null;
  return { stem: base, title: m[2].trim(), sort: Number(m[1]) };
}

/** 维基链转换:resolve(target) → {id,title} | null;命中出 [#doc-id](#doc-id),
 * 未命中剥掉双方括号留纯文字;代码块/行内代码内的内容不动 */
function convertWikilinks(md, resolve) {
  return String(md || '').replace(CODE_OR_WIKI, (whole, code, _wiki, inner) => {
    if (code) return whole;
    const parts = String(inner).split('|');
    const hit = resolve(parts[0].trim().replace(/\.md$/i, ''));
    if (!hit) return (parts[1] || parts[0]).trim();
    return '[' + (parts[1] || hit.title).trim() + '](#doc-' + hit.id + ')';
  });
}

/** 计划导入(纯):entries=[{stem,title,sort,body(原始 md)}];按「分类+标题」原位
 * 更新或追加。锚点先定(命中沿用既有 id、未命中新造),维基链转换在后——链接
 * 指向的就是最终 #doc-<id>。返回 { changed, docs, created, updated }(新数组,不改入参)。 */
function planKbImport(existingDocs, entries, options) {
  const o = options || {};
  const category = o.category || DEFAULT_CATEGORY;
  const now = new Date(typeof o.now === 'function' ? o.now() : Date.now()).toISOString();
  const newId = typeof o.newId === 'function' ? o.newId : () => 'd_' + crypto.randomBytes(8).toString('hex');
  const docs = (existingDocs || []).filter(Boolean).map((x) => Object.assign({}, x));
  const list = (entries || []).filter((e) => e && e.title);
  /* 先定锚:每篇的最终 id 与标题(维链 resolve 用;幂等重跑时命中篇 id 不变) */
  const anchors = new Map();
  for (const e of list) {
    const hit = docs.find((x) => x && x.category === category && x.title === e.title);
    anchors.set(e.stem, { id: hit ? hit.id : newId(), title: e.title });
  }
  let created = 0;
  let updated = 0;
  for (const e of list) {
    const body = convertWikilinks(e.body, (target) => anchors.get(target) || null);
    const idx = docs.findIndex((x) => x && x.category === category && x.title === e.title);
    if (idx >= 0) {
      const hit = docs[idx];
      if (hit.body === body && hit.sort === e.sort && hit.adminOnly === false) continue;
      docs[idx] = Object.assign({}, hit, { body, sort: e.sort, adminOnly: false, updatedAt: now });
      updated += 1;
    } else {
      docs.push({
        id: anchors.get(e.stem).id,
        title: e.title,
        category,
        body,
        adminOnly: false,
        sort: e.sort,
        createdBy: null,
        createdAt: now,
        updatedAt: now
      });
      created += 1;
    }
  }
  return { changed: created + updated > 0, docs, created, updated };
}

async function main() {
  /* require server.js 顺带读 .env(与 migrate-series.js 同模式),须在用 env 前完成 */
  require('../server');
  const oss = require('../api/oss');

  if (!oss.isOssConfigured()) {
    console.error('[import-kb] OSS 配置不完整:需要 OSS_REGION / OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const push = args.includes('--push');
  const catArg = args.find((a) => a.startsWith('--category='));
  const category = catArg ? catArg.slice('--category='.length).trim() : DEFAULT_CATEGORY;
  const dir = path.resolve(args.find((a) => !a.startsWith('--')) || 'kb');

  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => /\.md$/i.test(n)).sort();
  } catch (error) {
    console.error('[import-kb] 读目录失败:' + dir + '(' + error.message + ')');
    process.exit(1);
  }
  if (!names.length) {
    console.error('[import-kb] 目录内没有 .md 文件:' + dir);
    process.exit(1);
  }

  const parsed = names.map(parseKbEntry).filter(Boolean);
  const entries = parsed.map((p) => ({
    stem: p.stem,
    title: p.title,
    sort: p.sort,
    body: fs.readFileSync(path.join(dir, p.stem + '.md'), 'utf8')
  }));

  const existing = (await oss.readJson(DOCS_KEY)) || [];
  const result = planKbImport(existing, entries, { category });

  for (const e of entries) {
    console.log('  ' + String(e.sort).padStart(3) + '  ' + e.title + '(' + (e.body.length / 1024).toFixed(1) + 'KB)');
  }
  console.log('[import-kb] 目录 ' + dir + ' → 分类「' + category + '」:新建 ' + result.created
    + ' 篇,更新 ' + result.updated + ' 篇(既有共 ' + existing.length + ' 篇,全员可读)。');
  if (!result.changed) {
    console.log('[import-kb] 无变更(内容与线上一致)。');
    return;
  }
  if (!push) {
    console.log('[import-kb] dry-run 预览,未写入。加 --push 执行导入(写前自动备份 docs.json)。');
    return;
  }
  await oss.backupJson(DOCS_KEY, 'docs');
  await oss.writeJson(DOCS_KEY, result.docs);
  await oss.appendAudit('admin.kbImport', 'created=' + result.created + ' updated=' + result.updated
    + ' category=' + category + ' dir=' + path.basename(dir));
  console.log('[import-kb] 已备份 docs.json 并写入导入结果。');
}

module.exports = { parseKbEntry, convertWikilinks, planKbImport, DEFAULT_CATEGORY };

if (require.main === module) {
  main().catch((error) => {
    console.error('[import-kb] ' + (error && error.message ? error.message : error));
    process.exit(1);
  });
}
