/**
 * OBS 舞台页:免登录按 id 读 /api/poster-stage(链接即凭证)渲染海报。
 * 5 秒轮询跟随海报页编辑(防抖 PUT);内容不变绝不重建 DOM——innerHTML
 * 重建会重置 CSS 动画,故先比对 payload 字符串(304 在 HTTP 缓存层透明
 * 省流量,JS 恒收 200 重建体,动画保护全靠本地比对)。
 * 404=舞台不存在/7 天无推送过期:展示提示但保持轮询,操作员复活即自动恢复;
 * 瞬时网络/服务错误:已有画面时静默重试不打断投屏,空舞台才显错。
 */
(function () {
  "use strict";

  var slot = document.getElementById("poster-slot");
  var errorEl = document.getElementById("stage-error");
  var POLL_MS = 5000;

  var id = null;
  try {
    id = new URLSearchParams(location.search).get("id") || "";
  } catch (e) {
    id = "";
  }

  var inFlight = false;
  var lastPayloadStr = "";

  function showError(msg) {
    slot.innerHTML = "";
    lastPayloadStr = "";
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

  /* 内容比对防抖:同 payload 跳过,动画不重置 */
  function applyPayload(json) {
    var str = JSON.stringify(json);
    if (str === lastPayloadStr) return;
    lastPayloadStr = str;
    render(json);
  }

  function load() {
    if (inFlight) return;
    if (!id) {
      showError("缺少 id 参数");
      /* 误入/分享丢参时给条出路,别让投屏停在黑屏一行字 */
      var back = document.createElement("a");
      back.href = "/poster.html";
      back.className = "stage-back";
      back.textContent = "去海报页生成 OBS 投屏链接";
      errorEl.appendChild(document.createElement("br"));
      errorEl.appendChild(back);
      return;
    }
    inFlight = true;
    fetch("/api/poster-stage?id=" + encodeURIComponent(id))
      .then(function (resp) {
        return resp.json().catch(function () { return {}; }).then(function (json) {
          if (resp.status === 404) {
            /* 404 是权威状态(不存在/过期),无条件亮提示;保轮询等复活 */
            showError(json.error === "舞台已过期"
              ? "舞台已过期(7 天无推送自动失效);到海报页编辑一次即可复活本链接"
              : "舞台不存在;请到海报页点「OBS 源」重新生成链接");
            return null;
          }
          if (!resp.ok) {
            /* 5xx/瞬时错误:已有画面时静默等下一轮,不打断投屏 */
            if (lastPayloadStr) return null;
            throw new Error(json.error || ("请求失败 " + resp.status));
          }
          return json;
        });
      })
      .then(function (json) {
        if (json) applyPayload(json);
      })
      .catch(function (e) {
        if (!lastPayloadStr) showError((e && e.message) || "舞台加载失败");
      })
      .then(function () {
        inFlight = false;
      });
  }

  load();
  setInterval(load, POLL_MS);
})();
