'use strict';

/**
 * 超管后台(admin.html 独立轻量页,不引 common.js):
 * boot fetch /api/me → 401 跳登录页 / 非 super 无权提示;
 * 四块 tab:审计流水(月份+关键词过滤)/ 账号与邀请码(封禁/解封/降级升管)
 * / 比赛状态(/api/data 原样,卡组窗口与进度判定复用 canvas-model)/ 健康与备份。
 * 工具函数就地内置(escapeHtml 等),避免拉入整份 common.js。 */
(function () {
  const $ = (id) => document.getElementById(id);

  /* ---------- 小工具(页面自带,不依赖 common.js) ---------- */

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));
  }

  function setStatus(el, text, danger) {
    el.textContent = text || '';
    el.classList.toggle('is-danger', Boolean(danger));
  }

  function fmtDateTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* 码表 usedBy 是兑码者 username——短信注册账号 username=手机号,
   * 与账号表脱敏承诺同口径(规则同 api/admin.js maskUsername):11 位手机形态
   * → 138****1234,其余用户名原样 */
  function maskPhoneUsername(username) {
    const s = String(username == null ? '' : username);
    return /^1\d{10}$/.test(s) ? s.slice(0, 3) + '****' + s.slice(7) : s;
  }

  /* 统一请求:回 {ok, status, data};网络异常按 0 + 空对象处理 */
  async function api(url, options) {
    try {
      const resp = await fetch(url, Object.assign({ headers: { Accept: 'application/json' } }, options));
      const data = await resp.json().catch(() => ({}));
      return { ok: resp.ok, status: resp.status, data };
    } catch (error) {
      return { ok: false, status: 0, data: { error: '网络错误,请稍后再试' } };
    }
  }

  const ROLE_LABELS = { user: '用户', player: '选手', admin: '管理员', super: '超管' };
  const chip = (text, cls) => '<span class="admin-chip' + (cls ? ' ' + cls : '') + '">' + escapeHtml(text) + '</span>';

  /* ---------- boot:登录与角色门 ---------- */

  let meId = null;

  async function boot() {
    const result = await api('/api/me');
    if (result.status === 401) {
      location.replace('login.html?returnTo=' + encodeURIComponent('admin.html'));
      return;
    }
    const user = result.data && result.data.user;
    if (!user) {
      fail(result.status === 0 ? '网络错误,请刷新重试。' : '未登录。', result.status !== 0);
      return;
    }
    if (user.role !== 'super') {
      fail('仅超级管理员可访问后台(当前角色:' + (ROLE_LABELS[user.role] || user.role) + ')。', false);
      return;
    }
    meId = user.id || null;
    $('admin-empty').hidden = true;
    $('admin-shell').hidden = false;
    const hash = (location.hash || '').slice(1);
    showTab(TABS.some((t) => t.id === hash) ? hash : TABS[0].id, true);
  }

  function fail(text, showLogin) {
    $('admin-shell').hidden = true;
    $('admin-empty').hidden = false;
    $('admin-empty-text').textContent = text;
    /* 登录后带回本页,而非落在默认主页 */
    $('admin-login-btn').href = 'login.html?returnTo=' + encodeURIComponent(location.pathname);
    $('admin-login-btn').hidden = !showLogin;
  }

  /* ---------- tab(hash 路由,切到即拉数据) ---------- */

  const TABS = [
    { id: 'audit', btn: 'admin-tab-audit', load: loadAudit },
    { id: 'users', btn: 'admin-tab-users', load: loadUsersPanel },
    { id: 'tourneys', btn: 'admin-tab-tourneys', load: loadTourneys },
    { id: 'health', btn: 'admin-tab-health', load: loadHealth }
  ];
  let activeTab = null;

  function showTab(id, force) {
    const tab = TABS.find((t) => t.id === id) || TABS[0];
    if (!force && activeTab === tab.id) return;
    activeTab = tab.id;
    for (const t of TABS) {
      const on = t === tab;
      $(t.btn).classList.toggle('is-active', on);
      $(t.btn).setAttribute('aria-selected', String(on));
      $('admin-panel-' + t.id).hidden = !on;
    }
    try { history.replaceState(null, '', '#' + tab.id); } catch (error) { /* 忽略 */ }
    tab.load();
  }

  for (const t of TABS) $(t.btn).addEventListener('click', () => showTab(t.id));
  window.addEventListener('hashchange', () => {
    if ($('admin-shell').hidden) return;
    const hash = (location.hash || '').slice(1);
    if (TABS.some((t) => t.id === hash)) showTab(hash);
  });

  /* ---------- 审计流水 ---------- */

  /* 近 n 个月(含当月)的 yyyy-mm,UTC 口径与后端 monthKeyNow 同源;
   * 先钉到 1 号再回退月:否则 5/31 setUTCMonth(-1) 溢出成 3/31(跳过 4 月) */
  function recentMonths(n) {
    const out = [];
    const d = new Date();
    d.setUTCDate(1);
    for (let i = 0; i < n; i++) {
      out.push(d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'));
      d.setUTCMonth(d.getUTCMonth() - 1);
    }
    return out;
  }

  let auditItems = [];
  let auditOss = true;

  function renderAudit() {
    const keyword = $('admin-audit-filter').value.trim().toLowerCase();
    const items = keyword
      ? auditItems.filter((e) =>
          (e.action + ' ' + (e.detail || '')).toLowerCase().includes(keyword))
      : auditItems;
    $('admin-audit-tbody').innerHTML = items.map((e) =>
      '<tr><td>' + escapeHtml(fmtDateTime(e.at)) + '</td>' +
      '<td class="code-cell">' + escapeHtml(e.action || '—') + '</td>' +
      '<td class="admin-detail-cell">' + escapeHtml(e.detail || '—') + '</td></tr>'
    ).join('');
    setStatus($('admin-audit-status'),
      $('admin-audit-month').value + ' 共 ' + items.length + ' 条' + (keyword ? '(已过滤)' : '')
        + (!auditOss ? '(未配置 OSS,审计不可用)' : ''),
      !auditOss);
  }

  async function loadAudit() {
    const status = $('admin-audit-status');
    setStatus(status, '加载中…', false);
    const result = await api('/api/admin/audit?month=' + encodeURIComponent($('admin-audit-month').value) + '&limit=200');
    if (!result.ok) {
      setStatus(status, '审计加载失败:' + (result.data.error || result.status), true);
      return;
    }
    auditItems = Array.isArray(result.data.items) ? result.data.items : [];
    auditOss = result.data.oss !== false;
    renderAudit();
  }

  /* ---------- 账号与邀请码 ---------- */

  function renderUsers(users) {
    $('admin-users-tbody').innerHTML = users.map((u) => {
      const banned = u.status === 'banned';
      /* 超管与操作者本人受后端保护,不提供行内操作(避免必然失败的按钮) */
      const protectedRow = u.role === 'super' || (meId != null && u.id === meId);
      const actions = protectedRow
        ? '—'
        : '<button type="button" class="btn ' + (banned ? 'btn-secondary' : 'btn-danger') + ' btn-sm" data-act="status" data-id="' + escapeHtml(u.id) + '" data-name="' + escapeHtml(u.username) + '" data-banned="' + (banned ? '0' : '1') + '">' + (banned ? '解封' : '封禁') + '</button> ' +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="role" data-id="' + escapeHtml(u.id) + '" data-name="' + escapeHtml(u.username) + '" data-role="' + (u.role === 'admin' ? 'player' : 'admin') + '">' + (u.role === 'admin' ? '降为选手' : '升为管理员') + '</button> ' +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="delete" data-id="' + escapeHtml(u.id) + '" data-name="' + escapeHtml(u.username) + '" data-player="' + escapeHtml(u.playerName || (u.playerId || '')) + '">删除</button>';
      return '<tr><td>' + escapeHtml(u.username || '—') + '</td>' +
        '<td>' + escapeHtml(u.nickname || '—') + '</td>' +
        '<td>' + escapeHtml(ROLE_LABELS[u.role] || u.role || '—') + '</td>' +
        '<td>' + escapeHtml(u.playerName || (u.playerId || '—')) + '</td>' +
        '<td class="code-cell">' + escapeHtml(u.phoneMasked || '—') + '</td>' +
        '<td>' + chip(banned ? '已封禁' : '正常', banned ? 'admin-chip-danger' : 'admin-chip-ok') + '</td>' +
        '<td>' + escapeHtml(fmtDateTime(u.createdAt)) + '</td>' +
        '<td><span class="admin-row-actions">' + actions + '</span></td></tr>';
    }).join('');
  }

  async function loadUsers() {
    const status = $('admin-users-status');
    setStatus(status, '加载中…', false);
    const result = await api('/api/admin/users');
    if (!result.ok) {
      setStatus(status, '账号加载失败:' + (result.data.error || result.status), true);
      return;
    }
    const users = Array.isArray(result.data.users) ? result.data.users : [];
    renderUsers(users);
    setStatus(status, '共 ' + users.length + ' 个账号。', false);
  }

  function loadUsersPanel() {
    loadUsers();
    loadCodes();
  }

  async function loadCodes() {
    const status = $('admin-codes-status');
    setStatus(status, '加载中…', false);
    const result = await api('/api/codes');
    if (!result.ok) {
      setStatus(status, '邀请码加载失败:' + (result.data.error || result.status), true);
      return;
    }
    const codes = (Array.isArray(result.data.codes) ? result.data.codes : []).slice().reverse();
    $('admin-codes-tbody').innerHTML = codes.map((c) =>
      '<tr><td class="code-cell">' + escapeHtml(c.code) + '</td>' +
      '<td>' + (c.kind === 'admin' ? '管理员码' : '选手码') + '</td>' +
      '<td>' + escapeHtml(c.playerName || (c.playerId || '—')) + '</td>' +
      '<td>' + (c.used ? chip('已使用', 'admin-chip-muted') : chip('未使用', 'admin-chip-ok')) + '</td>' +
      '<td>' + escapeHtml(c.usedBy ? maskPhoneUsername(c.usedBy) : '—') + '</td>' +
      '<td>' + escapeHtml(fmtDateTime(c.createdAt)) + '</td></tr>'
    ).join('');
    setStatus(status, codes.length ? '共 ' + codes.length + ' 个码(新在前)。' : '暂无邀请码。', false);
  }

  /* 行内操作:封禁/解封、降级/升管理员(confirm 确认)、删除(confirm 双重确认) */
  $('admin-users-tbody').addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const name = btn.dataset.name || id;
    if (btn.dataset.act === 'status') {
      const banned = btn.dataset.banned === '1';
      const verb = banned ? '封禁' : '解封';
      if (!window.confirm('确认' + verb + '账号「' + name + '」?' + (banned ? '封禁后该账号将无法登录。' : ''))) return;
      const result = await api('/api/admin/users/' + encodeURIComponent(id) + '/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ banned })
      });
      const status = $('admin-users-status');
      if (!result.ok) {
        setStatus(status, verb + '失败:' + (result.data.error || result.status), true);
        return;
      }
      setStatus(status, '已' + verb + '「' + name + '」。', false);
      loadUsers();
      return;
    }
    if (btn.dataset.act === 'role') {
      const role = btn.dataset.role;
      const verb = role === 'admin' ? '升为管理员' : '降为选手';
      if (!window.confirm('确认把账号「' + name + '」' + verb + '?')) return;
      const result = await api('/api/admin/users/' + encodeURIComponent(id) + '/role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role })
      });
      const status = $('admin-users-status');
      if (!result.ok) {
        setStatus(status, verb + '失败:' + (result.data.error || result.status), true);
        return;
      }
      setStatus(status, '已把「' + name + '」' + verb + '。', false);
      loadUsers();
      return;
    }
    if (btn.dataset.act === 'delete') {
      /* 删除不可逆,双重确认:第二重需输入用户名(与恢复的 RESTORE 同风格) */
      const player = btn.dataset.player || '';
      const summary = player ? '其绑定的选手档案「' + player + '」将保留并解除绑定,' : '';
      if (!window.confirm('确认删除账号「' + name + '」?' + summary + '手机号将被释放(可重新注册)。此操作不可逆。')) return;
      const typed = window.prompt('删除不可逆。请输入该账号在表格中显示的用户名(手机号账号为脱敏形态)以确认:');
      if (typed == null) return;
      if (typed.trim() !== name) {
        setStatus($('admin-users-status'), '输入的用户名不一致,已取消删除。', true);
        return;
      }
      const result = await api('/api/admin/users/' + encodeURIComponent(id) + '/delete', { method: 'POST' });
      const status = $('admin-users-status');
      if (!result.ok) {
        setStatus(status, '删除失败:' + (result.data.error || result.status), true);
        return;
      }
      setStatus(status, '已删除「' + name + '」' + (player ? ',选手档案已解绑保留。' : ',手机号已释放。'), false);
      loadUsers();
    }
  });

  /* ---------- 比赛状态 ---------- */

  /* 卡组窗口概要:手动开/关优先,其次每日时段,缺配置为「未设置」 */
  function deckWindowSummary(record) {
    const w = record && record.deckWindow;
    if (!w || typeof w !== 'object') return '未设置';
    if (w.manual === 'open') return '手动开启';
    if (w.manual === 'closed') return '手动关闭';
    if (w.open && w.close) return '每日 ' + w.open + '-' + w.close;
    return '未设置';
  }

  async function loadTourneys() {
    const status = $('admin-tourneys-status');
    setStatus(status, '加载中…', false);
    const result = await api('/api/data');
    if (!result.ok) {
      setStatus(status, '比赛数据加载失败:' + (result.data.error || result.status), true);
      return;
    }
    const ws = result.data || {};
    const tournaments = Array.isArray(ws.tournaments) ? ws.tournaments.filter(Boolean) : [];
    const series = Array.isArray(ws.series) ? ws.series.filter(Boolean) : [];
    const seriesName = new Map(series.map((s) => [s.id, s.name || s.id]));
    const CM = window.CanvasModel;
    if (!tournaments.length) {
      $('admin-tourneys-tbody').innerHTML = '';
      setStatus(status, '暂无比赛数据。', false);
      return;
    }
    $('admin-tourneys-tbody').innerHTML = tournaments.map((t) => {
      /* 报名:开关 + 已报人数/名额 */
      const signup = t.signup || {};
      const joined = Array.isArray(signup.players) ? signup.players.length : 0;
      const slots = Number(signup.slots);
      const signupText = (signup.open ? '开' : '关') + ' · '
        + joined + (Number.isInteger(slots) && slots > 0 ? '/' + slots : ' 人');
      /* 卡组窗口:开/关判定复用 canvas-model.isWindowOpen(未加载则退化显示概要) */
      const windowOpen = CM && CM.isWindowOpen ? CM.isWindowOpen(t, Date.now) : null;
      const windowChip = windowOpen == null ? chip('?', 'admin-chip-muted')
        : chip(windowOpen ? '开' : '关', windowOpen ? 'admin-chip-ok' : 'admin-chip-muted');
      /* 进度:scores 有效非平场次 ÷ 画布总场次(判定同服务端 stripHiddenDecks) */
      const cards = (t.canvas && Array.isArray(t.canvas.cards)) ? t.canvas.cards.filter(Boolean) : [];
      const scores = t.scores || {};
      let done = 0;
      if (CM && CM.getResult) {
        for (const c of cards) {
          const r = CM.getResult(scores[c.id]);
          if (r && r.valid && !r.draw) done++;
        }
      }
      const active = t.id === ws.activeId ? ' ' + chip('当前', 'admin-chip-accent') : '';
      return '<tr><td>' + escapeHtml(t.name || t.id || '—') + active + '</td>' +
        '<td>' + escapeHtml(t.seriesId ? (seriesName.get(t.seriesId) || '未分组') : '未分组') + '</td>' +
        '<td>' + chip(signupText, signup.open ? 'admin-chip-ok' : 'admin-chip-muted') + '</td>' +
        '<td>' + windowChip + ' <span class="admin-detail-cell">' + escapeHtml(deckWindowSummary(t)) + '</span></td>' +
        '<td class="code-cell">' + done + '/' + cards.length + '</td></tr>';
    }).join('');
    setStatus(status, '共 ' + tournaments.length + ' 届 / ' + series.length + ' 个系列。', false);
  }

  /* ---------- 健康与备份 ---------- */

  /* backups/<kind>-<ts>.json 名内时间戳 → ISO(与后端 backupTimeOf 同规则) */
  function backupTimeOf(key) {
    const m = /^backups\/(?:manual-)?(?:data|users|codes)-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/.exec(String(key || ''));
    if (!m) return null;
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }

  function backupKind(key) {
    const m = /^backups\/(?:manual-)?(data|users|codes)-/.exec(String(key || ''));
    if (!m) return null;
    return { data: '数据', users: '账号', codes: '邀请码' }[m[1]];
  }

  async function loadHealth() {
    const status = $('admin-health-status');
    setStatus(status, '加载中…', false);
    const result = await api('/api/admin/health');
    if (!result.ok) {
      setStatus(status, '健康信息加载失败:' + (result.data.error || result.status), true);
      return;
    }
    const d = result.data;
    const backups = d.backups || {};
    const kv = [
      ['OSS 状态', d.oss ? '正常' : '未配置 / 异常', d.oss],
      ['账号数', d.users, true],
      ['届数', d.tournaments, true],
      ['系列数', d.series, true],
      ['备份总数', backups.count, true],
      ['最近备份', fmtDateTime(d.lastBackupAt), Boolean(d.lastBackupAt)]
    ];
    $('admin-health-kv').innerHTML = kv.map(([k, v, ok]) =>
      '<div class="admin-kv-item"><dt>' + escapeHtml(k) + '</dt><dd' + (ok ? '' : ' class="is-danger"') + '>' + escapeHtml(v) + '</dd></div>'
    ).join('');
    /* 最近 20 条备份:keys 升序(旧→新),倒序展示(新在前) */
    const keys = Array.isArray(backups.keys) ? backups.keys.slice().reverse() : [];
    $('admin-backups-tbody').innerHTML = keys.map((key) => {
      const kind = backupKind(key);
      return '<tr><td class="code-cell">' + escapeHtml(key) + '</td>' +
        '<td>' + escapeHtml(kind || '—') + '</td>' +
        '<td>' + escapeHtml(fmtDateTime(backupTimeOf(key))) + '</td>' +
        '<td>' + (kind === '数据'
          ? '<button type="button" class="btn btn-ghost btn-sm" data-key="' + escapeHtml(key) + '">填入恢复框</button>'
          : '') + '</td></tr>';
    }).join('');
    setStatus(status, d.oss ? '' : '未配置 OSS:备份/恢复不可用,其余数据为开发存储口径。', !d.oss);
  }

  $('admin-backup-btn').addEventListener('click', async () => {
    const btn = $('admin-backup-btn');
    const status = $('admin-backup-status');
    btn.disabled = true;
    setStatus(status, '备份中…', false);
    const result = await api('/api/admin/backup', { method: 'POST' });
    btn.disabled = false;
    if (!result.ok) {
      setStatus(status, '备份失败:' + (result.data.error || result.status), true);
      return;
    }
    const keys = (Array.isArray(result.data.keys) ? result.data.keys : []).filter(Boolean);
    setStatus(status, keys.length
      ? '已备份 ' + keys.length + ' 份:' + keys.join('、')
      : '未产生备份对象(未配置 OSS)。', keys.length ? false : true);
    loadHealth();
  });

  /* 备份行「填入恢复框」 */
  $('admin-backups-tbody').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-key]');
    if (!btn) return;
    $('admin-restore-key').value = btn.dataset.key;
    $('admin-restore-key').focus();
  });

  /* 恢复:确认框输入 RESTORE 双重确认 */
  $('admin-restore-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = $('admin-restore-status');
    const key = $('admin-restore-key').value.trim();
    if (!key) {
      setStatus(status, '请先填写备份对象名。', true);
      return;
    }
    const typed = window.prompt('即将用该备份覆盖 data.json(覆盖前会自动留底当前版本)。\n确认请输入 RESTORE:');
    if (typed === null) return;
    if (typed !== 'RESTORE') {
      setStatus(status, '未输入 RESTORE,已取消恢复。', true);
      return;
    }
    setStatus(status, '恢复中…', false);
    const result = await api('/api/admin/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    if (!result.ok) {
      setStatus(status, '恢复失败:' + (result.data.error || result.status), true);
      return;
    }
    setStatus(status, '已恢复 ' + key + ',各端数据将在下次加载时生效。', false);
    loadHealth();
  });

  /* ---------- 启动 ---------- */

  $('admin-audit-month').innerHTML = recentMonths(6).map((m, i) =>
    '<option value="' + m + '">' + m + (i === 0 ? '(当月)' : '') + '</option>'
  ).join('');
  $('admin-audit-month').addEventListener('change', loadAudit);
  $('admin-audit-filter').addEventListener('input', renderAudit);

  boot();
})();
