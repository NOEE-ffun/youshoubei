import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, seedWorkspace, makePlayer, resetStore } from './helpers.mjs';

/* 卡组构成分析 e2e(DECK_RESOLVE_FIXTURE_DIR fixture 模式,全程不出网):
 * ①种子快照 → 统计页四列表(卡名稀有度着色/费/携带率/分布)+ 未解析计数 + 非 admin 无回填钮
 * ②无快照 → admin 点「解析存量卡组」→ 真实 fixture 解析 → 表格出现
 * ③公示锁:窗口开他人卡组不入统计;关窗后出现
 * ④选手提交 WB 链接:无感(无 toast)+ cls 以解析结果自动纠错 */

test.setTimeout(90_000);

const WB_URL = 'https://shadowverse-wb.com/chs/deck/detail/?hash=1.2.cEZs.cEZs.cEZs.cEaA.dmyk.dmyk.dmyk.e9NO.eXnk.eXnu.eXnu.eXnu.evTW.evTW.evTW.evi-.evi-.evi-.evj8.evj8.evj8.evm6.evm6.evm6.evyc.evyc.evyc.ewCE.ewCE.ewCE.ewCO.ewCO.ewCO.fIAc.fIck.fIck.fIck.fIcu.fIcu.fh1O';

const SNAP_A = {
  v: 1, resolvedAt: '2026-08-31T00:00:00.000Z', classId: 2, format: 1,
  cards: [
    [10021110, '须臾剑士', 1, 1, 1, 3],
    [10724110, '统音的安纳提玛·吉尔达利娅', 5, 4, 1, 3],
    [10999120, '超费验证卡', 12, 1, 1, 1]
  ]
};
const SNAP_B = {
  v: 1, resolvedAt: '2026-08-31T00:00:00.000Z', classId: 2, format: 1,
  cards: [
    [10021110, '须臾剑士', 1, 1, 1, 2],
    [10824120, '焦灼炎将·玛尔斯', 4, 4, 1, 1]
  ]
};

function world(deckWindow, entries) {
  return {
    activeId: 't1',
    players: [{ id: 'pz1', name: '选手甲' }, { id: 'pz2', name: '选手乙' }],
    tournaments: [{
      id: 't1', name: '卡组构成届', roster: ['pz1', 'pz2'],
      canvas: {
        cards: [{
          id: 'c1', label: '首场', format: 'BO3',
          slots: [{ type: 'player', playerId: 'pz1' }, { type: 'player', playerId: 'pz2' }],
          classLinks: { a: entries, b: [] }
        }]
      },
      scores: {}, deckWindow, updatedAt: 1
    }]
  };
}

