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

  /* 字段标记(不含弹窗标题/按钮/提示);container.innerHTML = CardForm.fieldsHtml()
   * 结构:四分区(基本信息/对阵/出口名次/职业卡组),短字段两列栅格,弹窗与抽屉共用;
   * 所有控件 class(cf- 与 cl- 前缀)是跨容器契约,改动须同步两侧调用方与 e2e 选择器 */
  function fieldsHtml() {
    return (
      '<div class="cf-section" data-open="1">' +
      '  <div class="cf-section-title" role="button" tabindex="0" aria-expanded="true">基本信息<img class="icon cf-chevron" src="icons/chevron_right.svg" alt="" aria-hidden="true"></div>' +
      '  <div class="cf-section-body">' +
      '  <div class="cf-grid">' +
      '    <div class="form-field span-2"><label>标题</label><input type="text" class="cf-label" aria-label="标题"></div>' +
      '    <div class="form-field"><label>阶段</label><input type="text" class="cf-phase" placeholder="胜者组决赛" aria-label="阶段"></div>' +
      '    <div class="form-field"><label>赛制</label><input type="text" class="cf-format" placeholder="BO3 / 自定义" aria-label="赛制文本"></div>' +
      '    <div class="form-field span-2"><label>卡组数量（留空自动）</label><input type="number" class="cf-deck-count" min="1" step="1" aria-label="卡组数量"></div>' +
      '  </div>' +
      '  </div>' +
      '</div>' +
      '<div class="cf-section" data-open="1">' +
      '  <div class="cf-section-title" role="button" tabindex="0" aria-expanded="true">对阵<img class="icon cf-chevron" src="icons/chevron_right.svg" alt="" aria-hidden="true"></div>' +
      '  <div class="cf-section-body">' +
      '  <div class="form-field"><label>A 位选手</label><select class="cf-slot-a" aria-label="A 位选手"></select><select class="cf-flow-outcome-a flow-outcome" hidden aria-label="A 位连线取哪个出口"><option value="winner">取其胜者</option><option value="loser">取其败者</option></select></div>' +
      '  <div class="form-field"><label>B 位选手</label><select class="cf-slot-b" aria-label="B 位选手"></select><select class="cf-flow-outcome-b flow-outcome" hidden aria-label="B 位连线取哪个出口"><option value="winner">取其胜者</option><option value="loser">取其败者</option></select></div>' +
      '  </div>' +
      '</div>' +
      '<div class="cf-section" data-open="0">' +
      '  <div class="cf-section-title" role="button" tabindex="0" aria-expanded="false">出口名次<img class="icon cf-chevron" src="icons/chevron_right.svg" alt="" aria-hidden="true"></div>' +
      '  <div class="cf-section-body">' +
      '  <div class="cf-grid">' +
      '    <div class="form-field"><label>胜者名次</label><input type="number" class="cf-rank-winner" placeholder="如 1" aria-label="胜者出口名次"></div>' +
      '    <div class="form-field"><label>败者名次</label><input type="number" class="cf-rank-loser" placeholder="如 2" aria-label="败者出口名次"></div>' +
      '  </div>' +
      '  </div>' +
      '</div>' +
      '<div class="cf-section cf-banlist-section" hidden data-open="0">' +
      '  <div class="cf-section-title" role="button" tabindex="0" aria-expanded="false">禁卡表<img class="icon cf-chevron" src="icons/chevron_right.svg" alt="" aria-hidden="true"></div>' +
      '  <div class="cf-section-body">' +
      '  <div class="form-field span-2 cf-banlists"></div>' +
      '  <p class="hint">勾选本卡生效的禁卡表;双方卡组命中禁用或超限卡会在比赛页标红。</p>' +
      '  </div>' +
      '</div>' +
      '<div class="cf-section" data-open="1">' +
      '  <div class="cf-section-title" role="button" tabindex="0" aria-expanded="true">职业卡组<img class="icon cf-chevron" src="icons/chevron_right.svg" alt="" aria-hidden="true"></div>' +
      '  <div class="cf-section-body">' +
      '  <div class="form-field"><label>A 位选手(查看模式点击图标跳转)</label><div class="cl-list cf-cl-a"></div></div>' +
      '  <div class="form-field"><label>B 位选手</label><div class="cl-list cf-cl-b"></div></div>' +
      '  </div>' +
      '</div>'
    );
  }

  /* roll 池专属表单(弹窗与抽屉共用,同 fieldsHtml 口径):基本信息(标题/阶段/模式/
   * 形状宽高/四侧口数)+ 池位列表(动态增删)+ 池位职业卡组(每池位一组);
   * 比赛卡字段一个不出现,池位行与链接组由 fillPool 渲染、cf-pool-add 追加空行 */
  function fieldsHtmlPool() {
    return (
      '<div class="cf-section" data-open="1">' +
      '  <div class="cf-section-title" role="button" tabindex="0" aria-expanded="true">基本信息<img class="icon cf-chevron" src="icons/chevron_right.svg" alt="" aria-hidden="true"></div>' +
      '  <div class="cf-section-body"><div class="cf-grid">' +
      '    <div class="form-field span-2"><label>标题</label><input type="text" class="cf-label" aria-label="标题"></div>' +
      '    <div class="form-field"><label>阶段</label><input type="text" class="cf-phase" aria-label="阶段"></div>' +
      '    <div class="form-field"><label>模式</label><select class="cf-mode" aria-label="roll 模式">' +
      '      <option value="manual">手动 Roll</option><option value="auto">自动(逐人随机)</option></select></div>' +
      '    <div class="form-field"><label>宽(格)</label><input type="number" class="cf-w" min="2" max="40" step="1" aria-label="宽"></div>' +
      '    <div class="form-field"><label>高(格)</label><input type="number" class="cf-h" min="2" max="40" step="1" aria-label="高"></div>' +
      '    <div class="form-field"><label>左右口数(每侧)</label><input type="number" class="cf-lr" min="0" step="1" aria-label="左右口数"></div>' +
      '    <div class="form-field"><label>上下口数(每侧)</label><input type="number" class="cf-tb" min="0" step="1" aria-label="上下口数"></div>' +
      '  </div></div>' +
      '</div>' +
      '<div class="cf-section" data-open="1">' +
      '  <div class="cf-section-title" role="button" tabindex="0" aria-expanded="true">池位<img class="icon cf-chevron" src="icons/chevron_right.svg" alt="" aria-hidden="true"></div>' +
      '  <div class="cf-section-body"><div class="cf-pool-slots"></div>' +
      '  <button type="button" class="btn btn-ghost btn-sm cf-pool-add">添加池位</button></div>' +
      '</div>' +
      '<div class="cf-section" data-open="1">' +
      '  <div class="cf-section-title" role="button" tabindex="0" aria-expanded="true">池位职业卡组<img class="icon cf-chevron" src="icons/chevron_right.svg" alt="" aria-hidden="true"></div>' +
      '  <div class="cf-section-body"><div class="cf-pool-links"></div></div>' +
      '</div>'
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
      '<input type="url" class="cl-url" placeholder="卡组链接或国服牌组码(粘贴自动转链接)" value="' + escapeHtml(e.url || '') + '">' +
      '<input type="text" class="cl-text" placeholder="悬停文字" value="' + escapeHtml(e.text || '') + '">' +
      '<button type="button" class="btn btn-ghost btn-sm cl-del" data-cl-del title="删除此行" aria-label="删除此行"><img class="icon" src="icons/close.svg" alt="" aria-hidden="true"></button>' +
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
        /* 签名只取 UI 可见三字段并按读取侧同规则归一:上游条目可能携带 deck 快照,
         * 整体 stringify 会与读取侧 {cls,url,text} 恒不等,继承侧被误判为用户改动而固化 */
        list.dataset.effSig = JSON.stringify(effRows.map((e) => ({
          cls: e.cls || '',
          url: window.CanvasModel.normalizeDeckUrl(e.url || ''),
          text: String(e.text || '').trim().slice(0, 60)
        })));
        list.innerHTML = effRows.map(clRowHtml).join('') + clRowHtml(null);
      }
    }
  }

  /* 回填:card=卡片数据;eff={a:[],b:[]} 该卡有效职业链接(继承回显);
   * flowSourceLabels={a,b} 连线来源可读名称(调用方算好传入,缺省空串) */
  function fill(container, card, eff, flowSourceLabels) {
    const labels = flowSourceLabels || {};
    container.querySelector('.cf-label').value = card.label || '';
    const blSection = container.querySelector('.cf-banlist-section');
    if (blSection) {
      const rec = window.TournamentApp && window.TournamentApp.current;
      const lists = (rec && window.CanvasModel.normalizeBanLists(rec.banLists) || []).filter((l) => l.cards.length);
      if (lists.length) {
        const bound = new Set(window.CanvasModel.normalizeBanListIds(card.banListIds));
        container.querySelector('.cf-banlists').innerHTML = lists.map((l) =>
          '<label class="cf-banlist-opt"><input type="checkbox" class="cf-banlist-check" value="' + escapeHtml(l.id) + '"' +
          (bound.has(l.id) ? ' checked' : '') + '>' + escapeHtml(l.name) + '(' + l.cards.length + ' 卡)</label>').join('');
        blSection.hidden = false;
      } else {
        blSection.hidden = true;
      }
    }
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

  function readClassLinkGroup(container, listCls, lenient) {
    const list = container.querySelector(listCls);
    const out = [];
    let invalid = 0;
    list.querySelectorAll('.cl-row').forEach((row) => {
      const cls = row.querySelector('.cl-cls').value;
      /* 国服牌组码/裸 hash 读值时也归一(未失焦直接保存的兜底,且继承签名比对双方须同规则) */
      const url = window.CanvasModel.normalizeDeckUrl(row.querySelector('.cl-url').value);
      const text = row.querySelector('.cl-text').value.trim().slice(0, 60);
      if (cls && (url || text)) {
        out.push({ cls, url, text });
      } else if ((cls || url || text) && !lenient) {
        /* 选了职业没内容,或填了内容没选职业:不完整行。宽容读取(lenient,
         * 抽屉收口用)按行级丢弃不计 invalid,一行中间态不整体拒绝其余字段 */
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
   * groupX={links:[{cls,url,text}], fill:'own'|'inherited', unchangedInherited:bool}
   * opts.lenient(抽屉收口路径专用):不完整职业行按行级丢弃、恒返回 data——
   * 换卡/收抽屉/防抖到点时宽容落盘已完整字段;弹窗保存仍走严格模式拦下提示 */
  function read(container, opts) {
    const lenient = Boolean(opts && opts.lenient);
    const ga = readClassLinkGroup(container, '.cf-cl-a', lenient);
    const gb = readClassLinkGroup(container, '.cf-cl-b', lenient);
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
        groupB: gb,
        banListIds: Array.from(container.querySelectorAll('.cf-banlist-check:checked')).map((el) => el.value),
      }
    };
  }

  /* 保存时一侧的最终值:own 模式清空到零行 → null(显式阻断继承);
   * inherited 模式未改动 → 不动原值(继续继承);其余写入行内容。
   * own 模式行内容未变(cls+url 同)时保留旧条目的 deck 快照——表单只回读
   * cls/url/text,逐字重建会把服务端解析/选手提交附带的快照抹掉,连带丢
   * 禁卡表违规判定与统计口径(改链接/换职业时快照失效,丢弃走补解析) */
  function resolveGroup(currentLinks, groupId, result) {
    if (result.fill === 'own') {
      if (!result.links.length) return null;
      const prev = (currentLinks && Array.isArray(currentLinks[groupId])) ? currentLinks[groupId] : [];
      return result.links.map((entry) => {
        const old = prev.find((e) => e && e.deck && e.cls === entry.cls && e.url === entry.url);
        return old ? Object.assign({ deck: old.deck }, entry) : entry;
      });
    }
    if (result.unchangedInherited) {
      return (currentLinks && currentLinks[groupId] !== undefined) ? currentLinks[groupId] : [];
    }
    return result.links;
  }

  /* 把 read().data 写回 card(写回语义与弹窗时代逐行等价,弹窗已下线) */
  function applyToCard(card, data) {
    card.label = data.label;
    card.phase = data.phase;
    card.format = data.format;
    card.deckCount = data.deckCount;
    if (Array.isArray(data.banListIds) && data.banListIds.length) card.banListIds = data.banListIds;
    else delete card.banListIds;
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

  /* ========== roll 池表单(池位行/池位职业组/读写/口数守卫) ========== */

  /* 池位行:选手 select / 连线位只读(__flow)/ 删行。
   * data-prev-slot 存原槽 JSON:连线位不可在表单换源,readPool 读回时还原原槽
   * (含 outlet 与 inlet,删改别的池位不影响它的连线) */
  function poolSlotRowHtml(slot, flowLabel) {
    const isFlow = slot && slot.type === 'flow';
    const selected = !isFlow && slot && slot.type === 'player' ? slot.playerId : '';
    return (
      '<div class="cf-pool-row" data-prev-slot="' + escapeHtml(JSON.stringify(slot || null)) + '">' +
      '<select class="cf-pool-player" aria-label="池位选手">' + playerOptions(selected) +
      (isFlow ? '<option value="__flow" selected>来自 ' + escapeHtml(flowLabel || '连线') + '</option>' : '') +
      '</select>' +
      '<button type="button" class="btn btn-ghost btn-sm cf-pool-del" title="删除此池位" aria-label="删除此池位"><img class="icon" src="icons/close.svg" alt=""></button>' +
      '</div>'
    );
  }

  /* 池位职业卡组单组:own(该池位已填过,含显式清空 null)回显自己的,未填过回显
   * 继承(eff 池位组);签名口径与 renderClassLinkRows 相同(UI 可见三字段归一)。
   * origIndex=渲染时的池位下标:删中位槽后 DOM 组序左移,写回 prev 须按原下标
   * 对位旧数组(cf-pool-add 新增组不传 → 无历史);index 只作显示序号 */
  function poolLinksGroupHtml(index, own, effRows, origIndex) {
    const seats = effRows || [];
    const orig = origIndex === undefined ? '' : ' data-orig-index="' + origIndex + '"';
    let dataset;
    let rows;
    if (own === null || (Array.isArray(own) && own.length)) {
      dataset = ' data-fill="own"';
      rows = (own || []).map(clRowHtml).join('') + clRowHtml(null);
    } else {
      dataset = ' data-fill="inherited" data-eff-sig="' + escapeHtml(JSON.stringify(seats.map((e) => ({
        cls: e.cls || '',
        url: window.CanvasModel.normalizeDeckUrl(e.url || ''),
        text: String(e.text || '').trim().slice(0, 60)
      })))) + '"';
      rows = seats.map(clRowHtml).join('') + clRowHtml(null);
    }
    return '<div class="form-field"><label>池位 ' + (index + 1) + '</label><div class="cl-list cf-cl-p"' + orig + dataset + '>' + rows + '</div></div>';
  }

  /* 池位增删:池位行容器与职业组容器按下标一一对应,两侧同步增删 */
  function appendPoolSlot(container) {
    const slotsEl = container.querySelector('.cf-pool-slots');
    const linksEl = container.querySelector('.cf-pool-links');
    if (!slotsEl || !linksEl) return;
    slotsEl.insertAdjacentHTML('beforeend', poolSlotRowHtml(null, ''));
    linksEl.insertAdjacentHTML('beforeend', poolLinksGroupHtml(linksEl.children.length, undefined, []));
  }

  function removePoolSlot(container, delBtn) {
    const row = delBtn.closest('.cf-pool-row');
    if (!row) return;
    const siblings = row.parentElement ? row.parentElement.children : [];
    const index = Array.prototype.indexOf.call(siblings, row);
    row.remove();
    const linksEl = container.querySelector('.cf-pool-links');
    if (linksEl && index >= 0 && linksEl.children[index]) linksEl.children[index].remove();
  }

  /* roll 池回填:card=池卡数据;eff 是 resolveEffectiveClassLinks 的池形态
   * {seats:[[],...]};flowSourceLabels 按池位下标传 {s0,s1,...}(调用方算好) */
  function fillPool(container, card, eff, flowSourceLabels) {
    const labels = flowSourceLabels || {};
    container.querySelector('.cf-label').value = card.label || '';
    container.querySelector('.cf-phase').value = card.phase || '';
    container.querySelector('.cf-mode').value = card.mode === 'auto' ? 'auto' : 'manual';
    container.querySelector('.cf-w').value = card.w;
    container.querySelector('.cf-h').value = card.h;
    container.querySelector('.cf-lr').value = card.ports ? card.ports.lr : '';
    container.querySelector('.cf-tb').value = card.ports ? card.ports.tb : '';
    const slotsEl = container.querySelector('.cf-pool-slots');
    slotsEl.innerHTML = (card.slots || []).map((s, i) =>
      poolSlotRowHtml(s, labels['s' + i])).join('');
    const effSeats = (eff && eff.seats) || [];
    const linksEl = container.querySelector('.cf-pool-links');
    linksEl.innerHTML = (card.slots || []).map((_, i) =>
      poolLinksGroupHtml(i, (card.classLinks || [])[i], effSeats[i], i)).join('');
  }

  /* roll 池读取:池位行(select 值;__flow 保留原槽不可换源)+ 每池位职业组。
   * 不完整职业行静默跳过(与 a/b 口径不同:池位多、逐组弹提示过于打断) */
  function readPool(container) {
    const slots = [];
    container.querySelectorAll('.cf-pool-row').forEach((row) => {
      const v = row.querySelector('.cf-pool-player').value;
      const prev = row.dataset.prevSlot ? JSON.parse(row.dataset.prevSlot) : null;
      if (v === '') slots.push({ type: 'empty' });
      else if (v === '__flow') {
        /* 连线位不可在表单换源:保留原槽 */
        slots.push(prev && prev.type === 'flow' ? prev : { type: 'empty' });
      } else slots.push({ type: 'player', playerId: v });
    });
    const links = [];
    container.querySelectorAll('.cf-cl-p').forEach((list) => {
      const rows = [];
      list.querySelectorAll('.cl-row').forEach((row) => {
        const cls = row.querySelector('.cl-cls').value;
        const url = window.CanvasModel.normalizeDeckUrl(row.querySelector('.cl-url').value);
        const text = row.querySelector('.cl-text').value.trim().slice(0, 60);
        if (cls && (url || text)) rows.push({ cls, url, text });
      });
      const unchangedInherited = list.dataset.fill === 'inherited' &&
        JSON.stringify(rows) === list.dataset.effSig;
      const orig = list.dataset.origIndex;
      links.push({ rows, fill: list.dataset.fill, unchangedInherited,
        origIndex: orig === undefined ? undefined : Number(orig) });
    });
    const num = (sel) => Number(container.querySelector(sel).value);
    return {
      label: container.querySelector('.cf-label').value.trim() || 'Roll 池',
      phase: container.querySelector('.cf-phase').value.trim(),
      mode: container.querySelector('.cf-mode').value === 'auto' ? 'auto' : 'manual',
      w: num('.cf-w'), h: num('.cf-h'), lr: num('.cf-lr'), tb: num('.cf-tb'),
      slots, links
    };
  }

  /* roll 池写回;canvas 传入做口数悬空守卫:钳制后的新口列表不含任何被引用出口
   * (他卡 flow 槽 {cardId 本卡, outlet 非空})即拒绝,返回 false 数据不动。
   * container 传入表单容器时(弹窗/抽屉):成功写回后把各组 data-orig-index 重刷
   * 为当前 DOM 下标——写回产生的新数组与 DOM 序恒等对齐,而 live 抽屉不重填表单,
   * 不重刷则下一次 apply 仍用渲染期旧下标索引已重写的新数组(prev 错位:末组
   * undefined 丢 deck、中间组吸走邻组值);守卫失败路径数据未动,不刷 */
  function applyToCardPool(card, data, canvas, container) {
    const shape = window.CanvasModel.clampPoolShape(data.w, data.h, data.lr, data.tb);
    const kept = new Set(window.CanvasModel.outletList({ lr: shape.lr, tb: shape.tb }));
    for (const c of (canvas && canvas.cards) || []) {
      for (const s of c.slots || []) {
        if (s && s.type === 'flow' && s.cardId === card.id && s.outlet && !kept.has(s.outlet)) return false;
      }
    }
    card.label = data.label;
    card.phase = data.phase;
    card.mode = data.mode;
    card.w = shape.w;
    card.h = shape.h;
    card.ports = { lr: shape.lr, tb: shape.tb };
    if (card.mode === 'auto') card.assignments = null; /* 切自动丢弃快照 */
    card.slots = data.slots;
    /* 组序按 DOM 新序(新数组对齐新槽位序);prev 取历史值按组的 origIndex
     * (渲染期原下标)对位旧数组——删中位槽后 DOM 左移一位,若按新序取 prev,
     * 被删槽的 own 卡组会错挂到剩余槽(null 则错误阻断其继承,own 组 deck
     * 快照也会因查错 prev 而静默丢失);cf-pool-add 新增组无 origIndex → undefined */
    card.classLinks = data.links.map((g) => {
      const prev = g.origIndex === undefined ? undefined : (card.classLinks || [])[g.origIndex];
      if (g.fill === 'own') {
        if (!g.rows.length) return null;
        return g.rows.map((entry) => {
          const old = prev && Array.isArray(prev) ? prev.find((e) => e && e.deck && e.cls === entry.cls && e.url === entry.url) : null;
          return old ? Object.assign({ deck: old.deck }, entry) : entry;
        });
      }
      if (g.unchangedInherited) return prev !== undefined ? prev : [];
      return g.rows;
    });
    if (container) {
      container.querySelectorAll('.cf-cl-p').forEach((list, i) => {
        list.dataset.origIndex = String(i);
      });
    }
    return true;
  }

  /* live 模式:末行非空时补一行空行(保持焦点不整体重绘);roll 池逐组同口径 */
  function ensureTrailingRow(container) {
    for (const list of container.querySelectorAll('.cf-cl-a, .cf-cl-b, .cf-cl-p')) {
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

  /* 行级事件委托:renderClassLinkRows/ensureTrailingRow 重建行不需要重复绑定;
   * 弹窗与抽屉两容器各自挂一次。删除行 + 国服牌组码失焦转官网链接(canvas-model
   * 同一规则源)+ roll 池池位增删。全部委托在容器上:比赛卡两组与池位组共用同一
   * 监听,表单按卡型重建 innerHTML 或池位组动态增删都不需要重绑 */
  function bindRowDeletion(container) {
    /* 分区折叠(P4):标题行点按切换 cf-section data-open,内容 DOM 恒在不丢输入态 */
    container.addEventListener('click', (event) => {
      const title = event.target.closest('.cf-section-title');
      if (title) {
        const sec = title.closest('.cf-section');
        if (!sec) return;
        const open = sec.dataset.open !== '0';
        sec.dataset.open = open ? '0' : '1';
        title.setAttribute('aria-expanded', String(!open));
        return;
      }
      const del = event.target.closest('[data-cl-del]');
      if (del) {
        const row = del.closest('.cl-row');
        if (row) row.remove();
        return;
      }
      const poolDel = event.target.closest('.cf-pool-del');
      if (poolDel) {
        removePoolSlot(container, poolDel);
        return;
      }
      const poolAdd = event.target.closest('.cf-pool-add');
      if (poolAdd) appendPoolSlot(container);
    });
    container.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const title = event.target.closest ? event.target.closest('.cf-section-title') : null;
      if (!title) return;
      event.preventDefault();
      title.click();
    });
    /* focusout 冒泡,容器级委托对动态增删的池位组同样生效 */
    container.addEventListener('focusout', (event) => {
      const input = event.target.closest ? event.target.closest('.cl-url') : null;
      if (!input) return;
      const normalized = window.CanvasModel.normalizeDeckUrl(input.value);
      if (normalized !== input.value) input.value = normalized;
    });
  }

  return {
    fieldsHtml,
    fieldsHtmlPool,
    fill,
    fillPool,
    read,
    readPool,
    applyToCard,
    applyToCardPool,
    ensureTrailingRow,
    bindRowDeletion
  };
});
