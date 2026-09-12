import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, seedWorkspace, resetStore } from './helpers.mjs';

/* 内容审查·方案甲四链 E2E(合成词纪律:全程只用「测试违禁甲/乙/丙」,
 * 绝不经测试触碰 deploy/ 真实词表;拒绝文案固定话术,断言不含词本身):
 * ① 昵称拒审——含合成违禁词的昵称 400 且文案不回显词,改回正常昵称 200;
 * ② 举报流转——选手页侧边栏「举报/投诉」提交 → 超管后台「审查」标签出现条目 →
 *    name-reset(行内手填选手 ID)→ 选手名与绑定账号昵称双改「选手+尾4」;
 * ③ 词库即时生效——超管审查标签词库表单加词 → 该词立刻拒写(改昵称 400,
 *    文案不含词)→ chip 删词 → 同一昵称恢复可写(e2e 环境不依赖 deploy 种子:
 *    CI 无种子文件、本机有种子均成立,词审生效全靠用例内动态增删合成词);
 * ④ 模板名拒审——保存模板名含合成违禁词 PUT /api/templates 400,不落库。
 * 种子铁律:涉画布 grid:'dot';每条用例收尾 /api/dev/reset 清内存存储。 */

test.setTimeout(60_000);

const PHONE_USER_A = '13800006211'; /* ①/③ 选手账号(注册即自动建档) */
const PHONE_USER_B = '13800006222'; /* ② 举报提交者 */

/* 造一个已登录的超管浏览器上下文(词库增删 API 用;与主上下文会话隔离) */
async function makeSuperContext(browser) {
  const ctx = await browser.newContext();
  await smsLogin(ctx, ADMIN_PHONE);
  return ctx;
}

/* 词库增删(super API):容忍「已存在/不存在」400——前次失败运行的残留词
 * 不让本用例在清理步上二次红(moderation 单例词表在 /api/dev/reset 后仍在内存) */
async function wordAction(ctx, action, word) {
  const r = await ctx.request.post('/api/moderation/words', { data: { action, word } });
  expect(r.ok() || r.status() === 400, 'wordAction ' + action + ' 容忍重复增删').toBeTruthy();
  return r;
}

test('① 昵称拒审:含合成违禁词的昵称 400 文案不回显,改回正常昵称成功', async ({ page, context, browser }) => {
  await resetStore(context);
  const WORD = '测试违禁甲';

  /* e2e 环境词审生效的唯一来源:super 词库 API 动态加合成词 */
  const superCtx = await makeSuperContext(browser);
  await wordAction(superCtx, 'add', WORD);

  await smsLogin(context, PHONE_USER_A);
  const before = (await (await context.request.get('/api/me')).json()).user.nickname;
  await page.goto('/me.html#profile');
  await expect(page.locator('#nickname-form')).toBeVisible();

  /* 改昵称为含合成词昵称 → 400;状态行红字文案不含词本身;昵称未落库 */
  await page.locator('#account-nickname').fill('昵称夹' + WORD + '片段');
  const putStatuses = [];
  page.on('response', (r) => {
    if (r.request().method() === 'PUT' && r.url().includes('/api/me')) putStatuses.push(r.status());
  });
  await page.locator('#nickname-form button[type="submit"]').click();
  await expect(page.locator('#redeem-status')).toContainText('不允许的词汇');
  await expect(page.locator('#redeem-status')).not.toContainText(WORD);
  expect(putStatuses.at(-1), '违禁昵称 PUT 应 400').toBe(400);
  const afterBad = (await (await context.request.get('/api/me')).json()).user.nickname;
  expect(afterBad, '拒绝先于落库,昵称保持原值').toBe(before);

  /* 改回正常昵称 → 200 且落库 */
  await page.locator('#account-nickname').fill('E2E 正常昵称');
  await page.locator('#nickname-form button[type="submit"]').click();
  await expect(page.locator('#redeem-status')).toContainText('昵称已保存');
  expect(putStatuses.at(-1), '正常昵称 PUT 应 200').toBe(200);
  const afterOk = (await (await context.request.get('/api/me')).json()).user.nickname;
  expect(afterOk).toBe('E2E 正常昵称');

  await wordAction(superCtx, 'remove', WORD); /* 词表清理:不渗入后续用例 */
  await superCtx.close();
  await resetStore(context);
});

