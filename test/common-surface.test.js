'use strict';

/**
 * appInstance / TournamentApp 导出面完整性回归
 *
 * 背景:T1 重构曾把 isAdmin 从 appInstance 字面量删掉但调用处未同步,
 * 本地模式短路不触发,云端模式首屏渲染头部即抛
 * "appInstance.isAdmin is not a function",数据加载失败横幅。
 * E2E 跑在本地模式(OSS 未配置)覆盖不到,故用静态分析兜底:
 * 全库扫描 appInstance.X / TournamentApp.X 的属性访问,
 * 断言每个被访问的属性都在 appInstance 字面量里(或后续有赋值)。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/* 1. 提取 common.js 里 appInstance = { ... } 字面量的键 */
const commonSrc = read('common.js');
const literalMatch = commonSrc.match(/appInstance\s*=\s*\{([\s\S]*?)\n\s*\};/);
assert.ok(literalMatch, '应能找到 appInstance 对象字面量');
const literalBody = literalMatch[1]
  .replace(/\/\*[\s\S]*?\*\//g, '') // 去块注释
  .replace(/\/\/[^\n]*/g, '');       // 去行注释
const literalKeys = new Set();
for (const m of literalBody.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*(?=[,:(}\n])/gm)) {
  literalKeys.add(m[1]);
}
assert.ok(literalKeys.size >= 10, '字面量键解析异常: ' + [...literalKeys]);

/* 2. 收集后续动态赋值的属性(appInstance.X = ... / TournamentApp.X = ...) */
const assigned = new Set();
for (const m of commonSrc.matchAll(/(?:appInstance|TournamentApp)\.([A-Za-z_$][\w$]*)\s*=[^=]/g)) {
  assigned.add(m[1]);
}

/* 3. 全库扫描属性访问面(根目录 js + vs-poster/js + 全部 html 内联脚本) */
const files = fs.readdirSync(root)
  .filter((f) => f.endsWith('.js') && !f.startsWith('server'))
  .map((f) => [f, read(f)]);
const posterDir = path.join(root, 'vs-poster/js');
for (const f of fs.readdirSync(posterDir).filter((f) => f.endsWith('.js'))) {
  files.push(['vs-poster/js/' + f, fs.readFileSync(path.join(posterDir, f), 'utf8')]);
}
for (const f of fs.readdirSync(root).filter((f) => f.endsWith('.html'))) {
  files.push([f, read(f)]);
}

const surface = new Set([...literalKeys, ...assigned]);
const missing = [];
for (const [file, src] of files) {
  for (const m of src.matchAll(/(?:appInstance|TournamentApp)\.([A-Za-z_$][\w$]*)/g)) {
    if (!surface.has(m[1])) missing.push(file + ': ' + m[1]);
  }
}

assert.deepEqual(
  missing,
  [],
  '以下属性被访问但不在 appInstance 导出面(云端模式将抛 is not a function):\n' + missing.join('\n')
);

/* 4. 关键方法点名词质:历史事故属性必须在字面量上 */
for (const key of ['isAdmin', 'setActiveId', 'storagePut', 'uploadImage', 'fatalError']) {
  assert.ok(literalKeys.has(key), 'appInstance 字面量应包含 ' + key);
}

console.log('✓ common-surface: 导出面 ' + literalKeys.size + ' 键,访问面全部覆盖(含 isAdmin 回归)');
