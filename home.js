'use strict';

/**
 * 总览工作台:当前对阵 / 最新战报 / 接下来,全部由画布数据现算,
 * 不引入新的数据源。布局与入场动效见 styles.css 的 ov-* 段。
 */
(function () {
  const { escapeHtml, avatarMarkup, formatStartTime, notify, errMsg, groupTournamentsBySeries, canManage, openLightbox } = window.TournamentUtils;

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
    /* 多于一届才显示切换下拉;占位项固定显示「切换比赛」——
     * 选中后 setActiveId → ts:changed → 本函数重写 innerHTML,下拉复位占位文字 */
    const list = (window.TournamentApp.list || []).filter((t) => t && t.id);
    const switcher = list.length > 1
      ? '<select id="ov-tournament" class="header-select" aria-label="切换比赛">' +
        '<option value="" disabled selected hidden>切换比赛</option>' +
        list.map((t) =>
          '<option value="' + escapeHtml(t.id) + '">' +
          escapeHtml(t.name || t.id) + '</option>'
        ).join('') +
        '</select>'
      : '';
    $('ov-head').innerHTML =
      '<div class="ov-title-group">' +
      '<h2 class="ov-title">' + escapeHtml(record.name || '未命名赛事') + '</h2>' +
      switcher +
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

  /* 比赛总览单行(状况 + 进度),行内排序与点击切换行为与旧版一致 */
  function tournamentRow(t, currentId) {
    const st = STATUS[t.status] || STATUS.upcoming;
    const meta = [];
    if (t.canvas && t.canvas.cards && t.canvas.cards.length) {
      const { played, total } = splitCards(t);
      meta.push(played.length + '/' + total + ' 场已结束');
    } else {
      meta.push('未编排');
    }
    if (t.startTime) meta.push('开赛 ' + formatStartTime(t.startTime));
    const cur = t.id === currentId;
    return '<button type="button" class="ov-t-row' + (cur ? ' is-current' : '') + '" data-id="' + escapeHtml(t.id) + '"' +
      (cur ? ' aria-current="true"' : '') + ' title="' + (cur ? '当前比赛' : '点击切换到该比赛') + '">' +
      '<span class="ov-t-name">' + escapeHtml(t.name || t.id) + '</span>' +
      '<span class="status-badge ' + st.cls + '"><span class="status-dot" aria-hidden="true"></span>' + st.text + '</span>' +
      '<span class="ov-t-meta">' + escapeHtml(meta.join(' · ')) + '</span>' +
      '</button>';
  }

  /* 比赛总览:按系列分组的嵌套列表(系列名小节标题+届数计数),
   * 无 seriesId / 孤儿 seriesId / 系列名为空的届归末尾「未分组」;
   * 系列顺序 = workspace.series 数组序,届行排序与点击行为不变。
   * 小节标题旁「编辑」按钮仅 canManage(series) 者可见(super 恒可,
   * admin 需本人创建),点击唤出 common.js 的系列弹窗改名称/简介 */
  function renderTournaments(currentId) {
    const list = (window.TournamentApp.list || []).filter((t) => t && t.id);
    const box = $('ov-tournaments');
    if (!list.length) {
      box.hidden = true;
      return;
    }
    const seriesList = window.TournamentApp.series || [];
    box.innerHTML =
      '<h2>比赛总览</h2>' +
      groupTournamentsBySeries(list, seriesList).map((group) => {
        const series = group.id != null
          ? seriesList.find((s) => s && s.id === group.id)
          : null;
        const editBtn = series && canManage(series)
          ? '<button type="button" class="btn btn-ghost btn-sm ov-t-edit" data-series-edit="' +
            escapeHtml(series.id) + '" title="编辑系列" aria-label="编辑系列 ' +
            escapeHtml(group.label) + '">编辑</button>'
          : '';
        return '<section class="ov-t-group">' +
        '<h3 class="ov-t-group-title">' + escapeHtml(group.label) +
        '<span class="ov-t-group-count">' + group.count + ' 届</span>' + editBtn + '</h3>' +
        group.items.map((t) => tournamentRow(t, currentId)).join('') +
        '</section>';
      }).join('');
    box.hidden = false;
  }

  function render() {
    const app = window.TournamentApp;
    const record = app && app.current;
    const list = (app && app.list ? app.list : []).filter((t) => t && t.id);
    const hasData = Boolean(record && record.canvas && record.canvas.cards && record.canvas.cards.length);
    $('ov-head').hidden = !hasData;
    $('ov-grid').hidden = !hasData;
    $('ov-blank').hidden = list.length > 0;
    renderTournaments(record && record.id);
    if (!hasData) return;
    const { played, total } = splitCards(record);
    renderHead(record, played.length, total);
    renderGrid(record);
  }

  /* 届切换:下拉与总览行共用一套切换逻辑(事件委托,适配重渲染) */
  function switchTo(id) {
    window.TournamentApp.setActiveId(id)
      .then(() => document.dispatchEvent(new CustomEvent('ts:changed')))
      .catch((error) => notify('切换比赛失败：' + errMsg(error), 'danger'));
  }

  document.addEventListener('change', (event) => {
    if (event.target.id === 'ov-tournament' && event.target.value) switchTo(event.target.value);
  });

  document.addEventListener('click', (event) => {
    /* 系列小节标题旁「编辑系列」:唤出 common.js 系列弹窗(noMerge 精确流保存) */
    const seriesBtn = event.target.closest('[data-series-edit]');
    if (seriesBtn) {
      const series = (window.TournamentApp.series || [])
        .find((s) => s && s.id === seriesBtn.dataset.seriesEdit);
      if (series && window.TournamentApp.openSeriesDialog) {
        window.TournamentApp.openSeriesDialog(series);
      }
      return;
    }
    const row = event.target.closest('.ov-t-row');
    if (!row || row.classList.contains('is-current')) return;
    switchTo(row.dataset.id);
  });

  /* ---------- 通知横幅(独立于 workspace,GET /api/notices;失败静默) ---------- */

  const DISMISS_KEY = 'ts:dismissedNotices';
  const NOTICE_ROTATE_MS = 5000;

  let noticeItems = [];
  let noticeIndex = 0;
  let noticeTimer = null;

  function dismissedIds() {
    try {
      const v = JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  function rememberDismissed(id) {
    const ids = dismissedIds();
    if (!ids.includes(id)) {
      ids.push(id);
      try { localStorage.setItem(DISMISS_KEY, JSON.stringify(ids)); } catch { /* 忽略 */ }
    }
  }

  function noticeSlideHtml(n, i) {
    /* 动作:有收款码=整条可点弹灯箱(不另设按钮);仅链接=文字链,外链新标签开 */
    const action = n.qrImage
      ? ''
      : (n.linkUrl
        ? '<a class="notice-action" href="' + escapeHtml(n.linkUrl) + '" target="_blank" rel="noopener">' +
          escapeHtml(n.linkText || '查看') + '</a>'
        : '');
    const close = n.dismissible === false
      ? ''
      : '<button type="button" class="notice-close" data-notice-close="1" aria-label="关闭此通知">×</button>';
    /* class 与附加属性分开拼:收款码的 role/tabindex 不能混进 class 串(引号会截断属性) */
    const cls = 'notice-slide level-' + (n.level === 'important' ? 'important' : 'info') +
      (n.qrImage ? ' notice-has-qr' : '') + (i === noticeIndex ? ' is-active' : '');
    const attrs = n.qrImage ? ' role="button" tabindex="0" aria-label="点开收款码大图"' : '';
    return '<div class="' + cls + '"' + attrs + ' data-slide="' + i + '">' +
      '<span class="notice-text">' + escapeHtml(n.text) + '</span>' + action + close + '</div>';
  }

  function renderNotices() {
    const box = $('notice-banner');
    if (noticeTimer) { clearInterval(noticeTimer); noticeTimer = null; }
    if (!noticeItems.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    if (noticeIndex >= noticeItems.length) noticeIndex = 0;
    box.innerHTML =
      '<div class="notice-track">' + noticeItems.map(noticeSlideHtml).join('') + '</div>' +
      (noticeItems.length > 1
        ? '<div class="notice-dots" role="tablist" aria-label="通知切换">' + noticeItems.map((n, i) =>
            '<button type="button" class="notice-dot' + (i === noticeIndex ? ' is-active' : '') +
            '" data-dot="' + i + '" aria-label="第 ' + (i + 1) + ' 条通知"></button>'
          ).join('') + '</div>'
        : '');
    box.hidden = false;
    if (noticeItems.length > 1) {
      noticeTimer = setInterval(() => {
        noticeIndex = (noticeIndex + 1) % noticeItems.length;
        syncActiveSlide();
      }, NOTICE_ROTATE_MS);
    }
  }

  function syncActiveSlide() {
    const box = $('notice-banner');
    box.querySelectorAll('.notice-slide').forEach((el) => {
      el.classList.toggle('is-active', Number(el.dataset.slide) === noticeIndex);
    });
    box.querySelectorAll('.notice-dot').forEach((el) => {
      el.classList.toggle('is-active', Number(el.dataset.dot) === noticeIndex);
    });
  }

  /* 关闭当前条:记忆 id → 立即轮到下一条;全关=隐藏横幅 */
  function dismissCurrent() {
    const n = noticeItems[noticeIndex];
    if (!n || n.dismissible === false) return;
    rememberDismissed(n.id);
    noticeItems.splice(noticeIndex, 1);
    if (noticeIndex >= noticeItems.length) noticeIndex = 0;
    renderNotices();
  }

  $('notice-banner').addEventListener('click', (event) => {
    if (event.target.closest('[data-notice-close]')) {
      dismissCurrent();
      return;
    }
    const dot = event.target.closest('[data-dot]');
    if (dot) {
      noticeIndex = Number(dot.dataset.dot);
      syncActiveSlide();
      return;
    }
    /* 收款码:点横幅本体弹灯箱大图 */
    const slide = event.target.closest('.notice-has-qr');
    if (slide) {
      const n = noticeItems[Number(slide.dataset.slide)];
      if (n && n.qrImage) openLightbox([{ src: n.qrImage, alt: '收款码' }], 0, slide);
    }
  });

  /* 键盘可达:收款码条目聚焦后 Enter/空格开灯箱 */
  $('notice-banner').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const slide = event.target.closest && event.target.closest('.notice-has-qr');
    if (slide) {
      event.preventDefault();
      const n = noticeItems[Number(slide.dataset.slide)];
      if (n && n.qrImage) openLightbox([{ src: n.qrImage, alt: '收款码' }], 0, slide);
    }
  });

  async function loadNotices() {
    try {
      const resp = await fetch('/api/notices', { headers: { Accept: 'application/json' } });
      if (!resp.ok) return; /* 401=登录态异常(墙守卫兜底),其余静默:横幅不阻塞主页 */
      const data = await resp.json();
      const dismissed = new Set(dismissedIds());
      noticeItems = (Array.isArray(data.notices) ? data.notices : [])
        .filter((n) => n && n.id && !(n.dismissible !== false && dismissed.has(n.id)));
      noticeIndex = 0;
      renderNotices();
    } catch {
      /* 网络异常:横幅静默缺席 */
    }
  }

  document.addEventListener('ts:ready', loadNotices);

  document.addEventListener('ts:ready', render);
  document.addEventListener('ts:changed', render);
  window.TournamentAppInit('home').catch((error) => {
    if (window.TournamentApp) window.TournamentApp.fatalError(error);
  });
})();
