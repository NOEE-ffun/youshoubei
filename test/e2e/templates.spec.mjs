import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, seedWorkspace, resetStore, makeAdmin, DEFAULT_PLAYERS } from './helpers.mjs';

/* 画布卡片模板三主链(2026-09-12 模板批):
 * 1) 选中→保存至模板→抽屉(个人库缩略图)→使用→幽灵放置(body.tpl-placing)
 *    →点画布落子(新卡自动全选+连线跟随)→Ctrl+Z 单步撤销还原;
 * 2) Ctrl+C→Ctrl+V 改走幽灵放置(不再立即偏移粘贴)→落子全选→Esc 取消路径;
 * 3) 上架市场→第二管理账号(makeAdmin 造号)加入(409 撞名自动「(副本)」)→使用落子。
 * 种子铁律:grid:'dot';每条用例收尾 POST /api/dev/reset 清内存存储。 */

test.setTimeout(60_000);

const PHONE_B = '13800002222'; /* 第二管理账号(同 ownership.spec 惯例,makeAdmin 兑码升 admin) */

/* 种子届:2 张互连比赛卡(t_a flow→t_b)+ 1 张池卡,互不重叠(卡 10×7 格) */
function seedWorkspaceBody() {
  return {
    series: [],
    tournaments: [{
      id: 'tt', name: '模板测试', status: 'ongoing', startTime: null,
      roster: [], scores: {}, matchDecks: {}, rules: null,
      schemaVersion: 2, createdAt: 1, updatedAt: 1,
      canvas: {
        grid: 'dot', size: { cols: 48, rows: 32 }, style: { opacity: 0.7, blur: 8 },
        cards: [
          { id: 't_a', kind: 'match', label: 'A', phase: '胜者组', format: 'BO3', x: 2, y: 1, w: 10, h: 7,
            slots: [{ type: 'flow', cardId: 't_b', outcome: 'winner' }, { type: 'empty' }],
            exitRanks: {}, deckCount: null, color: null, classLinks: { a: [], b: [] } },
          { id: 't_b', kind: 'match', label: 'B', phase: '', format: 'BO3', x: 14, y: 1, w: 10, h: 7,
            slots: [], exitRanks: {}, deckCount: null, color: null, classLinks: { a: [], b: [] } },
          { id: 't_pool', kind: 'rollPool', label: '', x: 3, y: 10, w: 10, h: 7, entryCapacity: 4,
            slots: [{ type: 'empty' }, { type: 'empty' }] }
        ]
      }
    }],
    activeId: 'tt',
    players: DEFAULT_PLAYERS
  };
}

/* 进编辑(auto-fit 保证种子卡全部可见可点,同 canvas-edit-panel 惯例) */
async function enterEdit(page) {
  await page.goto('/schedule.html');
  await page.waitForSelector('.canvas-card');
  await expect(page.locator('.canvas-card')).toHaveCount(3);
  await page.locator('#header-edit-btn').click();
  await page.waitForSelector('.canvas-board.editing');
}

/* 选中两张比赛卡:点 A 单选 + Shift 点 B 加选(卡片头无按钮,避开职业槽) */
async function selectTwoMatchCards(page) {
  await page.locator('.canvas-card[data-match="t_a"] .match-head').click();
  await expect(page.locator('#card-panel')).toBeVisible();
  await page.locator('.canvas-card[data-match="t_b"] .match-head').click({ modifiers: ['Shift'] });
}

/* 画布空白落点:视口左下角(auto-fit 后左/底缘恒有留白,同 canvas-edit-panel 惯例) */
async function clickCanvasBlank(page) {
  const pt = await page.evaluate(() => {
    const r = document.getElementById('canvas-scroll').getBoundingClientRect();
    return { x: Math.round(r.left + 6), y: Math.round(r.top + r.height - 6) };
  });
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.click(pt.x, pt.y);
}

/* 落子后新卡 id 集(排除种子三张) */
async function placedCardIds(page) {
  return page.locator('.canvas-card.selected').evaluateAll((els) =>
    els.map((e) => e.dataset.match).filter((id) => !['t_a', 't_b', 't_pool'].includes(id)));
}

