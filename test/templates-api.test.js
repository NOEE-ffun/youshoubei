'use strict';

/* 模板 API——个人库 GET/PUT(handler 直测)。
 * storage 按 api/helpers.js createStorage 的真实注入契约 mock:
 * readJson/writeJson(对象级,同 test/codes-api.test.js memoryStorage),
 * 任务书草稿的 get/put 文本契约与仓库不符,已按实际核对改写。
 * now/appendAudit/backupJson 注入:审计(save/cover/delete + 市场 list/unlist/adopt)、
 * maskUser、撤架前备份策略、listedAt 倒序与配额计数口径在组 2 与市场组 7-11 断言。
 * 权限(HTTP 层匿名 401/越权 403)由 requireRole+session 兜底,e2e 匿名打真服务覆盖,
 * 单测不重复造会话——第 1 组留注释占位,handler 直测从第 2 组起。 */

const assert = require('node:assert/strict');
const { createHandler } = require('../api/templates.js');

function boot(nowFn) {
  const map = new Map();
  const storage = {
    readJson: async (key) => (map.has(key) ? map.get(key) : null),
    writeJson: async (key, value) => { map.set(key, value); }
  };
  const audits = [];
  const backups = [];
  let tick = 100;
  const h = createHandler(storage, {
    /* 默认可递增时钟:次序敏感断言(listedAt 倒序)需严格递增时间戳才可分辨;
     * 固定值场景(组 2 updatedAt / 组 8 adopt 时间戳)局部传 nowFn 覆盖 */
    now: nowFn || (() => ++tick),
    appendAudit: (a, d) => audits.push([a, d]),
    backupJson: (key, prefix) => { backups.push([key, prefix]); return Promise.resolve(); }
  });
  return { h, audits, backups, map };
}

/* 用户字段对齐真实契约:requireRole→currentUser 返回对象键是 id(safeUser,
 * account.js:60),uid 只在 session 载荷里——mock 照真实形状造 */
