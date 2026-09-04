(function () {
  'use strict';

  /* OBS 比分舞台:登录会话读 /api/data,10 秒轮询,resolveCanvas 派生当前对阵。
   * 当前对阵 = 赛事进行中(ongoing)且卡片 ready 未赛的那场;没有则取下一场。
   * 直播时把本页 URL 作为 OBS 浏览器源,比分变化最迟 10 秒自动刷新。
   * 401(未登录/会话过期):清空骨架换全屏登录提示并停轮询,替代报错横幅;
   * 本页不引 common.js,登录遮罩内联实现。 */

  var POLL_MS = 10 * 1000;
  var NEXT_COUNT = 3;
  var inFlight = false;

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  /* 当前对阵:进行中赛事取第一场 ready 未赛;否则也取第一场(画布顺序即赛程顺序) */
  function pickCurrent(record, cards) {
    var ready = cards.filter(function (m) { return m.a && m.b && !m.played && !m.invalid && !m.draw && !m.cycle; });
    return ready.length ? ready[0] : null;
  }

  function pickNext(cards, currentId) {
    return cards.filter(function (m) {
      return m.id !== currentId && m.a && m.b && !m.played && !m.invalid && !m.draw && !m.cycle;
    }).slice(0, NEXT_COUNT);
  }

  function render(record, workspace) {
    /* players 在 workspace 顶层,不在赛事记录内 */
    var names = {};
    ((workspace && workspace.players) || []).forEach(function (p) { names[p.id] = p.name || p.id; });
    if (!record || !record.canvas) {
      el('ss-empty').hidden = false;
      el('ss-empty').textContent = '暂无赛程数据';
      el('ss-now').hidden = true;
      el('ss-next').hidden = true;
      return;
    }
    var resolved = CanvasModel.resolveCanvas(record.canvas, record.roster || [], record.scores || {});
    var cards = resolved.cards;

    el('ss-title').textContent = record.name || '右手杯';
    el('ss-state').textContent = record.status === 'ongoing' ? 'LIVE' : record.status === 'finished' ? '已结束' : '';

    var cur = pickCurrent(record, cards);
    if (cur) {
      el('ss-empty').hidden = true;
      el('ss-now').hidden = false;
      el('ss-a').querySelector('.ss-name').textContent = names[cur.a] || '?';
      el('ss-b').querySelector('.ss-name').textContent = names[cur.b] || '?';
      var s = record.scores && record.scores[cur.id];
      el('ss-score').textContent = s ? (s.a + ':' + s.b) : 'VS';
      el('ss-bo').textContent = cur.format || 'BO3';
    } else {
      el('ss-empty').hidden = false;
      el('ss-empty').textContent = '暂无赛程数据';
      el('ss-now').hidden = true;
    }

    var next = pickNext(cards, cur && cur.id);
    el('ss-next').hidden = !next.length;
    el('ss-next-list').innerHTML = next.map(function (m) {
      return '<li><span class="ss-next-label">' + esc(m.label || m.id) + '</span>' +
        '<span class="ss-next-vs">' + esc(names[m.a] || '?') + ' vs ' + esc(names[m.b] || '?') + '</span></li>';
    }).join('');
  }

  var failCount = 0;
  var loginRequired = false;
  var pollTimer = null;

  /* 401 登录墙:全屏居中提示 + 跳登录按钮,停轮询;登录后按 returnTo 回本页 */
  function requireLogin() {
    loginRequired = true;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    document.body.innerHTML = '<div class="stage-login-required"><p>大屏需要登录后使用。</p>' +
      '<a class="btn btn-primary" href="login.html?returnTo=' + encodeURIComponent(location.pathname) + '"><img class="icon" src="icons/login.svg" alt="" aria-hidden="true">去登录</a></div>';
  }

  function load() {
    /* 重入保护:上一次请求未完成时跳过本轮,防慢响应旧帧覆盖新帧;401 后不再轮询 */
    if (inFlight || loginRequired) return;
    inFlight = true;
    fetch('/api/data', { cache: 'no-store' })
      .then(function (resp) {
        if (resp.status === 401) {
          requireLogin();
          return null;
        }
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        failCount = 0;
        return resp.json();
      })
      .then(function (workspace) {
        /* 401 分流:骨架已换登录遮罩,不再渲染(遮罩后元素已不存在) */
        if (!workspace) return;
        var list = (workspace.tournaments) || [];
        var activeId = workspace.activeId || (list[0] && list[0].id);
        var record = list.filter(function (t) { return t.id === activeId; })[0] || list[0];
        render(record, workspace);
      })
      .catch(function () {
        /* 401 已分流为登录遮罩,不再计入失败帧 */
        if (loginRequired) return;
        /* 网络抖动保持上一帧;持续失败(服务不可达)给出可见提示 */
        failCount += 1;
        if (failCount >= 3) {
          el('ss-empty').hidden = false;
          el('ss-empty').textContent = '暂时无法连接服务器,持续重试中…';
          el('ss-now').hidden = true;
          el('ss-next').hidden = true;
        }
      })
      .then(function () { inFlight = false; });
  }

  load();
  pollTimer = setInterval(load, POLL_MS);
})();