/* UI 保存选中为模板:抽屉「保存至模板」→弹窗输名→确定 */
async function saveSelectionViaUi(page, name) {
  await page.locator('#tpl-save-btn').click();
  const dlg = page.locator('dialog.tpl-prompt');
  await expect(dlg).toBeVisible();
  await dlg.locator('#tpl-prompt-input').fill(name);
  await dlg.locator('[data-tpl-prompt-ok]').click();
  await expect(dlg).toBeHidden();
  /* PUT 异步落库:轮询本人库 */
  await expect.poll(async () => {
    const lib = await (await page.request.get('/api/templates')).json();
    return lib.templates.find((t) => t.name === name) || null;
  }).toEqual(expect.objectContaining({ name, cards: expect.any(Array) }));
}

test('选中→保存→抽屉→使用→幽灵落子→新卡全选→Ctrl+Z 还原', async ({ page, context }) => {
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);
  await seedWorkspace(context, seedWorkspaceBody());

  await enterEdit(page);
  await selectTwoMatchCards(page);
  await expect(page.locator('#tpl-save-btn')).toBeVisible();

  /* 保存「双败小组」:2 张卡,包围盒 22×7(A 2..12 / B 14..24,y 均 1..8) */
  await saveSelectionViaUi(page, '双败小组');
  const saved = (await (await page.request.get('/api/templates')).json())
    .templates.find((t) => t.name === '双败小组');
  expect(saved.cards).toHaveLength(2);
  expect(saved.meta).toEqual({ w: 22, h: 7 });

  /* 工具栏模板按钮 → 抽屉开(个人库 tab):缩略图 2 节点 + 1 连线 + 名称/张数 */
  await page.locator('#edit-templates-btn').click();
  const drawer = page.locator('#tpl-drawer');
  await expect(drawer).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/tpl-drawer-open/);
  await expect(page.locator('.tpl-tab[data-tab="mine"]')).toHaveClass(/is-active/);
  const card = drawer.locator('.tpl-card', { hasText: '双败小组' });
  await expect(card).toHaveCount(1);
  await expect(card.locator('.tpl-sub')).toContainText('2 张卡片');
  await expect(card.locator('.tpl-thumb .tpl-node')).toHaveCount(2);
  await expect(card.locator('.tpl-thumb .tpl-edges line')).toHaveCount(1);

  /* 使用 → 幽灵放置态;首次 mousemove 前不亮相,移动后可见 */
  await card.locator('[data-act="use"]').click();
  await expect(page.locator('body')).toHaveClass(/tpl-placing/);
  const ghost = page.locator('.tpl-ghost');
  await expect(ghost).toHaveCount(1);
  await expect(ghost).toBeHidden(); /* 尚无光标坐标 */
  const center = await page.evaluate(() => {
    const r = document.getElementById('canvas-scroll').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  await page.mouse.move(center.x, center.y);
  await expect(ghost).toBeVisible();

  /* 信息完整钉:幽灵=页面同款构建器出的真实卡预览——每张 .match-card 的
   * .match-title/.match-phase 与保存的模板快照逐卡一致(t_a 有阶段、t_b 无) */
  const srcA = saved.cards.find((c) => c.label === 'A');
  const srcB = saved.cards.find((c) => c.label === 'B');
  expect(srcA.phase).toBe('胜者组');
  expect(srcB.phase).toBe('');
  const ghostInfo = await ghost.locator('.match-card').evaluateAll((els) => els.map((e) => ({
    title: e.querySelector('.match-title').textContent.trim(),
    phase: e.querySelector('.match-phase') ? e.querySelector('.match-phase').textContent.trim() : null
  })));
  expect(ghostInfo.map((i) => i.title).sort()).toEqual(saved.cards.map((c) => c.label).sort());
  expect(ghostInfo.find((i) => i.title === 'A').phase).toBe(srcA.phase);
  expect(ghostInfo.find((i) => i.title === 'B').phase).toBe(srcB.phase || null);

  /* 落子:3→5 张,新卡 2 张且全部 selected,克隆连线 +1,抽屉自动收起 */
  const edgesBefore = await page.locator('#canvas-board .canvas-edges path.canvas-edge').count();
  expect(edgesBefore).toBe(1); /* 种子 t_a→t_b 一条 */
  /* 所见即所得零容差钉:mousemove 至落点后读「幽灵层 left/top + 内卡(锚 A)
   * 内联 left/top」之和,点击同点落子后新卡 selected 的 left/top 与之严格相等。
   * 落点限正象限空白带(dx≥0/dy≥0):负象限落子会触发渲染原点外扩+相机等量
   * 补偿,新卡 left 被归一,DOM left 口径不可比——按格点反解屏幕坐标搜视口内点 */
  const dropPt = await page.evaluate(() => {
    const sr = document.getElementById('canvas-scroll').getBoundingClientRect();
    const br = document.getElementById('canvas-board').getBoundingClientRect();
    const cam = window.CanvasEditor.getCamera();
    const DOT = window.CanvasModel.DOT;
    const pick = (gx, gy) => ({
      x: Math.round(br.left + (gx - cam.ox) * DOT * cam.scale),
      y: Math.round(br.top + (gy - cam.oy) * DOT * cam.scale)
    });
    const inside = (p) => p.x >= sr.left + 8 && p.x <= sr.right - 8 &&
      p.y >= sr.top + 8 && p.y <= sr.bottom - 8;
    /* 命中校验:该点最顶层元素须属 #canvas-scroll 且不在任何卡上——
     * 放置态抽屉仍开着(盖住右缘,点进抽屉落不了子),点在卡上则
     * 落子后补发的 click 会单选该卡,顶掉新卡落选态 */
    const onBlank = (p) => {
      const el = document.elementFromPoint(p.x, p.y);
      return !!el && !!(el.closest && el.closest('#canvas-scroll')) &&
        !el.closest('.canvas-card');
    };
    /* 正象限空白带(dx=round(gx−11)≥0,dy=round(gy−3.5)≥0):先搜种子卡
     * 包围盒(x≤24,y≤17)右下侧;窄视口(放置态抽屉盖住右缘)退让左半
     * gx 12..24 的下方空白行(onBlank 已保证落点不压卡) */
    const tryBand = (x0, x1) => {
      for (let gx = x0; gx <= x1; gx += 2) {
        for (let gy = 12; gy <= 30; gy += 2) {
          const p = pick(gx, gy);
          if (inside(p) && onBlank(p)) return p;
        }
      }
      return null;
    };
    return tryBand(26, 46) || tryBand(12, 24) ||
      { x: Math.round(sr.left + 6), y: Math.round(sr.top + sr.height - 6) };
  });
  await page.mouse.move(dropPt.x, dropPt.y);
  const ghostSum = await page.evaluate(() => {
    const layer = document.querySelector('.tpl-ghost');
    const card = Array.from(layer.querySelectorAll('.match-card'))
      .find((e) => e.querySelector('.match-title').textContent.trim() === 'A');
    return {
      left: parseFloat(layer.style.left) + parseFloat(card.style.left),
      top: parseFloat(layer.style.top) + parseFloat(card.style.top)
    };
  });
  await page.mouse.click(dropPt.x, dropPt.y);
  await expect(page.locator('body')).not.toHaveClass(/tpl-placing/);
  await expect(ghost).toHaveCount(0);
  await expect(page.locator('.canvas-card')).toHaveCount(5);
  await expect(page.locator('.canvas-card.selected')).toHaveCount(2);
  const placedA = await page.evaluate(() => {
    const card = Array.from(document.querySelectorAll('#canvas-board .canvas-card.selected'))
      .find((e) => e.querySelector('.match-title').textContent.trim() === 'A');
    return { left: parseFloat(card.style.left), top: parseFloat(card.style.top) };
  });
  expect(placedA.left).toBe(ghostSum.left); /* 容差 0:所见即落点 */
  expect(placedA.top).toBe(ghostSum.top);
  expect(await placedCardIds(page)).toHaveLength(2);
  await expect(page.locator('#canvas-board .canvas-edges path.canvas-edge')).toHaveCount(2);
  await expect(drawer).toBeHidden();

  /* 单步撤销:新卡连同克隆连线一并消失,选择清空 */
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(500);
  await expect(page.locator('.canvas-card')).toHaveCount(3);
  await expect(page.locator('.canvas-card.selected')).toHaveCount(0);
  await expect(page.locator('#canvas-board .canvas-edges path.canvas-edge')).toHaveCount(1);

  await page.request.post('/api/dev/reset');
});

