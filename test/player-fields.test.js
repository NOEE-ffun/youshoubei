'use strict';

/* 选手字段归一化单测：node:vm 加载 common.js（IIFE，仅需 window 全局），
 * 校验 window.TournamentUtils.normalizePlayer 的 title(赛前垃圾话)纯文本与 color 校验。 */

const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const code = fs.readFileSync(path.join(__dirname, '..', 'common.js'), 'utf8');
const sandbox = {};
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'common.js' });

const normalizePlayer = sandbox.TournamentUtils && sandbox.TournamentUtils.normalizePlayer;
assert.equal(typeof normalizePlayer, 'function', 'TournamentUtils.normalizePlayer 应导出');

// 1. 非法选手对象 → null
assert.equal(normalizePlayer(null), null);
assert.equal(normalizePlayer(undefined), null);
assert.equal(normalizePlayer('x'), null);
assert.equal(normalizePlayer(42), null);
assert.equal(normalizePlayer([]), null);

// 2. 缺 title/color → title 纯文本默认空字符串 + color null
{
  const p = normalizePlayer({ id: 'p1', name: 'A' });
  assert.equal(p.id, 'p1');
  assert.equal(p.title, '');
  assert.equal(p.color, null);
}

// 3. title 字符串保留；非法 color → null
{
  const p = normalizePlayer({ id: 'p1', name: 'A', title: '今天你必输', color: 'red' });
  assert.equal(p.title, '今天你必输');
  assert.equal(p.color, null);
}

// 4. 上一版 title 对象结构 → 提取 text,丢弃 image
{
  const p = normalizePlayer({
    id: 'p1', name: 'A',
    title: { type: 'image', text: '赛前垃圾话', image: 'https://x/y.png' },
    color: '#ff00ff', avatar: 'https://x/a.png'
  });
  assert.equal(p.title, '赛前垃圾话');
  assert.equal(p.color, '#ff00ff');
  assert.equal(p.avatar, 'https://x/a.png');
}

// 5. 非法 title 类型/缺 text → 空字符串
assert.equal(normalizePlayer({ id: 'p1', title: 42 }).title, '');
assert.equal(normalizePlayer({ id: 'p1', title: { type: 'text', text: 42 } }).title, '');
assert.equal(normalizePlayer({ id: 'p1', title: { type: 'bogus', text: 'X' } }).title, 'X');

// 6. color 校验：非法 → null，合法（大小写 hex）保留
assert.equal(normalizePlayer({ id: 'p1', color: 'blue' }).color, null);
assert.equal(normalizePlayer({ id: 'p1', color: '#abc' }).color, null);
assert.equal(normalizePlayer({ id: 'p1', color: '#A1B2C3' }).color, '#A1B2C3');

// 7. tag(ID/队名)归一化：字符串保留并截 16 字，非字符串归空，缺省补空串
assert.equal(normalizePlayer({ id: 'p1', tag: 'DK.FIRE' }).tag, 'DK.FIRE');
assert.equal(normalizePlayer({ id: 'p1', tag: '  前后空格  ' }).tag, '前后空格');
assert.equal(normalizePlayer({ id: 'p1', tag: 'x'.repeat(20) }).tag.length, 16, '超长 tag 应截到 16 字符');
assert.equal(normalizePlayer({ id: 'p1', tag: 42 }).tag, '');
assert.equal(normalizePlayer({ id: 'p1' }).tag, '');

console.log('player-fields 全部测试通过 ✓');
