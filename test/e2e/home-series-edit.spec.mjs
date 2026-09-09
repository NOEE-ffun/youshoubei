import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, seedWorkspace, resetStore, makeAdmin } from './helpers.mjs';

/* 主页总览系列编辑模式:编辑态生命周期、行内新建/改名、删除归未分组、空系列可见性、
 * 拖拽(届跨系列改挂/系列整块重排)、权限边界(admin 他人届无手柄/选手无按钮)。 */

test.setTimeout(60_000);

function makeTournament(id, name, seriesId) {
  return {
    id, name,
    seriesId: seriesId || null,
    status: 'ongoing', startTime: null, roster: [], scores: {}, matchDecks: {},
    rules: null, schemaVersion: 2, updatedAt: 1,
    canvas: { grid: 'dot', size: { cols: 12, rows: 8 }, style: { opacity: 0.7, blur: 8 }, cards: [] }
  };
}

async function seedDefault(context) {
  await smsLogin(context, ADMIN_PHONE);
  await seedWorkspace(context, {
    series: [{ id: 'sr-a', name: '系列甲' }, { id: 'sr-empty', name: '空系列' }],
    tournaments: [
      makeTournament('t-a1', '甲一届', 'sr-a'),
      makeTournament('t-a2', '甲二届', 'sr-a'),
      makeTournament('t-free', '散届', null)
    ],
    players: [],
    activeId: 't-a1'
  });
}

async function enterEdit(page) {
  await page.goto('/');
  await page.waitForSelector('.ov-t-group');
  await page.locator('#ov-t-edit-btn').click();
  await page.waitForSelector('body.series-editing');
}

async function groupTitles(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('#ov-tournaments .ov-t-group')].map((g) => ({
      series: g.dataset.series,
      rows: [...g.querySelectorAll('.ov-t-row')].map((r) => r.dataset.id)
    }))
  );
}

async function dragMouse(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  }
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await resetStore(page.context());
});

test('进入/退出编辑态,空系列编辑态可见(视图态隐藏)', async ({ page }) => {
  const context = page.context();
  await seedDefault(context);
  await page.goto('/');
  /* 视图态:空系列被过滤 */
  await expect(page.locator('.ov-t-group')).toHaveCount(2); /* 系列甲 + 未分组 */
  await page.locator('#ov-t-edit-btn').click();
  await page.waitForSelector('body.series-editing');
  /* 编辑态:空系列出现,「+ 新建系列」与「完成」就位 */
  await expect(page.locator('.ov-t-group')).toHaveCount(3);
  await expect(page.locator('#ov-t-add-btn')).toBeVisible();
  await page.locator('#ov-t-done-btn').click();
  await page.waitForSelector('body.series-editing', { state: 'detached' });
  await expect(page.locator('.ov-t-group')).toHaveCount(2);
  await page.request.post('/api/dev/reset');
});

test('行内新建系列:输入名字 Enter 即建(渲染于未分组之前)', async ({ page }) => {
  const context = page.context();
  await seedDefault(context);
  await enterEdit(page);
  await page.locator('#ov-t-add-btn').click();
  await page.locator('.ov-t-name-input').fill('2026 冠军杯');
  await page.locator('.ov-t-name-input').press('Enter');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#ov-tournaments .ov-t-group')].some((g) => g.dataset.series !== '' && g.textContent.includes('2026 冠军杯'))
  );
  const groups = await groupTitles(page);
  expect(groups[groups.length - 1].series).toBe(''); /* 未分组恒最后 */
  const r = await page.request.get('/api/data');
  const names = (await r.json()).series.map((s) => s.name);
  expect(names).toContain('2026 冠军杯');
  await page.request.post('/api/dev/reset');
});

test('系列就地改名', async ({ page }) => {
  const context = page.context();
  await seedDefault(context);
  await enterEdit(page);
  await page.locator('[data-rename="sr-a"]').click();
  await page.locator('.ov-t-name-input').fill('系列甲改');
  await page.locator('.ov-t-name-input').press('Enter');
  await page.waitForFunction(() =>
    document.querySelector('#ov-tournaments .ov-t-name-btn')?.textContent === '系列甲改'
  );
  const r = await page.request.get('/api/data');
  expect((await r.json()).series.find((s) => s.id === 'sr-a').name).toBe('系列甲改');
  await page.request.post('/api/dev/reset');
});

