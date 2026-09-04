import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, seedWorkspace, resetStore } from './helpers.mjs';

/* 无限画布:四向无边界(2026-09-04 前左上有硬墙)——
 * 负坐标卡片渲染归一(包围盒左上对到 DOM 0,0)、键盘微调可负、
 * 鼠标拖拽可拖入负象限且落点即时归一(offsetLeft 恒 ≥0)。 */

test.setTimeout(60_000);

function world() {
  return {
    activeId: 't1',
    players: [{ id: 'pz1', name: '选手甲' }, { id: 'pz2', name: '选手乙' }],
    tournaments: [{
      id: 't1', name: '无限画布届', roster: ['pz1', 'pz2'],
      canvas: { grid: 'dot', cards: [
        { id: 'ca', label: '负卡', format: 'BO3', x: -4, y: -2,
          slots: [{ type: 'player', playerId: 'pz1' }, { type: 'player', playerId: 'pz2' }] },
        { id: 'cb', label: '正卡', format: 'BO3', x: 10, y: 1,
          slots: [{ type: 'player', playerId: 'pz2' }, { type: 'player', playerId: 'pz1' }] }
      ] },
      scores: {}, updatedAt: 1
    }]
  };
}

async function cardX(page, id) {
  const data = await page.request.get('/api/data').then((r) => r.json());
  const t = (data.tournaments || []).find((x) => x.id === 't1');
  const card = t.canvas.cards.find((c) => c.id === id);
  return card ? card.x : null;
}

test('无限画布:负坐标渲染归一 + 微调/拖拽可入负象限', async ({ page }) => {
  const context = page.context();
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);
  await seedWorkspace(context, world());

  await page.goto('/schedule.html');
  await page.waitForSelector('.canvas-card');

  /* 1. 渲染归一:最负卡片落在 DOM(0,0),板尺寸覆盖包围盒 */
  const geom = await page.evaluate(() => {
    const { DOT, CARD_WIDTH, CARD_HEIGHT } = window.CanvasModel;
    const board = document.getElementById('canvas-board');
    const ca = board.querySelector('.canvas-card[data-match="ca"]');
    const cb = board.querySelector('.canvas-card[data-match="cb"]');
    return {
      dot: DOT, cardW: CARD_WIDTH, cardH: CARD_HEIGHT,
      boardW: parseFloat(board.style.width), boardH: parseFloat(board.style.height),
      caLeft: ca.offsetLeft, caTop: ca.offsetTop,
      cbLeft: cb.offsetLeft, cbTop: cb.offsetTop
    };
  });
  expect(geom.caLeft).toBe(0);
  expect(geom.caTop).toBe(0);
  expect(geom.cbLeft).toBe((10 - (-4)) * geom.dot);
  expect(geom.cbTop).toBe((1 - (-2)) * geom.dot);
  expect(geom.boardW).toBe((10 - (-4)) * geom.dot + geom.cardW + 40);
  expect(geom.boardH).toBe(Math.max(400, (1 - (-2)) * geom.dot + geom.cardH + 40));

  /* 负卡在视口内可见(自适应以内容包围盒为准) */
  await expect(page.locator('.canvas-card[data-match="ca"] .match-title')).toContainText('负卡');

  /* 2. 键盘微调可负:x=-4 → ArrowLeft → -5,保存往返后渲染仍归一 */
  await page.locator('#header-edit-btn').click();
  await page.waitForSelector('.canvas-board.editing');
  await page.locator('.canvas-card[data-match="ca"] .match-head').click();
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(1100); /* 防抖 500 + 落盘 + 重渲染 */
  expect(await cardX(page, 'ca')).toBe(-5);
  const leftAfter = await page.evaluate(() =>
    document.querySelector('.canvas-card[data-match="ca"]').offsetLeft);
  expect(leftAfter).toBe(0);

  /* 3. 鼠标把正卡拖入负象限:模型 x<0,DOM 坐标即时归一(≥0) */
  const head = await page.locator('.canvas-card[data-match="cb"] .match-head').boundingBox();
  await page.mouse.move(head.x + head.width * 0.3, head.y + 8);
  await page.mouse.down();
  /* 左拖 6 个点以上(缩放最小时也 >4 点),逐步移动防误判为点击 */
  for (let i = 1; i <= 12; i += 1) {
    await page.mouse.move(head.x + head.width * 0.3 - i * 40, head.y + 8 - i * 4);
  }
  await page.mouse.up();
  await page.waitForTimeout(1100);
  expect(await cardX(page, 'cb')).toBeLessThan(0);
  const cbLeft = await page.evaluate(() =>
    document.querySelector('.canvas-card[data-match="cb"]').offsetLeft);
  expect(cbLeft).toBeGreaterThanOrEqual(0);
  await expect(page.locator('.canvas-card[data-match="cb"] .match-title')).toContainText('正卡');
});
