(function () {
  'use strict';

  /* 主页：跑马灯 + 比赛背景幻灯片渐变 */

  const { escapeHtml, medalMap, avatarMarkup, cssUrl } = window.TournamentUtils;

  let slideTimer = null;
  let slideIndex = 0;
  let slideBackgrounds = [];

  function renderMarquee() {
    const app = window.TournamentApp;
    const record = app && app.current;
    if (!app) return;
    const players = (app.players || []).slice();
    if (!players.length) {
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
      el.style.backgroundImage = 'linear-gradient(135deg, #1e293b, #0f172a)';
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
    layer.style.backgroundImage = cssUrl(url);
    el.appendChild(layer);
    requestAnimationFrame(() => layer.classList.add('show'));
    setTimeout(() => {
      el.querySelectorAll('.slideshow-layer:not(:last-child)').forEach((old) => old.remove());
    }, 1000);
    slideIndex += 1;
  }

  document.addEventListener('ts:ready', () => {
    renderMarquee();
    loadSlideshowBackgrounds();
    document.addEventListener('ts:changed', () => {
      renderMarquee();
      loadSlideshowBackgrounds();
    });
  });

  window.TournamentAppInit('home').catch((error) => {
    if (window.TournamentApp) window.TournamentApp.fatalError(error);
  });
})();
