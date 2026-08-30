'use strict';
/* 登录页:手机验证码(发送倒计时 120s)/ 用户名密码 双 tab。
 * 成功后按 returnTo 回跳(仅允许站内路径,防开放跳转)。 */
(function () {
  const $ = (id) => document.getElementById(id);
  const status = $('login-status');
  const say = (text, danger) => {
    status.textContent = text || '';
    status.classList.toggle('is-danger', Boolean(danger));
  };
  const params = new URLSearchParams(location.search);
  const returnTo = (() => {
    const raw = params.get('returnTo') || '';
    try {
      const u = new URL(raw, location.origin);
      return u.origin === location.origin ? u.pathname + u.search + u.hash : '';
    } catch {
      return '';
    }
  })();

  function switchTab(id) {
    const sms = id === 'sms';
    $('login-tab-sms').classList.toggle('is-active', sms);
    $('login-tab-pw').classList.toggle('is-active', !sms);
    $('login-tab-sms').setAttribute('aria-selected', String(sms));
    $('login-tab-pw').setAttribute('aria-selected', String(!sms));
    $('login-panel-sms').hidden = !sms;
    $('login-panel-pw').hidden = sms;
  }
  $('login-tab-sms').addEventListener('click', () => switchTab('sms'));
  $('login-tab-pw').addEventListener('click', () => switchTab('pw'));

  /* 已登录直接回跳 */
  fetch('/api/me', { headers: { Accept: 'application/json' } }).then((r) => {
    if (r.ok) location.replace(returnTo || 'index.html');
  }).catch(() => {});

  /* 发码 + 倒计时 */
  let timer = null;
  $('sms-send-btn').addEventListener('click', async () => {
    const phone = $('sms-phone').value.trim();
    if (!/^1\d{10}$/.test(phone)) return say('请输入 11 位手机号', true);
    const btn = $('sms-send-btn');
    btn.disabled = true;
    try {
      const r = await fetch('/api/auth/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        btn.disabled = false;
        return say((data && data.error) || '发送失败', true);
      }
      say(data.dev ? '开发模式:验证码见环境配置' : '验证码已发送');
      let left = 120;
      btn.textContent = left + 's';
      timer = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          clearInterval(timer);
          timer = null;
          btn.disabled = false;
          btn.textContent = '获取验证码';
        } else {
          btn.textContent = left + 's';
        }
      }, 1000);
    } catch {
      btn.disabled = false;
      say('网络错误', true);
    }
  });

  $('login-panel-sms').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await fetch('/api/auth/sms/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: $('sms-phone').value.trim(), code: $('sms-code').value.trim() })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return say((data && data.error) || '登录失败', true);
    location.replace(returnTo || 'index.html');
  });

  $('login-panel-pw').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('pw-user').value.trim(), password: $('pw-pass').value })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return say((data && data.error) || '登录失败', true);
    location.replace(returnTo || 'index.html');
  });
})();
