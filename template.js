'use strict';
/* 卡片模板:放置引擎(模板/粘贴共用)+ 模板抽屉(个人库/市场)+ 保存弹窗。
 * 数据面见 api/templates.js;纯函数见 canvas-model captureTemplate/materializeTemplate。
 * 本模块不进 common.js(D-04 债),不进 list.html(仅画布编辑页加载)。 */
(function () {
  if (window.CanvasTemplates) return;
  const U = window.TournamentUtils;
  const TPL_ICON = 'dashboard_customize';
  const THUMB_W = 220;        /* 抽屉缩略图目标宽(px) */
  const CLOSE_MS = 220;       /* 与 card-panel 收回动画同拍 */

  /* fetch 统一出口:非 2xx 抛错(message 透服务端 error 文案,err.status 留给 409 分支) */
  async function fetchJson(url, init) {
    const r = await fetch(url, init);
    let data = null;
    try { data = await r.json(); } catch (e) { /* 非 JSON 响应(网关页等) */ }
    if (!r.ok) {
      const error = new Error((data && data.error) ? data.error : 'HTTP ' + r.status);
      error.status = r.status;
      throw error;
    }
    return data;
  }

  function postMarket(body) {
    return fetchJson('/api/templates/market', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  /* ---------- 缩略示意渲染(模板卡/市场快照/幽灵共用) ---------- */

  /* 离屏示意:按 meta.w/h 等比缩放到 targetW 宽。卡画色块矩形(card.color 染底,
   * roll 池虚线框)+label 首行;flow 连线画卡中心到卡中心的静态线段。
   * 幽灵传 targetW = meta.w*DOT 即 1:1 原尺寸。 */
  function renderPreview(struct, targetW) {
    const DOT = (window.CanvasModel && window.CanvasModel.DOT) || 28;
    const cards = (struct && Array.isArray(struct.cards)) ? struct.cards.filter(Boolean) : [];
    if (!cards.length) return '';
    let w = Number(struct.meta && struct.meta.w) || 0;
    let h = Number(struct.meta && struct.meta.h) || 0;
    if (!(w > 0) || !(h > 0)) {
      /* meta 缺失兜底:从卡片自算(与 captureTemplate 同口径的 w/h 默认值) */
      w = Math.max.apply(null, cards.map((c) => (Number(c.x) || 0) + (Number(c.w) || 10)));
      h = Math.max.apply(null, cards.map((c) => (Number(c.y) || 0) + (Number(c.h) || 7)));
    }
    const k = (Number(targetW) > 0 ? targetW : w * DOT) / (w * DOT);
    const X = (g) => Math.round(g * DOT * k * 100) / 100;
    const size = (c) => ({ w: Number(c.w) || 10, h: Number(c.h) || 7 });
    const centers = cards.map((c) => ({
      x: X((Number(c.x) || 0) + size(c).w / 2),
      y: X((Number(c.y) || 0) + size(c).h / 2)
    }));

    let nodes = '';
    cards.forEach((c) => {
      const s = size(c);
      const color = c.color ? U.escapeHtml(String(c.color)) : '';
      /* 字号随卡高缩放,夹在 7-13px:原尺寸可读,缩略不糊版 */
      const fs = Math.max(7, Math.min(13, Math.round(s.h * DOT * k * 0.16)));
      nodes += '<div class="tpl-node' + (c.kind === 'rollPool' ? ' tpl-node-pool' : '') +
        '" style="left:' + X(Number(c.x) || 0) + 'px;top:' + X(Number(c.y) || 0) +
        'px;width:' + X(s.w) + 'px;height:' + X(s.h) + 'px;font-size:' + fs + 'px' +
        (color ? ';background:' + color : '') + '"><span>' + U.escapeHtml(String(c.label || '')) + '</span></div>';
    });

    let lines = '';
    const seen = new Set();
    cards.forEach((c, i) => {
      (c.slots || []).forEach((slot) => {
        if (!slot || slot.type !== 'flow') return;
        const j = Number(slot.cardId);
        if (!Number.isInteger(j) || j < 0 || j >= cards.length || j === i) return;
        const key = Math.min(i, j) + ':' + Math.max(i, j);
        if (seen.has(key)) return; /* 双向引用只画一条 */
        seen.add(key);
        lines += '<line x1="' + centers[i].x + '" y1="' + centers[i].y +
          '" x2="' + centers[j].x + '" y2="' + centers[j].y + '"' +
          (slot.outcome === 'loser' ? ' class="loser"' : '') + '/>';
      });
    });
    const svg = lines
      ? '<svg class="tpl-edges" viewBox="0 0 ' + X(w) + ' ' + X(h) + '" aria-hidden="true">' + lines + '</svg>'
      : '';
    return '<div class="tpl-canvas" style="width:' + X(w) + 'px;height:' + X(h) + 'px">' + svg + nodes + '</div>';
  }

  /* 抽屉缩略缓存:模板内容只随 updatedAt 变,重开抽屉/切 tab 不重算 */
  const thumbCache = new Map();
  function thumbHtml(t) {
    const key = t.id + '|' + (t.updatedAt || 0);
    if (thumbCache.has(key)) return thumbCache.get(key);
    if (thumbCache.size > 300) thumbCache.clear(); /* 市场全局量级上限保护 */
    const html = renderPreview({ cards: t.cards, meta: t.meta }, THUMB_W);
    thumbCache.set(key, html);
    return html;
  }

  /* ---------- 幽灵放置引擎(模板落子 / Ctrl+V 粘贴共用) ---------- */

  let placing = null; /* { struct, source, ghostEl } */

  function isActive() { return !!placing; }

  function enterPlacement(struct, opts) {
    if (!window.CanvasEditor || !CanvasEditor.isCanvasActive()) return false;
    if (!struct || !Array.isArray(struct.cards) || !struct.cards.length) return false;
    exitPlacement();
    const metaW = Number(struct.meta && struct.meta.w) || 0;
    const ghost = document.createElement('div');
    ghost.className = 'tpl-ghost';
    ghost.innerHTML = renderPreview(struct, metaW > 0 ? metaW * ((window.CanvasModel && window.CanvasModel.DOT) || 28) : 0);
    ghost.style.visibility = 'hidden'; /* 首次 mousemove 前不亮相(尚无光标坐标) */
    document.body.appendChild(ghost);
    placing = { struct, source: (opts && opts.source) || 'template', ghostEl: ghost };
    document.body.classList.add('tpl-placing');
    document.addEventListener('mousemove', onGhostMove, true);
    document.addEventListener('keydown', onPlacingKey, true);
    document.addEventListener('contextmenu', onPlacingContext, true);
    document.addEventListener('pointerdown', onPlacingPointerDown, true);
    return true;
  }

  function exitPlacement() {
    if (!placing) return;
    placing.ghostEl.remove();
    placing = null;
    document.body.classList.remove('tpl-placing');
    document.removeEventListener('mousemove', onGhostMove, true);
    document.removeEventListener('keydown', onPlacingKey, true);
    document.removeEventListener('contextmenu', onPlacingContext, true);
    document.removeEventListener('pointerdown', onPlacingPointerDown, true);
  }

  function onGhostMove(e) {
    if (!placing) return;
    placing.ghostEl.style.visibility = '';
    positionGhost(placing.ghostEl, e.clientX, e.clientY);
  }

  /* 包围盒中心吸附光标 */
  function positionGhost(el, cx, cy) {
    const s = el.getBoundingClientRect();
    el.style.left = (cx - s.width / 2) + 'px';
    el.style.top = (cy - s.height / 2) + 'px';
  }

  /* Esc 取消:捕获层截住,不让 canvas-editor 的 Esc 清掉画布选择 */
  function onPlacingKey(e) {
    if (!placing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      exitPlacement();
    }
  }

  /* 右键=取消:统一在 contextmenu 层拦(顺带压掉原生菜单);
   * pointerdown 层只阻断画布手势,不在此撤,避免右键菜单闪出 */
  function onPlacingContext(e) {
    if (placing) {
      e.preventDefault();
      exitPlacement();
    }
  }

  /* 画布区左键=落子;其它键位阻断画布手势(右键取消走 contextmenu 层)。
   * 捕获层 stopPropagation:canvas-editor 的画布 pointerdown(平移/框选/拖卡)
   * 绑在 #canvas-scroll 冒泡层,事件到不了它即被短路——无需改 canvas-editor */
  function onPlacingPointerDown(e) {
    if (!placing) return;
    const sc = document.getElementById('canvas-scroll');
    if (!sc || !(e.target === sc || (e.target.closest && e.target.closest('#canvas-scroll')))) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.button === 0) {
      placeNow(e.clientX, e.clientY);
    } else if (e.button !== 2) {
      exitPlacement(); /* 中键等:取消;右键(2)留给 contextmenu 层 */
    }
  }

  function placeNow(clientX, clientY) {
    const p = placing;
    if (!p) return;
    const pt = CanvasEditor.toGridPoint(clientX, clientY);
    closeDrawer();
    exitPlacement();
    suppressNextDblClick();
    CanvasEditor.placeCardsAt(pt.x, pt.y, p.struct).then((clones) => {
      if (!clones || !clones.length) return;
      U.notify('已放置 ' + clones.length + ' 张卡片(' +
        (p.source === 'clipboard' ? '粘贴' : '模板') + '),Ctrl+Z 可撤销');
    }).catch(() => {
      U.notify('放置后保存失败,改动仍在,请手动保存', 'danger');
    });
  }

  /* 落子那一击的 pointerdown 被拦,但浏览器仍可能补发 click/dblclick:
   * 快速连点会让 dblclick 落到画布空档触发"双击建卡"。吞掉落子后短窗内的 dblclick */
  function suppressNextDblClick() {
    const swallow = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('dblclick', swallow, true);
    setTimeout(() => document.removeEventListener('dblclick', swallow, true), 400);
  }

  /* ---------- 保存弹窗(<dialog>,风格对齐 common.js confirmDialog 族) ---------- */

  let promptDlg = null;

  function buildPromptDialog() {
    promptDlg = document.createElement('dialog');
    promptDlg.className = 'tpl-prompt';
    promptDlg.id = 'tpl-prompt';
    promptDlg.setAttribute('aria-labelledby', 'tpl-prompt-title');
    promptDlg.innerHTML =
      '<div class="dialog-head"><h2 id="tpl-prompt-title">保存模板</h2></div>' +
      '<div class="dialog-body">' +
      '  <label class="form-field"><span id="tpl-prompt-label">模板名</span>' +
      '    <input type="text" id="tpl-prompt-input" maxlength="20" autocomplete="off"></label>' +
      '  <p class="form-error" id="tpl-prompt-error" hidden></p>' +
      '  <div class="dialog-actions">' +
      '    <button type="button" class="btn btn-secondary" data-tpl-prompt-cancel>取消</button>' +
      '    <button type="button" class="btn btn-primary" data-tpl-prompt-ok>确定</button>' +
      '  </div>' +
      '</div>';
    const input = promptDlg.querySelector('#tpl-prompt-input');
    promptDlg.querySelector('[data-tpl-prompt-ok]').addEventListener('click', () => { settlePrompt(true); });
    promptDlg.querySelector('[data-tpl-prompt-cancel]').addEventListener('click', () => { promptDlg.close(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); settlePrompt(true); }
    });
    /* Esc 触发 cancel 走默认 close,统一在 close 里结算(null=取消) */
    promptDlg.addEventListener('close', () => {
      const resolve = promptDlg.__resolve;
      promptDlg.__resolve = null;
      if (resolve) resolve(promptDlg.__value === undefined ? null : promptDlg.__value);
    });
    document.body.appendChild(promptDlg);
  }

  function settlePrompt(ok) {
    const input = promptDlg.querySelector('#tpl-prompt-input');
    const err = promptDlg.querySelector('#tpl-prompt-error');
    const name = input.value.trim();
    if (ok) {
      if (!name) { err.textContent = '模板名不能为空'; err.hidden = false; input.focus(); return; }
      if (name.length > 20) { err.textContent = '模板名最多 20 字'; err.hidden = false; input.focus(); return; }
      promptDlg.__value = name;
    } else {
      promptDlg.__value = null;
    }
    promptDlg.close();
  }

  /* 返回 Promise<string|null>:确定=名字,取消/Esc=null */
  function promptName(title, initial) {
    return new Promise((resolve) => {
      if (!promptDlg) buildPromptDialog();
      promptDlg.__value = null;
      promptDlg.__resolve = resolve;
      promptDlg.querySelector('#tpl-prompt-title').textContent = title;
      promptDlg.querySelector('#tpl-prompt-label').textContent = title + '名';
      const input = promptDlg.querySelector('#tpl-prompt-input');
      input.value = initial || '';
      const err = promptDlg.querySelector('#tpl-prompt-error');
      err.hidden = true;
      err.textContent = '';
      promptDlg.showModal();
      input.focus();
      input.select();
    });
  }

  /* 选中卡捕获为模板:先捕获(结构随当下选中集),再问名;撞名 uiConfirm 覆盖 */
  async function saveSelectionAsTemplate() {
    if (!window.CanvasEditor || !window.CanvasModel) return;
    const cards = CanvasEditor.getSelectedCards();
    if (!cards.length) { U.notify('请先选中要保存为模板的卡片', 'danger'); return; }
    const cap = CanvasModel.captureTemplate(cards);
    if (!cap.cards.length) return;
    const name = await promptName('保存模板', '');
    if (name === null) return;
    let lib;
    try {
      lib = await fetchJson('/api/templates');
    } catch (error) {
      U.notify('模板库读取失败:' + error.message, 'danger');
      return;
    }
    const list = (lib && lib.templates) || [];
    const hit = list.find((t) => t.name === name);
    /* uiConfirm 走 textContent,名字原样安全 */
    if (hit && !(await U.uiConfirm('已有同名模板「' + name + '」,覆盖?'))) return;
    const now = Date.now();
    const next = hit
      ? list.map((t) => t.id === hit.id
        ? Object.assign({}, t, { cards: cap.cards, meta: cap.meta, updatedAt: now })
        : t)
      : list.concat([{
        id: 'tpl_' + (window.crypto && crypto.randomUUID
          ? crypto.randomUUID()
          : Date.now().toString(36) + Math.random().toString(16).slice(2)),
        name,
        cards: cap.cards,
        meta: cap.meta,
        createdAt: now,
        updatedAt: now
      }]);
    try {
      await fetchJson('/api/templates', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templates: next })
      });
      U.notify('模板「' + name + '」已保存(' + cap.cards.length + ' 张卡片)');
    } catch (error) {
      U.notify('保存失败:' + error.message, 'danger');
    }
  }

  /* ---------- 模板抽屉(双 tab:个人库 / 市场) ---------- */

  let drawerEl = null;
  let drawerBody = null;
  let drawerCloseTimer = null;
  const drawerState = { tab: 'mine', lib: [], market: [], myUid: null, busy: false };

  function drawerOpen() {
    return !!(drawerEl && !drawerEl.hidden);
  }

  function buildDrawer() {
    drawerEl = document.createElement('aside');
    drawerEl.id = 'tpl-drawer';
    drawerEl.className = 'tpl-drawer';
    drawerEl.setAttribute('aria-label', '卡片模板');
    drawerEl.hidden = true;
    drawerEl.innerHTML =
      '<div class="tpl-drawer-head">' +
      '  <div class="tpl-tabs" role="tablist" aria-label="模板来源">' +
      '    <button type="button" class="tpl-tab is-active" role="tab" aria-selected="true" data-tab="mine">模板</button>' +
      '    <button type="button" class="tpl-tab" role="tab" aria-selected="false" data-tab="market">模板市场</button>' +
      '  </div>' +
      '  <button type="button" class="tpl-close" id="tpl-drawer-close" aria-label="关闭模板抽屉" title="关闭">' +
      '    <img class="icon" src="icons/close.svg" alt="" aria-hidden="true"></button>' +
      '</div>' +
      '<div class="tpl-drawer-body" id="tpl-drawer-body"></div>';
    /* 与 card-panel 同轨:挂 main 内,右缘贴工具栏左缘 */
    (document.getElementById('main-content') || document.body).appendChild(drawerEl);
    drawerBody = drawerEl.querySelector('#tpl-drawer-body');
    drawerEl.addEventListener('click', onDrawerClick);
  }

  async function openDrawer() {
    if (!window.CanvasEditor) return;
    if (!drawerEl) buildDrawer();
    /* 收回途中重开:中断收合原地复开(同 card-panel cancelPanelClose) */
    if (drawerCloseTimer) {
      clearTimeout(drawerCloseTimer);
      drawerCloseTimer = null;
      drawerEl.classList.remove('closing');
    }
    /* card-panel 开着先收起:清选择触发 hidePanel(顺带 flush 待提交改动) */
    CanvasEditor.setSelection([]);
    if (!drawerOpen()) {
      drawerEl.hidden = false;
      document.body.classList.add('tpl-drawer-open');
    }
    await refresh();
  }

  function closeDrawer() {
    if (!drawerEl || drawerEl.hidden || drawerCloseTimer) return;
    drawerEl.classList.add('closing');
    drawerCloseTimer = setTimeout(() => {
      drawerCloseTimer = null;
      drawerEl.classList.remove('closing');
      drawerEl.hidden = true;
      document.body.classList.remove('tpl-drawer-open');
    }, CLOSE_MS);
  }

  async function refresh() {
    if (!drawerBody) return;
    drawerBody.innerHTML = '<div class="tpl-empty">加载中…</div>';
    const jobs = [
      fetchJson('/api/templates').then((d) => { drawerState.lib = (d && d.templates) || []; }),
      fetchJson('/api/templates/market').then((d) => { drawerState.market = (d && d.market) || []; })
    ];
    if (!drawerState.myUid) {
      jobs.push(fetchJson('/api/me').then((d) => { drawerState.myUid = d && d.user && d.user.id; }));
    }
    const results = await Promise.allSettled(jobs);
    const reason = results.find((r) => r.status === 'rejected');
    if (reason) U.notify('模板数据加载失败:' + (reason.reason && reason.reason.message ? reason.reason.message : '网络错误'), 'danger');
    renderBody();
  }

  function listedIds() {
    const set = new Set();
    if (!drawerState.myUid) return set;
    for (const m of drawerState.market) {
      if (m && m.authorUid === drawerState.myUid && m.snapshot && m.snapshot.id) set.add(m.snapshot.id);
    }
    return set;
  }

  function fmtDate(ts) {
    const d = new Date(Number(ts) || 0);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString('zh-CN');
  }

  function renderBody() {
    if (!drawerBody) return;
    drawerEl.querySelectorAll('.tpl-tab').forEach((b) => {
      const on = b.dataset.tab === drawerState.tab;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (drawerState.tab === 'market') {
      renderMarket();
    } else {
      renderMine();
    }
  }

  function renderMine() {
    if (!drawerState.lib.length) {
      drawerBody.innerHTML = '<div class="tpl-empty">还没有模板。<br>选中卡片后,在卡片设置抽屉点「保存至模板」。</div>';
      return;
    }
    const listed = listedIds();
    drawerBody.innerHTML = '<div class="tpl-list">' + drawerState.lib.map((t) => {
      const isListed = listed.has(t.id);
      return '<div class="tpl-card" data-tid="' + U.escapeHtml(t.id) + '">' +
        '<div class="tpl-thumb">' + thumbHtml(t) + '</div>' +
        '<div class="tpl-card-info">' +
        '<span class="tpl-name" title="' + U.escapeHtml(t.name) + '">' + U.escapeHtml(t.name) + '</span>' +
        '<span class="tpl-sub">' + (t.cards ? t.cards.length : 0) + ' 张卡片' + (isListed ? ' · 已上架' : '') + '</span>' +
        '</div>' +
        '<div class="tpl-actions">' +
        (isListed
          ? '<button type="button" class="btn btn-secondary btn-sm" data-act="unlist" title="点击撤下市场条目">已上架</button>'
          : '<button type="button" class="btn btn-secondary btn-sm" data-act="list">上架市场</button>') +
        '<button type="button" class="btn btn-secondary btn-sm" data-act="use">使用</button>' +
        '<button type="button" class="btn btn-danger btn-sm" data-act="del">删除</button>' +
        '</div>' +
        '</div>';
    }).join('') + '</div>';
  }

  function renderMarket() {
    if (!drawerState.market.length) {
      drawerBody.innerHTML = '<div class="tpl-empty">市场还没有在架模板。</div>';
      return;
    }
    drawerBody.innerHTML = '<div class="tpl-list">' + drawerState.market.map((m) => {
      const snap = m.snapshot || { name: '?', cards: [] };
      return '<div class="tpl-card" data-mid="' + U.escapeHtml(m.id) + '">' +
        '<div class="tpl-thumb">' + thumbHtml(snap) + '</div>' +
        '<div class="tpl-card-info">' +
        '<span class="tpl-name" title="' + U.escapeHtml(snap.name) + '">' + U.escapeHtml(snap.name) + '</span>' +
        '<span class="tpl-sub">' + U.escapeHtml(m.authorName || '匿名') + ' · ' + fmtDate(m.listedAt) +
        ' · ' + (snap.cards ? snap.cards.length : 0) + ' 张</span>' +
        '</div>' +
        '<div class="tpl-actions">' +
        '<button type="button" class="btn btn-secondary btn-sm" data-act="adopt">加入</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" data-act="use-market">使用</button>' +
        '</div>' +
        '</div>';
    }).join('') + '</div>';
  }

  function onDrawerClick(e) {
    const tab = e.target.closest && e.target.closest('.tpl-tab');
    if (tab) {
      drawerState.tab = tab.dataset.tab === 'market' ? 'market' : 'mine';
      renderBody();
      return;
    }
    if (e.target.closest && e.target.closest('#tpl-drawer-close')) {
      closeDrawer();
      return;
    }
    const actEl = e.target.closest && e.target.closest('[data-act]');
    if (actEl) handleAction(actEl.dataset.act, actEl.closest('.tpl-card'));
  }

  function handleAction(act, cardEl) {
    if (!cardEl || drawerState.busy) return;
    if (act === 'use') {
      const t = drawerState.lib.find((x) => x.id === cardEl.dataset.tid);
      if (t) useTemplate(t);
      return;
    }
    if (act === 'use-market') {
      const m = drawerState.market.find((x) => x.id === cardEl.dataset.mid);
      if (m && m.snapshot) useTemplate(m.snapshot);
      return;
    }
    if (act === 'list') return runDrawerAction(() => listTemplate(cardEl.dataset.tid));
    if (act === 'unlist') return runDrawerAction(() => unlistTemplate(cardEl.dataset.tid));
    if (act === 'del') return runDrawerAction(() => deleteTemplate(cardEl.dataset.tid));
    if (act === 'adopt') return runDrawerAction(() => adoptMarket(cardEl.dataset.mid));
  }

  /* 按钮互斥 + 动作完成后统一刷新(成功/失败都通知) */
  async function runDrawerAction(job) {
    drawerState.busy = true;
    try {
      await job();
    } finally {
      drawerState.busy = false;
      refresh();
    }
  }

  function useTemplate(t) {
    if (!window.CanvasEditor || !CanvasEditor.isCanvasActive()) {
      U.notify('请先切回画布视图再使用模板', 'danger');
      return;
    }
    if (enterPlacement({ cards: t.cards, meta: t.meta }, { source: 'template' })) {
      U.notify('在画布上点击放置,Esc 或右键取消');
    }
  }

  async function listTemplate(tid) {
    const t = drawerState.lib.find((x) => x.id === tid);
    if (!t) return;
    try {
      await postMarket({ action: 'list', templateId: tid });
      U.notify('模板「' + t.name + '」已上架市场');
    } catch (error) {
      U.notify('上架失败:' + error.message, 'danger');
    }
  }

  async function unlistTemplate(tid) {
    const t = drawerState.lib.find((x) => x.id === tid);
    try {
      await postMarket({ action: 'unlist', templateId: tid });
      U.notify('模板「' + (t ? t.name : '') + '」已撤架');
    } catch (error) {
      U.notify('撤架失败:' + error.message, 'danger');
    }
  }

  /* 删除在架模板:先撤市场条目再落库;确认文案区分两态 */
  async function deleteTemplate(tid) {
    const t = drawerState.lib.find((x) => x.id === tid);
    if (!t) return;
    const listed = drawerState.market.some((m) => m && m.authorUid === drawerState.myUid && m.snapshot && m.snapshot.id === tid);
    if (!(await U.uiConfirm(listed
      ? '删除模板「' + t.name + '」?该模板正在市场,将同时撤架'
      : '删除模板「' + t.name + '」?'))) return;
    try {
      if (listed) await postMarket({ action: 'unlist', templateId: tid });
      await fetchJson('/api/templates', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templates: drawerState.lib.filter((x) => x.id !== tid) })
      });
      U.notify('模板「' + t.name + '」已删除');
    } catch (error) {
      U.notify('删除失败:' + error.message, 'danger');
    }
  }

  /* 加入=深拷贝进本人库;撞名 409 自动 renameTo=原名+(副本) 重发一次 */
  async function adoptMarket(mid) {
    const m = drawerState.market.find((x) => x.id === mid);
    if (!m || !m.snapshot) return;
    const name = String(m.snapshot.name || '');
    try {
      await postMarket({ action: 'adopt', marketId: mid });
      U.notify('已加入「' + name + '」到我的模板');
    } catch (error) {
      if (error.status !== 409) {
        U.notify('加入失败:' + error.message, 'danger');
        return;
      }
      const renameTo = (name + '(副本)').slice(0, 20);
      try {
        await postMarket({ action: 'adopt', marketId: mid, renameTo });
        U.notify('已加入为「' + renameTo + '」');
      } catch (error2) {
        U.notify('加入失败:' + error2.message, 'danger');
      }
    }
  }

  /* ---------- init 注入(仅画布编辑页) ---------- */

  function init() {
    if (!document.getElementById('edit-toolbar')) return;

    /* card-panel 头部:「保存至模板」(选中卡→模板库的唯一捕获入口) */
    const head = document.querySelector('.card-panel-head');
    if (head && !document.getElementById('tpl-save-btn')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-secondary btn-sm tpl-save-btn';
      btn.id = 'tpl-save-btn';
      btn.textContent = '保存至模板';
      btn.addEventListener('click', saveSelectionAsTemplate);
      head.appendChild(btn);
    }

    /* edit-toolbar:模板工具组(开抽屉;放置态点=取消放置) */
    const toolbar = document.getElementById('edit-toolbar');
    if (toolbar && !document.getElementById('edit-templates-btn')) {
      const group = document.createElement('div');
      group.className = 'tool-group';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', '模板');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'tool-btn';
      open.id = 'edit-templates-btn';
      open.title = '模板';
      open.setAttribute('aria-label', '模板');
      open.innerHTML = '<img class="icon" src="icons/' + TPL_ICON + '.svg" alt="" aria-hidden="true">';
      open.addEventListener('click', () => {
        if (isActive()) exitPlacement();
        else if (drawerOpen()) closeDrawer();
        else openDrawer();
      });
      group.appendChild(open);
      toolbar.appendChild(group);
    }

    /* 抽屉开着时在主内容区(画布/列表)交互=收起抽屉:
     * 同 card-panel「空白点选收起」语义,避免与卡片设置抽屉同轨叠影 */
    document.addEventListener('pointerdown', (e) => {
      if (!drawerOpen() || !drawerEl) return;
      if (drawerEl.contains(e.target)) return;
      if (e.target.closest && (e.target.closest('#edit-toolbar') || e.target.closest('.tpl-prompt'))) return;
      if (e.target.closest && e.target.closest('#main-content')) closeDrawer();
    }, true);
  }

  document.addEventListener('DOMContentLoaded', init);

  window.CanvasTemplates = {
    openDrawer,
    closeDrawer,
    enterPlacement,
    exitPlacement,
    isActive,
    saveSelectionAsTemplate
  };
})();
