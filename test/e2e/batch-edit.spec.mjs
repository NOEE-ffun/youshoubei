import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, resetStore, seedWorkspace } from './helpers.mjs';

/* 批量编辑端到端(Task 7):画布多选(框选/Shift 点选)≥2 张 → 抽屉切批量表单
 * (四区块勾选/模板预览/应用到 N 张)→ 应用一步落盘 → Ctrl+Z(Cmd+Z)整批一步还原;
 * 混合选中(比赛卡+roll 池)赛制仅比赛卡;名次清除与非整数禁钮;禁卡表替换与
 * 空勾选解绑;列表组级「编辑本组」入口。
 * 自举/隔离纪律同 canvas-edit-panel/roll-pool:PUT /api/data 造数、API 短信登录
 * (会话 cookie 进 context 即页面登录)、结尾 /api/dev/reset。
 * 断言注意:hasText 不匹配 input value,输入框一律 toHaveValue/属性断言。 */

test.setTimeout(60_000);

test.beforeEach(async ({ page }) => {
  const context = page.context();
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);
});

/* ---------- 种子与公共工具 ---------- */

const PLAYERS = ['甲', '乙', '丙', '丁'].map((n, i) => ({
  id: 'pz' + (i + 1), name: '选手' + n, createdAt: 1, updatedAt: 1
}));

function matchCard(id, label, x, over) {
  return Object.assign({
    id, label, phase: '胜者组', format: 'BO3', x, y: 4,
    slots: [{ type: 'player', playerId: 'pz1' }, { type: 'player', playerId: 'pz2' }],
    exitRanks: { winner: 1, loser: 2 }
  }, over || {});
}

/* roll 池卡与 roll-pool.spec 同构:manual 模式 + 4 空池位 + 2+2 口 */
function poolCard(id, label, x) {
  return {
    kind: 'rollPool', id, label, phase: '', x, y: 14,
    w: 10, h: 7, ports: { lr: 2, tb: 2 }, mode: 'manual', seed: 'sdet1',
    slots: [{ type: 'empty' }, { type: 'empty' }, { type: 'empty' }, { type: 'empty' }]
  };
}

function workspace(cards, banLists) {
  return {
    activeId: 'tbatch',
    players: PLAYERS,
    tournaments: [{
      id: 'tbatch', name: '批量编辑端到端届', status: 'ongoing', createdAt: 1, updatedAt: 1,
      roster: PLAYERS.map((p) => p.id),
      /* grid:'dot' 必须显式给:缺省会被 migrateCanvasToDot 当旧像素坐标换算(x*320/28)把布局拉飞 */
      canvas: { grid: 'dot', cards },
      scores: {},
      banLists: banLists || []
    }],
    series: []
  };
}

/* 几何交互按 100% 原生像素:钉住记忆缩放(key 同 canvas-editor.js LS_ZOOM);
 * 种子画布小,100% 下全部卡片可见可命中 */
async function enterEdit(page) {
  await page.addInitScript(() =>
    localStorage.setItem('ts:canvasZoom', JSON.stringify({ scale: 1, user: true }))
  );
  await page.goto('/schedule.html');
  await page.waitForSelector('.canvas-card');
  await page.locator('#header-edit-btn').click();
  await page.waitForSelector('.canvas-board.editing');
}

const card = (page, id) => page.locator('.canvas-card[data-match="' + id + '"]');

/* 框选一行:从首卡中点上方 12px(卡顶上方的画布空白,避开 12px 连接点命中区)
 * 拖到末卡右缘、卡顶下方 8px,矩形与整行卡交叉即命中;roll 池在另一行(y=16)不进矩形 */
async function marqueeRow(page, firstId, lastId) {
  const a = await card(page, firstId).boundingBox();
  const b = await card(page, lastId).boundingBox();
  expect(a && b, '卡片须在视口内').toBeTruthy();
  await page.mouse.move(a.x + a.width * 0.5, a.y - 12);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 8, a.y - 2, { steps: 5 });
  await page.mouse.move(b.x + b.width - 8, a.y + 8, { steps: 3 });
  await page.mouse.up();
}

