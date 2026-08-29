'use strict';

/**
 * 总览工作台:当前对阵 / 最新战报 / 接下来,全部由画布数据现算,
 * 不引入新的数据源。布局与入场动效见 styles.css 的 ov-* 段。
 */
(function () {
  const { escapeHtml, avatarMarkup, formatStartTime } = window.TournamentUtils;

  const STATUS = {
    upcoming: { text: '未开始', cls: 'status-upcoming' },
    ongoing: { text: '进行中', cls: 'status-ongoing' },
    finished: { text: '已结束', cls: 'status-finished' }
  };

  const $ = (id) => document.getElementById(id);

  function playerById(id) {
    return (window.TournamentApp.players || []).find((p) => p.id === id) || null;
  }

  function nameOf(id) {
    const p = id && playerById(id);
    return p ? p.name : '待定';
  }

  /* 画布场次分类:已结束 / 待打(双方齐) */
  function splitCards(record) {
    const resolved = CanvasModel.resolveCanvas(record.canvas, record.roster || [], record.scores || {});
    const played = [];
    const upcoming = [];
    const total = resolved.cards.filter((m) => !m.invalid);
    for (const m of total) {
      if (m.played || m.draw) played.push(m);
      else if (m.a && m.b) upcoming.push(m);
    }
    return { played, upcoming, total: total.length };
  }

  function scoreOf(m) {
    return (m.scoreA == null ? '?' : m.scoreA) + ':' + (m.scoreB == null ? '?' : m.scoreB);
  }

  function renderHead(record, playedTotal, total) {
    const status = STATUS[record.status] || STATUS.upcoming;
    const parts = [];
    if (total) parts.push(playedTotal + '/' + total + ' 场已结束');
    if (record.startTime) parts.push('开赛 ' + formatStartTime(record.startTime));
    if (!parts.length) parts.push('画布可自由编排对阵');
    $('ov-head').innerHTML =
      '<div class="ov-title-group">' +
      '<h2 class="ov-title">' + escapeHtml(record.name || '未命名赛事') + '</h2>' +
      '<span class="status-badge ' + status.cls + '"><span class="status-dot" aria-hidden="true"></span>' + status.text + '</span>' +
      '</div>' +
      '<div class="ov-head-meta">' + escapeHtml(parts.join(' · ')) + '</div>' +
      '<div class="ov-head-actions">' +
      '<a class="btn btn-primary" href="schedule.html">查看赛程</a>' +
      '</div>';
    $('ov-head').hidden = false;
  }

  function duelHtml(m) {
    const a = playerById(m.a);
    const b = playerById(m.b);
    const meta = [(m.label || m.id), (m.phase || ''), (m.format || '')].filter(Boolean).join(' · ');
    return '<div class="ov-duel">' +
      '<div class="ov-side">' + avatarMarkup(a, 'avatar-lg') + '<span class="ov-side-name">' + escapeHtml(nameOf(m.a)) + '</span></div>' +
      '<div class="ov-mid"><span class="ov-vs">VS</span></div>' +
      '<div class="ov-side">' + avatarMarkup(b, 'avatar-lg') + '<span class="ov-side-name">' + escapeHtml(nameOf(m.b)) + '</span></div>' +
      '</div>' +
      '<p class="ov-duel-meta">' + escapeHtml(meta) + '</p>';
  }

  function recentHtml(played) {
    /* 画布顺序末端 = 最深阶段,倒序取 3 当「最新战报」 */
    const items = played.slice(-3).reverse();
    if (!items.length) return '<p class="ov-empty">还没有已结束的对局。</p>';
    return items.map((m) => {
      const decided = m.played && !m.draw;
      const aWin = decided && m.scoreA > m.scoreB;
      const bWin = decided && m.scoreB > m.scoreA;
      return '<div class="ov-item">' +
        '<span class="ov-item-label">' + escapeHtml(m.label || m.id) + '</span>' +
        '<span class="ov-item-players">' +
        '<span class="' + (aWin ? 'win' : '') + '">' + escapeHtml(nameOf(m.a)) + '</span>' +
        ' vs ' +
        '<span class="' + (bWin ? 'win' : '') + '">' + escapeHtml(nameOf(m.b)) + '</span>' +
        '</span>' +
        '<span class="ov-item-score">' + escapeHtml(scoreOf(m)) + '</span>' +
        '</div>';
    }).join('');
  }

  function upcomingHtml(list) {
    if (!list.length) return '<p class="ov-empty">对阵等待晋级产生。</p>';
    return list.slice(0, 3).map((m) =>
      '<div class="ov-item">' +
      '<span class="ov-item-label">' + escapeHtml(m.label || m.id) + '</span>' +
      '<span class="ov-item-players">' + escapeHtml(nameOf(m.a)) + ' vs ' + escapeHtml(nameOf(m.b)) + '</span>' +
      '</div>'
    ).join('');
  }

  function renderGrid(record) {
    const { played, upcoming } = splitCards(record);

    /* 当前对阵:进行中取待打第一场;全打完/未编排给出对应空态 */
    let nowInner;
    let nowTitle = '当前对阵';
    if (upcoming.length) {
      nowInner = duelHtml(upcoming[0]);
    } else if (played.length) {
      nowInner = '<p class="ov-empty">已安排的对局均已结束。</p>';
    } else {
      nowTitle = '赛事前瞻';
      nowInner = '<p class="ov-empty">对阵尚未编排,等待晋级或手动指派。</p>';
    }

    $('ov-grid').innerHTML =
      '<article class="ov-card ov-now" style="--ov-i:0"><h2>' + nowTitle + '</h2>' + nowInner + '</article>' +
      '<article class="ov-card" style="--ov-i:1"><h2>最新战报</h2>' + recentHtml(played) + '</article>' +
      '<article class="ov-card" style="--ov-i:2"><h2>接下来</h2>' + upcomingHtml(upcoming.slice(1)) + '</article>';
    $('ov-grid').hidden = false;
  }

  function render() {
    const record = window.TournamentApp && window.TournamentApp.current;
    const hasData = Boolean(record && record.canvas && record.canvas.cards && record.canvas.cards.length);
    $('ov-head').hidden = !hasData;
    $('ov-grid').hidden = !hasData;
    $('ov-blank').hidden = hasData;
    if (!hasData) return;
    const { played, total } = splitCards(record);
    renderHead(record, played.length, total);
    renderGrid(record);
  }

  document.addEventListener('ts:ready', render);
  document.addEventListener('ts:changed', render);
  window.TournamentAppInit('home').catch((error) => {
    if (window.TournamentApp) window.TournamentApp.fatalError(error);
  });
})();
