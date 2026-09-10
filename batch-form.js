(function (root, factory) {
  root.BatchForm = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function escapeHtml(s) { return window.TournamentUtils.escapeHtml(s); }

  /* 四区块:每区块「应用」勾选前置,未勾=不动该字段;底部应用到 N 张按钮 */
  function fieldsHtml() {
    return (
      '<div class="bf-section">' +
      '  <label class="bf-apply"><input type="checkbox" class="bf-apply-phase-format"> 应用阶段与赛制</label>' +
      '  <div class="cf-grid">' +
      '    <div class="form-field"><label>阶段</label><input type="text" class="bf-phase" placeholder="胜者组"></div>' +
      '    <div class="form-field"><label>赛制</label><input type="text" class="bf-format" placeholder="BO3"></div>' +
      '  </div><p class="hint bf-format-scope"></p>' +
      '</div>' +
      '<div class="bf-section">' +
      '  <label class="bf-apply"><input type="checkbox" class="bf-apply-rank"> 应用出口名次</label>' +
      '  <div class="cf-grid">' +
      '    <div class="form-field"><label>胜者名次(空=清除)</label><input type="number" class="bf-rank-winner" step="1"></div>' +
      '    <div class="form-field"><label>败者名次(空=清除)</label><input type="number" class="bf-rank-loser" step="1"></div>' +
      '  </div><p class="hint">仅对比赛卡生效</p>' +
      '</div>' +
      '<div class="bf-section bf-banlist-section" hidden>' +
      '  <label class="bf-apply"><input type="checkbox" class="bf-apply-banlist"> 应用禁卡表(替换现有绑定)</label>' +
      '  <div class="bf-banlists"></div>' +
      '</div>' +
      '<div class="bf-section">' +
      '  <label class="bf-apply"><input type="checkbox" class="bf-apply-title"> 应用标题模板</label>' +
      '  <div class="form-field"><label>模板({i}=序号,{old}=原标题)</label><input type="text" class="bf-title" placeholder="胜者组 R1-{i}"></div>' +
      '  <p class="hint bf-title-preview"></p>' +
      '</div>' +
      '<div class="bf-actions"><button type="button" class="btn btn-primary bf-apply-btn" disabled>应用到 N 张</button></div>'
    );
  }

  function fill(container, stats) {
    const rec = window.TournamentApp && window.TournamentApp.current;
    const lists = (rec && window.CanvasModel.normalizeBanLists(rec.banLists) || []).filter((l) => l.cards.length);
    const blSec = container.querySelector('.bf-banlist-section');
    if (blSec) {
      blSec.hidden = !lists.length;
      container.querySelector('.bf-banlists').innerHTML = lists.map((l) =>
        '<label class="cf-banlist-opt"><input type="checkbox" class="bf-banlist-check" value="' + escapeHtml(l.id) + '">' +
        escapeHtml(l.name) + '(' + l.cards.length + ' 卡)</label>').join('');
    }
    const scope = container.querySelector('.bf-format-scope');
    if (scope) scope.textContent = stats.poolCount > 0 ? '赛制仅对 ' + stats.matchCount + ' 张比赛卡生效(roll 池跳过)' : '';
    const btn = container.querySelector('.bf-apply-btn');
    if (btn) btn.textContent = '应用到 ' + stats.ids.length + ' 张';
    updatePreview(container, stats);
  }

  function read(container) {
    const config = {};
    const reasons = [];
    if (container.querySelector('.bf-apply-phase-format').checked) {
      config.phase = container.querySelector('.bf-phase').value;
      config.format = container.querySelector('.bf-format').value;
    }
    if (container.querySelector('.bf-apply-rank').checked) {
      const w = container.querySelector('.bf-rank-winner').value.trim();
      const l = container.querySelector('.bf-rank-loser').value.trim();
      if (w !== '' && !Number.isInteger(Number(w))) reasons.push('胜者名次须为整数');
      if (l !== '' && !Number.isInteger(Number(l))) reasons.push('败者名次须为整数');
      if (!reasons.length) {
        config.rankWinner = w === '' ? null : Number(w);
        config.rankLoser = l === '' ? null : Number(l);
      }
    }
    if (container.querySelector('.bf-apply-banlist') && container.querySelector('.bf-apply-banlist').checked) {
      config.banListIds = Array.from(container.querySelectorAll('.bf-banlist-check:checked')).map((el) => el.value);
    }
    if (container.querySelector('.bf-apply-title').checked) {
      const t = container.querySelector('.bf-title').value;
      if (!t.trim()) reasons.push('标题模板不能为空');
      else config.titleTemplate = t;
    }
    const valid = reasons.length === 0 && Object.keys(config).length > 0;
    return { valid, invalidReason: reasons[0] || null, config };
  }

  /* 模板输入实时预览:首末两张(按传入 stats.cards 序) */
  function updatePreview(container, stats) {
    const el = container.querySelector('.bf-title-preview');
    if (!el || !stats.cards.length) return;
    const t = container.querySelector('.bf-title').value;
    if (!t.trim()) { el.textContent = ''; return; }
    const first = window.CanvasModel.renderBatchTitle(t, 0, stats.cards[0].label);
    const last = window.CanvasModel.renderBatchTitle(t, stats.cards.length - 1, stats.cards[stats.cards.length - 1].label);
    el.textContent = '预览:' + first + (stats.cards.length > 1 ? ' … ' + last : '');
  }

  /* 勾选变化/输入只刷新预览与应用钮态,不写卡(批量显式应用) */
  function bindEvents(container, stats, onApply) {
    container.addEventListener('change', () => syncBtn(container));
    container.addEventListener('input', () => {
      updatePreview(container, stats);
      syncBtn(container);
    });
    container.querySelector('.bf-apply-btn').addEventListener('click', () => {
      const r = read(container);
      if (!r.valid) {
        if (r.invalidReason) window.TournamentUtils.notify(r.invalidReason, 'danger');
        return;
      }
      onApply(r.config, stats);
    });
    syncBtn(container);
  }

  function syncBtn(container) {
    const btn = container.querySelector('.bf-apply-btn');
    if (btn) btn.disabled = !read(container).valid;
  }

  return { fieldsHtml, fill, read, bindEvents, updatePreview };
});
