import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, resetStore, seedWorkspace } from './helpers.mjs';

/* roll 池端到端(Task 11):工具栏建池默认形状 → 表单改形状/口数落盘 →
 * 比赛卡拖口连池(落池口追加池位,上游选手沿连线入池)→ 池口连比赛卡
 * A/B 位 + 手动 Roll 下游显示池发选手 → 自动模式 reload 分配确定 →
 * 口数缩减悬空守卫(notify 提示且口数不变)。
 * 自举/隔离纪律同 canvas-edit-panel/canvas-edges:PUT /api/data 造数、
 * API 短信登录(会话 cookie 进 context 即页面登录)、结尾 /api/dev/reset。 */

test.setTimeout(60_000);

test.beforeEach(async ({ page }) => {
  const context = page.context();
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);
});

/* 几何断言与端口交互按 100% 原生像素:先钉住记忆缩放
 * (key 同 canvas-editor.js LS_ZOOM;卡片画布小,100% 下全部可见可命中) */
async function enterEdit(page) {
  await page.addInitScript(() =>
    localStorage.setItem('ts:canvasZoom', JSON.stringify({ scale: 1, user: true }))
  );
  await page.goto('/schedule.html');
  await page.waitForSelector('.canvas-card');
  await page.locator('#header-edit-btn').click();
  await page.waitForSelector('.canvas-board.editing');
}

/* 端口拖拽连线(画布编辑手势):源/目标均为 port-node locator,现取包围盒走鼠标 */
async function dragPort(page, from, to) {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  expect(a && b, '端口须在视口内可命中').toBeTruthy();
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  for (let i = 1; i <= 6; i += 1) {
    await page.mouse.move(ax + ((bx - ax) * i) / 6, ay + ((by - ay) * i) / 6);
  }
  await page.mouse.up();
}

/* 已打完的上游比赛卡:比分 2:0 → 胜者=选手甲(pz1)、败者=选手乙(pz2) */
function playedMatch() {
  return {
    id: 'k1', label: '上游决赛', phase: '', format: 'BO3', x: 0, y: 0,
    slots: [{ type: 'player', playerId: 'pz1' }, { type: 'player', playerId: 'pz2' }],
    exitRanks: {}
  };
}

function downstreamMatch(slots) {
  return {
    id: 'k2', label: '下游半决赛', phase: '', format: 'BO3', x: 24, y: 0,
    slots: slots || [{ type: 'empty' }, { type: 'empty' }], exitRanks: {}
  };
}

function poolCard(over) {
  return Object.assign({
    kind: 'rollPool', id: 'P', label: 'Roll 池 A', phase: '', x: 12, y: 0,
    w: 10, h: 7, ports: { lr: 2, tb: 2 }, mode: 'manual', seed: 'sdet1',
    slots: [{ type: 'empty' }, { type: 'empty' }, { type: 'empty' }, { type: 'empty' }]
  }, over || {});
}

function workspace(cards, scores) {
  return {
    activeId: 't1',
    players: [
      { id: 'pz1', name: '选手甲', createdAt: 1, updatedAt: 1 },
      { id: 'pz2', name: '选手乙', createdAt: 1, updatedAt: 1 }
    ],
    tournaments: [{
      id: 't1', name: 'roll 池端到端届', status: 'ongoing', createdAt: 1, updatedAt: 1,
      roster: ['pz1', 'pz2'],
      canvas: { grid: 'dot', cards },
      scores: scores || {}
    }],
    series: []
  };
}

/* 云端落盘后的池卡数据(缺 id 取第一个 roll 池) */
async function apiCard(page, id) {
  const data = await (await page.request.get('/api/data')).json();
  const cards = data.tournaments[0].canvas.cards;
  return id ? cards.find((c) => c.id === id) : cards.find((c) => c.kind === 'rollPool');
}

/* 下游比赛卡 A/B 两位选手名(playerRow 行序即 A/B) */
async function downstreamNames(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.canvas-card[data-match="k2"] .match-player .player-name')]
      .map((el) => el.textContent.trim())
  );
}

