import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, resetStore, seedWorkspace } from './helpers.mjs';

/* 编辑模式更新回归:卡高统一、八端口居中、选中抽屉、工具栏精简。 */

test.setTimeout(60_000);

test.beforeEach(async ({ page }) => {
  const context = page.context();
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);
});

async function enterEdit(page, opts) {
  /* 画布查看态默认 auto-fit 缩放(0.28~1)会整体缩放 getBoundingClientRect,
   * 几何断言按 100% 原生像素写死——先钉住记忆缩放为 100%(key 同 canvas-editor.js LS_ZOOM,
   * canvas-edges.spec.mjs 亦操作此 key)。
   * 交互用例传 { fit: true }:不钉缩放走 auto-fit,默认双败画布全部卡片可见可点
   * (100% 下首卡在视口外,locator.click 会因 element outside viewport 永远超时) */
  if (!opts || !opts.fit) {
    await page.addInitScript(() =>
      localStorage.setItem('ts:canvasZoom', JSON.stringify({ scale: 1, user: true }))
    );
  }
  await page.goto('/schedule.html');
  await page.waitForSelector('.canvas-card');
  await page.locator('#header-edit-btn').click();
  await page.waitForSelector('.canvas-board.editing');
}

/* 画布空白点:scroll 视口左下角。auto-fit 后内容整体居中,左缘与底缘恒有留白;
 * 左上角(0,0)附近是固定侧栏(3.25rem),不能当画布空白点用 */
async function clickCanvasBlank(page) {
  const pt = await page.evaluate(() => {
    const r = document.getElementById('canvas-scroll').getBoundingClientRect();
    return { x: Math.round(r.left + 6), y: Math.round(r.top + r.height - 6) };
  });
  await page.mouse.click(pt.x, pt.y);
}

test('卡高统一 196:未填与已填卡组的卡片同高', async ({ page }) => {
  await enterEdit(page);
  const heights = await page.evaluate(() =>
    [...document.querySelectorAll('.canvas-card')].map((el) => el.offsetHeight)
  );
  expect(heights.length).toBeGreaterThan(0);
  for (const h of heights) expect(h).toBe(196);
});

test('每卡八个连接点,四侧居中、对间距 38', async ({ page }) => {
  await enterEdit(page);
  const geo = await page.evaluate(() => {
    const el = document.querySelector('.canvas-card');
    const r = el.getBoundingClientRect();
    const out = {};
    el.querySelectorAll('.port-node').forEach((p) => {
      const b = p.getBoundingClientRect();
      out[p.dataset.port] = {
        x: Math.round(b.left + b.width / 2 - r.left),
        y: Math.round(b.top + b.height / 2 - r.top)
      };
    });
    return out;
  });
  expect(Object.keys(geo)).toHaveLength(8);
  // 上下对:以卡中线 x=140 居中,y 贴 0/196
  expect(geo.topLeft).toEqual({ x: 121, y: 0 });
  expect(geo.topRight).toEqual({ x: 159, y: 0 });
  expect(geo.bottomLeft).toEqual({ x: 121, y: 196 });
  expect(geo.bottomRight).toEqual({ x: 159, y: 196 });
  // 左右对:以卡中线 y=98 居中
  expect(geo.leftTop).toEqual({ x: 0, y: 79 });
  expect(geo.leftBottom).toEqual({ x: 0, y: 117 });
  expect(geo.rightTop).toEqual({ x: 280, y: 79 });
  expect(geo.rightBottom).toEqual({ x: 280, y: 117 });
  await page.request.post('/api/dev/reset');
});

test('单击选中卡片出现设置抽屉,点空白收起', async ({ page }) => {
  await enterEdit(page, { fit: true });
  await page.locator('.canvas-card').first().click();
  const panel = page.locator('#card-panel');
  await expect(panel).toBeVisible();
  /* 面板让位:zoom-dock 中心点不被面板遮挡(elementFromPoint 须命中 dock 自身) */
  const dockHit = await page.evaluate(() => {
    const dock = document.getElementById('zoom-dock');
    const r = dock.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return Boolean(el && el.closest('#zoom-dock'));
  });
  expect(dockHit).toBe(true);
  await clickCanvasBlank(page); // 画布空白
  await expect(panel).toBeHidden();
});

test('抽屉改标题实时生效并落盘', async ({ page }) => {
  await enterEdit(page, { fit: true });
  await page.locator('.canvas-card').first().click();
  await page.locator('#card-panel .cf-label').fill('抽屉改名实战');
  await page.waitForTimeout(800); // 防抖 500 + 落盘
  await expect(page.locator('.canvas-card').first()).toContainText('抽屉改名实战');
  const data = await (await page.request.get('/api/data')).json();
  const card = data.tournaments[0].canvas.cards[0];
  expect(card.label).toBe('抽屉改名实战');
  await page.request.post('/api/dev/reset');
});

