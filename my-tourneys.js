'use strict';

/**
 * 我的比赛:选手自助报名/退报。
 * 开放报名的届排前(带操作按钮),已参加过的届随后(只读或可退),
 * 其余不显示。写走 PUT /api/me/signup(服务端校验开关/上场锁定);
 * 沿用卡组提交的全部经验:启动强制校新、乐观更新、成功后再校新。
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const CM = window.CanvasModel;
  const { notify } = window.TournamentUtils;

  const state = { myId: null, records: [] };

  async function loadRecords() {
    const app = window.TournamentApp;
    try {
      state.records = (await app.storageGetAll()) || [];
    } catch (error) {
      state.records = [];
    }
  }

  function escape(s) {
    return window.TournamentUtils.escapeHtml(String(s == null ? '' : s));
  }

  function signedUp(record) {
    const list = (record.signup && Array.isArray(record.signup.players)) ? record.signup.players : [];
    return list.includes(state.myId);
  }

  function onCanvas(record) {
    return (record.roster || []).includes(state.myId);
  }

  function namesMap() {
    const players = (window.TournamentApp && window.TournamentApp.players) || [];
    return new Map(players.map((p) => [p.id, p.name || p.id]));
  }

  function statusText(record) {
    return record.status === 'ongoing' ? '进行中' : record.status === 'finished' ? '已结束' : '未开始';
  }

  function showEmpty(text, showLogin) {
    $('my-tourneys-body').hidden = true;
    $('my-tourneys-empty').hidden = false;
    $('my-tourneys-empty-text').textContent = text;
    $('my-tourneys-login-btn').hidden = !showLogin;
  }

  async function boot() {
    const app = window.TournamentApp;
    const player = await window.TournamentUtils.requirePlayerSession('我的比赛', showEmpty);
    if (!player) return;
    state.myId = player.id;
    $('my-tourneys-empty').hidden = true;
    $('my-tourneys-body').hidden = false;
    if (typeof app.revalidateWorkspace === 'function') {
      await app.revalidateWorkspace();
    }
    await loadRecords();
    render();
  }

  function cardHtml(record, names) {
    const open = Boolean(record.signup && record.signup.open);
    const joined = signedUp(record);
    const playing = onCanvas(record);
    const n = (record.signup && Array.isArray(record.signup.players)) ? record.signup.players.length : 0;
    const starters = (record.roster || []).map((id) => names.get(id)).filter(Boolean);

    let chip;
    let action = '';
    if (open) {
      chip = '<span class="md-chip md-chip-open">开放报名</span>';
      if (joined) {
        action = '<button type="button" class="btn btn-ghost btn-sm" data-signup="leave" data-id="' + escape(record.id) + '">已报名 · 取消报名</button>';
      } else {
        action = '<button type="button" class="btn btn-primary btn-sm" data-signup="join" data-id="' + escape(record.id) + '">报名</button>';
      }
    } else if (playing) {
      chip = '<span class="md-chip md-chip-locked">已参加</span>';
    } else {
      chip = '<span class="md-chip md-chip-wait">已报名(报名已关闭)</span>';
    }

    const meta = [
      statusText(record),
      record.startTime ? new Date(record.startTime).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }) : '',
      n ? ('报名 ' + n + ' 人') : ''
    ].filter(Boolean).join(' · ');

    const rules = record.rules
      ? '<p class="hint mt-rules">' + escape(String(record.rules).slice(0, 120)) + (String(record.rules).length > 120 ? '…' : '') + '</p>'
      : '';

    const rosterLine = starters.length
      ? '<p class="hint mt-roster">上场名单:' + escape(starters.join('、')) + '</p>'
      : '';

    return '<section class="md-card mt-card" data-record="' + escape(record.id) + '">' +
      '<header class="md-card-head">' +
      '<span class="md-card-label">' + escape(record.name || '未命名') + '</span>' +
      chip +
      '</header>' +
      '<p class="hint">' + escape(meta) + '</p>' +
      rules + rosterLine +
      (action ? '<div class="md-form-actions">' + action + '</div>' : '') +
      '</section>';
  }

  function render() {
    const listEl = $('my-tourneys-list');
    const names = namesMap();
    const openOnes = [];
    const mine = [];
    for (const record of state.records) {
      if (!record || !record.canvas && !record.signup) continue;
      if (record.signup && record.signup.open) openOnes.push(record);
      else if (signedUp(record) || onCanvas(record)) mine.push(record);
    }
    mine.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!openOnes.length && !mine.length) {
      listEl.innerHTML = '<p class="hint">暂无开放报名的比赛,也没有你参加过的比赛。</p>';
      return;
    }
    listEl.innerHTML =
      (openOnes.length ? '<h2 class="md-group-title">开放报名</h2>' +
        openOnes.map((r) => cardHtml(r, names)).join('') : '') +
      (mine.length ? '<h2 class="md-group-title">我参加过的</h2>' +
        mine.map((r) => cardHtml(r, names)).join('') : '');
  }

  async function act(action, id) {
    try {
      const resp = await fetch('/api/me/signup', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tournamentId: id, action })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        notify(data.error || '操作失败', 'danger');
        if (resp.status === 423) {
          if (typeof window.TournamentApp.revalidateWorkspace === 'function') {
            await window.TournamentApp.revalidateWorkspace();
          }
          await loadRecords();
          render();
        }
        return;
      }
      notify(action === 'join' ? '报名成功' : '已取消报名');
      if (typeof window.TournamentApp.revalidateWorkspace === 'function') {
        await window.TournamentApp.revalidateWorkspace();
      }
      await loadRecords();
      render();
    } catch (error) {
      notify('网络错误,请稍后再试', 'danger');
    }
  }

  $('my-tourneys-list').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-signup]');
    if (!btn) return;
    btn.disabled = true;
    /* 失败路径(409/网络错误)不重绘:必须复位按钮,否则永久禁用 */
    act(btn.dataset.signup, btn.dataset.id).finally(() => {
      btn.disabled = false;
    });
  });

  $('my-tourneys-login-btn').addEventListener('click', () => {
    window.TournamentApp.openLoginDialog();
  });

  document.addEventListener('ts:ready', boot);
  document.addEventListener('ts:changed', async () => {
    if (!state.myId || $('my-tourneys-body').hidden) return;
    await loadRecords();
    render();
  });

  /* 页面初始化与登录守卫由 me.js 统一驱动(选手中心合并页) */
})();