test('删除系列:确认后属下届归未分组', async ({ page }) => {
  const context = page.context();
  await seedDefault(context);
  await enterEdit(page);
  await page.locator('[data-del="sr-a"]').click();
  await page.locator('#confirm-dialog [data-confirm-ok]').click();
  await page.waitForFunction(() =>
    ![...document.querySelectorAll('#ov-tournaments .ov-t-group')].some((g) => g.dataset.series === 'sr-a')
  );
  const groups = await groupTitles(page);
  const ungrouped = groups.find((g) => g.series === '');
  expect(ungrouped.rows).toEqual(expect.arrayContaining(['t-a1', 't-a2', 't-free']));
  const r = await page.request.get('/api/data');
  const ws = await r.json();
  expect(ws.series.map((s) => s.id)).not.toContain('sr-a');
  expect(ws.tournaments.filter((t) => t.seriesId === 'sr-a')).toHaveLength(0);
  await page.request.post('/api/dev/reset');
});

test('拖届跨系列改挂:甲→乙改 seriesId,拖入未分组=解除挂系', async ({ page }) => {
  const context = page.context();
  await seedDefault(context);
  /* 增补系列乙:必须 GET 现库再增补——seedWorkspace 的整库 PUT 会用 body
   * 里的 series/tournaments 全量替换,直接给单条会把系列甲一并删掉 */
  const ws = await (await context.request.get('/api/data')).json();
  ws.series.push({ id: 'sr-b', name: '系列乙' });
  ws.tournaments.push(makeTournament('t-b1', '乙一届', 'sr-b'));
  const put = await context.request.put('/api/data', { data: ws });
  expect(put.ok()).toBeTruthy();
  await enterEdit(page);
  /* 甲一届 → 系列乙(落点=组头下方,参考 list-edit 跨阶段手法) */
  const s = await page.locator('.ov-t-row[data-id="t-a1"]').boundingBox();
  const d = await page.locator('.ov-t-group[data-series="sr-b"] .ov-t-group-title').boundingBox();
  await dragMouse(page,
    { x: s.x + s.width * 0.5, y: s.y + s.height / 2 },
    { x: d.x + 80, y: d.y + d.height + 8 });
  await page.waitForFunction(() =>
    document.querySelector('.ov-t-group[data-series="sr-b"]')?.querySelector('.ov-t-row[data-id="t-a1"]'));
  let after = await (await page.request.get('/api/data')).json();
  expect(after.tournaments.find((t) => t.id === 't-a1').seriesId).toBe('sr-b');
  /* 再拖回未分组:seriesId 置 null */
  const s2 = await page.locator('.ov-t-row[data-id="t-a1"]').boundingBox();
  const d2 = await page.locator('.ov-t-group-ungrouped .ov-t-group-title').boundingBox();
  await dragMouse(page,
    { x: s2.x + s2.width * 0.5, y: s2.y + s2.height / 2 },
    { x: d2.x + 80, y: d2.y + d2.height + 8 });
  await page.waitForFunction(() =>
    document.querySelector('.ov-t-group-ungrouped')?.querySelector('.ov-t-row[data-id="t-a1"]'));
  after = await (await page.request.get('/api/data')).json();
  expect(after.tournaments.find((t) => t.id === 't-a1').seriesId).toBeNull();
  await page.request.post('/api/dev/reset');
});

test('拖系列整块重排:组序变化落库,未分组恒最后', async ({ page }) => {
  const context = page.context();
  await seedDefault(context);
  await enterEdit(page);
  /* 系列甲组头 → 空系列组中点以下(明确落在其后;贴中点会被让位动画亚像素漂移翻转) */
  const s = await page.locator('.ov-t-group[data-series="sr-a"] .ov-t-group-title').boundingBox();
  const d = await page.locator('.ov-t-group[data-series="sr-empty"]').boundingBox();
  await dragMouse(page,
    { x: s.x + 20, y: s.y + s.height / 2 },
    { x: d.x + 60, y: d.y + d.height * 0.75 });
  await page.waitForFunction(() =>
    document.querySelectorAll('#ov-tournaments .ov-t-group')[0]?.dataset.series === 'sr-empty');
  const ws = await (await page.request.get('/api/data')).json();
  expect(ws.series.map((x) => x.id)).toEqual(['sr-empty', 'sr-a']);
  const groups = await groupTitles(page);
  expect(groups[groups.length - 1].series).toBe('');
  await page.request.post('/api/dev/reset');
});

