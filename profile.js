'use strict';

/**
 * 个人中心(选手中心 profile 面板):
 * - 选手自助维护资料(头像/昵称/队伍ID/队标/垃圾话/海报颜色)——PUT /api/me/player 白名单;
 * - 账号昵称(账号级字段,落 users.json)随资料一并提交;
 * - 「升级与绑定」:账号昵称保存(PUT /api/me/player 纯昵称请求,未绑选手也可改)、
 *   填码跃迁 POST /api/me/redeem、绑手机 PUT /api/me/phone(120s 发码倒计时);
 * - 「发码中心」tab 数据:GET/POST /api/codes(admin/super)。
 * 云端模式专用;游客提示登录,未绑选手账号显示升级与绑定+改密。
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const { notify, escapeHtml } = window.TournamentUtils;

  const state = {
    player: null,
    user: null,
    pendingAvatarUrl: null,   /* 本会话新传的头像 URL(未保存前仅预览) */
    pendingTagImgData: null,  /* 新队标 dataURL,保存时转 Blob 上传 */
    pendingTagImgRatio: null
  };

  function measureRatio(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : null);
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  function renderAvatar(player, urlOverride) {
    const url = urlOverride || (player && player.avatar) || null;
    $('profile-avatar-preview').innerHTML = url
      ? '<img class="avatar avatar-lg" src="' + String(url).replace(/"/g, '&quot;') + '" alt="头像预览">'
      : '<span class="avatar avatar-lg avatar-fallback">?</span>';
    $('profile-avatar-remove').hidden = !url;
  }

  function fillForm(player) {
    state.player = player;
    state.pendingAvatarUrl = null;
    state.pendingTagImgData = null;
    state.pendingTagImgRatio = null;
    $('profile-name').value = (player && player.name) || '';
    $('profile-tag').value = (player && player.tag) || '';
    $('profile-title').value = (player && player.title) || '';
    $('profile-color').value = (player && player.color) || '#4a5568';
    $('profile-color-hint').textContent = (player && player.color) ? '自定义' : '跟随主题';
    renderAvatar(player);
    const tagUrl = (player && player.tagImg) || null;
    const tagPrev = $('profile-tagimg-preview');
    if (tagUrl) {
      tagPrev.src = tagUrl;
      tagPrev.hidden = false;
    } else {
      tagPrev.removeAttribute('src');
      tagPrev.hidden = true;
    }
    $('profile-tagimg-remove').hidden = !tagUrl && !state.pendingTagImgData;
    $('profile-tagimg-size').value = (player && player.tagImgSize) || 96;
  }

  function showEmpty(text, showLoginBtn) {
    $('profile-card').hidden = true;
    $('profile-password').hidden = true;
    $('profile-logout-row').hidden = true;
    $('redeem-section').hidden = true;
    $('profile-empty').hidden = false;
    $('profile-empty-text').textContent = text;
    $('profile-login-btn').hidden = !showLoginBtn;
  }

  async function boot() {
    const app = window.TournamentApp;
    if (app.mode !== 'cloud') {
      showEmpty('个人中心需要连接服务器(当前为本机数据模式)。', false);
      return;
    }
    await app.refreshSession();
    const { user, player } = app.getSession();
    if (!user) {
      showEmpty('未登录。', true);
      return;
    }
    state.user = user;
    $('profile-username').textContent = user.username;
    $('profile-password').hidden = false;
    $('profile-logout-row').hidden = false;
    /* 升级与绑定:所有登录账号可见;绑手机表单仅未绑手机(hasPhone)时出现 */
    $('redeem-section').hidden = false;
    $('account-nickname').value = user.nickname || '';
    $('phone-bind-form').hidden = Boolean(user.phone || user.hasPhone);
    setRedeemStatus('');
    if (user.role === 'admin' || user.role === 'super') setupCodes(user.role);
    if (!player) {
      $('profile-card').hidden = true;
      notify('当前账号未绑定选手资料,可在上方「升级与绑定」填码绑定');
      return;
    }
    $('profile-card').hidden = false;
    fillForm(player);
  }

  /* ---------- 头像 ---------- */

  $('profile-avatar-upload').addEventListener('click', () => $('profile-avatar-file').click());
  $('profile-avatar-file').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      const app = window.TournamentApp;
      const blob = await app.compressAvatar(file);
      const url = await app.uploadImage(blob);
      state.pendingAvatarUrl = url;
      renderAvatar(null, url);
      notify('头像已就绪,记得保存资料');
    } catch (error) {
      notify('头像上传失败:' + (error && error.message ? error.message : '未知错误'), 'danger');
    }
  });
  $('profile-avatar-remove').addEventListener('click', () => {
    state.pendingAvatarUrl = '';
    renderAvatar(null, null);
  });

  /* ---------- 队标 ---------- */

  $('profile-tagimg-upload').addEventListener('click', () => $('profile-tagimg-file').click());
  $('profile-tagimg-file').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file || !window.VSUpload) return;
    try {
      const dataUrl = await VSUpload.handleFile(file);
      state.pendingTagImgData = dataUrl;
      state.pendingTagImgRatio = await measureRatio(dataUrl);
      const prev = $('profile-tagimg-preview');
      prev.src = dataUrl;
      prev.hidden = false;
      $('profile-tagimg-remove').hidden = false;
      notify('队标已就绪,记得保存资料');
    } catch (error) {
      notify('队标处理失败:' + (error && error.message ? error.message : '未知错误'), 'danger');
    }
  });
  $('profile-tagimg-remove').addEventListener('click', () => {
    state.pendingTagImgData = '';
    const prev = $('profile-tagimg-preview');
    prev.removeAttribute('src');
    prev.hidden = true;
    $('profile-tagimg-remove').hidden = true;
  });

  $('profile-color').addEventListener('input', () => {
    $('profile-color-hint').textContent = '自定义';
  });
  $('profile-color-clear').addEventListener('click', () => {
    $('profile-color').value = '#4a5568';
    $('profile-color-hint').textContent = '跟随主题';
  });

  /* ---------- 保存 ---------- */

  $('profile-save').addEventListener('click', async () => {
    if (!state.player) return;
    const app = window.TournamentApp;
    const { user } = app.getSession();
    if (!user) return;
    $('profile-save').disabled = true;
    const body = {
      name: $('profile-name').value.trim(),
      tag: $('profile-tag').value.trim() || null,
      title: $('profile-title').value.trim() || null,
      color: $('profile-color-hint').textContent === '跟随主题' ? null : $('profile-color').value,
      tagImgSize: Number($('profile-tagimg-size').value)
    };
    /* 账号昵称是账号级字段(nickname,落 users.json):随资料一并提交,
     * 服务端 /api/me 与 /api/me/player 是同一 handler,都会摘出 nickname 单独落盘;
     * 留空则不送,避免后端「昵称不能为空」挡掉选手资料保存 */
    const nickname = $('account-nickname').value.trim();
    if (nickname) body.nickname = nickname;
    if (state.pendingAvatarUrl !== null) body.avatar = state.pendingAvatarUrl || null;
    if (state.pendingTagImgData !== null) {
      if (state.pendingTagImgData) {
        try {
          const url = await app.uploadImage(await fetch(state.pendingTagImgData).blob());
          body.tagImg = url;
          body.tagImgRatio = state.pendingTagImgRatio;
        } catch (error) {
          notify('队标上传失败:' + (error && error.message ? error.message : '未知错误'), 'danger');
          return;
        }
      } else {
        body.tagImg = null;
        body.tagImgRatio = null;
      }
    }
    try {
      const resp = await fetch('/api/me/player', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        notify(data.error || '保存失败', 'danger');
        return;
      }
      notify('资料已保存');
      fillForm(data.player || state.player);
      app.refreshSession();
    } catch (error) {
      notify('网络错误,请稍后再试', 'danger');
    } finally {
      $('profile-save').disabled = false;
    }
  });

  /* ---------- 升级与绑定:填码跃迁 / 绑手机 ---------- */

  function setRedeemStatus(text, danger) {
    const el = $('redeem-status');
    el.textContent = text || '';
    el.classList.toggle('is-danger', Boolean(danger));
  }

  /* 账号昵称保存:昵称输入行已移入「升级与绑定」区,未绑选手的纯 user 账号
   * 也能改(服务端 /api/me/player 对纯昵称请求放行,不要求 playerId);
   * 绑选手者此处与「保存资料」同走一个端点,两处均生效 */
  $('nickname-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const nickname = $('account-nickname').value.trim();
    if (!nickname) {
      setRedeemStatus('昵称不能为空', true);
      return;
    }
    try {
      const resp = await fetch('/api/me/player', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setRedeemStatus((data && data.error) || '保存失败', true);
        return;
      }
      state.user = data.user || state.user;
      setRedeemStatus('昵称已保存');
      window.TournamentApp.refreshSession();
    } catch (error) {
      setRedeemStatus('网络错误,请稍后再试', true);
    }
  });

  $('redeem-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    /* 生成码全大写:输入归一(大小写/首尾空白)再提交 */
    const code = $('redeem-code').value.toUpperCase().trim();
    if (!code) {
      setRedeemStatus('请填写验证码', true);
      return;
    }
    try {
      const resp = await fetch('/api/me/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setRedeemStatus((data && data.error) || '兑换失败', true);
        return;
      }
      /* 兑换即角色/绑定变更(user.role 已是 effectiveRole):整页重载,
       * 让 me.js 的 tab 门按新身份重算(绑选手后「我的对局」等 tab 变可见) */
      const upgraded = data.user && data.user.role === 'admin';
      setRedeemStatus((upgraded ? '已升级为管理员' : '已绑定/创建选手档案') + ',正在刷新…');
      setTimeout(() => location.reload(), 700);
    } catch (error) {
      setRedeemStatus('网络错误,请稍后再试', true);
    }
  });

  /* 绑手机:发送验证码 + 120s 倒计时(与 login.js 同款逻辑,两处各自独立) */
  let bindTimer = null;

  $('bind-send-btn').addEventListener('click', async () => {
    const phone = $('bind-phone').value.trim();
    if (!/^1\d{10}$/.test(phone)) {
      setRedeemStatus('请输入 11 位手机号', true);
      return;
    }
    const btn = $('bind-send-btn');
    btn.disabled = true;
    try {
      const resp = await fetch('/api/auth/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        btn.disabled = false;
        setRedeemStatus((data && data.error) || '发送失败', true);
        return;
      }
      setRedeemStatus(data.dev ? '开发模式:验证码见环境配置' : '验证码已发送');
      let left = 120;
      btn.textContent = left + 's';
      bindTimer = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          clearInterval(bindTimer);
          bindTimer = null;
          btn.disabled = false;
          btn.textContent = '获取验证码';
        } else {
          btn.textContent = left + 's';
        }
      }, 1000);
    } catch (error) {
      btn.disabled = false;
      setRedeemStatus('网络错误', true);
    }
  });

  $('phone-bind-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const phone = $('bind-phone').value.trim();
    const code = $('bind-code').value.trim();
    if (!/^1\d{10}$/.test(phone)) {
      setRedeemStatus('请输入 11 位手机号', true);
      return;
    }
    if (!code) {
      setRedeemStatus('请填写验证码', true);
      return;
    }
    try {
      const resp = await fetch('/api/me/phone', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, code })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setRedeemStatus((data && data.error) || '绑定失败', true);
        return;
      }
      $('phone-bind-form').hidden = true;
      setRedeemStatus('手机号已绑定');
      window.TournamentApp.refreshSession();
    } catch (error) {
      setRedeemStatus('网络错误,请稍后再试', true);
    }
  });

  /* ---------- 发码中心(admin/super)---------- */

  async function loadCodes() {
    try {
      const resp = await fetch('/api/codes', { headers: { Accept: 'application/json' } });
      if (!resp.ok) return;
      const data = await resp.json();
      const tbody = $('codes-tbody');
      tbody.innerHTML = (data.codes || []).slice().reverse().map((c) =>
        '<tr><td class="code-cell">' + escapeHtml(c.code) + '</td><td>' + (c.kind === 'admin' ? '管理员' : '选手') + '</td><td>' +
        escapeHtml(c.playerName || (c.playerId ? c.playerId : '—')) + '</td><td>' + (c.used ? '已使用' : '未使用') +
        '</td><td>' + escapeHtml(c.usedBy || '—') + '</td><td>' + escapeHtml((c.createdAt || '').slice(0, 10)) + '</td></tr>'
      ).join('');
    } catch (error) {
      /* 静默:列表失败不打断面板,生成时仍会重试 */
    }
  }

  function setupCodes(role) {
    /* admin 码仅 super 可发:非 super 直接移除该 option(后端同样 403 兜底) */
    if (role !== 'super') {
      const adminOpt = $('codes-kind').querySelector('option[value="admin"]');
      if (adminOpt) adminOpt.remove();
    }
    const players = (window.TournamentApp && window.TournamentApp.players) || [];
    $('codes-player').innerHTML = players.map((p) =>
      '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name || p.id) + '</option>'
    ).join('');
    loadCodes();
  }

  $('codes-kind').addEventListener('change', () => {
    $('codes-player-field').hidden = $('codes-kind').value !== 'player-bound';
  });

  /* 切到发码中心 tab 时刷新列表(他人发的新码可见) */
  $('me-tab-codes').addEventListener('click', () => loadCodes());

  $('codes-gen-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const out = $('codes-gen-out');
    const kindSel = $('codes-kind').value;
    const body = { kind: kindSel === 'admin' ? 'admin' : 'player' };
    if (kindSel === 'player-bound') {
      const playerId = $('codes-player').value;
      if (!playerId) {
        out.textContent = '请先选择要绑定的选手';
        return;
      }
      body.playerId = playerId;
    }
    try {
      const resp = await fetch('/api/codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        out.textContent = (data && data.error) || '生成失败';
        return;
      }
      out.textContent = '新码:' + data.code + (body.kind === 'admin' ? '(管理员)' : '(选手)');
      loadCodes();
    } catch (error) {
      out.textContent = '网络错误,请稍后再试';
    }
  });

  /* ---------- 修改密码 / 退出 ---------- */

  $('profile-pass-save').addEventListener('click', async () => {
    const current = $('profile-pass-current').value;
    const next = $('profile-pass-next').value;
    if (!current || next.length < 8) {
      notify('请填写当前密码,新密码至少 8 位', 'danger');
      return;
    }
    try {
      const resp = await fetch('/api/me/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current, next })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        notify(data.error || '修改失败', 'danger');
        return;
      }
      $('profile-pass-current').value = '';
      $('profile-pass-next').value = '';
      notify('密码已修改');
    } catch (error) {
      notify('网络错误,请稍后再试', 'danger');
    }
  });

  $('profile-logout').addEventListener('click', async () => {
    /* logoutSession 内部登出后整页跳回登录页(带 returnTo) */
    await window.TournamentApp.logoutSession();
  });

  $('profile-login-btn').addEventListener('click', () => {
    window.TournamentApp.openLoginDialog();
  });

  document.addEventListener('ts:ready', boot);
  document.addEventListener('ts:changed', () => {
    /* 数据变更(如管理员改了选手)时,若已登录且未在编辑中,静默刷新绑定选手 */
    const app = window.TournamentApp;
    if (!state.player || document.activeElement === $('profile-name')) return;
    const { player } = app.getSession();
    if (player && player.id === state.player.id && player.updatedAt !== state.player.updatedAt) {
      fillForm(player);
    }
  });

  /* 页面初始化与登录守卫由 me.js 统一驱动(选手中心合并页) */
})();