const ADMIN = { username: 'admin1', id: 'u1', role: 'admin' };
/* 手机号形态 username:验审计 detail 里 maskUser 只留末 4 位 */
const USER = { username: '13900000002', id: 'u2', role: 'player' };
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
    const { h, audits, map } = boot(() => 123); /* 固定 now:updatedAt 断言需要确定值 */
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

  /* 5) 双用户隔离:A、B 两个 admin 先后落库,各占独立块,B 的 PUT 不删 A 的 */
  {
    const { h, map } = boot();
    const A = { username: 'adminA', id: 'uA', role: 'admin' };
    const B = { username: 'adminB', id: 'uB', role: 'admin' };
    await h.__putLibrary(A, { templates: [tpl('A1', 'tpl_a1')] });
    await h.__putLibrary(B, { templates: [tpl('B1', 'tpl_b1'), tpl('B2', 'tpl_b2')] });
    await h.__putLibrary(A, { templates: [tpl('A1', 'tpl_a1'), tpl('A2', 'tpl_a2')] });
    const file = map.get('templates.json');
    assert.deepEqual(file.libraries.uA.templates.map((t) => t.name), ['A1', 'A2'], 'A 块=自己最后一次提交');
    assert.deepEqual(file.libraries.uB.templates.map((t) => t.name), ['B1', 'B2'], 'B 块不被 A 的提交覆盖');
    assert.equal((await h.__getLibrary('uA')).length, 2, 'A 回读不空(B 的 PUT 不删 A 的)');
    assert.equal((await h.__getLibrary('uB')).length, 2, 'B 回读完整');
    assert.ok(file.libraries.uA && file.libraries.uB, '两个独立块并存(非 libraries["undefined"] 合写)');
  }

  /* 6) write 抛错:错误原样上抛不吞(HTTP 层 500 由 server.js handleApi catch 兜底),
   *    且 workspace-lock 链尾吞错设计保证失败不断链——恢复后同 handler 可继续写 */
  {
    const map = new Map();
    let fail = true;
    const storage = {
      readJson: async (key) => (map.has(key) ? map.get(key) : null),
      writeJson: async (key, value) => { if (fail) throw new Error('oss down'); map.set(key, value); }
    };
    const h = createHandler(storage, { now: () => 123, appendAudit: () => {} });
    await assert.rejects(() => h.__putLibrary(ADMIN, { templates: [tpl('X')] }), /oss down/,
      'write 失败原样 reject(吞错会变假 200)');
    fail = false;
    const ok = await h.__putLibrary(ADMIN, { templates: [tpl('X')] });
    assert.ok(Array.isArray(ok.templates), '锁链未断,恢复后可写');
    assert.equal(map.get('templates.json').libraries.u1.templates.length, 1, '恢复后落库成功');
  }

  /* 7) market.list:快照独立性(上架后改库不影响在架条目)+在架 ≤10(同模板重复上架也占位) */
  {
    const { h } = boot();
    await h.__putLibrary(ADMIN, { templates: [tpl('八强赛')] });
    const listed = await h.__marketAction(ADMIN, { action: 'list', templateId: 'tpl_x' });
    assert.ok(/^mkt_/.test(listed.item.id), '在架条目发 mkt_ 前缀新 id');
    await h.__putLibrary(ADMIN, { templates: [Object.assign(tpl('八强赛'), { name: '改名了' })] });
    const mkt = await h.__marketList();
    assert.equal(mkt.market.length, 1, '在架 1 条');
    assert.equal(mkt.market[0].snapshot.name, '八强赛', '在架=上架当时快照');
    /* 真实 maskUser 只脱敏手机号形态(***+末4),非手机号原样——任务书草稿 'ad***1' 系想象契约 */
    assert.equal(mkt.market[0].authorName, 'admin1', '作者名走 maskUser(非手机号形态原样)');
    for (let i = 0; i < 9; i++) {
      /* 已 1 条,同模板再上 9 条到 10:重复上架也占在架位 */
      await h.__marketAction(ADMIN, { action: 'list', templateId: 'tpl_x' });
    }
    assert.equal((await h.__marketList()).market.length, 10, '在架满 10');
    const r = await h.__marketAction(ADMIN, { action: 'list', templateId: 'tpl_x' });
    assert.equal(r.code, 400, '同模板重复上架也占在架位,第 11 条 400');
  }

  /* 8) adopt:拷贝语义(新 id/深拷贝)/撞名 409 带冲突名/renameTo 解冲突/库满 400/撤架后 404 */
  {
    const { h } = boot(() => 123); /* 固定 now:组尾断 adopt 副本时间戳=注入值 */
    const SUPER2 = { username: '13900000003', id: 'u3', role: 'admin' }; /* 手机号形态,组 9 验 by= 脱敏 */
    await h.__putLibrary(ADMIN, { templates: [tpl('八强赛')] });
    await h.__marketAction(ADMIN, { action: 'list', templateId: 'tpl_x' });
    const mkt = await h.__marketList();
    await h.__putLibrary(SUPER2, { templates: [tpl('八强赛')] }); /* u3 已有同名 */
    let r = await h.__marketAction(SUPER2, { action: 'adopt', marketId: mkt.market[0].id });
    assert.equal(r.code, 409, '撞名 409');
    assert.ok(r.error.includes('八强赛'), '409 带冲突名');
    r = await h.__marketAction(SUPER2, { action: 'adopt', marketId: mkt.market[0].id, renameTo: '八强赛(副本)' });
    /* 成功 outcome 不带 code(仅错误带,同 __putLibrary 契约),断产物 */
    assert.ok(r.template && r.template.name === '八强赛(副本)', 'renameTo 解冲突');
    const lib = await h.__getLibrary('u3'); /* __getLibrary 返回模板数组本身(组 4 契约) */
    assert.equal(lib.length, 2, '加入后 2 条');
    const adopted = lib[1];
    assert.notEqual(adopted.id, 'tpl_x', '新条目 id 全新');
    assert.equal(adopted.name, '八强赛(副本)', 'renameTo 生效');
    /* 时间戳重打:原快照 createdAt=1(tpl 固定),副本两时间戳=注入 now,可区分 */
    assert.equal(adopted.createdAt, 123, 'adopt 副本 createdAt=注入 now(非沿用快照的 1)');
    assert.equal(adopted.updatedAt, 123, 'adopt 副本 updatedAt=注入 now');
    adopted.cards[0].x = 999; /* 改加入后的副本不动在架快照=深拷贝 */
    assert.equal((await h.__marketList()).market[0].snapshot.cards[0].x, 0, 'cards 深拷贝');
    /* 库满 400:u3 已 2 条,整库补到 50 再 adopt */
    await h.__putLibrary(SUPER2, {
      templates: [tpl('八强赛', 'tpl_x'), tpl('八强赛(副本)')]
        .concat(Array.from({ length: 48 }, (_, i) => tpl('T' + i, 'tpl_f' + i)))
    });
    r = await h.__marketAction(SUPER2, { action: 'adopt', marketId: mkt.market[0].id, renameTo: '新名字' });
    assert.equal(r.code, 400, '个人模板库满 50 再 adopt 400');
    await h.__marketAction(ADMIN, { action: 'unlist', templateId: 'tpl_x' });
    r = await h.__marketAction(SUPER2, { action: 'adopt', marketId: mkt.market[0].id, renameTo: '新名字' });
    assert.equal(r.code, 404, '已撤架');
  }

  /* 9) unlist 只能撤自己的(他人条目按 404 处理);三动作审计齐含 by=;备份仅 unlist 一次 */
  {
    const { h, audits, backups } = boot();
    const SUPER2 = { username: '13900000003', id: 'u3', role: 'admin' };
    await h.__putLibrary(ADMIN, { templates: [tpl('八强赛')] });
    await h.__marketAction(ADMIN, { action: 'list', templateId: 'tpl_x' });
    await h.__marketAction(SUPER2, { action: 'adopt', marketId: (await h.__marketList()).market[0].id });
    const r = await h.__marketAction(SUPER2, { action: 'unlist', templateId: 'tpl_x' });
    assert.equal(r.code, 404, '他人模板撤架按不存在处理');
    await h.__marketAction(ADMIN, { action: 'unlist', templateId: 'tpl_x' });
    assert.equal((await h.__marketList()).market.length, 0, '撤自己的成功');
    assert.ok(audits.some(([a, d]) => a === 'tpl.list' && d.includes('by=admin1')), 'list 审计带 by=');
    assert.ok(audits.some(([a, d]) => a === 'tpl.unlist' && d.includes('by=admin1')), 'unlist 审计带 by=');
    assert.ok(audits.some(([a, d]) => a === 'tpl.adopt' && d.includes('by=***0003')), 'adopt 审计带 by=(手机号形态走 maskUser)');
    assert.deepEqual(backups, [['templates.json', 'templates']], '备份仅 unlist 触发一次(list/adopt 不备份)');
  }

  /* 10) 倒序:三模板 A→B→C 依次上架,__marketList 按 listedAt 倒序回 [C,B,A]
   *     (默认递增时钟使三次 listedAt 严格不同——固定 now 下稳定排序保持插入序,钉不住倒序) */
  {
    const { h } = boot();
    await h.__putLibrary(ADMIN, {
      templates: [tpl('A', 'tpl_a'), tpl('B', 'tpl_b'), tpl('C', 'tpl_c')]
    });
    for (const tid of ['tpl_a', 'tpl_b', 'tpl_c']) {
      await h.__marketAction(ADMIN, { action: 'list', templateId: tid });
    }
    const mkt = await h.__marketList();
    assert.deepEqual(mkt.market.map((m) => m.snapshot.name), ['C', 'B', 'A'], 'listedAt 倒序');
    assert.ok(
      mkt.market[0].listedAt > mkt.market[1].listedAt && mkt.market[1].listedAt > mkt.market[2].listedAt,
      'listedAt 严格递减');
  }

  /* 11) 混合配额:5 个不同模板 + 同模板重复 5 次 = 10 条在架,换新模板第 11 条 400
   *     (钉住按 authorUid 全量条目计数口径,防未来误改成按 templateId 去重后放行第 11 条) */
  {
    const { h } = boot();
    const tpls = ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => tpl(n, 'tpl_' + n.toLowerCase()));
    await h.__putLibrary(ADMIN, { templates: tpls });
    for (const t of tpls.slice(0, 5)) {
      assert.ok((await h.__marketAction(ADMIN, { action: 'list', templateId: t.id })).item, '5 个不同模板各上架成功');
    }
    for (let i = 0; i < 5; i++) {
      assert.ok((await h.__marketAction(ADMIN, { action: 'list', templateId: 'tpl_a' })).item, '同模板重复上架成功且占位');
    }
    assert.equal((await h.__marketList()).market.length, 10, '混合计数恰 10 条');
    const r = await h.__marketAction(ADMIN, { action: 'list', templateId: 'tpl_f' });
    assert.equal(r.code, 400, '新模板第 11 条 400(按 authorUid 条目数,非 templateId 去重)');
  }

  console.log('✓ templates-api(market): 5 组断言通过');
  console.log('✓ templates-api(personal): 6 组断言通过');
})().catch((e) => { console.error(e); process.exit(1); });
