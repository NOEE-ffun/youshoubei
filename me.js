'use strict';

/**
 * 选手中心:统一登录守卫 + 四 tab(我的对局/我的比赛/资料与账号/发码中心)。
 * 旧页 my-decks/my-tourneys/profile 已合并到此,hash 路由 #decks/#tourneys/#profile/#codes;
 * 未登录显示统一空态;playerOnly 需绑选手,adminOnly(发码中心)需 admin/super 角色。
 */
(function () {
  const $ = (id) => document.getElementById(id);

  const TABS = [
    { id: 'decks', btn: 'me-tab-decks', panel: 'me-panel-decks', playerOnly: true },
    { id: 'tourneys', btn: 'me-tab-tourneys', panel: 'me-panel-tourneys', playerOnly: true },
    { id: 'profile', btn: 'me-tab-profile', panel: 'me-panel-profile', playerOnly: false },
    { id: 'codes', btn: 'me-tab-codes', panel: 'me-panel-codes', adminOnly: true }
  ];

  let activeTab = null;
  let allowedIds = new Set();

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
    /* tab 门:playerOnly 需已绑选手;adminOnly(发码中心)需 admin/super。
     * user.role 即后端 effectiveRole(super/admin/player/user) */
    const role = user.role;
    const allowed = TABS.filter((t) =>
      (t.playerOnly ? Boolean(player) : true) && (t.adminOnly ? (role === 'admin' || role === 'super') : true));
    allowedIds = new Set(allowed.map((t) => t.id));
    for (const t of TABS) $(t.btn).hidden = !allowedIds.has(t.id);
    const hash = (location.hash || '').slice(1);
    showTab(allowed.some((t) => t.id === hash) ? hash : allowed[0].id);
  }

  for (const t of TABS) {
    $(t.btn).addEventListener('click', () => showTab(t.id));
  }
  /* 已在本页时点导航链接是 fragment 导航(不重载),监听 hash 变化切换 tab;
   * 仅允许切到本角色可见的 tab(防手改 #codes 越权看隐藏面板) */
  window.addEventListener('hashchange', () => {
    if ($('me-shell').hidden) return;
    const hash = (location.hash || '').slice(1);
    if (allowedIds.has(hash)) showTab(hash);
  });
  $('me-login-btn').addEventListener('click', () => {
    window.TournamentApp.openLoginDialog();
  });

  document.addEventListener('ts:ready', boot);
  window.TournamentAppInit('me').catch((error) => {
    if (window.TournamentApp) window.TournamentApp.fatalError(error);
  });
})();
