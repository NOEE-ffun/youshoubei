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

  /* 比赛已分出冠亚季军时,返回 playerId → 奖牌信息 的映射;未结束返回空 Map */
  function medalMap(record) {
    const map = new Map();
    if (!record || !Array.isArray(record.players)) return map;
    const standings = BracketModel.deriveStandings(
      record.players.map((p) => p.id),
      record.scores || {}
    );
    if (!standings.champion) return map;
    if (standings.champion) map.set(standings.champion, { type: 'gold', emoji: '🥇' });
    if (standings.runnerUp) map.set(standings.runnerUp, { type: 'silver', emoji: '🥈' });
    if (standings.thirdPlace) map.set(standings.thirdPlace, { type: 'bronze', emoji: '🥉' });
    return map;
  }

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
