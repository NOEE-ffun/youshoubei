'use strict';

/**
 * 选手中心:统一登录守卫 + 三 tab(我的对局/我的比赛/资料与账号)。
 * 旧页 my-decks/my-tourneys/profile 已合并到此,hash 路由 #decks/#tourneys/#profile;
 * 未登录显示统一空态;管理员(未绑选手)只开放「资料与账号」。
 */
(function () {
  const $ = (id) => document.getElementById(id);

  const TABS = [
    { id: 'decks', btn: 'me-tab-decks', panel: 'me-panel-decks', playerOnly: true },
    { id: 'tourneys', btn: 'me-tab-tourneys', panel: 'me-panel-tourneys', playerOnly: true },
    { id: 'profile', btn: 'me-tab-profile', panel: 'me-panel-profile', playerOnly: false }
  ];

  let activeTab = null;

  function showTab(id) {
    const tab = TABS.find((t) => t.id === id) || TABS[0];
    if (activeTab === tab.id) return;
    activeTab = tab.id;
    for (const t of TABS) {
      const on = t === tab;
      $(t.btn).classList.toggle('is-active', on);
      $(t.btn).setAttribute('aria-selected', String(on));
      $(t.panel).hidden = !on;
    }
    try { history.replaceState(null, '', '#' + tab.id); } catch (error) { /* 忽略 */ }
  }

  async function boot() {
    const app = window.TournamentApp;
    const fail = (text, showLogin) => {
      $('me-shell').hidden = true;
      $('me-empty').hidden = false;
      $('me-empty-text').textContent = text;
      $('me-login-btn').hidden = !showLogin;
    };
    if (app.mode !== 'cloud') {
      fail('选手中心需要连接服务器(当前为本机数据模式)。', false);
      return;
    }
    await app.refreshSession();
    const { user, player } = app.getSession();
    if (!user) {
      fail('未登录。', true);
      return;
    }
    $('me-empty').hidden = true;
    $('me-shell').hidden = false;
    /* 管理员(未绑选手):仅资料 tab;选手:三 tab 全开 */
    const allowed = TABS.filter((t) => player || !t.playerOnly);
    for (const t of TABS) $(t.btn).hidden = !allowed.includes(t);
    const hash = (location.hash || '').slice(1);
    showTab(allowed.some((t) => t.id === hash) ? hash : allowed[0].id);
  }

  for (const t of TABS) {
    $(t.btn).addEventListener('click', () => showTab(t.id));
  }
  /* 已在本页时点导航链接是 fragment 导航(不重载),监听 hash 变化切换 tab */
  window.addEventListener('hashchange', () => {
    if ($('me-shell').hidden) return;
    const hash = (location.hash || '').slice(1);
    if (TABS.some((t) => t.id === hash)) showTab(hash);
  });
  $('me-login-btn').addEventListener('click', () => {
    window.TournamentApp.openLoginDialog();
  });

  document.addEventListener('ts:ready', boot);
  window.TournamentAppInit('me').catch((error) => {
    if (window.TournamentApp) window.TournamentApp.fatalError(error);
  });
})();