test('双击卡片仍开弹窗(保存/取消语义保留)', async ({ page }) => {
  await enterEdit(page, { fit: true });
  await page.locator('.canvas-card').first().dblclick();
  await page.locator('#card-edit-dialog').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await page.locator('#card-edit-dialog').waitFor({ state: 'hidden' });
  await page.request.post('/api/dev/reset');
});

test('批删模式点选两张卡后可一键删除', async ({ page }) => {
  await enterEdit(page, { fit: true });
  const before = await page.locator('.canvas-card').count();
  await page.locator('[data-tool="delete"]').click();
  await page.locator('.canvas-card').nth(0).click();
  await page.locator('.canvas-card').nth(1).click();
  await page.locator('#edit-delete-selected-btn').click();
  await page.locator('#confirm-dialog [data-confirm-ok]').click();
  await page.waitForTimeout(600);
  expect(await page.locator('.canvas-card').count()).toBe(before - 2);
  await page.request.post('/api/dev/reset');
});

test('抽屉连续输入合并为一步撤销', async ({ page }) => {
  await enterEdit(page, { fit: true });
  await page.locator('.canvas-card').first().click();
  await page.locator('#card-panel .cf-label').fill('一步撤销甲');
  await page.locator('#card-panel .cf-label').fill('一步撤销乙');
  await page.waitForTimeout(800);
  /* 焦点移出输入框(抽屉标题非输入元素):画布快捷键守卫会忽略输入框内的 Meta+Z */
  await page.locator('#card-panel .card-panel-title').click();
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(600);
  await expect(page.locator('.canvas-card').first()).toContainText('胜者组 1/4 决赛 1'); // 回到模板原名
  await page.request.post('/api/dev/reset');
});

test('弹窗保存后面板同步回填,继续面板编辑不回退弹窗改动', async ({ page }) => {
  await enterEdit(page, { fit: true });
  await page.locator('.canvas-card').first().click();
  await expect(page.locator('#card-panel')).toBeVisible();
  await page.locator('.canvas-card').first().dblclick();
  await page.locator('#card-edit-dialog').waitFor({ state: 'visible' });
  await page.locator('#card-edit-dialog .cf-label').fill('弹窗改的名');
  await page.locator('#card-edit-dialog [data-card-save]').click();
  await page.locator('#card-edit-dialog').waitFor({ state: 'hidden' });
  /* 面板表单必须立刻反映弹窗保存的值,否则下一次面板输入会把全量旧值写回 */
  await expect(page.locator('#card-panel .cf-label')).toHaveValue('弹窗改的名');
  await page.locator('#card-panel .cf-label').fill('面板接着改');
  await page.waitForTimeout(800); // 防抖 500 + 落盘
  await expect(page.locator('.canvas-card').first()).toContainText('面板接着改');
  const data = await (await page.request.get('/api/data')).json();
  expect(data.tournaments[0].canvas.cards[0].label).toBe('面板接着改');
  await page.request.post('/api/dev/reset');
});

test('空栈撤销不误弃面板待提交(防幽灵编辑)', async ({ page }) => {
  await enterEdit(page, { fit: true });
  /* 全新会话无任何历史:Cmd+Z 为空栈无操作,不能顺带取消面板 500ms 防抖 */
  await page.locator('.canvas-card').first().click();
  await expect(page.locator('#card-panel')).toBeVisible();
  await page.locator('#card-panel .cf-label').fill('空栈撤销不丢');
  /* 焦点移出输入框(抽屉标题非输入元素),Cmd+Z 才走画布撤销路径 */
  await page.locator('#card-panel .card-panel-title').click();
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(800); // 防抖 500 + 落盘
  const data = await (await page.request.get('/api/data')).json();
  expect(data.tournaments[0].canvas.cards[0].label).toBe('空栈撤销不丢');
  await page.request.post('/api/dev/reset');
});

test('拖动卡片不开设置抽屉,纯点击才开', async ({ page }) => {
  await enterEdit(page, { fit: true });
  const panel = page.locator('#card-panel');
  const card = page.locator('.canvas-card').first();
  const head = await card.locator('.match-head').boundingBox();

  /* 拖动 3×1 格:松手落盘后抽屉不应被自动打开 */
  await page.mouse.move(head.x + head.width * 0.3, head.y + 8);
  await page.mouse.down();
  for (let i = 1; i <= 6; i += 1) {
    await page.mouse.move(head.x + head.width * 0.3 + (84 * i) / 6, head.y + 8 + (28 * i) / 6);
  }
  await page.mouse.up();
  await page.waitForTimeout(900);
  await expect(panel).toBeHidden();

  /* 同一张卡纯点击(无位移)仍即时开抽屉 */
  await card.locator('.match-head').click();
  await expect(panel).toBeVisible();
  await page.request.post('/api/dev/reset');
});