test('同组放下与原位放下均为无操作(不落盘不报错)', async ({ page }) => {
  const context = page.context();
  await seedDefault(context);
  await enterEdit(page);
  const before = await (await page.request.get('/api/data')).json();
  /* 组内末行底缘 +4px 落在两组模糊带,会被「出界就近归属」吸走——那是有意行为;
   * no-op 用例的落点必须明确在原组内:原行内下移 12px 松手(过阈值成拖拽,同组放下) */
  const s = await page.locator('.ov-t-row[data-id="t-a1"]').boundingBox();
  await dragMouse(page,
    { x: s.x + s.width * 0.5, y: s.y + s.height / 2 },
    { x: s.x + s.width * 0.5, y: s.y + s.height / 2 + 12 });
  await page.waitForTimeout(300);
  const after = await (await page.request.get('/api/data')).json();
  expect(after.tournaments.find((x) => x.id === 't-a1').seriesId).toBe('sr-a');
  expect(after.series).toHaveLength(before.series.length);
  await page.request.post('/api/dev/reset');
});

test('组尾就地产届:系列组建届挂对系列+空白画布,未分组组建届 seriesId=null', async ({ page }) => {
  const context = page.context();
  await seedDefault(context);
  await enterEdit(page);
  /* 系列甲组尾建届 */
  await page.locator('.ov-t-group[data-series="sr-a"] [data-add-tournament]').click();
  await page.locator('.ov-t-name-input').fill('丙一届');
  await page.locator('.ov-t-name-input').press('Enter');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.ov-t-group[data-series="sr-a"] .ov-t-row')].some((r) => r.textContent.includes('丙一届')));
  /* 未分组组尾建届 */
  await page.locator('.ov-t-group-ungrouped [data-add-tournament]').click();
  await page.locator('.ov-t-name-input').fill('散二届');
  await page.locator('.ov-t-name-input').press('Enter');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.ov-t-group-ungrouped .ov-t-row')].some((r) => r.textContent.includes('散二届')));
  const ws = await (await page.request.get('/api/data')).json();
  const byName = (n) => ws.tournaments.find((t) => t.name === n);
  expect(byName('丙一届').seriesId).toBe('sr-a');
  expect(byName('散二届').seriesId).toBeNull();
  expect(Array.isArray(byName('丙一届').canvas.cards) && byName('丙一届').canvas.cards).toHaveLength(0); /* 空白画布 */
  await page.request.post('/api/dev/reset');
});

test('行删除比赛:确认后届消失(确认弹窗在 common.js deleteTournament 内)', async ({ page }) => {
  const context = page.context();
  await seedDefault(context);
  await enterEdit(page);
  await page.locator('.ov-t-row[data-id="t-free"] [data-del-tournament]').click();
  await page.locator('#confirm-dialog [data-confirm-ok]').click();
  await page.waitForFunction(() =>
    !document.querySelector('.ov-t-row[data-id="t-free"]'));
  const ws = await (await page.request.get('/api/data')).json();
  expect(ws.tournaments.map((t) => t.id)).not.toContain('t-free');
  await page.request.post('/api/dev/reset');
});

test('届组内排序:同组拖拽重排落库为数组序(全局届序)', async ({ page }) => {
  const context = page.context();
  await seedDefault(context);
  await enterEdit(page);
  const before = await (await page.request.get('/api/data')).json();
  expect(before.tournaments.map((t) => t.id)).toEqual(['t-a1', 't-a2', 't-free']);
  /* 落点坑:拖拽启动即原行 display:none 让位,后续行整体上移一行——拖前测的
   * t-a2 底缘坐标在拖后已过期 47px,落在组外真空带会被「就近归属+间隙条反馈」
   * 吸进相邻组。正确落点=被拖行原槽位底部 -10px(拖后该槽位正是 t-a2 实身,
   * 处于其下半区 → 组内第 1 位)。 */
  const s = await page.locator('.ov-t-row[data-id="t-a1"]').boundingBox();
  await dragMouse(page,
    { x: s.x + s.width * 0.5, y: s.y + s.height / 2 },
    { x: s.x + s.width * 0.5, y: s.y + s.height - 10 });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.ov-t-group[data-series="sr-a"] .ov-t-row')].map((r) => r.dataset.id).join(',') === 't-a2,t-a1');
  const ws = await (await page.request.get('/api/data')).json();
  expect(ws.tournaments.map((x) => x.id)).toEqual(['t-a2', 't-a1', 't-free']); /* 组内序=数组序投影 */
  await page.request.post('/api/dev/reset');
});

