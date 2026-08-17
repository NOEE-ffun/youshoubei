(function () {
  'use strict';

  /* 主页：跑马灯 + 比赛背景幻灯片渐变 */

  const {
    escapeHtml, iconMarkup, medalMap, avatarMarkup, safeUrl,
    statusBadgeMarkup, formatStartTime
  } = window.TournamentUtils;

  let slideTimer = null;
  let slideIndex = 0;
  let slideBackgrounds = [];
  let slidePaused = false;
  let slidePausedByFocus = false;
  let marqueePaused = false;
  let controlsBound = false;

  function reducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /* 赛事身份：标题用比赛名（静态兜底「右手杯」），状态徽章 + 开赛时间 + 直播入口 */
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
        '<a class="marquee-item' + (medal ? ' medal-' + medal.type : '') + '" href="players.html">' +
        (medal ? '<span class="medal-badge">' + iconMarkup(medal.icon, '') + '</span>' : '') +
        avatarMarkup(player, 'avatar-lg') +
        '<span class="marquee-name">' + escapeHtml(player.name) + '</span>' +
        '</a>'
      );
    }).join('');
    const doubled = items + '<div class="marquee-copy" aria-hidden="true">' + items + '</div>';
    const track = document.getElementById('marquee-track');
    const reverseTrack = document.getElementById('marquee-track-reverse');
    if (track) track.innerHTML = doubled;
    if (reverseTrack) reverseTrack.innerHTML = doubled;
  }

  /* ---------- 背景幻灯片：播放/暂停控件 + reduced-motion 静态终态 ---------- */

  function renderSlideControl() {
    const btn = document.getElementById('slideshow-pause');
    if (!btn) return;
    btn.hidden = !slideBackgrounds.length;
    if (reducedMotion()) {
      btn.disabled = true;
      btn.setAttribute('aria-pressed', 'true');
      btn.setAttribute('aria-label', '减少动态效果模式已停用背景轮播');
      btn.innerHTML = iconMarkup('pause', '');
      return;
    }
    btn.disabled = false;
    const paused = slidePaused || slidePausedByFocus;
    btn.setAttribute('aria-pressed', String(paused));
    btn.setAttribute('aria-label', paused ? '播放背景轮播' : '暂停背景轮播');
    btn.innerHTML = iconMarkup(paused ? 'play_arrow' : 'pause', '');
  }

  function syncSlideTimer() {
    if (slideTimer) {
      clearInterval(slideTimer);
      slideTimer = null;
    }
    if (slideBackgrounds.length && !slidePaused && !slidePausedByFocus && !reducedMotion()) {
      slideTimer = setInterval(() => showSlide(), 5000);
    }
  }

  function setSlidePaused(paused, byFocus) {
    if (byFocus) slidePausedByFocus = paused;
    else slidePaused = paused;
    renderSlideControl();
    syncSlideTimer();
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
    renderSlideControl();
    if (!slideBackgrounds.length) {
      if (slideTimer) clearInterval(slideTimer);
      slideTimer = null;
      el.innerHTML = '';
      el.style.backgroundImage = 'linear-gradient(135deg, var(--hero-fallback-a), var(--hero-fallback-b))';
      return;
    }
    showSlide();
    syncSlideTimer();
  }

  function showSlide() {
    const el = document.getElementById('home-slideshow');
    if (!el || !slideBackgrounds.length) return;
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

  /* ---------- 跑马灯暂停控件 ---------- */

  function renderMarqueeControl() {
    const btn = document.getElementById('marquee-pause');
    const region = document.getElementById('home-marquee');
    if (!btn || !region) return;
    region.classList.toggle('is-paused', marqueePaused);
    btn.setAttribute('aria-pressed', String(marqueePaused));
    btn.setAttribute('aria-label', marqueePaused ? '播放选手跑马灯' : '暂停选手跑马灯');
    btn.innerHTML = iconMarkup(marqueePaused ? 'play_arrow' : 'pause', '');
  }

  function bindPauseControls() {
    if (controlsBound) return;
    controlsBound = true;
    const slideBtn = document.getElementById('slideshow-pause');
    if (slideBtn) {
      slideBtn.addEventListener('click', () => {
        setSlidePaused(!slidePaused, false);
      });
      /* UX #108：轮播控件获得焦点时暂停，避免键盘用户追不上轮播 */
      slideBtn.addEventListener('focus', () => setSlidePaused(true, true));
      slideBtn.addEventListener('blur', () => setSlidePaused(false, true));
    }
    const marqueeBtn = document.getElementById('marquee-pause');
    if (marqueeBtn) {
      marqueeBtn.addEventListener('click', () => {
        marqueePaused = !marqueePaused;
        renderMarqueeControl();
      });
    }
  }

  document.addEventListener('ts:ready', () => {
    bindPauseControls();
    renderIdentity();
    renderMarquee();
    renderMarqueeControl();
    loadSlideshowBackgrounds();
    document.addEventListener('ts:changed', () => {
      renderIdentity();
      renderMarquee();
      renderMarqueeControl();
      loadSlideshowBackgrounds();
    });
  });

  window.TournamentAppInit('home').catch((error) => {
    if (window.TournamentApp) window.TournamentApp.fatalError(error);
  });
})();