/* Shift 点选:首卡普通点选(单卡抽屉),余卡 Shift 加选成多选 */
async function shiftSelect(page, ids) {
  await card(page, ids[0]).locator('.match-title').click();
  for (let i = 1; i < ids.length; i += 1) {
    await card(page, ids[i]).locator('.match-title').click({ modifiers: ['Shift'] });
  }
  await expect(page.locator('#card-panel .bf-apply-btn')).toBeVisible();
}

/* 画布空白点:scroll 视口左下角(与 canvas-edit-panel.spec 同法),清空多选收抽屉 */
async function clickCanvasBlank(page) {
  const pt = await page.evaluate(() => {
    const r = document.getElementById('canvas-scroll').getBoundingClientRect();
    return { x: Math.round(r.left + 6), y: Math.round(r.top + r.height - 6) };
  });
  await page.mouse.click(pt.x, pt.y);
}

async function apiCards(page) {
  const r = await page.request.get('/api/data');
  expect(r.ok(), 'GET /api/data').toBeTruthy();
  return (await r.json()).tournaments[0].canvas.cards;
}

async function apiCard(page, id) {
  return (await apiCards(page)).find((c) => c.id === id);
}

/* ---------- 用例 ---------- */

/* a) 框选 3 张 → 四区块一次应用(阶段/赛制+名次+禁卡表+标题模板)→ DOM 与落盘双断言
 * → Cmd+Z 一步整批还原(四字段各回种子值) */
