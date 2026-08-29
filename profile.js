'use strict';

/**
 * 个人中心:登录选手自助维护资料(头像/昵称/队伍ID/队标/垃圾话/海报颜色)、
 * 修改密码、退出登录。写走 PUT /api/me/player(服务端白名单校验)。
 * 云端模式专用;游客提示登录,管理员(未绑选手)只显示账号+改密。
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const { notify } = window.TournamentUtils;

  const state = {
    player: null,
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
    $('profile-username').textContent = user.username;
    $('profile-password').hidden = false;
    $('profile-logout-row').hidden = false;
    if (!player) {
      $('profile-card').hidden = true;
      notify('当前是管理员账号,未绑定选手资料');
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
    await window.TournamentApp.logoutSession();
    location.href = 'index.html';
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
