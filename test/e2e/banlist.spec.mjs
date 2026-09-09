import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, seedWorkspace, makePlayer, resetStore } from './helpers.mjs';

/* 禁卡表全链:设置弹窗录入(粘码批量加禁=张数即限档、中立基本卡占位忽略;搜索-单卡不变)→ 顶栏下拉 → CardForm 绑表 → 画布标红+弹层 → 公示锁可见性。
 * 种子直接内联 deck 快照(判定只读快照,不出网);粘码用 fixture 现有 hash。 */
test.setTimeout(90_000);

const BL = [{ id: 'bl1', name: '第一周表', cards: [
  [501, '终焉之炎', 8, 4, 0],   /* 禁用 */
  [502, '苍蓝少女', 3, 3, 1]    /* 限1 */
] }];

function deckWith(cards, cls) {
  return { cls, url: 'https://shadowverse-wb.com/chs/deck/detail/?hash=1.2.banlist', text: '',
    deck: { v: 1, resolvedAt: 1, classId: 2, format: null, cards } };
}

function seedTournament(extra) {
  return Object.assign({
    id: 'tb1', name: '禁卡表测试届', status: 'ongoing', rules: 'BO3 单败', createdAt: 1, updatedAt: 1,
    canvas: { cards: [{ id: 'k1', label: '决赛', phase: '', format: 'BO3', x: 0, y: 0,
      slots: [{ type: 'player', playerId: 'pz1' }, { type: 'player', playerId: 'pz2' }],
      exitRanks: { winner: 1, loser: 2 }, deckCount: null, color: null,
      classLinks: { a: [deckWith([[501, '终焉之炎', 8, 4, 0, 1], [999, '白板卡', 1, 1, 0, 3]], '皇家')],
                    b: [deckWith([[502, '苍蓝少女', 3, 3, 0, 2]], '精灵')] },
      banListIds: ['bl1'] }], style: {} },
    scores: {}, roster: ['pz1', 'pz2'], banLists: BL
  }, extra || {});
}

test.beforeEach(async ({ request }) => { await request.post('/api/dev/reset'); });
test.afterEach(async ({ request }) => { await request.post('/api/dev/reset'); });

test('下拉展示:表名/排序/禁与限标记,无表届隐藏按钮', async ({ browser }) => {
  const ctx = await browser.newContext();
  await smsLogin(ctx, ADMIN_PHONE);
  const page = await ctx.newPage();
  await seedWorkspace(ctx, {
    tournaments: [seedTournament(), { id: 'tb0', name: '无表届', status: 'ongoing', createdAt: 1, updatedAt: 1,
      canvas: { cards: [{ id: 'k0', label: '唯一卡', phase: '', format: 'BO3', x: 0, y: 0,
        slots: [{ type: 'empty' }, { type: 'empty' }], exitRanks: {}, deckCount: null, color: null, classLinks: { a: [], b: [] } }], style: {} },
      scores: {}, roster: [] }],
    activeId: 'tb1',
    players: [{ id: 'pz1', name: '甲', createdAt: 1, updatedAt: 1 }, { id: 'pz2', name: '乙', createdAt: 1, updatedAt: 1 }]
  });
  await page.goto('/schedule.html');
  await page.waitForTimeout(900);
  await expect(page.locator('#header-banlist-btn')).toBeVisible();
  await page.locator('#header-banlist-btn').click();
  const dd = page.locator('.banlist-dropdown');
  await expect(dd).toBeVisible();
  await expect(dd.locator('.rules-dropdown-head')).toContainText('第一周表(2)');
  /* 排序:苍蓝少女(3费)在终焉之炎(8费)前;禁=block 图标,限1=文字 */
  const names = await dd.locator('.banlist-name').allInnerTexts();
  expect(names).toEqual(['苍蓝少女', '终焉之炎']);
  await expect(dd.locator('.banlist-row').first().locator('.banlist-mark.lim')).toHaveText('限1');
  await expect(dd.locator('.banlist-row').nth(1).locator('.banlist-mark.ban img')).toBeVisible();
  /* 切到无表届:按钮隐藏(#tournament-switch option value=届 id,common.js 2230 行) */
  await page.locator('#header-banlist-btn').click(); /* 关闭 */
  await page.selectOption('#tournament-switch', 'tb0');
  await page.waitForTimeout(700);
  await expect(page.locator('#header-banlist-btn')).toBeHidden();
  await ctx.close(); /* 手建 context 用例收尾必关:残留页 60s 校新会把旧工作区合并写回,污染后续用例(deck-flow 同款纪律) */
});