/* 回归(effSig 含 deck,2026-09-09 禁卡表批终审移交):继承侧上游条目带快照时,
 * 面板无关编辑(改名/勾禁卡表)不得把该侧固化成无 deck 的 own 值——
 * 快照是卡组构成统计与禁卡违规判定的数据源,固化=静默失明+继承断链。 */
test('继承侧带快照:面板无关编辑不固化 own 值、快照与继承保持', async ({ page }) => {
  const context = page.context();
  const LINK = 'https://shadowverse-wb.com/chs/deck/detail/?hash=1.2.effsig';
  const deck = { v: 1, resolvedAt: 1, classId: 2, format: null,
    cards: [[501, '快照禁卡', 2, 3, 0, 3], [999, '快照杂卡', 1, 1, 0, 3]] };
  await seedWorkspace(context, {
    tournaments: [{
      id: 'teff', name: 'effSig回归届', status: 'ongoing', createdAt: 1, updatedAt: 1,
      canvas: { cards: [
        { id: 'k1', label: '上游决赛', phase: '', format: 'BO3', x: 0, y: 0,
          slots: [{ type: 'player', playerId: 'pz1' }, { type: 'player', playerId: 'pz2' }],
          exitRanks: { winner: 1, loser: 2 }, deckCount: null, color: null,
          classLinks: { a: [{ cls: '皇家', url: LINK, text: '', deck }], b: [] } },
        { id: 'k2', label: '下游半决赛', phase: '', format: 'BO3', x: 4, y: 0,
          slots: [{ type: 'flow', cardId: 'k1', outcome: 'winner' }, { type: 'player', playerId: 'pz2' }],
          exitRanks: { winner: 1, loser: 2 }, deckCount: null, color: null,
          classLinks: { a: [], b: [] }, banListIds: ['bl1'] }
      ], style: {} },
      scores: { k1: { a: 2, b: 0 } }, roster: ['pz1', 'pz2'],
      banLists: [{ id: 'bl1', name: '表一', cards: [[501, '快照禁卡', 2, 3, 0]] }]
    }],
    series: [], activeId: 'teff',
    players: [{ id: 'pz1', name: '甲', createdAt: 1, updatedAt: 1 }, { id: 'pz2', name: '乙', createdAt: 1, updatedAt: 1 }]
  });

  await enterEdit(page, { fit: true });
  await page.locator('.canvas-card').nth(1).click();
  await expect(page.locator('#card-panel')).toBeVisible();
  /* A 侧应回显继承行(带快照的上游条目) */
  await expect(page.locator('#card-panel .cf-cl-a .cl-row input.cl-url').first()).toHaveValue(LINK);

  /* 无关编辑:改标题 + 点画布空白触发 change 落用 */
  await page.locator('#card-panel .cf-label').fill('下游半决赛改');
  await clickCanvasBlank(page);
  await page.waitForTimeout(800);

  const state = await page.evaluate(() => {
    const rec = window.TournamentApp.current;
    const k2 = rec.canvas.cards.find((c) => c.id === 'k2');
    const eff = window.CanvasModel.resolveEffectiveClassLinks(rec.canvas, rec.scores || {});
    const rows = (eff.get('k2') || { a: [] }).a;
    return {
      ownSolidified: Array.isArray(k2.classLinks && k2.classLinks.a) && k2.classLinks.a.length > 0,
      effDeckOk: Boolean(rows[0] && rows[0].deck),
      viol: window.CanvasModel.checkBanViolations(rec, 'k2').length,
      label: k2.label
    };
  });
  expect(state.ownSolidified, '继承侧不得被固化成 own').toBe(false);
  expect(state.effDeckOk, '有效链接仍带快照').toBe(true);
  expect(state.viol, '继承快照驱动的禁卡判定仍在(1 项禁用)').toBe(1);
  expect(state.label).toBe('下游半决赛改');

  /* 真修改继承行:应固化 own(新值,无快照属预期——URL 变了旧快照失效) */
  await page.locator('.canvas-card').nth(1).click();
  await page.locator('#card-panel .cf-cl-a .cl-row input.cl-url').first()
    .fill('https://shadowverse-wb.com/chs/deck/detail/?hash=1.2.changed');
  await clickCanvasBlank(page);
  await page.waitForTimeout(800);
  const solidified = await page.evaluate(() => {
    const k2 = window.TournamentApp.current.canvas.cards.find((c) => c.id === 'k2');
    return { own: (k2.classLinks && k2.classLinks.a) || [],
      viol: window.CanvasModel.checkBanViolations(window.TournamentApp.current, 'k2').length };
  });
  expect(solidified.own.length).toBe(1);
  expect(solidified.own[0].url).toContain('1.2.changed');
  expect(solidified.own[0].deck, '改 URL 后旧快照不随行(走补解析)').toBeUndefined();
  expect(solidified.viol, '改后无快照不判定').toBe(0);
  await page.request.post('/api/dev/reset');
});