test('工具栏建池:默认 10×7、2+2 口、4 空池位,出口节点按几何分布', async ({ page }) => {
  await seedWorkspace(page.context(), workspace([playedMatch()], { k1: { a: 2, b: 0 } }));
  await enterEdit(page);

  await page.locator('#edit-add-pool-btn').click();
  const pool = page.locator('.canvas-card.pool-card');
  await expect(pool).toHaveCount(1);
  await expect(pool.locator('.match-format')).toHaveText('2+2 口');
  await expect(pool.locator('.match-state')).toHaveText('待 roll');
  await expect(pool.locator('.pool-row')).toHaveCount(4);
  await expect(pool.locator('.pool-row.tbd .player-name')).toHaveCount(4);

  /* 出口节点几何(canvas-model portOffsetForCard:组内 1 DOT 间距、以中线居中),
   * 内联 left/top 与旧八口同口径(border-box 卡左上原点) */
  const geo = await page.evaluate(() => {
    const el = document.querySelector('.canvas-card.pool-card');
    const ports = {};
    el.querySelectorAll('.port-node').forEach((p) => {
      ports[p.dataset.port] = { left: p.style.left, top: p.style.top };
    });
    return { ports, width: el.offsetWidth, height: el.offsetHeight };
  });
  expect(Object.keys(geo.ports)).toHaveLength(8);
  expect(geo.ports.L1).toEqual({ left: '0px', top: '84px' });
  expect(geo.ports.L2).toEqual({ left: '0px', top: '112px' });
  expect(geo.ports.R1).toEqual({ left: '280px', top: '84px' });
  expect(geo.ports.T1).toEqual({ left: '126px', top: '0px' });
  expect(geo.ports.B2).toEqual({ left: '154px', top: '196px' });
  expect(geo.width).toBe(280); /* 10 点 × DOT 28 */
  expect(geo.height).toBeGreaterThanOrEqual(196); /* 7 点 × DOT 28 */

  const card = await apiCard(page);
  expect(card.kind).toBe('rollPool');
  expect(card.w).toBe(10);
  expect(card.h).toBe(7);
  expect(card.ports).toEqual({ lr: 2, tb: 2 });
  expect(card.mode).toBe('manual');
  expect(card.assignments).toBe(null);
  expect(card.slots).toHaveLength(4);
  await page.request.post('/api/dev/reset');
});

test('表单改形状/口数:抽屉实时应用并落盘', async ({ page }) => {
  await seedWorkspace(page.context(), workspace([playedMatch()], { k1: { a: 2, b: 0 } }));
  await enterEdit(page);

  await page.locator('#edit-add-pool-btn').click();
  /* 建池即选中,设置抽屉自动滑出池专属表单 */
  await expect(page.locator('#card-panel')).toBeVisible();
  await expect(page.locator('#card-panel .cf-mode')).toBeVisible();

  /* 断言 input 值用 toHaveValue(hasText 匹配不到 input 的 value) */
  await page.locator('#card-panel .cf-w').fill('14');
  await page.locator('#card-panel .cf-h').fill('9');
  await page.locator('#card-panel .cf-lr').fill('3');
  await page.locator('#card-panel .cf-tb').fill('1');
  await expect(page.locator('#card-panel .cf-w')).toHaveValue('14');
  await expect(page.locator('#card-panel .cf-h')).toHaveValue('9');
  await expect(page.locator('#card-panel .cf-lr')).toHaveValue('3');
  await expect(page.locator('#card-panel .cf-tb')).toHaveValue('1');
  await page.waitForTimeout(800); /* 防抖 500 + 落盘 */

  const pool = page.locator('.canvas-card.pool-card');
  await expect(pool.locator('.match-format')).toHaveText('3+1 口');
  await expect(pool.locator('.port-node')).toHaveCount(8); /* (3+3) 左右 + (1+1) 上下 */
  expect(await pool.evaluate((el) => el.offsetWidth)).toBe(392); /* 14 点 × 28 */

  const card = await apiCard(page);
  expect(card.w).toBe(14);
  expect(card.h).toBe(9);
  expect(card.ports).toEqual({ lr: 3, tb: 1 });
  await page.request.post('/api/dev/reset');
});

test('比赛卡拖口连池:落池口追加池位,池位显示上游胜者', async ({ page }) => {
  await seedWorkspace(page.context(), workspace(
    [playedMatch(), poolCard()],
    { k1: { a: 2, b: 0 } }
  ));
  await enterEdit(page);

  const src = page.locator('.canvas-card[data-match="k1"] .port-node[data-port="rightTop"]');
  const dst = page.locator('.canvas-card[data-match="P"] .port-node[data-port="L1"]');
  await dragPort(page, src, dst);

  /* 池位追加在末位:4 空位 + 1 连线位;连线位解析上游胜者=选手甲 */
  const pool = page.locator('.canvas-card.pool-card');
  await expect(pool.locator('.pool-row')).toHaveCount(5);
  await expect(pool.locator('.pool-row:not(.tbd)')).toHaveCount(1);
  await expect(pool.locator('.pool-row:not(.tbd) .player-name')).toHaveText('选手甲');
  await expect(page.locator('#canvas-board .canvas-edges path.canvas-edge')).toHaveCount(1);

  const card = await apiCard(page, 'P');
  expect(card.slots[4]).toEqual({ type: 'flow', cardId: 'k1', outcome: 'winner', inlet: 'L1' });
  await page.request.post('/api/dev/reset');
});