test('画布标红+点击弹违规清单', async ({ browser }) => {
  const ctx = await browser.newContext();
  await smsLogin(ctx, ADMIN_PHONE);
  const page = await ctx.newPage();
  await seedWorkspace(ctx, { tournaments: [seedTournament()], activeId: 'tb1',
    players: [{ id: 'pz1', name: '甲', createdAt: 1, updatedAt: 1 }, { id: 'pz2', name: '乙', createdAt: 1, updatedAt: 1 }] });
  await page.goto('/schedule.html');
  await page.waitForTimeout(900);
  const badges = page.locator('.class-slot.ban-violated');
  await expect(badges).toHaveCount(2); /* a 侧禁用1项 + b 侧超限1项 */
  await expect(badges.first()).toContainText('1');
  await badges.nth(1).click();
  const pop = page.locator('.ban-popover');
  await expect(pop).toBeVisible();
  await expect(pop.locator('.ban-pop-listname')).toHaveText(['第一周表']);
  await expect(pop.locator('.banlist-name')).toHaveText(['苍蓝少女']);
  await expect(pop.locator('.ban-pop-meta')).toContainText('带 2 张 / 限1');
  /* 点外部关闭 */
  await page.locator('body').click({ position: { x: 10, y: 300 } });
  await expect(pop).toBeHidden();
  await ctx.close();
});

test('隐藏期可见性:锁侧不显徽标;公示期全员可见', async ({ browser }) => {
  /* deckWindow 手动开(隐藏期):观众看锁不看徽标;关(公示):徽标可见 */
  const openRec = seedTournament({ id: 'tb2', deckWindow: { open: '', close: '', manual: 'open' } });
  const adminCtx = await browser.newContext();
  await smsLogin(adminCtx, ADMIN_PHONE);
  await seedWorkspace(adminCtx, { tournaments: [openRec], activeId: 'tb2',
    players: [{ id: 'pz1', name: '甲', createdAt: 1, updatedAt: 1 }, { id: 'pz2', name: '乙', createdAt: 1, updatedAt: 1 }] });
  const viewerCtx = await browser.newContext();
  await makePlayer(viewerCtx, '13800005555', 'pz2'); /* 乙:b 侧所属,能看 b 不能看 a */
  const viewer = await viewerCtx.newPage();
  await viewer.goto('/schedule.html');
  await viewer.waitForTimeout(900);
  await expect(viewer.locator('.cl-locked')).toHaveCount(1);       /* a 侧锁 */
  const vBadges = viewer.locator('.class-slot.ban-violated');
  await expect(vBadges).toHaveCount(1);                            /* 仅 b 侧自己的 */
  /* 管理员隐藏期看两侧 */
  const admin = await adminCtx.newPage();
  await admin.goto('/schedule.html');
  await admin.waitForTimeout(900);
  await expect(admin.locator('.class-slot.ban-violated')).toHaveCount(2);
  await viewerCtx.close();
  await adminCtx.close();
});