test('② 举报流转:侧边栏提交 → 后台审查标签条目 → name-reset 双改选手名与昵称', async ({ page, context, browser }) => {
  await resetStore(context);
  const REPORT_DETAIL = 'E2E 举报:某选手昵称不妥,请管理员核实处理';

  /* 选手登录 → 侧边栏「举报/投诉」→ 弹窗默认违规昵称 → 提交 */
  const userCtx = await browser.newContext();
  await smsLogin(userCtx, PHONE_USER_B);
  const userPage = await userCtx.newPage();
  await userPage.goto('/me.html');
  await expect(userPage.locator('#report-btn'), '登录态侧边栏举报入口').toBeVisible();
  await userPage.locator('#report-btn').click();
  const dlg = userPage.locator('#report-dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('input[name="report-kind"][value="nickname"]')).toBeChecked();
  await dlg.locator('#report-detail').fill(REPORT_DETAIL);
  await dlg.locator('button[type="submit"]').click();
  await expect(dlg).toBeHidden();
  await expect(userPage.locator('.toast', { hasText: '举报已提交' })).toBeVisible();

  const me = await (await userCtx.request.get('/api/me')).json();
  const playerId = me.player && me.player.id;
  expect(playerId, '注册即选手:登录自动建档').toBeTruthy();

  /* 超管后台「审查」标签:举报条目出现(类型/内容/待处理) */
  await smsLogin(context, ADMIN_PHONE);
  await page.goto('/admin.html#review');
  await page.waitForSelector('#admin-reports-tbody tr');
  const row = page.locator('#admin-reports-tbody tr', { hasText: REPORT_DETAIL });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('违规昵称');
  await expect(row).toContainText('待处理');

  /* name-reset:行内手填选手 ID → confirm → 行变已处理(回执状态行随即被
   * loadReports 汇总覆盖,系 users/notices 面板同款既有模式——断言落在行态) */
  await row.locator('input[data-report-player]').fill(playerId);
  page.once('dialog', (d) => d.accept());
  await row.locator('button[data-act="name-reset"]').click();
  await expect(page.locator('#admin-reports-tbody tr', { hasText: REPORT_DETAIL })).toContainText('已改名');

  /* 双改钉:player.name 与绑定账号 nickname 同变「选手+尾4」 */
  const expected = '选手' + String(playerId).slice(-4);
  const data = await (await context.request.get('/api/data')).json();
  const player = (data.players || []).find((p) => p.id === playerId);
  expect(player.name).toBe(expected);
  const meAfter = await (await userCtx.request.get('/api/me')).json();
  expect(meAfter.user.nickname).toBe(expected);

  await userPage.close();
  await userCtx.close();
  await resetStore(context);
});

test('③ 词库即时生效:后台加词立刻拒写,删词恢复可写', async ({ page, context, browser }) => {
  await resetStore(context);
  const WORD = '测试违禁乙';
  const BAD_NICK = '昵称带' + WORD + '拒绝';

  /* 超管审查标签词库表单加词(不走 API:同链测「后台词库管理」UI 面) */
  await smsLogin(context, ADMIN_PHONE);
  await page.goto('/admin.html#review');
  await expect(page.locator('#admin-words-form')).toBeVisible();
  await page.locator('#admin-words-input').fill(WORD);
  await page.locator('#admin-words-form button[type="submit"]').click();
  await expect(page.locator('#admin-words-status')).toContainText('已添加');
  await expect(page.locator('#admin-words-list .admin-word-chip', { hasText: WORD })).toHaveCount(1);

  /* 加词即时生效:选手改昵称(同一端点)立刻 400,文案不含词 */
  const userCtx = await browser.newContext();
  await smsLogin(userCtx, PHONE_USER_A);
  const bad = await userCtx.request.put('/api/me/player', { data: { nickname: BAD_NICK } });
  expect(bad.status(), '加词后昵称应立刻拒写').toBe(400);
  const badBody = await bad.json();
  expect(badBody.error).toContain('不允许的词汇');
  expect(badBody.error).not.toContain(WORD);

  /* chip 删词(confirm)→ 同一昵称恢复可写并落库 */
  page.once('dialog', (d) => d.accept());
  await page.locator('#admin-words-list .admin-word-chip', { hasText: WORD }).locator('.admin-word-del').click();
  await expect(page.locator('#admin-words-status')).toContainText('已删除');
  const ok = await userCtx.request.put('/api/me/player', { data: { nickname: BAD_NICK } });
  expect(ok.status(), '删词后同一昵称应恢复可写').toBe(200);
  const meAfter = await (await userCtx.request.get('/api/me')).json();
  expect(meAfter.user.nickname).toBe(BAD_NICK);

  await userCtx.close();
  await resetStore(context);
});

test('④ 模板名拒审:保存名含合成违禁词 400 不落库', async ({ page, context }) => {
  await resetStore(context);
  const WORD = '测试违禁丙';

  /* 主上下文即超管:词库 API 加合成词后,再种一届单卡画布(grid 铁律:'dot') */
  await smsLogin(context, ADMIN_PHONE);
  const add = await context.request.post('/api/moderation/words', { data: { action: 'add', word: WORD } });
  expect(add.ok()).toBeTruthy();
  await seedWorkspace(context, {
    series: [],
    tournaments: [{
      id: 'tt', name: '审查测试届', status: 'ongoing', startTime: null,
      roster: [], scores: {}, matchDecks: {}, rules: null,
      schemaVersion: 2, createdAt: 1, updatedAt: 1,
      canvas: {
        grid: 'dot', size: { cols: 48, rows: 32 }, style: { opacity: 0.7, blur: 8 },
        cards: [
          { id: 't_a', kind: 'match', label: 'A', phase: '', format: 'BO3', x: 2, y: 1, w: 10, h: 7,
            slots: [{ type: 'empty' }, { type: 'empty' }],
            exitRanks: {}, deckCount: null, color: null, classLinks: { a: [], b: [] } }
        ]
      }
    }],
    activeId: 'tt',
    players: []
  });

  /* 进编辑 → 选中卡 → 保存至模板:名含合成词 → PUT 400,toast 文案不含词 */
  await page.goto('/schedule.html');
  await page.waitForSelector('.canvas-card');
  await page.locator('#header-edit-btn').click();
  await page.waitForSelector('.canvas-board.editing');
  await page.locator('.canvas-card[data-match="t_a"] .match-head').click();
  await expect(page.locator('#card-panel')).toBeVisible();
  await page.locator('#tpl-save-btn').click();
  const dlg = page.locator('dialog.tpl-prompt');
  await expect(dlg).toBeVisible();
  const tplPuts = [];
  page.on('response', (r) => {
    if (r.request().method() === 'PUT' && r.url().includes('/api/templates')) tplPuts.push(r.status());
  });
  await dlg.locator('#tpl-prompt-input').fill('模板名' + WORD + '测试');
  await dlg.locator('[data-tpl-prompt-ok]').click();
  await expect(dlg).toBeHidden();
  const toast = page.locator('.toast', { hasText: '保存失败' });
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('不允许的词汇');
  await expect(toast).not.toContainText(WORD);
  expect(tplPuts.at(-1), '违禁模板名 PUT 应 400').toBe(400);

  /* 未落库:个人库不出现该模板(空库) */
  const lib = await (await context.request.get('/api/templates')).json();
  expect(lib.templates.some((t) => t.name.includes(WORD))).toBe(false);
  expect(lib.templates).toHaveLength(0);

  /* 词表清理 + 收尾 */
  const rm = await context.request.post('/api/moderation/words', { data: { action: 'remove', word: WORD } });
  expect(rm.ok()).toBeTruthy();
  await resetStore(context);
});