test('统计页:快照聚合携带率表格 + 稀有度着色 + 未解析计数', async ({ browser }) => {
  const adminCtx = await browser.newContext();
  await resetStore(adminCtx);
  await smsLogin(adminCtx, ADMIN_PHONE);
  await seedWorkspace(adminCtx, world({ manual: 'closed' }, [
    { cls: '皇家', url: 'https://shadowverse-wb.com/chs/deck/detail/?hash=1.2.aaaa.bbbb', text: '', deck: SNAP_A },
    { cls: '皇家', url: 'https://shadowverse-wb.com/chs/deck/detail/?hash=1.3.cccc.dddd', text: '', deck: SNAP_B },
    { cls: '皇家', url: 'https://other.example', text: '未解析' }
  ]));

  /* 非 admin 视角:表格可看,回填按钮隐藏 */
  const viewCtx = await browser.newContext();
  await smsLogin(viewCtx, '13800001234');
  const page = await viewCtx.newPage();
  await page.goto('/stats.html');
  await page.waitForSelector('#deck-comp-table');

  /* 皇家自动选中,分段带副数 */
  const activeTab = page.locator('#deck-class-tabs .deck-comp-tab[aria-pressed="true"]');
  await expect(activeTab).toContainText('皇家');
  await expect(activeTab).toContainText('2');

  const rows = page.locator('#deck-comp-table tbody tr');
  await expect(rows).toHaveCount(4, '四种卡');
  /* 表头三列:费用(竖排窄列)|卡名|分布 */
  await expect(page.locator('#deck-comp-table thead th')).toHaveText(['费用', '卡名', '分布(3·2·1·0)']);
  /* 排序:费用升序 → 稀有度升序(须臾1费 → 焦灼4费 → 统音5费 → 超费12费) */
  await expect(rows.nth(0).locator('.deck-name-r1')).toContainText('须臾剑士');
  await expect(rows.nth(0).locator('.cost-icon')).toHaveAttribute('src', 'icons/cost/cost-1.png');
  await expect(rows.nth(0)).toContainText('50%·50%·0%·0%');
  await expect(rows.nth(0).locator('.dist-bar')).toBeVisible();
  /* 百分比着色:非 0 段按红3/黄2 着色加粗,0 段保持弱化灰 */
  await expect(rows.nth(0).locator('.dist-text .dist-pt')).toHaveCount(2);
  await expect(rows.nth(0).locator('.dist-text .dist-pt').first()).toHaveClass(/p3/);
  await expect(rows.nth(0).locator('.dist-text .dist-pt').nth(1)).toHaveClass(/p2/);
  await expect(rows.nth(1).locator('.deck-name-r4')).toContainText('焦灼炎将·玛尔斯');
  await expect(rows.nth(1)).toContainText('0%·0%·50%·50%');
  await expect(rows.nth(2).locator('.deck-name-r4')).toContainText('统音的安纳提玛');
  await expect(rows.nth(2)).toContainText('50%·0%·0%·50%');
  /* 费用 ≥10 统一用 10+ 图标(渲染层钳制,排序仍按真实费用) */
  await expect(rows.nth(3).locator('.deck-name-r1')).toContainText('超费验证卡');
  await expect(rows.nth(3).locator('.cost-icon')).toHaveAttribute('src', 'icons/cost/cost-10.png');

  await expect(page.locator('#deck-comp-foot')).toContainText('共 2 副');
  await expect(page.locator('#deck-comp-foot')).toContainText('1 条链接未解析');
  await expect(page.locator('#deck-backfill-btn')).toBeHidden();
  await adminCtx.close();
});

test('管理端回填:未解析链接 → 解析存量卡组 → 表格出现', async ({ browser }) => {
  const adminCtx = await browser.newContext();
  await resetStore(adminCtx);
  await smsLogin(adminCtx, ADMIN_PHONE);
  await seedWorkspace(adminCtx, world({ manual: 'closed' }, [
    { cls: '皇家', url: WB_URL, text: '' }
  ]));

  const page = await adminCtx.newPage();
  await page.goto('/stats.html');
  await page.waitForSelector('#deck-comp-table');
  await expect(page.locator('#deck-comp-table tbody')).toContainText('暂无已解析');
  await expect(page.locator('#deck-backfill-btn')).toBeVisible();

  await page.locator('#deck-backfill-btn').click();
  await expect(page.locator('.toast')).toContainText('解析完成:成功 1 · 失败 0');
  /* revalidateWorkspace → ts:changed → 重渲出表 */
  await expect(page.locator('#deck-comp-table tbody tr')).toHaveCount(17, '真实卡组 17 种卡');
  await expect(page.locator('#deck-comp-table tbody')).toContainText('须臾剑士');
  await expect(page.locator('#deck-comp-table tbody')).toContainText('真红与群青·塞达&贝阿朵丽丝');
  await expect(page.locator('#deck-comp-foot')).toContainText('共 1 副');
  await adminCtx.close();
});

test('公示锁:窗口开他人卡组不入统计,关窗后出现', async ({ browser }) => {
  const adminCtx = await browser.newContext();
  await resetStore(adminCtx);
  await smsLogin(adminCtx, ADMIN_PHONE);
  const entry = { cls: '皇家', url: 'https://shadowverse-wb.com/chs/deck/detail/?hash=1.2.aaaa.bbbb', text: '', deck: SNAP_A };
  await seedWorkspace(adminCtx, world({ manual: 'open' }, [entry]));

  /* 非 admin、非所属选手:stripHiddenDecks 剥离 → 不入统计 */
  const viewCtx = await browser.newContext();
  await smsLogin(viewCtx, '13800001234');
  const page = await viewCtx.newPage();
  await page.goto('/stats.html');
  await page.waitForSelector('#deck-comp-table');
  await expect(page.locator('#deck-comp-table tbody')).toContainText('暂无已解析');

  /* 关窗公示 → 全员可见(清 SWR 缓存再刷新,避开 60s 内命中剥离版旧缓存) */
  await seedWorkspace(adminCtx, world({ manual: 'closed' }, [entry]));
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('#deck-comp-table');
  await expect(page.locator('#deck-comp-table tbody tr')).toHaveCount(3);
  await viewCtx.close();
  await adminCtx.close();
});

