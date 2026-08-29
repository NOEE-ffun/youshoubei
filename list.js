(function () {
  'use strict';

  /* 赛程列表视图(比赛页内,与画布同页切换):resolveCanvas 后按阶段分组,
   * 行 = 场次 + A vs B + 比分 + 状态;点行展开职业卡组(有效继承,图标可点跳链接)。
   * 视图显隐由 bracket.js 的 body[data-view] 管理;本模块只负责渲染 #list-body。 */

  const { escapeHtml } = window.TournamentUtils;

  function stateText(m) {
    if (m.invalid) return '无效';
    if (m.draw) return '平局';
    if (m.played) return '已结束';
    if (m.cycle) return '连线成环';
    if (m.a && m.b) return '未开始';
    return '待定';
  }

  function classGroupHtml(eff, group) {
    const links = (eff && eff[group]) || [];
    return links.map((entry) => {
      /* 协议白名单:仅 http(s) 可成为可点链接,阻断 javascript: 等注入 */
      const url = /^https?:\/\//i.test(entry.url || '') ? entry.url : null;
      return (
      '<a class="list-class" href="' + escapeHtml(url || '#') + '"' +
      (url ? ' target="_blank" rel="noopener"' : '') +
      ' title="' + escapeHtml(entry.text || entry.cls) + '">' +
      '<img class="icon" src="icons/classes/' + escapeHtml(entry.cls) + '.svg" alt="' + escapeHtml(entry.cls) + '">' +
      '</a>'
      );
    }).join('');
  }

  function rowHtml(m, eff) {
    const a = m.a ? playerName(m.a) : '待定';
    const b = m.b ? playerName(m.b) : '待定';
    const score = m.played || m.draw
      ? (m.scoreA == null ? '?' : m.scoreA) + ':' + (m.scoreB == null ? '?' : m.scoreB)
      : '';
    const clsA = classGroupHtml(eff, 'a');
    const clsB = classGroupHtml(eff, 'b');
    const sep = (clsA && clsB) ? '<span class="vs-sep">对</span>' : '';
    const decks = (clsA || clsB)
      ? '<div class="deck-class-row">' + clsA + sep + clsB + '</div>'
      : '';
    return (
      '<details class="list-row' + (m.played ? ' played' : '') + '">' +
      '<summary>' +
      '<span class="list-label">' + escapeHtml(m.label || m.id) + '</span>' +
      '<span class="list-vs">' + escapeHtml(a) + ' vs ' + escapeHtml(b) + '</span>' +
      '<span class="list-score">' + (score || '—') + '</span>' +
      '</summary>' +
      decks +
      '</details>'
    );
  }

  function playerNameMap() {
    return new Map((window.TournamentApp.players || []).map((p) => [p.id, p.name || p.id]));
  }
  let names = new Map();
  function playerName(id) {
    return names.get(id) || '?';
  }

  function render() {
    const app = window.TournamentApp;
    const record = app && app.current;
    const body = document.getElementById('list-body');
    if (!body || !record || !record.canvas) return;
    names = playerNameMap();
    const resolved = CanvasModel.resolveCanvas(record.canvas, record.roster || [], record.scores || {});
    const eff = CanvasModel.resolveEffectiveClassLinks(record.canvas, record.scores || {});

    /* 按 phase 分组,保持画布卡片顺序 */
    const groups = [];
    const groupIndex = new Map();
    for (const m of resolved.cards) {
      const key = m.phase || '其他';
      if (!groupIndex.has(key)) {
        groupIndex.set(key, []);
        groups.push({ key, items: groupIndex.get(key) });
      }
      groupIndex.get(key).push(m);
    }
    body.innerHTML = groups.map((g) => (
      '<section class="list-group">' +
      '<h2>' + escapeHtml(g.key) + '</h2>' +
      g.items.map((m) => rowHtml(m, eff.get(m.id))).join('') +
      '</section>'
    )).join('');
  }

  document.addEventListener('ts:ready', render);
  document.addEventListener('ts:changed', render);
})();
