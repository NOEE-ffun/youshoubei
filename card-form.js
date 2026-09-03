(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CardForm = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 卡片设置共享表单:弹窗(保存/取消)与选中抽屉(实时应用)复用;
   * 选择器一律 class,两容器可同时挂 DOM。
   * 零依赖 canvas-editor.js:选手列表读 window.TournamentApp.players,
   * 连线来源可读名称由调用方算好经 fill 的 flowSourceLabels 传入。 */

  function escapeHtml(str) {
    return window.TournamentUtils.escapeHtml(str);
  }

  /* 字段标记(不含弹窗标题/按钮/提示);container.innerHTML = CardForm.fieldsHtml() */
  function fieldsHtml() {
    return (
      '  <div class="form-field"><label>标题</label><input type="text" class="cf-label" aria-label="标题"></div>' +
      '  <div class="form-field"><label>阶段</label><input type="text" class="cf-phase" placeholder="如：胜者组决赛" aria-label="阶段"></div>' +
      '  <div class="form-field"><label>赛制文本</label><input type="text" class="cf-format" placeholder="BO3 / BO5 / 自定义" aria-label="赛制文本"></div>' +
      '  <div class="form-field"><label>卡组数量（留空自动）</label><input type="number" class="cf-deck-count" min="1" step="1" aria-label="卡组数量"></div>' +
      '  <div class="form-field"><label>A 位选手</label><select class="cf-slot-a" aria-label="A 位选手"></select><select class="cf-flow-outcome-a flow-outcome" hidden aria-label="A 位连线取哪个出口"><option value="winner">取其胜者</option><option value="loser">取其败者</option></select></div>' +
      '  <div class="form-field"><label>B 位选手</label><select class="cf-slot-b" aria-label="B 位选手"></select><select class="cf-flow-outcome-b flow-outcome" hidden aria-label="B 位连线取哪个出口"><option value="winner">取其胜者</option><option value="loser">取其败者</option></select></div>' +
      '  <div class="form-field"><label>胜者出口名次</label><input type="number" class="cf-rank-winner" placeholder="如 1" aria-label="胜者出口名次"></div>' +
      '  <div class="form-field"><label>败者出口名次</label><input type="number" class="cf-rank-loser" placeholder="如 2" aria-label="败者出口名次"></div>' +
      '  <div class="form-field">' +
      '    <label>职业卡组 · A 位选手(查看模式点击图标跳转)</label>' +
      '    <div class="cl-list cf-cl-a"></div>' +
      '  </div>' +
      '  <div class="form-field">' +
      '    <label>职业卡组 · B 位选手</label>' +
      '    <div class="cl-list cf-cl-b"></div>' +
      '  </div>'
    );
  }

  function classOptions(selected) {
    let html = '<option value="">未选择</option>';
    for (const cls of window.CanvasModel.CLASS_LIST) {
      html += '<option value="' + escapeHtml(cls) + '"' + (cls === selected ? ' selected' : '') + '>' +
        escapeHtml(cls) + '</option>';
    }
    return html;
  }

  function clRowHtml(entry) {
    const e = entry || {};
    return (
      '<div class="cl-row">' +
      '<select class="cl-cls" aria-label="职业">' + classOptions(e.cls) + '</select>' +
      '<input type="url" class="cl-url" placeholder="卡组链接 https://" value="' + escapeHtml(e.url || '') + '">' +
      '<input type="text" class="cl-text" placeholder="悬停文字" value="' + escapeHtml(e.text || '') + '">' +
      '<button type="button" class="btn btn-ghost btn-sm cl-del" data-cl-del title="删除此行" aria-label="删除此行">×</button>' +
      '</div>'
    );
  }

  function playerOptions(selectedId) {
    const players = window.TournamentApp.players || [];
    let html = '<option value="">空</option>';
    for (const p of players) {
      html += '<option value="' + p.id + '"' + (p.id === selectedId ? ' selected' : '') + '>' +
        escapeHtml(p.name) + '</option>';
    }
    return html;
  }

  /* 每组末尾永远有一行空行供新增。
   * 预填:own 模式(该侧已填过,含显式清空 null)回显自己的;
   * 未填过的侧回显继承值(eff)。保存时:
   * - own 模式:行内容原样写入;清空到零行写 null(显式阻断继承)
   * - inherited 模式:未改动则不动原值(继续继承),有改动写入固化 */
  function renderClassLinkRows(container, card, eff) {
    const cl = card.classLinks || {};
    for (const [groupId, listCls] of [['a', '.cf-cl-a'], ['b', '.cf-cl-b']]) {
      const own = cl[groupId];
      const list = container.querySelector(listCls);
      if (own === null || (Array.isArray(own) && own.length)) {
        list.dataset.fill = 'own';
        list.innerHTML = (own || []).map(clRowHtml).join('') + clRowHtml(null);
      } else {
        list.dataset.fill = 'inherited';
        const effRows = (eff[groupId] || []);
        list.dataset.effSig = JSON.stringify(effRows);
        list.innerHTML = effRows.map(clRowHtml).join('') + clRowHtml(null);
      }
    }
  }

  /* 回填:card=卡片数据;eff={a:[],b:[]} 该卡有效职业链接(继承回显);
   * flowSourceLabels={a,b} 连线来源可读名称(调用方算好传入,缺省空串) */
  function fill(container, card, eff, flowSourceLabels) {
    const labels = flowSourceLabels || {};
    container.querySelector('.cf-label').value = card.label || '';
    container.querySelector('.cf-phase').value = card.phase || '';
    container.querySelector('.cf-format').value = card.format || 'BO3';
    container.querySelector('.cf-deck-count').value = card.deckCount || '';
    const slotA = card.slots && card.slots[0];
    const slotB = card.slots && card.slots[1];
    container.querySelector('.cf-slot-a').innerHTML = playerOptions(slotA && slotA.type === 'player' ? slotA.playerId : '');
    container.querySelector('.cf-slot-b').innerHTML = playerOptions(slotB && slotB.type === 'player' ? slotB.playerId : '');
    /* 连线位的出口切换:显示并回填当前 outcome(拖拽侧默认之外的自定义入口) */
    const flowOutcomeA = container.querySelector('.cf-flow-outcome-a');
    const flowOutcomeB = container.querySelector('.cf-flow-outcome-b');
    flowOutcomeA.hidden = !(slotA && slotA.type === 'flow');
    flowOutcomeB.hidden = !(slotB && slotB.type === 'flow');
    if (slotA && slotA.type === 'flow') {
      flowOutcomeA.value = slotA.outcome === 'loser' ? 'loser' : 'winner';
      container.querySelector('.cf-slot-a').insertAdjacentHTML('beforeend',
        '<option value="__flow" selected>来自 ' + escapeHtml(labels.a || '') + '</option>');
    }
    if (slotB && slotB.type === 'flow') {
      flowOutcomeB.value = slotB.outcome === 'loser' ? 'loser' : 'winner';
      container.querySelector('.cf-slot-b').insertAdjacentHTML('beforeend',
        '<option value="__flow" selected>来自 ' + escapeHtml(labels.b || '') + '</option>');
    }
    container.querySelector('.cf-rank-winner').value = card.exitRanks && card.exitRanks.winner != null ? card.exitRanks.winner : '';
    container.querySelector('.cf-rank-loser').value = card.exitRanks && card.exitRanks.loser != null ? card.exitRanks.loser : '';
    renderClassLinkRows(container, card, eff || {});
  }

  function readClassLinkGroup(container, listCls) {
    const list = container.querySelector(listCls);
    const out = [];
    let invalid = 0;
    list.querySelectorAll('.cl-row').forEach((row) => {
      const cls = row.querySelector('.cl-cls').value;
      const url = row.querySelector('.cl-url').value.trim().slice(0, 500);
      const text = row.querySelector('.cl-text').value.trim().slice(0, 60);
      if (cls && (url || text)) {
        out.push({ cls, url, text });
      } else if (cls || url || text) {
        /* 选了职业没内容,或填了内容没选职业:不完整行 */
        invalid += 1;
      }
    });
    const unchangedInherited = list.dataset.fill === 'inherited' &&
      JSON.stringify(out) === list.dataset.effSig;
    return { links: out, invalid, fill: list.dataset.fill, unchangedInherited };
  }

  /* 读取校验:有不完整职业行时返回 {invalid:N>0, data:null};否则
   * data={label,phase,format,deckCount,slotAValue,slotBValue,flowOutcomeA,
   *       flowOutcomeB,rankWinner,rankLoser,groupA,groupB}
   * groupX={links:[{cls,url,text}], fill:'own'|'inherited', unchangedInherited:bool} */
  function read(container) {
    const ga = readClassLinkGroup(container, '.cf-cl-a');
    const gb = readClassLinkGroup(container, '.cf-cl-b');
    const invalid = ga.invalid + gb.invalid;
    if (invalid > 0) return { invalid, data: null };
    const deckCount = Number(container.querySelector('.cf-deck-count').value);
    const rw = Number(container.querySelector('.cf-rank-winner').value);
    const rl = Number(container.querySelector('.cf-rank-loser').value);
    return {
      invalid: 0,
      data: {
        label: container.querySelector('.cf-label').value.trim() || '未命名对局',
        phase: container.querySelector('.cf-phase').value.trim(),
        format: container.querySelector('.cf-format').value.trim() || 'BO3',
        deckCount: Number.isFinite(deckCount) && deckCount > 0 ? deckCount : null,
        slotAValue: container.querySelector('.cf-slot-a').value,
        slotBValue: container.querySelector('.cf-slot-b').value,
        flowOutcomeA: container.querySelector('.cf-flow-outcome-a').value === 'loser' ? 'loser' : 'winner',
        flowOutcomeB: container.querySelector('.cf-flow-outcome-b').value === 'loser' ? 'loser' : 'winner',
        rankWinner: Number.isFinite(rw) ? rw : null,
        rankLoser: Number.isFinite(rl) ? rl : null,
        groupA: ga,
        groupB: gb
      }
    };
  }

  /* 保存时一侧的最终值:own 模式清空到零行 → null(显式阻断继承);
   * inherited 模式未改动 → 不动原值(继续继承);其余写入行内容 */
  function resolveGroup(currentLinks, groupId, result) {
    if (result.fill === 'own') {
      return result.links.length ? result.links : null;
    }
    if (result.unchangedInherited) {
      return (currentLinks && currentLinks[groupId] !== undefined) ? currentLinks[groupId] : [];
    }
    return result.links;
  }

  /* 把 read().data 写回 card(与旧 saveCardDialog 写回语义逐行等价) */
  function applyToCard(card, data) {
    card.label = data.label;
    card.phase = data.phase;
    card.format = data.format;
    card.deckCount = data.deckCount;
    if (data.slotAValue === '') {
      card.slots[0] = { type: 'empty' };
    } else if (data.slotAValue && data.slotAValue !== '__flow') {
      card.slots[0] = { type: 'player', playerId: data.slotAValue };
    } else if (data.slotAValue === '__flow' && card.slots[0] && card.slots[0].type === 'flow') {
      card.slots[0].outcome = data.flowOutcomeA === 'loser' ? 'loser' : 'winner';
    }
    if (data.slotBValue === '') {
      card.slots[1] = { type: 'empty' };
    } else if (data.slotBValue && data.slotBValue !== '__flow') {
      card.slots[1] = { type: 'player', playerId: data.slotBValue };
    } else if (data.slotBValue === '__flow' && card.slots[1] && card.slots[1].type === 'flow') {
      card.slots[1].outcome = data.flowOutcomeB === 'loser' ? 'loser' : 'winner';
    }
    card.exitRanks = card.exitRanks || {};
    card.exitRanks.winner = data.rankWinner;
    card.exitRanks.loser = data.rankLoser;
    card.classLinks = {
      a: resolveGroup(card.classLinks, 'a', data.groupA),
      b: resolveGroup(card.classLinks, 'b', data.groupB)
    };
  }

  /* live 模式:末行非空时补一行空行(保持焦点不整体重绘) */
  function ensureTrailingRow(container) {
    for (const listCls of ['.cf-cl-a', '.cf-cl-b']) {
      const list = container.querySelector(listCls);
      if (!list) continue;
      const rows = list.querySelectorAll('.cl-row');
      const last = rows[rows.length - 1];
      if (!last) continue;
      const cls = last.querySelector('.cl-cls').value;
      const url = last.querySelector('.cl-url').value.trim();
      const text = last.querySelector('.cl-text').value.trim();
      if (cls || url || text) {
        list.insertAdjacentHTML('beforeend', clRowHtml(null));
      }
    }
  }

  /* 行删除走事件委托:renderClassLinkRows/ensureTrailingRow 重建行不需要重复绑定;
   * 弹窗与抽屉两容器各自挂一次 */
  function bindRowDeletion(container) {
    for (const listCls of ['.cf-cl-a', '.cf-cl-b']) {
      const list = container.querySelector(listCls);
      if (!list) continue;
      list.addEventListener('click', (event) => {
        const del = event.target.closest('[data-cl-del]');
        if (del) del.closest('.cl-row').remove();
      });
    }
  }

  return {
    fieldsHtml,
    fill,
    read,
    applyToCard,
    ensureTrailingRow,
    bindRowDeletion
  };
});
