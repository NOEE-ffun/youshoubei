(function () {
  'use strict';

  /* 主页跑马灯：读取当前比赛选手（名字 + 头像），横向无缝滚动展示。
   * 数据联动复用 common.js 的存储层（window.TournamentApp），
   * 头像渲染复用全局 avatarMarkup。 */

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));
  }

  function renderMarquee() {
    const app = window.TournamentApp;
    const record = app && app.current;
    const track = document.getElementById('marquee-track');
    if (!track || !record || !Array.isArray(record.players)) return;
    const players = record.players;
    if (!players.length) {
      track.innerHTML = '';
      return;
    }
    const items = players.map((player) =>
      '<div class="marquee-item">' +
      avatarMarkup(player, 'avatar-md') +
      '<span class="marquee-name">' + escapeHtml(player.name) + '</span>' +
      '</div>'
    ).join('');
    /* 无缝滚动：内容复制两份，轨道平移 -50% 即一个完整循环 */
    track.innerHTML = items + items;
  }

  document.addEventListener('ts:ready', () => {
    renderMarquee();
    /* 选手信息变更时（改名/换头像）联动刷新 */
    document.addEventListener('ts:changed', renderMarquee);
  });

  /* 初始化数据层（复用 common.js：IndexedDB/云端读取、页头渲染） */
  window.TournamentAppInit('home');
})();
