/**
 * OBS 舞台页:按 id 读取 /api/poster-stage 并渲染海报。
 * 无鉴权、无站点 chrome;失败展示错误并在 5s 后重试。
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
    if (!id) {
      showError("缺少 id 参数");
      return;
    }
    fetch("/api/poster-stage?id=" + encodeURIComponent(id))
      .then(function (resp) {
        return resp.json().catch(function () { return {}; }).then(function (json) {
          if (!resp.ok) throw new Error(json.error || ("请求失败 " + resp.status));
          render(json);
        });
      })
      .catch(function (e) {
        showError((e && e.message) || "舞台加载失败");
        setTimeout(load, 5000);
      });
  }

  load();
})();