test('跨组拖拽顺带落位:拖入目标组第 0 位,数组序插到该组首行之前', async ({ page }) => {
  const context = page.context();
  await seedDefault(context);
  /* 增补系列乙(GET 现库再补,整库 PUT 全量替换语义) */
  const ws = await (await context.request.get('/api/data')).json();
  ws.series.push({ id: 'sr-b', name: '系列乙' });
  ws.tournaments.push(makeTournament('t-b1', '乙一届', 'sr-b'));
  const put = await context.request.put('/api/data', { data: ws });
  expect(put.ok()).toBeTruthy();
  await enterEdit(page);
  /* t-free(未分组)拖到系列乙组头中心=组内第 0 位 */
  const s = await page.locator('.ov-t-row[data-id="t-free"]').boundingBox();
  const d = await page.locator('.ov-t-group[data-series="sr-b"] .ov-t-group-title').boundingBox();
  await dragMouse(page,
    { x: s.x + s.width * 0.5, y: s.y + s.height / 2 },
    { x: d.x + 80, y: d.y + d.height / 2 });
  await page.waitForFunction(() =>
    document.querySelector('.ov-t-group[data-series="sr-b"]')?.querySelector('.ov-t-row[data-id="t-free"]'));
  const after = await (await page.request.get('/api/data')).json();
  const ids = after.tournaments.map((x) => x.id);
  expect(ids.indexOf('t-free')).toBe(ids.indexOf('t-b1') - 1); /* t-free 紧贴乙组首行之前 */
  expect(after.tournaments.find((x) => x.id === 't-free').seriesId).toBe('sr-b');
  await page.request.post('/api/dev/reset');
});

