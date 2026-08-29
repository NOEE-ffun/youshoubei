'use strict';

/**
 * 我的对局:登录选手在卡组提交窗口开启期间,为自己参与且未开始的场次
 * 提交/修改卡组(职业 + 卡组名称 + 外链)。窗口关闭即锁定并全员公示。
 * 写走 PUT /api/me/classlinks(服务端校验归属/比分/开关);本页只读
 * TournamentApp 的 workspace(自己的条目不会被服务端剥离)。
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const CM = window.CanvasModel;
  const { notify } = window.TournamentUtils;

  const state = { myId: null, tournamentId: null, records: [] };

  async function loadRecords() {
    const app = window.TournamentApp;
    try {
      state.records = (await app.storageGetAll()) || [];
    } catch (error) {
      state.records = [];
    }
  }

  /* 窗口判定与 api/decks.js 共用 canvas-model.js isWindowOpen(展示用;写权限以服务端为准) */

  function isStarted(record, cardId) {
    const r = CM.getResult((record.scores || {})[cardId]);
    return Boolean(r && r.valid && !r.draw);
  }

  function namesMap() {
    const players = (window.TournamentApp && window.TournamentApp.players) || [];
    return new Map(players.map((p) => [p.id, p.name || p.id]));
  }

  function findRecord(id) {
    return state.records.find((t) => t.id === id) || null;
  }

  function showEmpty(text, showLogin) {
    $('my-decks-body').hidden = true;
    $('my-decks-empty').hidden = false;
    $('my-decks-empty-text').textContent = text;
    $('my-decks-login-btn').hidden = !showLogin;
  }

  async function boot() {
    const app = window.TournamentApp;
    const player = await window.TournamentUtils.requirePlayerSession('我的对局', showEmpty);
    if (!player) return;
    state.myId = player.id;
    $('my-decks-empty').hidden = true;
    $('my-decks-body').hidden = false;
    /* 窗口状态/场次指派强依赖最新数据,不吃 60s 缓存:强制校新一次 */
    if (typeof app.revalidateWorkspace === 'function') {
      await app.revalidateWorkspace();
    }
    await loadRecords();
    renderTournamentOptions();
    render();
  }

  function renderTournamentOptions() {
    const app = window.TournamentApp;
    const sel = $('my-decks-tournament');
    const list = app.list || [];
    if (!list.length) {
      state.tournamentId = null;
      return;
    }
    if (!state.tournamentId || !list.some((t) => t.id === state.tournamentId)) {
      state.tournamentId = (app.current && app.current.id) || list[0].id;
    }
    sel.innerHTML = list.map((t) => '<option value="' + t.id + '">' + t.name + '</option>').join('');
    sel.value = state.tournamentId;
  }

  function deckRowHtml(idx, entry, editable) {
    const clsOptions = CM.CLASS_LIST.map((c) =>
      '<option value="' + c + '"' + (entry && entry.cls === c ? ' selected' : '') + '>' + c + '</option>'
    ).join('');
    if (!editable) {
      /* 协议白名单与 list.js/bracket.js 同策:非 http(s) 的外链只显示纯文本,不渲染可点链接 */
      const safeUrl = entry && entry.url && /^https?:\/\//i.test(entry.url) ? entry.url : '';
      return '<div class="md-deck-row readonly">' +
        '<img class="icon" src="icons/classes/' + encodeURIComponent(entry ? entry.cls : '') + '.svg" alt="" aria-hidden="true">' +
        '<span class="md-deck-name">' + (entry && entry.text ? escape(entry.text) : '未命名') + '</span>' +
        (safeUrl ? '<a href="' + escape(safeUrl) + '" target="_blank" rel="noopener">外链 ↗</a>' : '') +
        '</div>';
    }
    return '<div class="md-deck-row" data-slot="' + idx + '">' +
      '<select class="md-cls" aria-label="第 ' + (idx + 1) + ' 套职业">' + clsOptions + '</select>' +
      '<input type="text" class="md-text" maxlength="60" placeholder="卡组名称" value="' + escape(entry ? entry.text || '' : '') + '">' +
      '<input type="url" class="md-url" maxlength="500" placeholder="卡组外链 https://…" value="' + escape(entry ? entry.url || '' : '') + '">' +
      '</div>';
  }

  function escape(s) {
    return window.TournamentUtils.escapeHtml(String(s == null ? '' : s));
  }

  function cardBlockHtml(record, card, side, names, editable, effEntries) {
    const oppId = side === 'a' ? card.b : card.a;
    const opp = oppId ? (names.get(oppId) || '?') : '待定';
    const started = isStarted(record, card.id);
    const own = (card.classLinks && card.classLinks[side]) || [];
    const inherited = !own.length && effEntries.length > 0;

    let statusChip;
    let body;
    if (started) {
      statusChip = '<span class="md-chip md-chip-locked">已开始 · 锁定</span>';
      body = effEntries.map((e, i) => deckRowHtml(i, e, false)).join('') || '<p class="hint">无卡组记录</p>';
    } else if (editable) {
      statusChip = '<span class="md-chip md-chip-open">可修改</span>';
      const n = CM.getDeckCount(card);
      const rows = [];
      for (let i = 0; i < n; i++) rows.push(deckRowHtml(i, own[i], true));
      body = '<div class="md-form" data-card="' + escape(card.id) + '" data-side="' + side + '">' +
        rows.join('') +
        '<div class="md-form-actions">' +
        '<button type="button" class="btn btn-primary btn-sm" data-md-save>保存卡组</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-md-clear>清空(恢复继承)</button>' +
        '<span class="hint md-save-hint"></span>' +
        '</div></div>';
    } else {
      statusChip = '<span class="md-chip md-chip-wait">窗口关闭 · 等待公示</span>';
      body = (inherited ? '<p class="hint md-inherited">继承上场:' : '<p class="hint">当前:') + effEntries.length + ' 套</p>' +
        effEntries.map((e, i) => deckRowHtml(i, e, false)).join('');
    }

    return '<section class="md-card' + (started ? ' md-card-started' : '') + '" data-md-card="' + escape(card.id) + '">' +
      '<header class="md-card-head">' +
      '<span class="md-card-label">' + escape(card.label || card.id) + '</span>' +
      '<span class="md-card-opp">对手:' + escape(opp) + '</span>' +
      escape(card.format || '') + ' ' + statusChip +
      '</header>' +
      '<div class="md-card-body">' + body + '</div>' +
      '</section>';
  }

  function render() {
    const record = findRecord(state.tournamentId);
    const listEl = $('my-decks-list');
    const chip = $('my-decks-window-state');
    if (!record || !record.canvas) {
      chip.textContent = '';
      listEl.innerHTML = '<p class="hint">该比赛暂无画布数据。</p>';
      return;
    }
    const open = CM.isWindowOpen(record);
    chip.textContent = open ? '提交窗口:开放中' : '提交窗口:关闭';
    chip.className = 'my-decks-window-chip ' + (open ? 'md-chip-open' : 'md-chip-wait');

    const resolved = CM.resolveCanvas(record.canvas, record.roster || [], record.scores || {});
    const eff = CM.resolveEffectiveClassLinks(record.canvas, record.scores || {});
    const names = namesMap();
    const mine = [];
    const others = [];
    for (const rc of resolved.cards) {
      const side = rc.a === state.myId ? 'a' : rc.b === state.myId ? 'b' : null;
      if (!side) continue;
      const raw = (record.canvas.cards || []).find((c) => c.id === rc.id) || rc;
      (isStarted(record, rc.id) ? others : mine).push([raw, side, ((eff.get(rc.id) || {})[side] || [])]);
    }
    if (!mine.length && !others.length) {
      listEl.innerHTML = '<p class="hint">你在本届还没有已确定的对局(晋级产生的场次会随比分推进自动出现)。</p>';
      return;
    }
    listEl.innerHTML =
      mine.map(([card, side, effEntries]) => cardBlockHtml(record, card, side, names, open, effEntries)).join('') +
      (others.length ? '<h2 class="md-group-title">已开始的场次</h2>' +
        others.map(([card, side, effEntries]) => cardBlockHtml(record, card, side, names, false, effEntries)).join('') : '');
  }

  /* 读取一个表单块 → links 数组(空行跳过,与归一化规则一致) */
  function readForm(form) {
    const links = [];
    form.querySelectorAll('.md-deck-row').forEach((row) => {
      const cls = row.querySelector('.md-cls').value;
      const text = row.querySelector('.md-text').value.trim();
      const url = row.querySelector('.md-url').value.trim();
      if (!cls || (!text && !url)) return;
      links.push({ cls, text: text.slice(0, 60), url: url.slice(0, 500) });
    });
    return links;
  }

  async function submitForm(form, links) {
    const hint = form.querySelector('.md-save-hint');
    const btn = form.querySelector('[data-md-save]');
    btn.disabled = true;
    hint.textContent = '保存中…';
    try {
      const resp = await fetch('/api/me/classlinks', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId: state.tournamentId,
          cardId: form.dataset.card,
          side: form.dataset.side,
          links
        })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        hint.textContent = '';
        notify(data.error || '保存失败', 'danger');
        if (resp.status === 423) render(); /* 状态变了,重绘刷新锁定态 */
        return;
      }
      /* 乐观更新本地 record,立即重绘 */
      const record = findRecord(state.tournamentId);
      const card = record && (record.canvas.cards || []).find((c) => c.id === form.dataset.card);
      if (card) {
        if (!card.classLinks) card.classLinks = { a: [], b: [] };
        card.classLinks[form.dataset.side] = links;
      }
      notify('卡组已保存');
      /* 拉服务器最新并回写缓存:切到赛程页立刻能看到自己提交的卡组 */
      if (typeof window.TournamentApp.revalidateWorkspace === 'function') {
        await window.TournamentApp.revalidateWorkspace();
      }
      render();
    } catch (error) {
      hint.textContent = '';
      notify('网络错误,请稍后再试', 'danger');
    } finally {
      btn.disabled = false;
    }
  }

  $('my-decks-tournament').addEventListener('change', (event) => {
    state.tournamentId = event.target.value;
    render();
  });

  $('my-decks-list').addEventListener('click', (event) => {
    const form = event.target.closest('.md-form');
    if (!form) return;
    if (event.target.closest('[data-md-save]')) submitForm(form, readForm(form));
    else if (event.target.closest('[data-md-clear]')) submitForm(form, []);
  });

  $('my-decks-login-btn').addEventListener('click', () => {
    window.TournamentApp.openLoginDialog();
  });

  document.addEventListener('ts:ready', boot);
  document.addEventListener('ts:changed', async () => {
    if (!state.myId || $('my-decks-body').hidden) return;
    await loadRecords();
    renderTournamentOptions();
    render();
  });

  /* 页面初始化与登录守卫由 me.js 统一驱动(选手中心合并页) */
})();
