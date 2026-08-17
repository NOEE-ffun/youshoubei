(function () {
  'use strict';

  /* 主页：跑马灯 + 比赛背景幻灯片渐变 */

  const { escapeHtml, medalMap, avatarMarkup, safeUrl, statusBadgeMarkup } = window.TournamentUtils;

  let slideTimer = null;
  let slideIndex = 0;
  let slideBackgrounds = [];

  /* 赛事身份：标题用比赛名（静态兜底「右手杯」），状态徽章 + 开赛时间 + 直播入口 */
  function formatStartTime(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function renderIdentity() {
    const app = window.TournamentApp;
    const record = app && app.current;
    if (!record) return;
    const titleEl = document.getElementById('home-title');
    if (titleEl) titleEl.textContent = record.name || '右手杯';
    const meta = document.getElementById('home-meta');
    if (meta) {
      const parts = [statusBadgeMarkup(record.status)];
      const time = formatStartTime(record.startTime);
      if (time) parts.push('<span class="home-start-time">开赛 ' + time + '</span>');
      meta.innerHTML = parts.join('');
    }
    const liveBtn = document.getElementById('home-live-btn');
    if (liveBtn) {
      /* liveUrl 经白名单校验（仅 https 直播地址放行），无链接时隐藏按钮 */
      const url = safeUrl(record.liveUrl || '');
      liveBtn.hidden = !url;
      if (url) liveBtn.href = url;
    }
  }

  function renderMarquee() {
    const app = window.TournamentApp;
    const record = app && app.current;
    if (!app) return;
    const players = (app.players || []).slice();
    /* 全是「选手 N」占位名或库为空时显示待公布空状态，不滚动占位卡 */
    const allPlaceholder = !players.length || players.every((p) =>
      /^选手\s*\d+$/.test(String((p && p.name) || '').trim()));
    const emptyNote = document.getElementById('home-marquee-empty');
    if (emptyNote) emptyNote.hidden = !allPlaceholder;
    if (allPlaceholder) {
      for (const id of ['marquee-track', 'marquee-track-reverse']) {
        const track = document.getElementById(id);
        if (track) track.innerHTML = '';
      }
      return;
    }
    const medalOf = record ? medalMap(record) : new Map();
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
    const doubled = items + '<div class="marquee-copy" aria-hidden="true">' + items + '</div>';
    const track = document.getElementById('marquee-track');
    const reverseTrack = document.getElementById('marquee-track-reverse');
    if (track) track.innerHTML = doubled;
    if (reverseTrack) reverseTrack.innerHTML = doubled;
  }

  async function loadSlideshowBackgrounds() {
    try {
      const all = await window.TournamentApp.storageGetAll();
      slideBackgrounds = (all || [])
        .map((t) => t && t.background)
        .filter(Boolean);
    } catch (error) {
      slideBackgrounds = [];
    }
    const el = document.getElementById('home-slideshow');
    if (!el) return;
    if (!slideBackgrounds.length) {
      if (slideTimer) clearInterval(slideTimer);
      el.innerHTML = '';
      el.style.backgroundImage = 'linear-gradient(135deg, var(--hero-fallback-a), var(--hero-fallback-b))';
      return;
    }
    showSlide();
    if (slideTimer) clearInterval(slideTimer);
    slideTimer = setInterval(showSlide, 5000);
  }

  function showSlide() {
    const el = document.getElementById('home-slideshow');
    if (!el) return;
    if (!slideBackgrounds.length) return;
    const url = window.TournamentApp.blobUrl(slideBackgrounds[slideIndex % slideBackgrounds.length]);
    const layer = document.createElement('div');
    layer.className = 'slideshow-layer';
    layer.style.backgroundImage = "url('" + safeUrl(url) + "')";
    el.appendChild(layer);
    requestAnimationFrame(() => layer.classList.add('show'));
    setTimeout(() => {
      el.querySelectorAll('.slideshow-layer:not(:last-child)').forEach((old) => old.remove());
    }, 1000);
    slideIndex += 1;
  }

  document.addEventListener('ts:ready', () => {
    renderIdentity();
    renderMarquee();
    loadSlideshowBackgrounds();
    document.addEventListener('ts:changed', () => {
      renderIdentity();
      renderMarquee();
      loadSlideshowBackgrounds();
    });
  });

  window.TournamentAppInit('home').catch((error) => {
    if (window.TournamentApp) window.TournamentApp.fatalError(error);
  });
})();