test('admin 权限边界:他人届无手柄不可拖,他人系列不可改名,删除预判禁用,排序放行', async ({ page, context, browser }) => {
  await resetStore(context);
  const PHONE_B = '13800003333';
  const contextB = await browser.newContext();
  const userB = await makeAdmin(contextB, PHONE_B);
  expect(userB.role).toBe('admin');
  /* 种子顺序注意:主页有 60s workspace 缓存,页面只加载一次且在全部 API 种子完成之后,
   * 否则会命中旧缓存令权限预判失真 */
  await smsLogin(context, ADMIN_PHONE);
  await seedWorkspace(context, {
    series: [{ id: 'sr-a', name: '系列甲' }],
    tournaments: [makeTournament('t-super', '超管届', 'sr-a')],
    players: [], activeId: 't-super'
  });
  /* super 把超管届挂进系列乙的「预定地」:先建系列乙(super 建,归属 super)——
   * 再由 adminB 增补自己的届;最后 super 把超管届移入系列乙(守卫放行,现状语义) */
  const ws1 = await (await context.request.get('/api/data')).json();
  ws1.series.push({ id: 'sr-b', name: '系列乙', desc: '' });
  const put1 = await context.request.put('/api/data', { data: ws1 });
  expect(put1.ok()).toBeTruthy();
  const wsB = await (await contextB.request.get('/api/data')).json();
  wsB.tournaments.push(makeTournament('t-b', 'B届', 'sr-b'));
  const putB = await contextB.request.put('/api/data', { data: wsB });
  expect(putB.ok()).toBeTruthy();
  const wsS = await (await context.request.get('/api/data')).json();
  wsS.tournaments.find((t) => t.id === 't-super').seriesId = 'sr-b';
  const putS = await context.request.put('/api/data', { data: wsS });
  expect(putS.ok()).toBeTruthy();

  const pageB = await contextB.newPage();
  await pageB.goto('/');
  await pageB.locator('#ov-t-edit-btn').click();
  await pageB.waitForSelector('body.series-editing');
  /* 他人届(超管届,现在系列乙下):无 is-movable、无手柄、无行删除钮 */
  await expect(pageB.locator('.ov-t-row[data-id="t-super"]')).not.toHaveClass(/is-movable/);
  await expect(pageB.locator('.ov-t-row[data-id="t-super"] .list-handle')).toHaveCount(0);
  await expect(pageB.locator('.ov-t-row[data-id="t-super"] [data-del-tournament]')).toHaveCount(0);
  /* 自己届:可拖、可删 */
  await expect(pageB.locator('.ov-t-row[data-id="t-b"]')).toHaveClass(/is-movable/);
  await expect(pageB.locator('.ov-t-row[data-id="t-b"] [data-del-tournament]')).toHaveCount(1);
  /* 他人系列(sr-a/sr-b 均 super 建):无改名按钮、无删除按钮 */
  await expect(pageB.locator('.ov-t-group[data-series="sr-a"] [data-rename]')).toHaveCount(0);
  await expect(pageB.locator('.ov-t-group[data-series="sr-a"] [data-del]')).toHaveCount(0);
  await pageB.close();

  /* 删除预判禁用需要「自己的系列含他人届」:adminB 建系列丙,super 把超管届移入 */
  const ws2 = await (await contextB.request.get('/api/data')).json();
  ws2.series.push({ id: 'sr-c', name: '系列丙', desc: '' });
  const put2 = await contextB.request.put('/api/data', { data: ws2 });
  expect(put2.ok()).toBeTruthy();
  const ws3 = await (await context.request.get('/api/data')).json();
  ws3.tournaments.find((t) => t.id === 't-super').seriesId = 'sr-c';
  const put3 = await context.request.put('/api/data', { data: ws3 });
  expect(put3.ok()).toBeTruthy();

  const pageC = await contextB.newPage();
  await pageC.addInitScript(() => {
    /* 同 context 二次加载会命中 60s 缓存,清掉工作区缓存强制拉新 */
    for (const key of Object.keys(localStorage)) {
      if (/workspace/i.test(key)) localStorage.removeItem(key);
    }
  });
  await pageC.goto('/');
  await pageC.locator('#ov-t-edit-btn').click();
  await pageC.waitForSelector('body.series-editing');
  await expect(pageC.locator('.ov-t-group[data-series="sr-c"] [data-del]')).toBeDisabled();
  /* 排序对 admin 放行:拖系列乙组头到系列甲之上(sr-c 无届不渲染干扰:
     编辑态空系列也渲染,落点按组中点计数,丙在乙之后不影响) */
  const s = await pageC.locator('.ov-t-group[data-series="sr-b"] .ov-t-group-title').boundingBox();
  const d = await pageC.locator('.ov-t-group[data-series="sr-a"]').boundingBox();
  await dragMouse(pageC,
    { x: s.x + 20, y: s.y + s.height / 2 },
    { x: d.x + 60, y: d.y + d.height * 0.4 });
  await pageC.waitForFunction(() =>
    document.querySelectorAll('#ov-tournaments .ov-t-group')[0]?.dataset.series === 'sr-b');
  const ws = await (await contextB.request.get('/api/data')).json();
  expect(ws.series.map((x) => x.id)).toEqual(['sr-b', 'sr-a', 'sr-c']);
  await pageC.close();
  await contextB.close();
  await resetStore(context);
});

test('非管理员(选手)无编辑按钮,主页纯只读', async ({ page, context }) => {
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);
  await seedWorkspace(context, {
    series: [{ id: 'sr-a', name: '系列甲' }],
    tournaments: [makeTournament('t-a1', '甲一届', 'sr-a')],
    players: [], activeId: 't-a1'
  });
  const playerCtx = await context.browser().newContext();
  await smsLogin(playerCtx, '13800004444');
  const playerPage = await playerCtx.newPage();
  await playerPage.goto('/');
  await playerPage.waitForSelector('.ov-t-group');
  await expect(playerPage.locator('#ov-t-edit-btn')).toHaveCount(0);
  await playerPage.close();
  await playerCtx.close();
  await resetStore(context);
});
