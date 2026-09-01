(function () {
  'use strict';

  /* 官方文档页:GET /api/docs 一次拉全量(文档量小,不做单篇接口),
   * 列表/阅读两视图本地切换;hash #doc-<id> 直链(hashchange 兜底路由)。 */
  const { escapeHtml } = window.TournamentUtils;
  const { DOC_CATEGORIES, docCategoryLabel } = window.DocsMeta;
  let docs = [];

  function fmtDate(ts) {
    const d = new Date(ts);
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '';
  }

  function renderList() {
    const wrap = document.getElementById('docs-list');
    const empty = document.getElementById('docs-empty');
    const sections = DOC_CATEGORIES
      .map((c) => ({ label: c.label, items: docs.filter((x) => x.category === c.key) }))
      .filter((s) => s.items.length);
    empty.hidden = !!sections.length;
    wrap.innerHTML = sections.map((s) =>
      '<section class="stats-section" aria-label="' + escapeHtml(s.label) + '">' +
      '<h2 class="stats-section-title">' + escapeHtml(s.label) + '</h2>' +
      s.items.map((x) =>
        '<button type="button" class="doc-item" data-id="' + escapeHtml(x.id) + '">' +
        '<span class="doc-item-title">' + escapeHtml(x.title) + '</span>' +
        '<span class="doc-item-date">' + fmtDate(x.updatedAt) + '</span></button>'
      ).join('') +
      '</section>'
    ).join('');
  }

  function openDoc(id) {
    const doc = docs.find((x) => x.id === id);
    if (!doc) { backToList(); return; }
    document.getElementById('docs-list-view').hidden = true;
    document.getElementById('doc-view').hidden = false;
    document.getElementById('doc-view-meta').textContent =
      docCategoryLabel(doc.category) + ' · 更新于 ' + fmtDate(doc.updatedAt);
    document.getElementById('doc-view-body').innerHTML = MDRender.render(doc.body);
  }

  function backToList() {
    document.getElementById('doc-view').hidden = true;
    document.getElementById('docs-list-view').hidden = false;
    if (location.hash) location.hash = '';
  }

  function routeFromHash() {
    const m = /^#doc-(.+)$/.exec(location.hash);
    if (m) openDoc(decodeURIComponent(m[1]));
    else backToList();
  }

  async function load() {
    try {
      const res = await fetch('/api/docs', { headers: { Accept: 'application/json' } });
      if (res.status === 401) { location.href = 'login.html'; return; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      docs = (await res.json()).docs || [];
    } catch (error) {
      docs = [];
    }
    renderList();
    routeFromHash();
  }

  document.addEventListener('ts:ready', () => {
    document.getElementById('docs-list').addEventListener('click', (ev) => {
      const btn = ev.target.closest('.doc-item');
      if (btn) location.hash = 'doc-' + btn.dataset.id;
    });
    document.querySelector('.doc-back').addEventListener('click', backToList);
    window.addEventListener('hashchange', routeFromHash);
    load();
  });
  window.TournamentAppInit('docs').catch((error) => {
    if (window.TournamentApp) window.TournamentApp.fatalError(error);
  });
})();