test('Ctrl+C → Ctrl+V 幽灵落子(不再立即偏移粘贴),Esc 取消', async ({ page, context }) => {
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);
  await seedWorkspace(context, seedWorkspaceBody());

  await enterEdit(page);
  await selectTwoMatchCards(page);
  await page.keyboard.press('Control+c');

  /* Ctrl+V:改走幽灵放置——不立即落卡(旧「偏移粘贴」行为已退役)。
   * 幽灵=board 内真实卡预览层:多出的 2 张 .canvas-card 全在 .tpl-ghost 内,
   * 板内非幽灵卡仍 3 张(粘贴不落卡语义钉不放松) */
  await page.keyboard.press('Control+v');
  await expect(page.locator('body')).toHaveClass(/tpl-placing/);
  await expect(page.locator('.tpl-ghost')).toHaveCount(1);
  await expect(page.locator('.tpl-ghost .canvas-card')).toHaveCount(2);
  const boardCardsWhilePlacing = await page.locator('.canvas-card').evaluateAll((els) =>
    els.filter((e) => !e.closest('.tpl-ghost')).length);
  expect(boardCardsWhilePlacing).toBe(3);

  /* 落子:3→5,新卡 2 张全选 */
  await clickCanvasBlank(page);
  await expect(page.locator('body')).not.toHaveClass(/tpl-placing/);
  await expect(page.locator('.canvas-card')).toHaveCount(5);
  await expect(page.locator('.canvas-card.selected')).toHaveCount(2);
  expect(await placedCardIds(page)).toHaveLength(2);

  /* 再入放置态按 Esc 取消:退出放置且画布不变 */
  await page.keyboard.press('Control+v');
  await expect(page.locator('body')).toHaveClass(/tpl-placing/);
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/tpl-placing/);
  await expect(page.locator('.tpl-ghost')).toHaveCount(0);
  await expect(page.locator('.canvas-card')).toHaveCount(5);

  await page.request.post('/api/dev/reset');
});

