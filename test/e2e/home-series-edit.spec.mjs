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
