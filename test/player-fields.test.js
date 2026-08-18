'use strict';

/* 选手字段归一化单测：node:vm 加载 common.js（IIFE，仅需 window 全局），
 * 校验 window.TournamentUtils.normalizePlayer 的默认/保留/修复逻辑。 */

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

// 2. 缺 title/color → 默认 title 对象 + color null
{
  const p = normalizePlayer({ id: 'p1', name: 'A' });
  assert.equal(p.id, 'p1');
  assert.equal(p.title.type, 'text');
  assert.equal(p.title.text, '');
  assert.equal(p.title.image, null);
  assert.equal(p.color, null);
}

// 3. title 为字符串（旧 schema 遗留）→ 修复为默认对象；非法 color → null
{
  const p = normalizePlayer({ id: 'p1', name: 'A', title: 'DK.FIRE', color: 'red' });
  assert.equal(p.title.type, 'text');
  assert.equal(p.title.text, '');
  assert.equal(p.title.image, null);
  assert.equal(p.color, null);
}

// 4. 合法字段完整保留
{
  const p = normalizePlayer({
    id: 'p1', name: 'A',
    title: { type: 'text', text: 'DK.FIRE', image: null },
    color: '#ff00ff', avatar: 'https://x/a.png'
  });
  assert.equal(p.title.type, 'text');
  assert.equal(p.title.text, 'DK.FIRE');
  assert.equal(p.title.image, null);
  assert.equal(p.color, '#ff00ff');
  assert.equal(p.avatar, 'https://x/a.png');
}

// 5. image 保留 string / object（Blob 类），其余类型置 null
{
  const p = normalizePlayer({ id: 'p1', title: { type: 'image', text: '', image: 'https://x/y.png' } });
  assert.equal(p.title.type, 'image');
  assert.equal(p.title.image, 'https://x/y.png');
}
{
  const blob = { size: 10, type: 'image/png' };
  const p = normalizePlayer({ id: 'p1', title: { type: 'image', text: '', image: blob } });
  assert.equal(p.title.type, 'image');
  assert.equal(p.title.image, blob);
}
{
  const p = normalizePlayer({ id: 'p1', title: { type: 'image', text: '', image: 123 } });
  assert.equal(p.title.type, 'image');
  assert.equal(p.title.image, null);
}

// 6. type 非法 → text
{
  const p = normalizePlayer({ id: 'p1', title: { type: 'bogus', text: 'X', image: null } });
  assert.equal(p.title.type, 'text');
  assert.equal(p.title.text, 'X');
}

// 7. text 非法 → ''
{
  const p = normalizePlayer({ id: 'p1', title: { type: 'text', text: 42, image: null } });
  assert.equal(p.title.text, '');
}

// 8. color 校验：非法 → null，合法（大小写 hex）保留
assert.equal(normalizePlayer({ id: 'p1', color: 'blue' }).color, null);
assert.equal(normalizePlayer({ id: 'p1', color: '#abc' }).color, null);
assert.equal(normalizePlayer({ id: 'p1', color: '#A1B2C3' }).color, '#A1B2C3');

console.log('player-fields 全部测试通过 ✓');