test('框选多选:四区块批量应用一次生效,Cmd+Z 一步整批还原', async ({ page }) => {
  await seedWorkspace(page.context(), workspace([
    matchCard('k1', '首战', 0, { banListIds: ['bl0'] }),
    matchCard('k2', '次战', 12),
    matchCard('k3', '决战', 24)
  ], [
    { id: 'bl0', name: '旧表', cards: [[701, '旧禁卡', 2, 1, 0, 2]] },
    { id: 'bl1', name: '新表', cards: [[501, '终焉之炎', 8, 4, 0, 2], [502, '苍蓝少女', 3, 3, 1, 0]] }
  ]));

  await enterEdit(page);
  await marqueeRow(page, 'k1', 'k3');
  const panel = page.locator('#card-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('#card-panel-label')).toHaveText('已选 3 张');
  await expect(panel.locator('.bf-apply-btn')).toHaveText('应用到 3 张');
  await expect(panel.locator('.bf-apply-btn')).toBeDisabled(); // 零勾选不可应用

  // 四区块全勾:阶段/赛制 + 出口名次(败者留空=清除) + 禁卡表(替换) + 标题模板
  await panel.locator('.bf-apply-phase-format').check();
  await panel.locator('.bf-phase').fill('败者组');
  await panel.locator('.bf-format').fill('BO5');
  await panel.locator('.bf-apply-rank').check();
  await panel.locator('.bf-rank-winner').fill('3');
  await panel.locator('.bf-rank-loser').fill('');
  await panel.locator('.bf-apply-banlist').check();
  await panel.locator('.bf-banlist-check[value="bl1"]').check();
  await panel.locator('.bf-apply-title').check();
  await panel.locator('.bf-title').fill('批-{i}');
  await expect(panel.locator('.bf-title-preview')).toContainText('批-1');
  await expect(panel.locator('.bf-title-preview')).toContainText('批-3');
  await expect(panel.locator('.bf-apply-btn')).toBeEnabled();
  await panel.locator('.bf-apply-btn').click();

  // 卡 DOM:{i} 按画布数组序编号,阶段/赛制同步刷新
  await expect(card(page, 'k1').locator('.match-title')).toHaveText('批-1');
  await expect(card(page, 'k2').locator('.match-title')).toHaveText('批-2');
  await expect(card(page, 'k3').locator('.match-title')).toHaveText('批-3');
  for (const id of ['k1', 'k2', 'k3']) {
    await expect(card(page, id).locator('.match-phase')).toHaveText('败者组');
    await expect(card(page, id).locator('.match-format')).toHaveText('BO5');
  }
  // 落盘双断言:名次落盘(败者空=清除为 null)、禁卡表整批替换(k1 由 bl0 换绑 bl1)
  await expect.poll(async () => {
    const c = await apiCard(page, 'k1');
    return [c.label, c.phase, c.format, JSON.stringify(c.exitRanks), JSON.stringify(c.banListIds)].join('~');
  }).toBe('批-1~败者组~BO5~{"winner":3,"loser":null}~["bl1"]');
  await expect.poll(async () => {
    const c = await apiCard(page, 'k3');
    return [c.label, JSON.stringify(c.exitRanks), JSON.stringify(c.banListIds)].join('~');
  }).toBe('批-3~{"winner":3,"loser":null}~["bl1"]');

  // 一步撤销:整批四字段全部回到种子值
  await page.keyboard.press('Meta+z');
  await expect(card(page, 'k1').locator('.match-title')).toHaveText('首战');
  await expect(card(page, 'k3').locator('.match-format')).toHaveText('BO3');
  await expect.poll(async () => {
    const c = await apiCard(page, 'k1');
    return [c.label, c.phase, c.format, JSON.stringify(c.exitRanks), JSON.stringify(c.banListIds)].join('~');
  }).toBe('首战~胜者组~BO3~{"winner":1,"loser":2}~["bl0"]');
  await expect.poll(async () => {
    const c = await apiCard(page, 'k3');
    return JSON.stringify([c.label, c.banListIds === undefined]);
  }).toBe('["决战",true]'); // k3 种子无绑定,撤销一并还原为未绑定
  await page.request.post('/api/dev/reset');
});

/* b) {i}{old} 标题模板:实时预览首末两张 → 应用后按画布数组序重编号(旧题入 {old})
 * → Cmd+Z 标题还原 */
test('标题模板 {i}{old}:预览实时刷新,应用后按序编号,撤销还原', async ({ page }) => {
  await seedWorkspace(page.context(), workspace([
    matchCard('k1', '旧题一', 0),
    matchCard('k2', '旧题二', 12),
    matchCard('k3', '旧题三', 24)
  ]));

  await enterEdit(page);
  await shiftSelect(page, ['k1', 'k2', 'k3']);
  const panel = page.locator('#card-panel');
  await expect(panel.locator('.bf-apply-btn')).toHaveText('应用到 3 张');

  await panel.locator('.bf-apply-title').check();
  await panel.locator('.bf-title').fill('LB-{i}({old})');
  // hasText 不匹配 input value:模板输入用 toHaveValue 断言
  await expect(panel.locator('.bf-title')).toHaveValue('LB-{i}({old})');
  // 实时预览:首 … 末({i} 从 1 编号,{old} 取各自原标题)
  await expect(panel.locator('.bf-title-preview')).toContainText('LB-1(旧题一)');
  await expect(panel.locator('.bf-title-preview')).toContainText('LB-3(旧题三)');

  await panel.locator('.bf-apply-btn').click();
  await expect(card(page, 'k1').locator('.match-title')).toHaveText('LB-1(旧题一)');
  await expect(card(page, 'k2').locator('.match-title')).toHaveText('LB-2(旧题二)');
  await expect(card(page, 'k3').locator('.match-title')).toHaveText('LB-3(旧题三)');
  await expect.poll(async () =>
    (await apiCards(page)).map((c) => c.label).join('|')
  ).toBe('LB-1(旧题一)|LB-2(旧题二)|LB-3(旧题三)');

  await page.keyboard.press('Meta+z');
  await expect(card(page, 'k2').locator('.match-title')).toHaveText('旧题二');
  await expect.poll(async () =>
    (await apiCards(page)).map((c) => c.label).join('|')
  ).toBe('旧题一|旧题二|旧题三');
  await page.request.post('/api/dev/reset');
});

/* c) 混合选中(2 比赛 + 1 roll 池):阶段全变;赛制仅比赛卡(池无 format 字段、
 * 徽标仍是口数)→ Cmd+Z 还原 */
test('混合选中:阶段全变,赛制仅比赛卡生效 roll 池跳过', async ({ page }) => {
  await seedWorkspace(page.context(), workspace([
    matchCard('k1', '甲战', 0),
    matchCard('k2', '乙战', 12),
    poolCard('P1', 'Roll 池甲', 0)
  ]));

  await enterEdit(page);
  await shiftSelect(page, ['k1', 'k2', 'P1']);
  const panel = page.locator('#card-panel');
  await expect(panel.locator('#card-panel-label')).toHaveText('已选 3 张');
  await expect(panel.locator('.bf-apply-btn')).toHaveText('应用到 3 张');
  // 混合集提示:赛制适用面收窄
  await expect(panel.locator('.bf-format-scope')).toHaveText('赛制仅对 2 张比赛卡生效(roll 池跳过)');

  await panel.locator('.bf-apply-phase-format').check();
  await panel.locator('.bf-phase').fill('小组赛');
  await panel.locator('.bf-format').fill('BO7');
  await panel.locator('.bf-apply-btn').click();

  // DOM:三张阶段全变;赛制仅比赛卡,roll 池徽标仍是口数
  for (const id of ['k1', 'k2', 'P1']) {
    await expect(card(page, id).locator('.match-phase')).toHaveText('小组赛');
  }
  await expect(card(page, 'k1').locator('.match-format')).toHaveText('BO7');
  await expect(card(page, 'k2').locator('.match-format')).toHaveText('BO7');
  await expect(card(page, 'P1').locator('.match-format')).toHaveText('2+2 口');
  // 落盘:池卡无 format 字段(不物化默认值)
  await expect.poll(async () => {
    const m = await apiCard(page, 'k1');
    const p = await apiCard(page, 'P1');
    return [m.phase, m.format, p.phase, String(p.format)].join('~');
  }).toBe('小组赛~BO7~小组赛~undefined');

  await page.keyboard.press('Meta+z');
  await expect(card(page, 'k1').locator('.match-phase')).toHaveText('胜者组');
  await expect(card(page, 'P1').locator('.match-phase')).toHaveCount(0); // 池阶段回空不再渲染
  await expect.poll(async () => {
    const m = await apiCard(page, 'k1');
    const p = await apiCard(page, 'P1');
    return [m.phase, m.format, p.phase].join('~');
  }).toBe('胜者组~BO3~');
  await page.request.post('/api/dev/reset');
});

/* d) 出口名次:胜者改 3 / 败者留空=清除(null)落盘 → Cmd+Z 还原;
 * 非整数(1.5)或含小数尾数时应用钮禁用,修回整数即恢复 */
test('出口名次:空=清除落盘 null,非整数禁用应用钮', async ({ page }) => {
  await seedWorkspace(page.context(), workspace([
    matchCard('k1', '名次甲', 0),
    matchCard('k2', '名次乙', 12)
  ]));

  await enterEdit(page);
  await shiftSelect(page, ['k1', 'k2']);
  const panel = page.locator('#card-panel');
  await panel.locator('.bf-apply-rank').check();
  await panel.locator('.bf-rank-winner').fill('3');
  await panel.locator('.bf-rank-loser').fill(''); // 留空 = 清除
  await expect(panel.locator('.bf-apply-btn')).toBeEnabled();
  await panel.locator('.bf-apply-btn').click();

  await expect.poll(async () =>
    JSON.stringify((await apiCard(page, 'k2')).exitRanks)
  ).toBe('{"winner":3,"loser":null}');
  // 单卡抽屉回显:先清多选再点开 k1,名次输入框为 3 / 空(输入框断言走 value)
  await clickCanvasBlank(page);
  await expect(page.locator('#card-panel')).toBeHidden();
  await card(page, 'k1').locator('.match-title').click();
  await expect(page.locator('#card-panel .cf-rank-winner')).toHaveValue('3');
  await expect(page.locator('#card-panel .cf-rank-loser')).toHaveValue('');

  await page.keyboard.press('Meta+z');
  await expect.poll(async () =>
    JSON.stringify((await apiCard(page, 'k1')).exitRanks)
  ).toBe('{"winner":1,"loser":2}');

  // 非整数守卫:撤销后选择已清,重新多选;1.5 / 2.5 均禁钮,修回整数即解禁
  await shiftSelect(page, ['k1', 'k2']);
  await panel.locator('.bf-apply-rank').check();
  await panel.locator('.bf-rank-winner').fill('1.5');
  await expect(panel.locator('.bf-apply-btn')).toBeDisabled();
  await panel.locator('.bf-rank-winner').fill('');
  await panel.locator('.bf-rank-loser').fill('2.5');
  await expect(panel.locator('.bf-apply-btn')).toBeDisabled();
  await panel.locator('.bf-rank-loser').fill('');
  await panel.locator('.bf-rank-winner').fill('3');
  await expect(panel.locator('.bf-apply-btn')).toBeEnabled();
  await page.request.post('/api/dev/reset');
});

/* e) 禁卡表:勾表替换现有绑定(整批统一)→ 勾选集清空=解绑(delete 字段)
 * → Cmd+Z 回到「替换后」上一步 */
test('禁卡表:替换现有绑定,空勾选集解绑,撤销还原', async ({ page }) => {
  await seedWorkspace(page.context(), workspace([
    matchCard('k1', '禁表甲', 0, { banListIds: ['bl0'] }),
    matchCard('k2', '禁表乙', 12)
  ], [
    { id: 'bl0', name: '旧表', cards: [[701, '旧禁卡', 2, 1, 0, 2]] },
    { id: 'bl1', name: '新表', cards: [[501, '终焉之炎', 8, 4, 0, 2], [502, '苍蓝少女', 3, 3, 1, 0]] }
  ]));

  await enterEdit(page);
  await shiftSelect(page, ['k1', 'k2']);
  const panel = page.locator('#card-panel');
  await panel.locator('.bf-apply-banlist').check();
  await panel.locator('.bf-banlist-check[value="bl1"]').check();
  await panel.locator('.bf-apply-btn').click();

  // 替换:k1 由 bl0 换绑 bl1,k2 新绑 bl1
  await expect.poll(async () =>
    (await apiCards(page)).map((c) => JSON.stringify(c.banListIds)).join('|')
  ).toBe('["bl1"]|["bl1"]');

  // 同一选中集二次应用:勾选集清空 = 解绑(delete,不残留空数组)
  await panel.locator('.bf-banlist-check[value="bl1"]').uncheck();
  await panel.locator('.bf-apply-btn').click();
  await expect.poll(async () =>
    (await apiCards(page)).map((c) => String(c.banListIds)).join('|')
  ).toBe('undefined|undefined');

  // 一步撤销:回到上一历史步(替换后),两卡均 ['bl1']
  await page.keyboard.press('Meta+z');
  await expect.poll(async () =>
    (await apiCards(page)).map((c) => JSON.stringify(c.banListIds)).join('|')
  ).toBe('["bl1"]|["bl1"]');
  await page.request.post('/api/dev/reset');
});

/* f) 列表组级入口:编辑态组头「编辑本组」→ 选中集=组内全部卡 → 抽屉批量形态
 * (应用到 N 张)→ 应用生效 → Cmd+Z 还原 */
test('列表组级入口:编辑本组选中整组,批量应用后撤销还原', async ({ page }) => {
  await seedWorkspace(page.context(), workspace([
    matchCard('k1', '组内一', 0),
    matchCard('k2', '组内二', 12),
    matchCard('k3', '组内三', 24),
    matchCard('k4', '败者首战', 0, { phase: '败者组' })
  ]));

  await page.addInitScript(() => sessionStorage.setItem('ts:preferCanvas', '0'));
  await page.goto('/schedule.html');
  await page.waitForSelector('#list-body .list-row');
  await page.locator('#header-edit-btn').click();
  await page.waitForSelector('body.list-editing');

  await page.locator('.list-group-edit[data-edit-group="胜者组"]').click();
  const panel = page.locator('#card-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('#card-panel-label')).toHaveText('已选 3 张'); // 选中集=组内卡
  await expect(panel.locator('.bf-apply-btn')).toHaveText('应用到 3 张');

  await panel.locator('.bf-apply-title').check();
  await panel.locator('.bf-title').fill('组-{i}');
  await panel.locator('.bf-apply-btn').click();

  await expect(page.locator('.list-row[data-match="k1"] .list-title')).toHaveText('组-1');
  await expect(page.locator('.list-row[data-match="k2"] .list-title')).toHaveText('组-2');
  await expect(page.locator('.list-row[data-match="k3"] .list-title')).toHaveText('组-3');
  await expect(page.locator('.list-row[data-match="k4"] .list-title')).toHaveText('败者首战'); // 组外不动
  await expect.poll(async () =>
    (await apiCards(page)).map((c) => c.label).join('|')
  ).toBe('组-1|组-2|组-3|败者首战');

  await page.keyboard.press('Meta+z');
  await expect(page.locator('.list-row[data-match="k2"] .list-title')).toHaveText('组内二');
  await expect.poll(async () =>
    (await apiCards(page)).map((c) => c.label).join('|')
  ).toBe('组内一|组内二|组内三|败者首战');
  await page.request.post('/api/dev/reset');
});