test('晋级继承去重:选手流动未换卡组,同一副只计一副', async ({ browser }) => {
  const adminCtx = await browser.newContext();
  await resetStore(adminCtx);
  await smsLogin(adminCtx, ADMIN_PHONE);
  /* c1 甲胜乙(a:2 b:0)→ 甲流入 c2;c2 自己未交(空数组=继承)→ 同一副卡组
   * 在 c1(自有)与 c2(继承)各出现一次,聚合必须只计一副 */
  await seedWorkspace(adminCtx, {
    activeId: 't1',
    players: [{ id: 'pz1', name: '选手甲' }, { id: 'pz2', name: '选手乙' }],
    tournaments: [{
      id: 't1', name: '流动届', roster: ['pz1', 'pz2'],
      canvas: {
        cards: [
          { id: 'c1', label: '首场', format: 'BO3', slots: [{ type: 'player', playerId: 'pz1' }, { type: 'player', playerId: 'pz2' }],
            classLinks: { a: [{ cls: '皇家', url: 'https://shadowverse-wb.com/chs/deck/detail/?hash=1.2.aaaa.bbbb', text: '', deck: SNAP_A }], b: [] } },
          { id: 'c2', label: '次场', format: 'BO3', slots: [{ type: 'flow', cardId: 'c1', outcome: 'winner' }, { type: 'empty' }],
            classLinks: { a: [], b: [] } }
        ], edges: []
      },
      scores: { c1: { a: 2, b: 0 } },
      deckWindow: { manual: 'closed' }, updatedAt: 1
    }]
  });

  const page = await adminCtx.newPage();
  await page.goto('/stats.html');
  await page.waitForSelector('#deck-comp-table');
  const rows = page.locator('#deck-comp-table tbody tr');
  await expect(rows).toHaveCount(3, 'SNAP_A 三种卡(去重后仍只计一副)');
  await expect(rows.nth(0)).toContainText('须臾剑士');
  await expect(rows.nth(0)).toContainText('100%·0%·0%·0%');
  await expect(rows.nth(1)).toContainText('统音的安纳提玛');
  await expect(page.locator('#deck-comp-foot')).toContainText('共 1 副');
  await adminCtx.close();
});

test('选手提交 WB 链接:无感无 toast + cls 自动纠错', async ({ browser }) => {
  const adminCtx = await browser.newContext();
  await resetStore(adminCtx);
  await smsLogin(adminCtx, ADMIN_PHONE);
  await seedWorkspace(adminCtx, world({ manual: 'open' }, []));

  const playerCtx = await browser.newContext();
  await makePlayer(playerCtx, '13800005555', 'pz1');
  const page = await playerCtx.newPage();
  await page.goto('/me.html#decks');
  await page.reload(); /* 同 URL 含 hash 的 goto 不重载 */
  await page.waitForSelector('#my-decks-body', { state: 'visible' });
  await expect(page.locator('#my-decks-window-state')).toContainText('开放中');

  /* 故意选错职业(精灵),链接实为皇家卡组 */
  const form = page.locator('.md-form').first();
  await form.locator('.md-cls').first().selectOption('精灵');
  await form.locator('.md-url').first().fill(WB_URL);
  await form.locator('[data-md-save]').click();
  await page.waitForTimeout(1500);

  /* 无感提交:不出现任何 toast */
  await expect(page.locator('.toast')).toHaveCount(0);

  /* 服务端(fixture 解析):快照落库 + cls 纠错为皇家 */
  const r = await adminCtx.request.get('/api/data');
  expect(r.ok()).toBeTruthy();
  const data = await r.json();
  const entry = data.tournaments[0].canvas.cards[0].classLinks.a[0];
  expect(entry.cls).toBe('皇家');
  expect(entry.deck && entry.deck.classId).toBe(2);
  expect(entry.deck.cards).toHaveLength(17);
  expect(entry.deck.cards.reduce((s, c) => s + c[5], 0)).toBe(40);
  await playerCtx.close();
  await adminCtx.close();
});
