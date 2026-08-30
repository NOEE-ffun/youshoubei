/**
 * OBS 舞台页:按 id 登录会话读 /api/poster-stage 并渲染海报。
 * 无站点 chrome;失败展示错误并在 5s 后重试。
 * 401(未登录/会话过期):清空舞台换全屏登录提示并停重试,替代报错横幅;
 * 本页不引 common.js,登录遮罩内联实现;returnTo 带 ?id 保证登录后回到同一舞台。
 */
(function () {
  "use strict";

  var slot = document.getElementById("poster-slot");
  var errorEl = document.getElementById("stage-error");

  var id = null;
  try {
    id = new URLSearchParams(location.search).get("id") || "";
  } catch (e) {
    id = "";
  }

  var loginRequired = false;

  /* 401 登录墙:全屏居中提示 + 跳登录按钮;hash 不带(无 hash 状态),query 保留舞台 id */
  function requireLogin() {
    loginRequired = true;
    document.body.innerHTML = '<div class="stage-login-required"><p>大屏需要登录后使用。</p>' +
      '<a class="btn btn-primary" href="login.html?returnTo=' +
      encodeURIComponent(location.pathname + location.search) + '">去登录</a></div>';
  }

  function showError(msg) {
    slot.innerHTML = "";
    errorEl.textContent = msg || "舞台加载失败";
    errorEl.hidden = false;
  }

  function clearError() {
    errorEl.textContent = "";
    errorEl.hidden = true;
  }

  function render(payload) {
    clearError();
    var theme = VSThemes.byId(payload.themeId) || VSThemes[0];
    if (theme && payload.data) {
      document.documentElement.setAttribute("data-poster-theme", theme.id);
      slot.innerHTML = VSPoster.build(payload.data, theme);
    } else {
      showError("舞台数据不完整");
    }
  }

  function load() {
    if (loginRequired) return;
    if (!id) {
      showError("缺少 id 参数");
      return;
    }
    fetch("/api/poster-stage?id=" + encodeURIComponent(id))
      .then(function (resp) {
        return resp.json().catch(function () { return {}; }).then(function (json) {
          if (resp.status === 401) {
            requireLogin();
            return;
          }
          if (!resp.ok) throw new Error(json.error || ("请求失败 " + resp.status));
          render(json);
        });
      })
      .catch(function (e) {
        /* 401 已分流为登录遮罩,不再走错误横幅与 5s 重试 */
        if (loginRequired) return;
        showError((e && e.message) || "舞台加载失败");
        setTimeout(load, 5000);
      });
  }

  load();
})();
