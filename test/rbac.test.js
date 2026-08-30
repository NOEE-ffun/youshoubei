'use strict';
/* rbac 角色判定:env 超管名单动态升格 + 角色工具函数 */
const assert = require('node:assert');
const { effectiveRole, isAdminRole, ROLES } = require('../api/rbac');

const kept = {};
function withEnv(patch, fn) {
  for (const k of Object.keys(patch)) { kept[k] = process.env[k]; process.env[k] = patch[k]; }
  try { fn(); } finally { for (const k of Object.keys(patch)) process.env[k] = kept[k]; }
}

assert.strictEqual(ROLES.join(','), 'user,player,admin,super');
assert.strictEqual(effectiveRole(null), null);
assert.strictEqual(effectiveRole({ role: 'player' }), 'player');
assert.strictEqual(effectiveRole({ role: 'admin' }), 'admin');
assert.strictEqual(effectiveRole({ role: 'bogus' }), 'user');      // 未知角色兜底
assert.strictEqual(effectiveRole({ role: 'player', usernameLower: 'noee' }), 'player');

withEnv({ SUPER_ADMIN_USERNAMES: 'NOEE, ops ' }, () => {
  assert.strictEqual(effectiveRole({ role: 'player', usernameLower: 'noee' }), 'super');
  assert.strictEqual(effectiveRole({ role: 'user', usernameLower: 'ops' }), 'super');
  assert.strictEqual(effectiveRole({ role: 'player', usernameLower: 'other' }), 'player');
});
withEnv({ SUPER_ADMIN_PHONES: '13900000000' }, () => {
  assert.strictEqual(effectiveRole({ role: 'user', phone: '13900000000' }), 'super');
  assert.strictEqual(effectiveRole({ role: 'user', phone: '13800000000' }), 'user');
  // 空名单不误伤
});
withEnv({ SUPER_ADMIN_USERNAMES: '' }, () => {
  assert.strictEqual(effectiveRole({ role: 'admin', usernameLower: 'noee' }), 'admin');
});

assert.strictEqual(isAdminRole('admin'), true);
assert.strictEqual(isAdminRole('super'), true);
assert.strictEqual(isAdminRole('player'), false);
assert.strictEqual(isAdminRole('user'), false);
console.log('✓ rbac: 12 断言通过');
