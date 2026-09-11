'use strict';

/* 官方文档:公共读权限矩阵/服务端剥离 adminOnly/排序口径/字段剥离、
 * super CRUD 鉴权与校验、保留字段、审计;自定义分类文字(旧键折算/长度/排序)
 * 与 kb 导入纯函数(parseKbEntry/convertWikilinks/planKbImport)。
 * 范式同 notices-api.test.js:users 种子落全局 dev-store(requireUser 走全局单例),
 * docs.json 注入内存存储;now 固定注入防时间漂移。 */

const assert = require('node:assert');
const session = require('../api/session');
const docsApi = require('../api/docs');
const devStore = require('../api/dev-store');
const { parseKbEntry, convertWikilinks, planKbImport } = require('../scripts/import-kb');

function memoryStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    readJson: async (key) => (map.has(key) ? map.get(key) : null),
    writeJson: async (key, value) => { map.set(key, value); },
    _map: map
  };
}

function mockReq(method, opts) {
  const o = opts || {};
  const chunks = o.body === undefined ? [] : [Buffer.from(o.body, 'utf8')];
  return {
    method,
    url: o.url || '/api/docs',
    headers: o.headers || {},
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true })
      };
    }
  };
}

function mockRes() {
  const captured = { status: 0, headers: {}, body: null };
  return {
    status(code) { captured.status = code; return this; },
    cacheControl() { return this; },
    setHeader(name, value) { captured.headers[name] = value; return this; },
    json(payload) { captured.body = payload; return this; },
    _captured: captured
  };
}

async function call(handler, req) {
  const res = mockRes();
  await handler(req, res);
  return res._captured;
}

