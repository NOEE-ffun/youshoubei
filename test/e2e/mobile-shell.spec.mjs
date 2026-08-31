import { test, expect } from '@playwright/test';
import { ADMIN_PHONE, smsLogin, seedWorkspace, makePlayer, resetStore } from './helpers.mjs';

/* 移动端壳层适配回归(390×844,2026-08-31 移动端审查修复的防再犯断言):
 * ①底栏「更多」收纳:登录/主题/管理收进弹出层,底栏不再溢出裁切(原 super 11 项宽 515px)
 * ②me#profile:.visually-hidden file 输入不得撑宽布局视口(原 409px 事故),底栏贴底
 * ③stats:分布列窄屏换行,表格回到视口内不再横溢(原 dist-pt 右缘 409 被裁)
 * ④触控目标:行内删除/职业链接 ≥44px,搜索框/职业页签 ≥37px */

test.setTimeout(60_000);

const SNAP = {
  v: 1, resolvedAt: '2026-08-31T00:00:00.000Z', classId: 2, format: 1,
  cards: [
    [10021110, '须臾剑士', 1, 1, 1, 3],
    [10724110, '统音的安纳提玛·吉尔达利娅', 5, 4, 1, 3],
    [10824120, '焦灼炎将·玛尔斯', 4, 4, 1, 2]
  ]
};

function world() {
  return {
    activeId: 't1',
    players: [{ id: 'pz1', name: '选手甲' }, { id: 'pz2', name: '选手乙' }],
    tournaments: [{
      id: 't1', name: '移动端回归届', roster: ['pz1', 'pz2'],
      canvas: {
        cards: [{
          id: 'c1', label: '首场', format: 'BO3',
          slots: [{ type: 'player', playerId: 'pz1' }, { type: 'player', playerId: 'pz2' }],
          classLinks: { a: [{ cls: '皇家', url: 'https://shadowverse-wb.com/x', text: '', deck: SNAP }], b: [] }
        }]
      },
      scores: {}, deckWindow: { manual: 'closed' }, updatedAt: 1
    }]
  };
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const context = page.context();
  await resetStore(context);
  await smsLogin(context, ADMIN_PHONE);
  await seedWorkspace(context, world());
});

test.afterEach(async ({ page }) => {
  await resetStore(page.context());
});

test('底栏「更多」收纳:不溢出,菜单项完整可达,Escape 关闭', async ({ page }) => {
  await page.goto('/schedule.html');
  await page.waitForSelector('#list-body');

  /* super 最坏形态(7 导航+更多)也不得横向溢出 */
  const bar = await page.evaluate(() => {
    const el = document.getElementById('app-sidebar');
    return { sw: el.scrollWidth, cw: el.clientWidth };
  });
  expect(bar.sw).toBeLessThanOrEqual(bar.cw + 1);

  const more = page.locator('#side-more-btn');
  await expect(more).toBeVisible();
  expect((await more.boundingBox()).height).toBeGreaterThanOrEqual(44);

  /* 收纳态:三枚 side-action 藏于弹出层,不占底栏 */
  await expect(page.locator('.side-more-menu')).toBeHidden();

  await more.click();
  await expect(page.locator('.side-more-menu')).toBeVisible();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  /* 真渲染断言:elementFromPoint 命中菜单自身——toBeVisible/boundingBox 测不出
   * overflow:hidden 裁切(曾致点更多无任何视觉反馈而 e2e 照绿) */
  const hitOk = await page.evaluate(() =>
    [...document.querySelectorAll('.side-more-menu .side-action')]
      .filter((el) => el.offsetParent !== null)
      .every((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return top && top.closest('.side-more-menu') !== null;
      }));
  expect(hitOk).toBeTruthy();
  const items = await page.evaluate(() =>
    [...document.querySelectorAll('.side-more-menu .side-action')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => { const r = el.getBoundingClientRect(); return { right: r.right, height: r.height }; }));
  expect(items.length).toBeGreaterThanOrEqual(2);
  for (const it of items) {
    expect(it.right).toBeLessThanOrEqual(391);
    expect(it.height).toBeGreaterThanOrEqual(44);
  }

  await page.keyboard.press('Escape');
  await expect(page.locator('.side-more-menu')).toBeHidden();

  /* 列表视图职业链接(看卡组入口,收在 details 展开区)触控 ≥44 */
  await page.locator('.list-row summary').first().click();
  const lc = await page.locator('.list-class').first().boundingBox();
  expect(lc.height).toBeGreaterThanOrEqual(44);
  expect(lc.width).toBeGreaterThanOrEqual(44);
});

