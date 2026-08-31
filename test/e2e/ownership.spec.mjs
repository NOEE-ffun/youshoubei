import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, seedWorkspace, resetStore, makeAdmin } from './helpers.mjs';

/* 二期归属隔离 E2E:
 * 1) admin 只能动自己 createdBy 的系列/届——改他人届 403(带资源名)、删 403;
 *    赛程页他人届编辑入口隐藏(选手视角),自己届可见。
 * 2) 主页比赛总览按系列分组(未分组归末尾),赛程页头下拉 optgroup 同口径。
 * 种子注意:createdBy 由服务端盖章(新资源盖请求者 id、已有资源回填存档值),
 * super 无法替 userB 代盖——userB(admin)以自己的 PUT 增补 tB/sB,归属自然成立。 */

test.setTimeout(60_000);

const PHONE_B = '13800002222';

/* 种子届:dot 坐标 + schemaVersion 2 + roster [],页面加载零迁移零回写
 * (非 owner 管理员的自动回写若改到他人届会被守卫 403,种子先排除该噪音)。 */
function makeTournament(id, name, seriesId) {
  return {
    id,
    name,
    seriesId: seriesId || null,
    status: 'ongoing',
    startTime: null,
    roster: [],
    scores: {},
    matchDecks: {},
    rules: null,
    schemaVersion: 2,
    updatedAt: 1,
    canvas: {
      grid: 'dot',
      size: { cols: 12, rows: 8 },
      style: { opacity: 0.7, blur: 8 },
      cards: [
        {
          id: id + '-c1', label: '测试场 1', phase: '', format: 'BO3', x: 60, y: 40,
          slots: [{ type: 'empty' }, { type: 'empty' }], exitRanks: {}, deckCount: null,
          color: null, classLinks: { a: [], b: [] }
        },
        {
          id: id + '-c2', label: '测试场 2', phase: '', format: 'BO3', x: 60, y: 160,
          slots: [{ type: 'empty' }, { type: 'empty' }], exitRanks: {}, deckCount: null,
          color: null, classLinks: { a: [], b: [] }
        }
      ]
    }
  };
}

async function getData(context) {
  const r = await context.request.get('/api/data');
  expect(r.ok(), 'GET /api/data').toBeTruthy();
  return r.json();
}

test('归属隔离:admin 只能写自己建的届,他人届改/删 403 且编辑入口隐藏', async ({ page, context, browser }) => {
  await resetStore(context);

  /* super 引导:userB 兑管理员码升 admin,记其真实用户 id */
  await smsLogin(context, ADMIN_PHONE);
  const me = await (await context.request.get('/api/me')).json();
  const superId = me.user.id;
  const contextB = await browser.newContext();
  const userB = await makeAdmin(contextB, PHONE_B);
  expect(userB.role).toBe('admin');

  /* super 先种自己的系列+届(createdBy 由服务端盖成 superId) */
  const tA = makeTournament('own-a', 'A届-超管建', 'sr-a');
  await seedWorkspace(context, {
    series: [{ id: 'sr-a', name: '系列甲', description: null }],
    tournaments: [tA],
    players: [],
    activeId: tA.id
  });
  const seeded = await getData(contextB);
  expect(seeded.tournaments.find((t) => t.id === tA.id).createdBy).toBe(superId);

  /* adminB 在 GET 回读的基础上增补自己的系列+届(新增盖 userB.id,原资源不动) */
  const tB = makeTournament('own-b', 'B届-管理员建', 'sr-b');
  seeded.series.push({ id: 'sr-b', name: '系列乙', description: null });
  seeded.tournaments.push(tB);
  const addB = await contextB.request.put('/api/data', { data: seeded });
  expect(addB.status(), 'adminB 增补自己的届').toBe(200);

  const after = await getData(contextB);
  expect(after.tournaments.find((t) => t.id === tA.id).createdBy).toBe(superId);
  expect(after.tournaments.find((t) => t.id === tB.id).createdBy).toBe(userB.id);

  /* 改自己的届 → 200 */
  after.tournaments.find((t) => t.id === tB.id).name = 'B届-已改名';
  const putOwn = await contextB.request.put('/api/data', { data: after });
  expect(putOwn.status(), 'adminB 改自己的届').toBe(200);

  /* 改他人届 → 403 且错误带资源名 */
  const tamper = await getData(contextB);
  tamper.tournaments.find((t) => t.id === tA.id).name = '篡改A届';
  const putOthers = await contextB.request.put('/api/data', { data: tamper });
  expect(putOthers.status()).toBe(403);
  expect((await putOthers.json()).error).toContain('无权修改届:A届-超管建');

  /* 删他人届(提交不含该届)→ 403 */
  const drop = await getData(contextB);
  drop.tournaments = drop.tournaments.filter((t) => t.id !== tA.id);
  const delOthers = await contextB.request.put('/api/data', { data: drop });
  expect(delOthers.status()).toBe(403);
  expect((await delOthers.json()).error).toContain('无权删除届:A届-超管建');

  /* 浏览器视角:他人届(tA 为 activeId)编辑入口隐藏;切到自己届恢复 */
  const pageB = await contextB.newPage();
  await pageB.goto('/schedule.html');
  await expect(pageB.locator('.header-title')).toHaveText('A届-超管建');
  await expect(pageB.locator('#header-edit-btn')).toBeHidden();
  await pageB.locator('#tournament-switch').selectOption(tB.id);
  await expect(pageB.locator('.header-title')).toHaveText('B届-已改名');
  await expect(pageB.locator('#header-edit-btn')).toBeVisible();

  await pageB.close();
  await contextB.close();
  await resetStore(context);
});