test('池口连比赛卡 A/B 位:手动 Roll 后下游两位均为池内选手', async ({ page }) => {
  await seedWorkspace(page.context(), workspace([
    poolCard({ slots: [{ type: 'player', playerId: 'pz1' }, { type: 'player', playerId: 'pz2' }] }),
    downstreamMatch()
  ]));
  await enterEdit(page);

  const pool = page.locator('.canvas-card[data-match="P"]');
  const k2 = page.locator('.canvas-card[data-match="k2"]');
  /* 池 R1 口 → k2 上排口(A 位):outlet 引用形态 */
  await dragPort(page,
    pool.locator('.port-node[data-port="R1"]'),
    k2.locator('.port-node[data-port="leftTop"]'));
  /* 连线落盘重绘后出第一条边(未 roll 前下游 A 位仍待定) */
  await expect(page.locator('#canvas-board .canvas-edges path.canvas-edge')).toHaveCount(1);
  /* 池 L1 口 → k2 下排口(B 位) */
  await dragPort(page,
    pool.locator('.port-node[data-port="L1"]'),
    k2.locator('.port-node[data-port="leftBottom"]'));
  await expect(page.locator('#canvas-board .canvas-edges path.canvas-edge')).toHaveCount(2);

  /* 手动 Roll(卡头部 shuffle 钮,首次无快照不弹确认):两口已连,两选手各占一口 */
  await pool.locator('.roll-open').click();
  await expect(pool.locator('.match-state')).toHaveText('已 roll');
  const names = await downstreamNames(page);
  expect(names).toHaveLength(2);
  /* 手动 roll 真随机:A/B 两侧顺序不定,断言集合相等且互不重复 */
  expect(names).toEqual(expect.arrayContaining(['选手甲', '选手乙']));
  expect(new Set(names).size).toBe(2);

  /* 快照落盘:roll 的 PUT 在徽标翻转后 ~百毫秒内完成(写锁串行),轮询等它落定;
   * assignments = 出口→选手 平表,断言值域(两口各发一人) */
  await expect.poll(async () => {
    const card = await apiCard(page, 'P');
    return Object.values(card.assignments || {}).sort().join(',');
  }).toBe('pz1,pz2');
  await page.request.post('/api/dev/reset');
});

test('自动模式:分配由 seed 确定,reload 后下游选手一致', async ({ page }) => {
  await seedWorkspace(page.context(), workspace([
    poolCard({
      mode: 'auto',
      slots: [{ type: 'player', playerId: 'pz1' }, { type: 'player', playerId: 'pz2' }]
    }),
    downstreamMatch([
      { type: 'flow', cardId: 'P', outlet: 'R1' },
      { type: 'flow', cardId: 'P', outlet: 'L1' }
    ])
  ]));
  await page.goto('/schedule.html');
  await page.waitForSelector('.canvas-card[data-match="k2"]');

  /* 期望值直接取纯函数(autoAssign 同 seed 可重放),DOM 必须与其一致 */
  const want = await page.evaluate(() => {
    const r = window.CanvasModel.autoAssign(
      ['pz1', 'pz2'], { lr: 2, tb: 2 }, new Set(['L1', 'R1']), 'sdet1');
    return { r1: r.outlets.R1, l1: r.outlets.L1 };
  });
  const names = { pz1: '选手甲', pz2: '选手乙' };
  const rows = await downstreamNames(page);
  expect(rows).toEqual([names[want.r1], names[want.l1]]);

  await page.reload();
  await page.waitForSelector('.canvas-card[data-match="k2"]');
  const rowsAfter = await downstreamNames(page);
  expect(rowsAfter).toEqual([names[want.r1], names[want.l1]]);
  await page.request.post('/api/dev/reset');
});

test('口数缩减守卫:会拆已连线出口时 notify 拒绝,口数不变', async ({ page }) => {
  await seedWorkspace(page.context(), workspace([
    poolCard({ slots: [{ type: 'player', playerId: 'pz1' }, { type: 'player', playerId: 'pz2' }] }),
    downstreamMatch([{ type: 'flow', cardId: 'P', outlet: 'R1' }, { type: 'empty' }])
  ]));
  await enterEdit(page);

  await page.locator('.canvas-card.pool-card .match-title').click();
  await expect(page.locator('#card-panel')).toBeVisible();
  await expect(page.locator('#card-panel .cf-lr')).toHaveValue('2');

  /* 左右口缩到 0 会拆掉已连线的 R1:守卫拒绝,危险 toast 提示,数据不动 */
  await page.locator('#card-panel .cf-lr').fill('0');
  await expect(page.locator('.toast-danger')).toContainText('该口数会拆掉已连线的出口,先拆线');
  await page.waitForTimeout(800); /* 若守卫失守,防抖 500ms 会把 lr=0 落盘 */
  await expect(page.locator('.canvas-card.pool-card .match-format')).toHaveText('2+2 口');
  const card = await apiCard(page, 'P');
  expect(card.ports).toEqual({ lr: 2, tb: 2 });
  await page.request.post('/api/dev/reset');
});
