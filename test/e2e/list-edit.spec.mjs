import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, resetStore } from './helpers.mjs';

/* 列表视图编辑:就地编辑不跳画布、选择/设置抽屉、删除、拖拽排序、染色同步、新列布局。 */

test.setTimeout(60_000);

test.beforeEach(async ({ page }) => {
  const context = page.context();
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);
});

async function enterListEdit(page) {
  await page.addInitScript(() => {
    sessionStorage.setItem('ts:preferCanvas', '0');
  });
  await page.goto('/schedule.html');
  await page.waitForSelector('#list-body .list-row');
  await page.locator('#header-edit-btn').click();
  await page.waitForSelector('body.list-editing');
}

async function rows(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('#list-body .list-row')].map((el) => el.dataset.match)
  );
}

async function groups(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('#list-body .list-group')].map((g) => ({
      key: g.dataset.key,
      rows: [...g.querySelectorAll('.list-row')].map((el) => el.dataset.match)
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

test('列表视图进入编辑不切换到画布,手柄可见', async ({ page }) => {
  await enterListEdit(page);
  await expect(page.locator('#list-view')).toBeVisible();
  await expect(page.locator('#canvas-wrap')).toBeHidden();
  await expect(page.locator('.list-row .list-handle').first()).toBeVisible();
  await expect(page.locator('#edit-toolbar').locator('[data-tool="select"]')).toBeHidden();
  await page.request.post('/api/dev/reset');
});

test('点行选中并滑出设置抽屉,改标题实时生效', async ({ page }) => {
  await enterListEdit(page);
  const row = page.locator('.list-row').nth(1);
  await row.click();
  await expect(page.locator('#card-panel')).toBeVisible();
  await page.locator('#card-panel .cf-label').fill('首轮焦点战');
  await expect(page.locator('.list-row .list-title').nth(1)).toHaveText('首轮焦点战', { timeout: 4000 });
  await page.request.post('/api/dev/reset');
});

test('删除选中行(确认弹窗)', async ({ page }) => {
  await enterListEdit(page);
  const before = await rows(page);
  await page.locator('.list-row').nth(1).click();
  await page.locator('#edit-delete-selected-btn').click();
  await page.locator('#confirm-dialog [data-confirm-ok]').click();
  await page.waitForFunction((n) => document.querySelectorAll('#list-body .list-row').length === n - 1, before.length);
  const after = await rows(page);
  expect(after).toHaveLength(before.length - 1);
  expect(after).not.toContain(before[1]);
  await page.request.post('/api/dev/reset');
});

test('行拖拽同阶段重排,撤销可回', async ({ page }) => {
  await enterListEdit(page);
  const before = await rows(page);
  const a = await page.locator('.list-row').nth(0).boundingBox();
  const t = await page.locator('.list-row').nth(3).boundingBox();
  /* 目标 = 第 4 行底缘再 +4px:中点命中语义下明确落在其后(间隙条与行高不等,
   * 贴中点仅几 px 的落点会被让位动画的亚像素漂移翻转) */
  await dragMouse(page,
    { x: a.x + a.width * 0.5, y: a.y + a.height / 2 },
    { x: t.x + t.width * 0.5, y: t.y + t.height + 4 });
  const after = await rows(page);
  expect(after[3]).toBe(before[0]);
  await page.locator('[data-tool="undo"]').click();
  await page.waitForFunction((expectFirst) =>
    document.querySelector('#list-body .list-row')?.dataset.match === expectFirst, before[0]);
  expect(await rows(page)).toEqual(before);
  await page.request.post('/api/dev/reset');
});

test('单场跨阶段拖拽:归属与卡片设置阶段字段同步', async ({ page }) => {
  await enterListEdit(page);
  const before = await groups(page);
  const moved = before.find((g) => g.key === '胜者组').rows[0];
  const s = await page.locator('.list-row[data-match="' + moved + '"]').boundingBox();
  const d = await page.locator('.list-group[data-key="败者组"] h2').boundingBox();
  await dragMouse(page,
    { x: s.x + s.width * 0.5, y: s.y + s.height / 2 },
    { x: d.x + 60, y: d.y + d.height + 8 });
  const after = await groups(page);
  expect(after.find((g) => g.key === '败者组').rows).toContain(moved);
  expect(after.find((g) => g.key === '胜者组').rows).not.toContain(moved);
  await page.locator('.list-row[data-match="' + moved + '"]').click();
  await expect(page.locator('#card-panel')).toBeVisible();
  await expect(page.locator('#card-panel .cf-phase')).toHaveValue('败者组');
  await page.request.post('/api/dev/reset');
});

test('阶段整块拖拽重排,幽灵芯片跟随指针', async ({ page }) => {
  await enterListEdit(page);
  const before = (await groups(page)).map((g) => g.key);
  const a = await page.locator('.list-group h2').first().boundingBox();
  const b = await page.locator('.list-group').last().boundingBox();
  /* 目标 = 末组底缘再 +4px:明确落在末组之后 */
  const from = { x: a.x + 40, y: a.y + a.height / 2 };
  const to = { x: b.x + 80, y: b.y + b.height + 4 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  /* 中途:幽灵芯片必须跟在指针附近(锚定bug时会钉在视口左上角) */
  const ghost = await page.evaluate(({ px, py }) => {
    const g = document.querySelector('.list-ghost');
    if (!g) return null;
    const r = g.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, px, py };
  }, { px: (from.x + to.x) / 2, py: (from.y + to.y) / 2 });
  expect(ghost).not.toBeNull();
  expect(Math.abs(ghost.cx - ghost.px)).toBeLessThan(80);
  expect(Math.abs(ghost.cy - ghost.py)).toBeLessThan(80);
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  const after = (await groups(page)).map((g) => g.key);
  expect(after[after.length - 1]).toBe(before[0]);
  /* 原生干扰源已封:h2/行内 img 不可拖,编辑态无划选 */
  const guards = await page.evaluate(() => ({
    drag: getComputedStyle(document.querySelector('.list-group h2 img')).webkitUserDrag,
    select: getComputedStyle(document.querySelector('.list-group h2')).userSelect
  }));
  expect(guards.select).toBe('none');
  await page.request.post('/api/dev/reset');
});

test('列表染色与画布双向同步,编辑中切视图保留编辑态', async ({ page }) => {
  await enterListEdit(page);
  const row = page.locator('.list-row').first();
  const id = await row.getAttribute('data-match');
  await row.click();
  await page.locator('[data-tool="style"]').click();
  await page.locator('#card-tint-input').evaluate((el) => {
    el.value = '#b91c1c';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('.list-row[data-match="' + id + '"]')).toHaveAttribute('data-tint', '');
  /* 编辑中切画布:互换编辑器,染色同步到卡片 */
  await page.locator('#view-toggle').click();
  await page.waitForSelector('.canvas-card');
  await expect(page.locator('.canvas-card[data-match="' + id + '"]')).toHaveAttribute('data-tint', '');
  await expect(page.locator('#canvas-board')).toHaveClass(/editing/);
  /* 画布改色,切回列表仍编辑态且行染色跟随 */
  await page.locator('#card-tint-input').evaluate((el) => {
    el.value = '#047857';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('#view-toggle').click();
  await page.waitForSelector('body.list-editing');
  const attr = await page.locator('.list-row[data-match="' + id + '"]').evaluate((el) =>
    el.getAttribute('style') || '');
  expect(attr).toContain('--list-tint:#047857');
  await page.request.post('/api/dev/reset');
});

test('阶段整块拖到中间位置生效(非仅首尾)', async ({ page }) => {
  await enterListEdit(page);
  /* 胜者组拖到 败者组 与 总决赛 之间:中间落点曾因 no-op 误判不生效;
   * 落点须拖起后实时取(原组隐藏会使下方组整体上移,拖前坐标全部过期) */
  const h = await page.locator('.list-group h2').first().boundingBox();
  const p0 = { x: h.x + 40, y: h.y + h.height / 2 };
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  await page.mouse.move(p0.x, p0.y + 120, { steps: 6 });
  const live = await page.evaluate(() => {
    const r = document.querySelector('.list-group[data-key="总决赛"] h2').getBoundingClientRect();
    return { x: Math.round(r.left + 60), y: Math.round(r.top + 4) };
  });
  await page.mouse.move(live.x, live.y, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = (await groups(page)).map((g) => g.key);
  expect(after).toEqual(['败者组', '胜者组', '总决赛']);
  await page.request.post('/api/dev/reset');
});

test('原位放下不消失:块/行拖起又放回,行数组序不变', async ({ page }) => {
  await enterListEdit(page);
  const beforeRows = await rows(page);
  const beforeGroups = (await groups(page)).map((g) => g.key);
  /* 消失是视觉性的(原组/原行 display:none 还在 DOM):断言可见行数与残留类 */
  const visState = () => page.evaluate(() => ({
    visible: [...document.querySelectorAll('.list-row')].filter((r) => r.getBoundingClientRect().height > 0).length,
    leftover: document.querySelectorAll('.dragging-origin').length
  }));

  /* 块:拖起组头越过阈值(拖拽真正开始,原组 display:none)再放回原位 */
  const h = await page.locator('.list-group h2').first().boundingBox();
  const p0 = { x: h.x + 40, y: h.y + h.height / 2 };
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  await page.mouse.move(p0.x + 10, p0.y + 60, { steps: 6 });
  await page.mouse.move(p0.x, p0.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(await visState()).toEqual({ visible: beforeRows.length, leftover: 0 });
  expect(await rows(page)).toEqual(beforeRows);
  expect((await groups(page)).map((g) => g.key)).toEqual(beforeGroups);

  /* 行:拖起首行越阈值再放回 */
  const a = await page.locator('.list-row').first().boundingBox();
  const r0 = { x: a.x + a.width * 0.5, y: a.y + a.height / 2 };
  await page.mouse.move(r0.x, r0.y);
  await page.mouse.down();
  await page.mouse.move(r0.x, r0.y + 80, { steps: 5 });
  await page.mouse.move(r0.x, r0.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(await visState()).toEqual({ visible: beforeRows.length, leftover: 0 });
  expect(await rows(page)).toEqual(beforeRows);
  expect((await groups(page)).map((g) => g.key)).toEqual(beforeGroups);
  await page.request.post('/api/dev/reset');
});

test('新列布局:赛制列直出、未开始对阵是 vs、比分并入对阵', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('ts:preferCanvas', '0'));
  await page.goto('/schedule.html');
  await page.waitForSelector('#list-body .list-row');
  const first = page.locator('.list-row').first();
  await expect(first.locator('.list-format')).toHaveText('BO3');
  await expect(first.locator('.list-title')).toBeVisible();
  await expect(first.locator('.list-vs .vs-vs')).toHaveText(' vs ');
  /* 落一局比分后比分嵌入对阵列 */
  await page.evaluate(() => {
    const app = window.TournamentApp;
    app.current.scores.wb_r1_1 = { a: 2, b: 1 };
    return window.TournamentUtils.save();
  });
  await page.reload();
  await page.waitForSelector('#list-body .list-row');
  await expect(page.locator('.list-row').first().locator('.vs-score')).toHaveText('2:1');
  await page.request.post('/api/dev/reset');
});