test('上架→第二账号加入(409 副本路径)→使用落子', async ({ page, context, browser }) => {
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);
  await seedWorkspace(context, seedWorkspaceBody());

  /* admin1(=super,掩码名 ***0000):UI 存模板并上架市场 */
  await enterEdit(page);
  await selectTwoMatchCards(page);
  await saveSelectionViaUi(page, '市场模板');
  await page.locator('#edit-templates-btn').click();
  const mineCard = page.locator('#tpl-drawer .tpl-card', { hasText: '市场模板' });
  await expect(mineCard).toHaveCount(1);
  await mineCard.locator('[data-act="list"]').click();
  await expect(mineCard.locator('[data-act="unlist"]')).toBeVisible(); /* 刷新后变「已上架」 */
  await expect(mineCard.locator('.tpl-sub')).toContainText('已上架');

  /* 市场 tab:1 条,作者为掩码手机号,快照 2 张 */
  await page.locator('.tpl-tab[data-tab="market"]').click();
  const mktCard = page.locator('#tpl-drawer .tpl-card', { hasText: '市场模板' });
  await expect(mktCard).toHaveCount(1);
  await expect(mktCard.locator('.tpl-sub')).toContainText('***0000');
  await expect(mktCard.locator('.tpl-sub')).toContainText('2 张');
  const market = await (await page.request.get('/api/templates/market')).json();
  expect(market.market).toHaveLength(1);
  expect(market.market[0].authorName).toBe('***0000');

  /* 第二管理账号:super 发 admin 码 → 新手机号登录兑换(helpers.makeAdmin 现成通道) */
  const contextB = await browser.newContext();
  const userB = await makeAdmin(contextB, PHONE_B);
  expect(userB.role).toBe('admin');

  /* admin2 自建一届(归属盖章):GET 回读增补自己的届,不碰他人资源 */
  const seeded = await (await contextB.request.get('/api/data')).json();
  seeded.tournaments.push({
    id: 'tpl-b', name: '模板B届', seriesId: null, status: 'ongoing', startTime: null,
    roster: [], scores: {}, matchDecks: {}, rules: null, schemaVersion: 2, createdAt: 1, updatedAt: 1,
    canvas: {
      grid: 'dot', size: { cols: 48, rows: 32 }, style: { opacity: 0.7, blur: 8 },
      cards: [
        { id: 'b1', kind: 'match', label: 'B1', phase: '', format: 'BO3', x: 2, y: 1, w: 10, h: 7,
          slots: [{ type: 'empty' }, { type: 'empty' }],
          exitRanks: {}, deckCount: null, color: null, classLinks: { a: [], b: [] } }
      ]
    }
  });
  const putB = await contextB.request.put('/api/data', { data: seeded });
  expect(putB.ok(), 'admin2 增补自己的届').toBeTruthy();

  /* admin2 页面:切到自己届 → 编辑 → 抽屉市场 tab 加入两次(第二次撞名 409 走副本重发) */
  const pageB = await contextB.newPage();
  const marketPosts = [];
  pageB.on('response', (r) => {
    if (r.request().method() === 'POST' && r.url().includes('/api/templates/market')) {
      marketPosts.push(r.status());
    }
  });
  await pageB.goto('/schedule.html');
  await pageB.waitForSelector('.canvas-card');
  await pageB.locator('#tournament-switch').selectOption('tpl-b');
  await expect(pageB.locator('.header-title')).toHaveText('模板B届');
  await pageB.locator('#header-edit-btn').click();
  await pageB.waitForSelector('.canvas-board.editing');

  await pageB.locator('#edit-templates-btn').click();
  await expect(pageB.locator('#tpl-drawer .tpl-empty')).toBeVisible(); /* 个人库初始为空 */
  await pageB.locator('.tpl-tab[data-tab="market"]').click();
  const mktB = pageB.locator('#tpl-drawer .tpl-card', { hasText: '市场模板' });
  await expect(mktB).toHaveCount(1);
  await mktB.locator('[data-act="adopt"]').click();
  await expect.poll(async () => {
    const lib = await (await contextB.request.get('/api/templates')).json();
    return lib.templates.map((t) => t.name);
  }).toEqual(['市场模板']);

  /* 第二次加入:后端 409 撞名 → 前端自动 renameTo「(副本)」重发 */
  await mktB.locator('[data-act="adopt"]').click();
  await expect.poll(async () => {
    const lib = await (await contextB.request.get('/api/templates')).json();
    return lib.templates.map((t) => t.name);
  }).toEqual(['市场模板', '市场模板(副本)']);
  expect(marketPosts).toEqual([200, 409, 200]); /* 三连 POST:加入 / 撞名 / 副本重发 */

  /* 个人库对副本「使用」→ 幽灵落子:1→3 张,新卡 2 张全选 */
  await pageB.locator('.tpl-tab[data-tab="mine"]').click();
  const copyCard = pageB.locator('#tpl-drawer .tpl-card', { hasText: '市场模板(副本)' });
  await expect(copyCard).toHaveCount(1);
  await copyCard.locator('[data-act="use"]').click();
  await expect(pageB.locator('body')).toHaveClass(/tpl-placing/);
  await clickCanvasBlank(pageB);
  await expect(pageB.locator('.canvas-card')).toHaveCount(3);
  await expect(pageB.locator('.canvas-card.selected')).toHaveCount(2);
  const placedIds = await pageB.locator('.canvas-card.selected').evaluateAll((els) =>
    els.map((e) => e.dataset.match).filter((id) => id !== 'b1'));
  expect(placedIds).toHaveLength(2);

  await pageB.close();
  await contextB.close();
  await page.request.post('/api/dev/reset');
});
