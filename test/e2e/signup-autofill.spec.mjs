import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { ADMIN_PHONE, smsLogin, seedWorkspace, resetStore } from './helpers.mjs';

/* 报名取前 N + 自动填入全链路(开发内存云端,PUT /api/data 自举):
 * 开放期名单编号/候补弱化/自动弹开 → 关报名撤"已报名"留编号 →
 * 设置 N>空位拦截 → 自动填入前 N 覆盖入场卡。
 * 2026-08-30 权限重构后:自举 PUT 与数据核验走超管会话(旧 Bearer 口令退役);
 * 2026-09-01 注册即选手合并后种子走 seedWorkspace(自动保留被绑档案,防 409);
 * 登录墙下查看视角也是登录用户(player 级,不涉卡组剥离)。 */

const require = createRequire(import.meta.url);
const CM = require('../../canvas-model.js');

const P = ['sp1', 'sp2', 'sp3', 'sp4', 'sp5'];

function workspace(signup) {
  return {
    activeId: 't1',
    players: P.map((id, i) => ({ id, name: '选' + (i + 1) + '号' })),
    tournaments: [{
      id: 't1', name: 'E2E取前N届', status: 'upcoming', startTime: null,
      rules: '', roster: [], canvas: CM.createDefaultCanvas([]), scores: {},
      matchDecks: {}, signup, createdAt: 1, updatedAt: 1
    }]
  };
}

test('报名:取前N编号展示 → 关闭留编号撤标记 → 自动填入', async ({ browser, request }) => {
  await request.post('/api/dev/reset');
  const adminCtx = await browser.newContext();
  await smsLogin(adminCtx, ADMIN_PHONE);
  await seedWorkspace(adminCtx, workspace({ open: true, players: P, slots: 4 }));

  /* ---- 1. 登录用户视角:开放期名单自动弹开,按报名先后编号,第 5 人候补弱化 ---- */
  const viewerCtx = await browser.newContext();
  await smsLogin(viewerCtx, '13800007771');
  const viewer = await viewerCtx.newPage();
  await viewer.goto('/schedule.html');
  await viewer.waitForSelector('.canvas-card');
  await expect(viewer.locator('.roster-dropdown')).toBeVisible();
  const nums = viewer.locator('.roster-dropdown .roster-sign-num');
  await expect(nums).toHaveCount(5);
  await expect(nums.nth(4)).toHaveClass(/reserve/);
  await expect(nums.nth(0)).not.toHaveClass(/reserve/);
  await expect(viewer.locator('.roster-dropdown .roster-signed-only')).toHaveCount(5);
  /* ts:session 晚于首渲会重绘并关下拉:自动弹开必须恢复(回归:曾被视为渲染关闭) */
  await viewer.waitForTimeout(1500);
  await expect(viewer.locator('.roster-dropdown')).toBeVisible();
  /* 手动关闭后不强开 */
  await viewer.locator('#header-roster-btn').click();
  await expect(viewer.locator('.roster-dropdown')).toHaveCount(0);
  await viewer.waitForTimeout(600);
  await expect(viewer.locator('.roster-dropdown')).toHaveCount(0);
  await viewerCtx.close();

  /* ---- 2. 关报名:不自动弹开,点开后编号保留、"已报名"标记撤销 ---- */
  await seedWorkspace(adminCtx, workspace({ open: false, players: P, slots: 4 }));
  const viewer2Ctx = await browser.newContext();
  await smsLogin(viewer2Ctx, '13800007772');
  const viewer2 = await viewer2Ctx.newPage();
  await viewer2.goto('/schedule.html');
  await viewer2.waitForSelector('.canvas-card');
  await expect(viewer2.locator('.roster-dropdown')).toHaveCount(0);
  await viewer2.locator('#header-roster-btn').click();
  await expect(viewer2.locator('.roster-dropdown .roster-sign-num')).toHaveCount(5);
  await expect(viewer2.locator('.roster-dropdown .roster-signed-only')).toHaveCount(0);
  await viewer2Ctx.close();

  /* ---- 3. 管理端:N>空位保存被拦截;改回合法值后自动填入 ---- */
  const admin = await adminCtx.newPage();
  await admin.goto('/schedule.html');
  await admin.waitForTimeout(800);
  await admin.locator('#settings-btn').click();
  await admin.waitForSelector('#settings-form');
  await expect(admin.locator('#signup-slots')).toHaveValue('4');
  await expect(admin.locator('#signup-slots-hint')).toContainText('当前入场空位 8 个');
  await admin.locator('#signup-slots').fill('9');
  await admin.locator('#settings-form button[type="submit"]').click();
  await expect(admin.locator('.toast-danger')).toContainText('不能大于空位数');
  await admin.locator('#settings-form [data-dialog-close]').click();
  await admin.waitForTimeout(300);

  await admin.locator('#settings-btn').click();
  await admin.waitForSelector('#settings-form');
  await admin.locator('#signup-slots').fill('4');
  await admin.locator('#signup-autofill').click();
  await expect(admin.getByText('已随机填入 4 名选手')).toBeVisible();
  await admin.waitForTimeout(800);

  /* ---- 4. 数据核验:前 4 名洗牌落入场卡,候补第 5 人不上场,报名名单原样 ---- */
  const resp = await adminCtx.request.get('/api/data');
  const data = await resp.json();
  const rec = data.tournaments.find((t) => t.id === 't1');
  const entries = CM.entryCards(rec.canvas);
  expect(entries.map((c) => c.id)).toEqual(['wb_r1_1', 'wb_r1_2', 'wb_r1_3', 'wb_r1_4']);
  const entrySlots = entries.flatMap((c) => c.slots);
  const filled = entrySlots.filter((s) => s.type === 'player').map((s) => s.playerId).sort();
  expect(filled).toEqual(['sp1', 'sp2', 'sp3', 'sp4']);
  expect(entrySlots.filter((s) => s.type === 'empty')).toHaveLength(4);
  expect(rec.roster.sort()).toEqual(['sp1', 'sp2', 'sp3', 'sp4'].sort());
  expect(rec.signup).toEqual({ open: false, players: P, slots: 4 });

  await adminCtx.close();
  await request.post('/api/dev/reset');
});
