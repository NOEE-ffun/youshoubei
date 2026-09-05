(function () {
  'use strict';

  /* 赛程列表视图(比赛页内,与画布同页切换):resolveCanvas 后经 CanvasModel.listGroups
   * 按阶段分组,列序 = 赛制 | 标题 | 对阵(比分并入) | 状态 | 卡组(有效继承,图标可点);
   * 编辑态由 body.list-editing 标记(置位/交互在 list-editor.js):行加 data-match、
   * 拖拽手柄格与组头手柄;染色行带 data-tint 与 --list-tint(与画布 card.color 同源)。
   * 视图显隐由 bracket.js 的 body[data-view] 管理,列表视图隐藏赛事背景图由 CSS 负责;
   * 本模块只渲染 #list-body,渲染结束派发 ts:list-render(list-editor 借此重挂编辑态)。 */

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

  function playerNameMap() {
    return new Map((window.TournamentApp.players || []).map((p) => [p.id, p.name || p.id]));
  }
  let names = new Map();
  function playerName(id) {
    return names.get(id) || '?';
  }

  /* 对阵列:比分并入(已结束/平局嵌在两名之间),胜者加粗、败者降透明(与画布口径同源) */
  function vsHtml(m) {
    const a = escapeHtml(m.a ? playerName(m.a) : '待定');
    const b = escapeHtml(m.b ? playerName(m.b) : '待定');
    const clsA = m.played ? (m.winner === m.a ? ' won' : m.loser === m.a ? ' lost' : '') : '';
    const clsB = m.played ? (m.winner === m.b ? ' won' : m.loser === m.b ? ' lost' : '') : '';
    if (m.played || m.draw) {
      const sa = m.scoreA == null ? '?' : m.scoreA;
      const sb = m.scoreB == null ? '?' : m.scoreB;
      return '<span class="vs-name' + clsA + '">' + a + '</span>' +
        '<span class="vs-score">' + escapeHtml(sa + ':' + sb) + '</span>' +
        '<span class="vs-name' + clsB + '">' + b + '</span>';
    }
    return '<span class="vs-name' + clsA + '">' + a + '<span class="vs-vs"> vs </span></span>' +
      '<span class="vs-name' + clsB + '">' + b + '</span>';
  }

  function rowHtml(m, eff, card, editing) {
    const st = stateInfo(m);
    const clsA = classGroupHtml(eff, 'a');
    const clsB = classGroupHtml(eff, 'b');
    const sep = (clsA && clsB) ? '<span class="vs-sep">对</span>' : '';
    const tint = card && card.color
      ? ' data-tint style="--list-tint:' + escapeHtml(card.color) + '"'
      : '';
    const handle = editing
      ? '<span class="list-handle" data-drag-handle title="拖拽排序" aria-hidden="true">' +
        '<img class="icon" src="icons/drag_indicator.svg" alt=""></span>'
      : '';
    return (
      '<div class="list-row' + (m.played ? ' played' : '') + '" data-match="' + escapeHtml(m.id) + '"' + tint + '>' +
      handle +
      '<span class="list-format">' + escapeHtml(m.format || 'BO3') + '</span>' +
      '<span class="list-title">' + escapeHtml(m.label || m.id) + '</span>' +
      '<span class="list-vs">' + vsHtml(m) + '</span>' +
      '<span class="list-status' + st.cls + '">' + escapeHtml(st.text) + '</span>' +
      '<div class="deck-class-row">' + clsA + sep + clsB + '</div>' +
      '</div>'
    );
  }

  function render() {
    const app = window.TournamentApp;
    const record = app && app.current;
    const el = document.getElementById('list-body');
    if (!el || !record || !record.canvas) return;
    names = playerNameMap();
    const editing = document.body.classList.contains('list-editing');
    const resolved = CanvasModel.resolveCanvas(record.canvas, record.roster || [], record.scores || {});
    const eff = CanvasModel.resolveEffectiveClassLinks(record.canvas, record.scores || {});
    const resolvedById = new Map(resolved.cards.map((c) => [c.id, c]));
    const groups = CanvasModel.listGroups(record.canvas.cards);
    el.innerHTML = groups.map((g) => (
      '<section class="list-group" data-key="' + escapeHtml(g.key) + '">' +
      '<h2' + (editing ? ' data-group-handle title="拖动可调整整个阶段的顺序"' : '') + '>' +
      (editing ? '<span class="list-handle" data-drag-handle aria-hidden="true">' +
        '<img class="icon" src="icons/drag_indicator.svg" alt=""></span>' : '') +
      escapeHtml(g.key === '__other__' ? '其他' : g.phase) +
      '</h2>' +
      g.cards.map((card) => {
        const m = resolvedById.get(card.id);
        return m ? rowHtml(m, eff.get(card.id), card, editing) : '';
      }).join('') +
      '</section>'
    )).join('');
    document.dispatchEvent(new CustomEvent('ts:list-render'));
  }

  window.ListView = { render };
  document.addEventListener('ts:ready', render);
  document.addEventListener('ts:changed', render);
})();
