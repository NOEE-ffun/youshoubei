'use strict';

/* 模板 API——个人库 GET/PUT(handler 直测)。
 * storage 按 api/helpers.js createStorage 的真实注入契约 mock:
 * readJson/writeJson(对象级,同 test/codes-api.test.js memoryStorage),
 * 任务书草稿的 get/put 文本契约与仓库不符,已按实际核对改写。
 * now/appendAudit 注入:审计三分支(save/cover/delete)与 maskUser 在此断言。
 * 权限(HTTP 层匿名 401/越权 403)由 requireRole+session 兜底,e2e 匿名打真服务覆盖,
 * 单测不重复造会话——第 1 组留注释占位,handler 直测从第 2 组起。 */

const assert = require('node:assert/strict');
const { createHandler } = require('../api/templates.js');

function boot() {
  const map = new Map();
  const storage = {
    readJson: async (key) => (map.has(key) ? map.get(key) : null),
    writeJson: async (key, value) => { map.set(key, value); }
  };
  const audits = [];
  const h = createHandler(storage, { now: () => 123, appendAudit: (a, d) => audits.push([a, d]) });
  return { h, audits, map };
}

const ADMIN = { username: 'admin1', uid: 'u1', role: 'admin' };
/* 手机号形态 username:验审计 detail 里 maskUser 只留末 4 位 */
const USER = { username: '13900000002', uid: 'u2', role: 'player' };
const tpl = (name, id) => ({
  id: id || 'tpl_x', name,
  cards: [{ kind: 'match', x: 0, y: 0 }],
  meta: { w: 10, h: 7 }, createdAt: 1, updatedAt: 1
});

(async () => {
  /* 1) 权限(匿名 401 / 越权 403):requireRole 依赖 session cookie,
   *    HTTP 层链路由 e2e 兜底;handler 单测用注入 user 覆盖校验/配额/隔离/审计(第 2 组起)。 */

  /* 2) PUT:合法落库、只写自己块、updatedAt 走注入 now、审计三分支 + by= 脱敏 */
  {
    const { h, audits, map } = boot();
    await h.__putLibrary(ADMIN, { templates: [tpl('八强赛')] });
    let file = map.get('templates.json');
    assert.ok(file.libraries.u1 && file.libraries.u1.templates.length === 1, 'u1 落库');
    assert.equal(file.libraries.u2, undefined, '只写自己块');
    assert.equal(file.libraries.u1.templates[0].name, '八强赛', '名字保留');
    assert.equal(file.libraries.u1.templates[0].updatedAt, 123, 'updatedAt 走注入 now');

    await h.__putLibrary(USER, { templates: [tpl('我的模板', 'tpl_y')] });
    file = map.get('templates.json');
    assert.ok(file.libraries.u2 && file.libraries.u2.templates.length === 1, 'u2 落库');
    assert.equal(file.libraries.u1.templates.length, 1, '他人提交不动 u1 块');

    /* 同 id 保留=覆盖更新(cover);清空=delete */
    await h.__putLibrary(ADMIN, { templates: [tpl('八强赛v2')] });
    await h.__putLibrary(ADMIN, { templates: [] });
    assert.deepEqual(audits.map((a) => a[0]), ['tpl.save', 'tpl.save', 'tpl.cover', 'tpl.delete'],
      '审计三分支:save→save→cover→delete');
    assert.match(audits[0][1], /^模板「八强赛」1 卡 by=admin1$/, 'save detail 带卡数与 by=');
    assert.match(audits[1][1], /by=\*\*\*0002$/, '手机号形态 username 走 maskUser 脱敏');
    assert.match(audits[2][1], /^模板「八强赛v2」覆盖更新 by=admin1$/, 'cover detail');
    assert.match(audits[3][1], /^模板「八强赛v2」by=admin1$/, 'delete 记删除前名字');
    file = map.get('templates.json');
    assert.equal(file.libraries.u1.templates.length, 0, '清空后 u1 块为空');
    assert.equal(file.libraries.u2.templates.length, 1, '清空自己不碰别人');
  }

  /* 3) 校验:非对象 400 / 同名 409 / 超 50 模板 400 / 名字空或超 20 字 400 / 单模板超 50 卡 400 */
  {
    const { h } = boot();
    assert.equal(h.__validateLibrary(null).code, 400, 'body 非对象 400');
    assert.equal(h.__validateLibrary({}).code, 400, '缺 templates 数组 400');
    assert.equal(h.__validateLibrary({ templates: [tpl('A'), tpl('A')] }).code, 409, '同名两条 409');
    assert.equal(
      h.__validateLibrary({ templates: Array.from({ length: 51 }, (_, i) => tpl('T' + i, 'tpl_' + i)) }).code,
      400, '超 50 模板 400');
    assert.equal(h.__validateLibrary({ templates: [tpl('  ')] }).code, 400, '名字 trim 后空 400');
    assert.equal(h.__validateLibrary({ templates: [tpl('x'.repeat(21))] }).code, 400, '名字超 20 字 400');
    const big = tpl('大');
    big.cards = Array.from({ length: 51 }, () => ({ kind: 'match' }));
    assert.equal(h.__validateLibrary({ templates: [big] }).code, 400, '单模板超 50 卡 400');
    assert.ok(h.__validateLibrary({ templates: [tpl('好')] }).ok, '合法库通过');
  }

  /* 4) GET:空库返回 [] ;本人库回读、他人块不可见 */
  {
    const { h } = boot();
    assert.deepEqual(await h.__getLibrary('u9'), [], '空库返回空数组');
    await h.__putLibrary(ADMIN, { templates: [tpl('甲'), tpl('乙', 'tpl_y')] });
    assert.equal((await h.__getLibrary('u1')).length, 2, '回读本人库');
    assert.deepEqual(await h.__getLibrary('u2'), [], '他人块不可见');
  }

  console.log('✓ templates-api(personal): 4 组断言通过');
})().catch((e) => { console.error(e); process.exit(1); });
