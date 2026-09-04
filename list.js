(function () {
  'use strict';

  /* 赛程列表视图(比赛页内,与画布同页切换):resolveCanvas 后按阶段分组,
   * 扁平行 = 场次 + A vs B + 状态 + 职业卡组(有效继承,图标可点跳链接) + 比分,
   * 全部信息直出、不可折叠;视图显隐由 bracket.js 的 body[data-view] 管理,
   * 列表视图下隐藏赛事背景图由 CSS 负责;本模块只渲染 #list-body。 */

  const { escapeHtml } = window.TournamentUtils;

  /* 状态口径与画布卡片(bracket.js)对齐:invalid > 平局 > 已结束 > 成环 > 进行中/未开始 > 待定 */
  function stateInfo(m) {
    if (m.invalid) return { text: '无效', cls: ' is-invalid' };
    if (m.draw) return { text: '平局', cls: '' };
    if (m.played) return { text: '已结束', cls: '' };
    if (m.cycle) return { text: '连线成环', cls: '' };
    if (m.a && m.b) {
      const record = window.TournamentApp.current;
      const live = record && record.status === 'ongoing';
      return live ? { text: '进行中', cls: ' is-live' } : { text: '未开始', cls: '' };
    }
    return { text: '待定', cls: '' };
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
    const st = stateInfo(m);
    return (
      '<div class="list-row' + (m.played ? ' played' : '') + '">' +
      '<span class="list-label">' + escapeHtml(m.label || m.id) + '</span>' +
      '<span class="list-vs">' + escapeHtml(a) + ' vs ' + escapeHtml(b) + '</span>' +
      '<span class="list-status' + st.cls + '">' + escapeHtml(st.text) + '</span>' +
      '<div class="deck-class-row">' + clsA + sep + clsB + '</div>' +
      '<span class="list-score">' + escapeHtml(score) + '</span>' +
      '</div>'
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