(async () => {
  process.env.SESSION_SECRET = 'test-secret';

  const NOW = Date.parse('2026-09-01T12:00:00Z');
  const auditLog = [];
  const opts = { now: () => NOW, appendAudit: (action, detail) => auditLog.push(action + ' ' + detail) };

  await devStore.writeJson('users.json', [
    { id: 'u2', username: 'p', usernameLower: 'p', phone: '13900000002', passHash: null, role: 'player', playerId: 'p1', status: 'active', createdAt: 't' },
    { id: 'u3', username: 'a', usernameLower: 'a', phone: '13900000003', passHash: null, role: 'admin', playerId: null, status: 'active', createdAt: 't' },
    { id: 'u5', username: 's', usernameLower: 's', phone: '13900000005', passHash: null, role: 'super', playerId: null, status: 'active', createdAt: 't' }
  ]);

  const d = (over) => Object.assign({
    id: 'x', title: '文档', category: 'rules', body: '# 内容', adminOnly: false, sort: 0,
    createdBy: 'u5', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z'
  }, over);
  const store = memoryStorage({
    'docs.json': [
      d({ id: 'd1', title: '规则A', category: 'rules', sort: 1 }),
      d({ id: 'd2', title: '规则B', category: 'rules', sort: 1, updatedAt: '2026-08-02T00:00:00.000Z' }),
      d({ id: 'd3', title: '指南', category: 'guide', sort: 9 }),
      d({ id: 'd4', title: '内部规程', category: 'internal', adminOnly: true }),
      /* 自定义文字分类:与旧键同名文字(公告)应并入旧 notice 序,陌生文字排其后 */
      d({ id: 'd5', title: '技术文档A', category: '技术文档' }),
      d({ id: 'd6', title: '公告C', category: '公告' }),
      d({ id: 'd7', title: '运维手册', category: '运维手册' })
    ]
  });
  const pub = docsApi.createPublicHandler(store, opts);
  const adm = docsApi.createAdminHandler(store, opts);
  const ck = (uid) => 'sess=' + session.issueFor(uid, '');

  /* ---- 公共读 /api/docs ---- */
  assert.strictEqual((await call(pub, mockReq('GET'))).status, 401, '匿名 401');
  let r = await call(pub, mockReq('GET', { headers: { cookie: ck('u2') } }));
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.docs.map((x) => x.id),
    ['d2', 'd1', 'd3', 'd6', 'd5', 'd7'],
    '分类序(旧键与同名文字并组,自定义按中文 locale)→sort→updatedAt 降序,internal 剥离');
  assert.deepStrictEqual(r.body.docs.map((x) => x.category),
    ['rules', 'rules', 'guide', '公告', '技术文档', '运维手册'],
    '公共列表原样返回存储分类(旧键不折算,折算在展示层)');
  assert.deepStrictEqual(Object.keys(r.body.docs[0]).sort(),
    ['adminOnly', 'body', 'category', 'id', 'sort', 'title', 'updatedAt'], '公共字段剥离 createdBy');
  /* admin/super 可见 adminOnly 篇 */
  for (const uid of ['u3', 'u5']) {
    r = await call(pub, mockReq('GET', { headers: { cookie: ck(uid) } }));
    assert.strictEqual(r.body.docs.length, 7, uid + ' 全见 adminOnly');
  }
  /* 空存储空列表 */
  const empty = docsApi.createPublicHandler(memoryStorage({}), opts);
  r = await call(empty, mockReq('GET', { headers: { cookie: ck('u2') } }));
  assert.deepStrictEqual(r.body, { docs: [] }, '空存储返回空列表');
  assert.strictEqual((await call(pub, mockReq('DELETE', { headers: { cookie: ck('u5') } }))).status, 405, '非 GET 405');

  /* ---- 管理列表 GET /api/admin/docs ---- */
  assert.strictEqual((await call(adm, mockReq('GET', { url: '/api/admin/docs', headers: { cookie: ck('u2') } }))).status, 403, 'player 403');
  assert.strictEqual((await call(adm, mockReq('GET', { url: '/api/admin/docs', headers: { cookie: ck('u3') } }))).status, 403, 'admin 403');
  r = await call(adm, mockReq('GET', { url: '/api/admin/docs', headers: { cookie: ck('u5') } }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.docs.length, 7, 'super 全量');

  console.log('✓ docs-api 读:权限矩阵/排序/字段剥离');

  /* ---- CRUD:新建 ---- */
  r = await call(adm, mockReq('POST', {
    url: '/api/admin/docs',
    body: JSON.stringify({ title: '  新文档  ', category: 'guide', body: '## 你好' }),
    headers: { cookie: ck('u5') }
  }));
  assert.strictEqual(r.status, 200);
  assert.match(r.body.doc.id, /^d_[0-9a-f]{16}$/, 'id 形态');
  assert.strictEqual(r.body.doc.title, '新文档', 'title trim');
  assert.strictEqual(r.body.doc.adminOnly, false, 'adminOnly 缺省公开');
  assert.strictEqual(r.body.doc.sort, 0, 'sort 缺省');
  assert.strictEqual(r.body.doc.createdBy, 'u5');
  assert.strictEqual(r.body.doc.updatedAt, new Date(NOW).toISOString(), 'updatedAt 服务端时钟');
  assert.ok(auditLog.some((s) => s.startsWith('admin.docCreate')), '审计 docCreate');
  /* 自定义分类:trim 后入库;旧键入参折算为对应文字 */
  r = await call(adm, mockReq('POST', {
    url: '/api/admin/docs',
    body: JSON.stringify({ title: '自定义分类篇', category: '  玩家手册  ', body: 'x' }),
    headers: { cookie: ck('u5') }
  }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.doc.category, '玩家手册', '自定义分类 trim 入库');
  assert.strictEqual((await call(adm, mockReq('POST', {
    url: '/api/admin/docs', body: JSON.stringify({ title: 'x', category: 'rules' }), headers: { cookie: ck('u3') }
  }))).status, 403, 'admin 建 403');
  for (const [body, why] of [
    [{ category: 'rules' }, '空标题'],
    [{ title: ' ' }, '空白标题'],
    [{ title: 'x' }, '缺分类'],
    [{ title: 'x', category: '   ' }, '空白分类'],
    [{ title: 'x', category: 'x'.repeat(17) }, '分类超 16 字'],
    [{ title: 'x', category: 'rules', body: 'y'.repeat(64 * 1024 + 1) }, '超 64KB'],
    [{ title: 'x', category: 'rules', adminOnly: 'yes' }, 'adminOnly 非布尔'],
    [{ title: 'x', category: 'rules', sort: 1.5 }, 'sort 非整数']
  ]) {
    const rr = await call(adm, mockReq('POST', {
      url: '/api/admin/docs', body: JSON.stringify(body), headers: { cookie: ck('u5') }
    }));
    assert.strictEqual(rr.status, 400, '拒判:' + why);
  }

  /* ---- 编辑:id/createdBy/createdAt 保留,updatedAt 刷新 ---- */
  r = await call(adm, mockReq('POST', {
    url: '/api/admin/docs/d1/update',
    body: JSON.stringify({ title: '改名', category: 'rules', adminOnly: true, sort: -3 }),
    headers: { cookie: ck('u5') }
  }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.doc.category, '赛事规则', '旧键入参折算为文字入库');
  assert.strictEqual(r.body.doc.createdBy, 'u5', 'createdBy 保留');
  assert.strictEqual(r.body.doc.createdAt, '2026-08-01T00:00:00.000Z', 'createdAt 保留');
  assert.strictEqual(store._map.get('docs.json').find((x) => x.id === 'd1').adminOnly, true, 'adminOnly 落盘');
  assert.ok(auditLog.some((s) => s.startsWith('admin.docUpdate')), '审计 docUpdate');
  assert.strictEqual((await call(adm, mockReq('POST', {
    url: '/api/admin/docs/d_none/update', body: JSON.stringify({ title: 'x', category: 'rules' }), headers: { cookie: ck('u5') }
  }))).status, 404, '改不存在 404');

  /* ---- 删除 ---- */
  assert.strictEqual((await call(adm, mockReq('POST', {
    url: '/api/admin/docs/d3/delete', headers: { cookie: ck('u5') }
  }))).status, 200);
  assert.ok(!store._map.get('docs.json').some((x) => x.id === 'd3'), '已删除');
  assert.ok(auditLog.some((s) => s.startsWith('admin.docDelete')), '审计 docDelete');
  assert.strictEqual((await call(adm, mockReq('POST', {
    url: '/api/admin/docs/d3/delete', headers: { cookie: ck('u5') }
  }))).status, 404, '重复删除 404');
  assert.strictEqual((await call(adm, mockReq('POST', {
    url: '/api/admin/docs/d1/what', body: '{}', headers: { cookie: ck('u5') }
  }))).status, 404, '未知子路径 404');

  console.log('✓ docs-api 写:CRUD/校验/保留字段/审计');

  /* ---- kb 导入纯函数(scripts/import-kb.js) ---- */
  assert.deepStrictEqual(
    { title: parseKbEntry('10-架构总览.md').title, sort: parseKbEntry('10-架构总览.md').sort },
    { title: '架构总览', sort: 10 }, '文件名数字前缀→sort/剥前缀→标题');
  assert.strictEqual(parseKbEntry('README.md').sort, 0, '无前缀文件 sort=0');
  const resolve = (t) => (t === '10-架构总览' ? { id: 'd_x', title: '架构总览' } : null);
  const conv = convertWikilinks(
    '看 [[10-架构总览]] 与 [[10-架构总览|见此]];代码不动 `cards:[[id,名]]`\n' +
    '```\n[[10-架构总览]]\n```\n外指 [[../deploy/README]]', resolve);
  assert.ok(conv.includes('[架构总览](#doc-d_x)'), '维基链转站内锚链');
  assert.ok(conv.includes('[见此](#doc-d_x)'), '管道写法用显示名');
  assert.ok(conv.includes('`cards:[[id,名]]`'), '行内代码内的双方括号不动');
  assert.ok(conv.includes('```\n[[10-架构总览]]\n```'), '围栏代码块内的维基链不动');
  assert.ok(conv.includes('外指 ../deploy/README'), '解析不到的目标退化为纯文字');
  const kbEntries = [
    { stem: '10-架构总览', title: '架构总览', sort: 10, body: '# a\n见 [[10-架构总览]] 与 [[99-不存在]]' },
    { stem: '20-数据模型', title: '数据模型', sort: 20, body: '# b' }
  ];
  const once = planKbImport([], kbEntries, { now: () => 0 });
  assert.strictEqual(once.created, 2, '空库两篇全新建');
  assert.ok(once.docs.every((x) => x.category === '技术文档' && x.adminOnly === false), '默认技术文档/全员可读');
  const archId = once.docs.find((x) => x.title === '架构总览').id;
  assert.ok(once.docs.find((x) => x.title === '架构总览').body
    .includes('[架构总览](#doc-' + archId + ')'), '维链在导入内转换为最终锚点(非 undefined)');
  assert.ok(once.docs.find((x) => x.title === '架构总览').body
    .includes('与 99-不存在'), '解析不到的目标退化为纯文字');
  const twice = planKbImport(once.docs, kbEntries, { now: () => 1 });
  assert.ok(!twice.changed, '重复运行零变更(幂等)');
  const edited = [{ stem: '10-架构总览', title: '架构总览', sort: 10, body: '# a 改' }];
  const thrice = planKbImport(once.docs, edited, { now: () => 2 });
  assert.strictEqual(thrice.updated, 1, '同题原位更新');
  const hit = thrice.docs.find((x) => x.title === '架构总览');
  assert.strictEqual(hit.body, '# a 改', '更新写新正文');
  assert.strictEqual(hit.id, archId, '更新沿用既有 id(锚点稳定)');
  assert.strictEqual(hit.createdAt, once.docs.find((x) => x.title === '架构总览').createdAt, 'createdAt 保留');
  console.log('✓ import-kb 纯函数:命名解析/维链转换(代码段豁免)/幂等导入');
  delete process.env.SESSION_SECRET;
  console.log('✓ docs-api: 官方文档读写全链通过');
})().catch((e) => { console.error(e); process.exit(1); });
