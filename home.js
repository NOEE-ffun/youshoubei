(function () {
  'use strict';

  /* 主页跑马灯：读取当前比赛选手（名字 + 头像），横向无缝滚动展示。
   * 数据联动复用 common.js 的存储层（window.TournamentApp），
   * 头像渲染复用全局 avatarMarkup。 */

  /* 共享工具（escapeHtml/medalMap）统一来自 common.js */
  const { escapeHtml, medalMap } = window.TournamentUtils;

  function renderMarquee() {
    const app = window.TournamentApp;
    const record = app && app.current;
    if (!record || !Array.isArray(record.players)) return;
    const players = record.players;
    if (!players.length) {
      for (const id of ['marquee-track', 'marquee-track-reverse']) {
        const track = document.getElementById(id);
        if (track) track.innerHTML = '';
      }
      return;
    }
    const medalOf = medalMap(record);
    const items = players.map((player) => {
      const medal = medalOf.get(player.id);
      return (
        '<div class="marquee-item' + (medal ? ' medal-' + medal.type : '') + '">' +
        (medal ? '<span class="medal-badge">' + medal.emoji + '</span>' : '') +
        avatarMarkup(player, 'avatar-lg') +
        '<span class="marquee-name">' + escapeHtml(player.name) + '</span>' +
        '</div>'
      );
    }).join('');
    /* 无缝滚动：内容重复两份，轨道平移 -50% 即一个完整循环 */
    const doubled = items + items;
    const track = document.getElementById('marquee-track');
    const reverseTrack = document.getElementById('marquee-track-reverse');
    if (track) track.innerHTML = doubled;
    if (reverseTrack) reverseTrack.innerHTML = doubled;
  }

  document.addEventListener('ts:ready', () => {
    renderMarquee();
    /* 选手信息变更时（改名/换头像）联动刷新 */
    document.addEventListener('ts:changed', renderMarquee);
  });

  /* 初始化数据层（复用 common.js：IndexedDB/云端读取、页头渲染） */
  window.TournamentAppInit('home');
})();