test('海报页:「更多」浮层不被内容遮挡;静态空 toast 不闪入场动画', async ({ page }) => {
  await page.goto('/poster.html');
  await page.waitForSelector('#poster-theme-picker');

  /* vs-poster 面板内容曾叠在浮层之上(elementFromPoint 落到 .field-row) */
  await page.locator('#side-more-btn').click();
  await expect(page.locator('.side-more-menu')).toBeVisible();
  const hitOk = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.side-more-menu .side-action')].filter((el) => el.offsetParent !== null);
    return items.length >= 1 && items.every((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top && top.closest('.side-more-menu') !== null;
    });
  });
  expect(hitOk).toBeTruthy();

  /* 主站通用 .toast 的 toast-in 动画不得作用到海报页静态 #toast(黑底绿边空胶囊闪现) */
  const anim = await page.evaluate(() => {
    const t = document.getElementById('toast');
    return t ? getComputedStyle(t).animationName : 'no-toast';
  });
  expect(anim).toBe('none');
});

test('me#profile:隐藏 file 输入不撑宽视口,底栏贴底', async ({ browser, page }) => {
  const playerCtx = await browser.newContext();
  await makePlayer(playerCtx, '13800002233', 'pz1');
  const p2 = await playerCtx.newPage();
  await p2.setViewportSize({ width: 390, height: 844 });
  await p2.goto('/me.html#profile');
  await p2.waitForSelector('#profile-card', { state: 'visible' });

  const m = await p2.evaluate(() => {
    const bar = document.getElementById('app-sidebar').getBoundingClientRect();
    return {
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      fileW: getComputedStyle(document.getElementById('profile-avatar-file')).width,
      barBottom: bar.y + bar.height
    };
  });
  expect(m.scrollW).toBeLessThanOrEqual(m.innerW);
  expect(m.fileW).toBe('1px');
  expect(m.barBottom).toBeGreaterThan(844 - 80);
  await playerCtx.close();
});

test('stats:分布列窄屏换行,表格不横溢,职业页签触控达标', async ({ page }) => {
  await page.goto('/stats.html');
  await page.waitForSelector('#deck-comp-table tbody tr');

  const m = await page.evaluate(() => {
    const wrap = document.querySelector('.stats-table-wrap');
    const pts = [...document.querySelectorAll('.dist-pt')].map((el) => el.getBoundingClientRect().right);
    const tab = document.querySelector('.deck-comp-tab').getBoundingClientRect();
    return { wsw: wrap.scrollWidth, wcw: wrap.clientWidth, wrapRight: wrap.getBoundingClientRect().right, maxPtRight: Math.max(...pts), tabH: tab.height };
  });
  expect(m.wsw).toBeLessThanOrEqual(m.wcw + 1);
  expect(m.maxPtRight).toBeLessThanOrEqual(m.wrapRight + 1);
  expect(m.tabH).toBeGreaterThanOrEqual(37);
});

test('触控:选手库行内删除/头像 ≥44px,搜索框 ≥37px', async ({ page }) => {
  await page.goto('/players.html');
  await page.waitForSelector('.row-del');

  expect((await page.locator('.row-del').first().boundingBox()).height).toBeGreaterThanOrEqual(44);
  const av = await page.locator('.avatar-btn').first().boundingBox();
  expect(Math.min(av.width, av.height)).toBeGreaterThanOrEqual(44);
  expect((await page.locator('.header-search input').first().boundingBox()).height).toBeGreaterThanOrEqual(37);
});