test('设置弹窗录入:粘码批量加禁(张数=限档,占位忽略)+搜索单卡+保存持久', async ({ browser }) => {
  const ctx = await browser.newContext();
  await smsLogin(ctx, ADMIN_PHONE);
  const page = await ctx.newPage();
  await seedWorkspace(ctx, { tournaments: [seedTournament({ banLists: undefined })], activeId: 'tb1',
    players: [{ id: 'pz1', name: '甲', createdAt: 1, updatedAt: 1 }, { id: 'pz2', name: '乙', createdAt: 1, updatedAt: 1 }] });
  await page.goto('/schedule.html');
  await page.waitForTimeout(900);
  await page.locator('#settings-btn').click();
  await page.locator('#banlist-add-btn').click();
  await page.locator('.bl-name').fill('新表');
  /* 粘码批量:fixture 牌组 40 张 = 2 占位(3+2)+禁卡甲×3+限卡乙×2+单卡丙×1+填充×29 */
  await page.locator('.bl-paste-input').fill('https://shadowverse-wb.com/chs/deck/detail/?hash=1.2.bn01.bn01.bn01.bn02.bn02.bn03.bn03.bn03.bn04.bn04.bn05.bn06.bn06.bn06.bn07.bn07.bn07.bn08.bn08.bn08.bn09.bn09.bn09.bn10.bn10.bn10.bn11.bn11.bn11.bn12.bn12.bn12.bn13.bn13.bn13.bn14.bn14.bn14.bn15.bn15');
  await page.locator('.bl-paste-btn').click();
  await page.waitForTimeout(600);
  const rows = page.locator('.bl-row');
  await expect(rows).toHaveCount(13); /* fixture 15 种卡 - 2 占位 = 13 */
  const names = await page.locator('.bl-row .banlist-name').allInnerTexts();
  expect(names, '占位卡不入表').not.toContain('不屈的剑斗士');
  expect(names, '占位卡不入表').not.toContain('商队猛犸象');
  /* 张数→限档:×3=禁用,×2=限2,×1=限1(按行内卡名定位各自 select) */
  const limitOf = async (name) => page.locator('.bl-row', { hasText: name }).locator('.bl-limit').inputValue();
  await expect.poll(() => limitOf('禁卡甲')).toBe('0');
  await expect.poll(() => limitOf('限卡乙')).toBe('2');
  await expect.poll(() => limitOf('单卡丙')).toBe('1');
  /* 搜索-单卡加禁不变:候选池含种子快照卡,搜"终焉" */
  await page.locator('.bl-search').fill('终焉');
  await expect(page.locator('.bl-hit .banlist-name')).toHaveText(['终焉之炎']);
  await page.locator('.bl-hit').first().click();
  await expect(rows).toHaveCount(14);
  /* 终焉之炎默认禁用;改限2 后保存 */
  await page.locator('.bl-row', { hasText: '终焉之炎' }).locator('.bl-limit').selectOption('2');
  await page.locator('#settings-form button[type="submit"]').click();
  await page.waitForTimeout(800);
  /* 重开设置仍在;下拉出现 */
  await page.locator('#settings-btn').click();
  await expect(rows).toHaveCount(14);
  await expect(page.locator('.bl-row', { hasText: '终焉之炎' }).locator('.bl-limit')).toHaveValue('2');
  await page.locator('#settings-form button[type="submit"]').click();
  await page.waitForTimeout(500);
  await page.locator('#header-banlist-btn').click();
  await expect(page.locator('.banlist-dropdown .banlist-row', { hasText: '终焉之炎' }).locator('.banlist-mark.lim')).toHaveText('限2');
  await ctx.close();
});

test('CardForm 绑表:e2e 勾选生效', async ({ browser }) => {
  const ctx = await browser.newContext();
  await smsLogin(ctx, ADMIN_PHONE);
  const page = await ctx.newPage();
  /* 种子:有表+快照含禁卡,但卡未绑表 → 无徽标;编辑模式勾选后出现 */
  const rec = seedTournament();
  rec.canvas.cards[0].banListIds = [];
  await seedWorkspace(ctx, { tournaments: [rec], activeId: 'tb1',
    players: [{ id: 'pz1', name: '甲', createdAt: 1, updatedAt: 1 }, { id: 'pz2', name: '乙', createdAt: 1, updatedAt: 1 }] });
  await page.goto('/schedule.html');
  await page.waitForTimeout(900);
  await expect(page.locator('.class-slot.ban-violated')).toHaveCount(0);
  /* 选中卡开抽屉面板(与 canvas-edit-panel.spec.mjs 同法:auto-fit 下点画布卡) */
  await page.waitForSelector('.canvas-card');
  await page.locator('#header-edit-btn').click();
  await page.waitForSelector('.canvas-board.editing');
  await page.locator('.canvas-card').first().click();
  await expect(page.locator('#card-panel')).toBeVisible();
  const checks = page.locator('#card-panel .cf-banlist-check');
  await expect(checks).toHaveCount(1);
  await checks.first().check();
  await page.waitForTimeout(600); /* 抽屉实时应用 */
  await expect(page.locator('.class-slot.ban-violated')).toHaveCount(2);
  await ctx.close();
});