test('主页分组:总览按系列小节分组,未分组届归末尾,页头下拉 optgroup 同口径', async ({ page, context }) => {
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);
  await seedWorkspace(context, {
    series: [
      { id: 'sr-1', name: '春季赛', description: null },
      { id: 'sr-2', name: '秋季赛', description: null }
    ],
    tournaments: [
      makeTournament('grp-1', '春季第一届', 'sr-1'),
      makeTournament('grp-2', '秋季第一届', 'sr-2'),
      makeTournament('grp-3', '无系列散届', null)
    ],
    players: [],
    activeId: 'grp-1'
  });

  /* 主页总览:两系列小节各一届 + 末尾「未分组」小节一届 */
  await page.goto('/index.html');
  const groups = page.locator('#ov-tournaments .ov-t-group');
  await expect(groups).toHaveCount(3);
  await expect(groups.nth(0).locator('.ov-t-group-title')).toContainText('春季赛');
  await expect(groups.nth(0).locator('.ov-t-group-count')).toHaveText('1 届');
  await expect(groups.nth(0).locator('.ov-t-row')).toHaveCount(1);
  await expect(groups.nth(1).locator('.ov-t-group-title')).toContainText('秋季赛');
  await expect(groups.nth(1).locator('.ov-t-row')).toHaveCount(1);
  await expect(groups.nth(2).locator('.ov-t-group-title')).toContainText('未分组');
  await expect(groups.nth(2).locator('.ov-t-row')).toHaveCount(1);
  await expect(page.locator('#ov-tournaments .ov-t-row')).toHaveCount(3);

  /* 赛程页头切换下拉:optgroup 按系列分组(未分组最后)。
   * option 无独立盒模型,等待用 attached 而非 visible */
  await page.goto('/schedule.html');
  await page.waitForSelector('#tournament-switch option', { state: 'attached' });
  const optgroups = page.locator('#tournament-switch optgroup');
  await expect(optgroups).toHaveCount(3);
  await expect(optgroups.nth(0)).toHaveAttribute('label', '春季赛');
  await expect(optgroups.nth(1)).toHaveAttribute('label', '秋季赛');
  await expect(optgroups.nth(2)).toHaveAttribute('label', '未分组');
  await expect(page.locator('#tournament-switch option')).toHaveCount(3);

  await resetStore(context);
});
