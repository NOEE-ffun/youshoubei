/**
 * 应用装配:状态 ↔ 选手选择器 ↔ 海报渲染 ↔ 导出 ↔ OBS 舞台 API
 * 与主站解耦:等待 ts:ready 后启动,海报主题写 html[data-poster-theme],不覆盖 data-theme。
 * 选手数据全部来自主站选手库(TournamentApp.players);左右两侧只做选择与颜色微调,
 * 资料维护走个人中心(profile.html),本页不再提供自由手填。
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var els = {
    matchName: $("match-name"),
    stage: $("stage"),
    bo: $("bo"),
    date: $("match-date"),
    venue: $("venue"),
    leftColor: $("left-color"),
    rightColor: $("right-color"),
    slot: $("poster-slot"),
    toast: $("toast"),
    posterStage: $("poster-stage")
  };

  var SIDES = ["left", "right"];
  function sideEl(side, suffix) { return $(side + "-" + suffix); }

  function esc(s) {
    return window.TournamentUtils.escapeHtml(s);
  }

  function notifyError(msg) {
    window.TournamentUtils.notify(msg, "danger");
  }

  var state = VSState.load();
  var exporting = false;

  var EMPTY_SIDE = { name: "", tag: "", img: null, color: null, rosterId: null, tagImg: null, tagImgRatio: null, tagImgSize: null, title: "" };

  function currentData() {
    return {
      matchName: els.matchName.value.trim(),
      stage: els.stage.value,
      bo: els.bo.value,
      date: els.date.value,
      venue: els.venue.value.trim(),
      left: pickSide("left"),
      right: pickSide("right")
    };
  }

  /* state 即唯一真源:选手字段全部来自 applyPlayer 写入,不再反向读 DOM */
  function pickSide(side) {
    var d = state.data[side] || {};
    return {
      name: d.name || "",
      tag: d.tag || "",
      img: d.img || null,
      color: d.color || null,
      rosterId: d.rosterId || null,
      tagImg: d.tagImg || null,
      tagImgRatio: d.tagImgRatio || null,
      tagImgSize: d.tagImgSize || null,
      title: typeof d.title === "string" ? d.title : ""
    };
  }

  function sidePlayer(side) {
    var id = (state.data[side] || {}).rosterId;
    if (!id) return null;
    return findPlayer(id);
  }

  /* ---------- 侧栏槽位渲染(未选/已选摘要) ---------- */

  function renderSideSlot(side) {
    var host = sideEl(side, "slot");
    if (!host) return;
    var d = state.data[side] || {};
    if (!d.rosterId) {
      host.innerHTML =
        '<button type="button" class="picker-empty" data-pick="' + side + '">' +
        '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>' +
        "从选手库选择" + (side === "left" ? "左侧" : "右侧") + "选手</button>";
      return;
    }
    var player = findPlayer(d.rosterId);
    var avatar = d.img
      ? '<img class="roster__avatar" src="' + esc(d.img) + '" alt="">'
      : '<span class="roster__avatar roster__avatar--ph">' + esc((d.name || "?")[0]) + "</span>";
    var tagLine = d.tag ? '<em class="roster__id">' + esc(d.tag) + "</em>" : (d.tagImg ? '<span class="picker__tagimg">🖼 队标</span>' : "");
    var titleLine = d.title ? esc(d.title) : "—";
    host.innerHTML =
      '<div class="picker-card">' + avatar +
      '<div class="roster__meta">' +
      '<span class="roster__name">' + esc(d.name || (player && player.name) || "?") + " " + tagLine + "</span>" +
      '<span class="roster__tag">' + titleLine + "</span>" +
      (player ? "" : '<span class="picker__gone hint">选手已被删除,请重新选择</span>') +
      "</div>" +
      '<button type="button" class="btn btn--ghost btn--sm" data-pick="' + side + '">更换</button>' +
      "</div>";
  }

  /* ---------- 选择列表(搜索 + 卡片单选) ---------- */

  function openList(side) {
    var list = sideEl(side, "list");
    if (!list) return;
    list.hidden = false;
    var search = sideEl(side, "search");
    renderPickerList(side, search ? search.value.trim() : "");
    if (search) search.focus();
  }

  function closeList(side) {
    var list = sideEl(side, "list");
    if (list) list.hidden = true;
  }

  function renderPickerList(side, filter) {
    var ul = document.querySelector('.roster__list[data-side="' + side + '"]');
    var empty = document.querySelector('.roster__empty[data-side="' + side + '"]');
    if (!ul) return;
    var players = (window.TournamentApp && window.TournamentApp.players) || [];
    var kw = String(filter || "").toLowerCase();
    var visible = players.filter(function (p) {
      if (!kw) return true;
      return (p.name || "").toLowerCase().indexOf(kw) >= 0 || (p.tag || "").toLowerCase().indexOf(kw) >= 0;
    });
    ul.innerHTML = visible.map(function (p) {
      var dot = /^#[0-9a-fA-F]{6}$/.test(p.color || "")
        ? '<span class="roster__dot" style="background:' + p.color + '" title="自定义颜色"></span>'
        : '<span class="roster__dot roster__dot--none" title="跟随全局主题"></span>';
      var selected = (state.data[side] || {}).rosterId === p.id ? " picker-card--selected" : "";
      return '<li class="roster__card' + selected + '" data-id="' + esc(p.id) + '" data-act-side="' + side + '" tabindex="0" role="button">' +
        rosterAvatarMarkup(p) + dot +
        '<div class="roster__meta">' +
        '<span class="roster__name">' + esc(p.name || "?") + (p.tag ? ' <em class="roster__id">' + esc(p.tag) + "</em>" : "") + "</span>" +
        '<span class="roster__tag">' + esc(titleDisplayText(p)) + "</span>" +
        "</div></li>";
    }).join("");
    if (empty) empty.hidden = visible.length > 0;
  }

  function render() {
    var theme = VSThemes.byId(state.themeId);
    document.documentElement.setAttribute("data-poster-theme", theme.id);

    updateThemePicker(theme);
    els.slot.innerHTML = VSPoster.build(currentData(), theme);

    SIDES.forEach(function (side) {
      renderSideSlot(side);
      var d = state.data[side] || {};
      var color = d.color;
      var dot = sideEl(side, "color-dot");
      var input = sideEl(side, "color");
      if (color) {
        input.value = color;
        dot.style.background = color;
        dot.classList.add("color-dot--custom");
      } else {
        dot.style.background = theme[side].main;
        dot.classList.remove("color-dot--custom");
      }
    });
  }

  function saveState() {
    state.data = currentData();
    state.themeId = VSThemes.byId(state.themeId).id;
    state.resolution = els.resolution.value;
    VSState.save(state);
  }

  /* ---------- 提示条 ---------- */

  var toastTimer = null;
  function toast(msg, isError) {
    els.toast.textContent = msg;
    els.toast.classList.toggle("toast--error", !!isError);
    els.toast.classList.add("toast--show");
    clearTimeout(toastTimer);
    var duration = Math.min(6000, 2200 + String(msg).length * 45);
    toastTimer = setTimeout(function () { els.toast.classList.remove("toast--show"); }, duration);
  }

  /* ---------- 导出 ---------- */

  function doExport() {
    if (exporting) return;
    if (!els.matchName.value.trim()) {
      toast("请先填写比赛名称", true);
      els.matchName.focus();
      return;
    }
    if (!(state.data.left.rosterId && state.data.right.rosterId)) {
      toast("请先选择左右两侧选手", true);
      return;
    }
    exporting = true;
    els.exportBtn.disabled = true;
    els.exportLabel.textContent = "导出中…";

    var theme = VSThemes.byId(state.themeId);
    var svg = VSPoster.build(currentData(), theme);
    var resolution = els.resolution.value;

    var ready = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
    ready
      .then(function () { return VSExport.svgToPng(svg, resolution); })
      .then(function (blob) {
        var filename = VSExport.sanitizeFilename(currentData().matchName) + "_" + theme.name + "_" + resolution + ".png";
        VSExport.download(blob, filename);
        toast("已导出 " + filename);
        els.posterStage.classList.add("stage__frame--exported");
        setTimeout(function () { els.posterStage.classList.remove("stage__frame--exported"); }, 1500);
      })
      .catch(function (e) { toast((e && e.message) || "导出失败", true); })
      .then(function () {
        exporting = false;
        els.exportBtn.disabled = false;
        els.exportLabel.textContent = "导出 PNG";
      });
  }

  /* ---------- 单侧控件:选色 + 选择器 ---------- */

  function bindSideControls(side) {
    sideEl(side, "color").addEventListener("input", function () {
      state.data[side].color = sideEl(side, "color").value;
      saveState();
      render();
    });
    sideEl(side, "color-clear").addEventListener("click", function () {
      /* 跟随选手:恢复为选手资料里的颜色(无则不覆盖主题) */
      var player = sidePlayer(side);
      state.data[side].color = (player && player.color) || null;
      saveState();
      render();
      toast("已恢复跟随选手资料颜色");
    });

    var slotHost = sideEl(side, "slot");
    slotHost.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-pick]");
      if (!btn) return;
      openList(side);
    });

    var search = sideEl(side, "search");
    search.addEventListener("input", function () {
      renderPickerList(side, search.value.trim());
    });

    var closeBtn = sideEl(side, "list").querySelector("[data-close-list]");
    if (closeBtn) closeBtn.addEventListener("click", function () { closeList(side); });

    var ul = document.querySelector('.roster__list[data-side="' + side + '"]');
    ul.addEventListener("click", function (e) {
      var card = e.target.closest(".roster__card");
      if (!card) return;
      var player = findPlayer(card.dataset.id);
      if (player) applyPlayer(side, player);
    });
    ul.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      var card = e.target.closest(".roster__card");
      if (!card) return;
      e.preventDefault();
      var player = findPlayer(card.dataset.id);
      if (player) applyPlayer(side, player);
    });
  }

  /* 比赛信息字段:输入同步写 state,持久化与重绘走 160ms 防抖;下拉即时 */
  function bindMatchFields() {
    var fieldMap = {
      "match-name": function (v) { state.data.matchName = v; },
      "venue": function (v) { state.data.venue = v; }
    };
    var debounce = {};
    Object.keys(fieldMap).forEach(function (id) {
      $(id).addEventListener("input", function () {
        fieldMap[id](this.value.trim());
        clearTimeout(debounce[id]);
        debounce[id] = setTimeout(function () { saveState(); render(); }, 160);
      });
    });
    ["stage", "bo", "match-date"].forEach(function (id) {
      $(id).addEventListener("change", function () { saveState(); render(); });
    });
  }

  /* 随机对阵(从选手库抽两位)与双击确认重置 */
  function bindGlobalActions() {
    $("btn-random").addEventListener("click", function () {
      var players = (window.TournamentApp && window.TournamentApp.players) || [];
      if (players.length < 2) {
        toast("选手库选手不足 2 人,无法随机", true);
        return;
      }
      var a = Math.floor(Math.random() * players.length);
      var b = (a + 1 + Math.floor(Math.random() * (players.length - 1))) % players.length;
      applyPlayer("left", players[a]);
      applyPlayer("right", players[b]);
      toast("已随机:" + players[a].name + " vs " + players[b].name);
    });

    $("btn-reset").addEventListener("click", function () {
      if (!resetArmed) {
        resetArmed = true;
        var btn = $("btn-reset");
        btn.classList.add("btn--confirm");
        btn.textContent = "再点一次确认重置";
        resetTimer = setTimeout(disarmReset, 3000);
        return;
      }
      disarmReset();
      VSState.reset();
      state = VSState.load();
      normalizeSides();
      SIDES.forEach(closeList);
      syncForm();
      render();
      toast("已重置为默认");
    });
  }

  function bindFormControls() {
    SIDES.forEach(bindSideControls);
    bindMatchFields();
    bindGlobalActions();

    /* 点击选择器外部任意位置收起抽屉(打开按钮/抽屉内部除外) */
    document.addEventListener("click", function (e) {
      if (e.target.closest(".picker-list") || e.target.closest("[data-pick]")) return;
      SIDES.forEach(closeList);
    });
  }

  /* ---------- 选手库(主站全局选手) ---------- */

  function findPlayer(id) {
    var players = (window.TournamentApp && window.TournamentApp.players) || [];
    return players.filter(function (p) { return p.id === id; })[0];
  }

  function titleDisplayText(p) {
    return typeof p.title === "string" ? p.title : ((p.title && p.title.text) || "—");
  }

  function rosterAvatarMarkup(p) {
    var app = window.TournamentApp;
    var av = p.avatar;
    if (av && app && app.blobUrl) {
      var url = app.blobUrl(av);
      var safe = window.TournamentUtils.safeUrl(url);
      if (safe) return '<img class="roster__avatar" src="' + esc(safe) + '" alt="">';
    }
    var initial = (p.name || "?")[0];
    return '<span class="roster__avatar roster__avatar--ph">' + esc(initial) + "</span>";
  }

  function refreshLists() {
    SIDES.forEach(function (side) {
      renderPickerList(side, sideEl(side, "search") ? sideEl(side, "search").value.trim() : "");
    });
  }

  /* OSS 图片可能已被普通 <img>(非 CORS 模式)加载进 HTTP 缓存,复用那份
   * 无 Access-Control-Allow-Origin 的缓存响应会被 crossOrigin 加载拒绝;
   * 加一次性穿透参数强制取回带 CORS 头的新响应(blob:/data: 引用必须原样) */
  function corsFresh(url) {
    if (!url || /^(data|blob):/i.test(url)) return url;
    return url + (url.indexOf("?") >= 0 ? "&" : "?") + "_ts=" + Date.now();
  }

  /* 应用选手到一侧:头像/队标经 blobUrl → dataURL(可随画布导出) */
  function applyPlayer(side, player) {
    var d = state.data[side];
    var app = window.TournamentApp;
    var avatarJob = player.avatar
      ? Promise.resolve(app.blobUrl(player.avatar)).then(function (u) { return VSUpload.handleURL(corsFresh(u)); }).catch(function () { return null; })
      : Promise.resolve(null);
    var tagImgJob = player.tagImg
      ? Promise.resolve(app.blobUrl(player.tagImg)).then(function (u) { return VSUpload.handleURL(corsFresh(u)); }).catch(function () { return null; })
      : Promise.resolve(null);
    var title = typeof player.title === "string" ? player.title : ((player.title && player.title.text) || "");

    Promise.all([avatarJob, tagImgJob]).then(function (jobs) {
      d.name = player.name || "";
      d.tag = player.tag || "";
      d.img = jobs[0];
      d.color = player.color || null;
      d.rosterId = player.id;
      d.tagImg = jobs[1];
      d.tagImgRatio = jobs[1] ? (player.tagImgRatio || null) : null;
      d.tagImgSize = jobs[1] ? (player.tagImgSize || null) : null;
      d.title = title || "";
      saveState();
      render();
      closeList(side);
      toast("已应用「" + (player.name || "") + "」到" + (side === "left" ? "左侧" : "右侧"));
    });
  }

  /* ---------- 主题选择器(页头) ---------- */

  var menuOpen = false;
  var menuIndex = 0;

  function renderThemeMenu() {
    els.themeMenu.innerHTML = VSThemes.map(function (t, i) {
      return '<li role="option" data-theme-id="' + t.id + '" data-index="' + i + '" aria-selected="false" tabindex="-1">' +
        '<span class="theme-menu__dot" style="background:linear-gradient(135deg,' + t.left.main + ' 50%,' + t.right.main + ' 50%)"></span>' +
        '<span class="theme-menu__name">' + esc(t.name) + "</span>" +
        "</li>";
    }).join("");
  }

  function updateThemePicker(theme) {
    els.themePickerName.textContent = theme.name;
    els.themePickerDot.style.background = "linear-gradient(135deg," + theme.left.main + " 50%," + theme.right.main + " 50%)";
    els.themeMenu.querySelectorAll('[role="option"]').forEach(function (item) {
      item.setAttribute("aria-selected", String(item.dataset.themeId === theme.id));
    });
  }

  function setMenu(open) {
    menuOpen = open;
    els.themeMenu.hidden = !open;
    els.themePicker.setAttribute("aria-expanded", String(open));
    if (open) {
      menuIndex = Math.max(0, VSThemes.findIndex(function (t) { return t.id === state.themeId; }));
      focusMenuIndex();
    }
  }

  function focusMenuIndex() {
    var items = els.themeMenu.querySelectorAll('[role="option"]');
    if (menuIndex < 0) menuIndex = 0;
    if (menuIndex >= items.length) menuIndex = items.length - 1;
    items.forEach(function (item, i) {
      item.setAttribute("aria-selected", String(item.dataset.themeId === state.themeId));
      if (i === menuIndex) item.classList.add("theme-menu__item--focused");
      else item.classList.remove("theme-menu__item--focused");
    });
    items[menuIndex].focus();
  }

  function chooseTheme(id) {
    state.themeId = id;
    saveState();
    render();
    setMenu(false);
    els.themePicker.focus();
  }

  function handleMenuKey(e) {
    if (e.key === "ArrowDown") { e.preventDefault(); menuIndex = (menuIndex + 1) % VSThemes.length; focusMenuIndex(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); menuIndex = (menuIndex - 1 + VSThemes.length) % VSThemes.length; focusMenuIndex(); }
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      chooseTheme(VSThemes[menuIndex].id);
    }
    else if (e.key === "Escape") { setMenu(false); els.themePicker.focus(); }
  }

  function bindHeaderControls() {
    els.themePicker.addEventListener("click", function () { setMenu(!menuOpen); });
    els.themePicker.addEventListener("keydown", function (e) {
      if (menuOpen) handleMenuKey(e);
    });
    els.themeMenu.addEventListener("click", function (e) {
      var item = e.target.closest('[role="option"]');
      if (item) chooseTheme(item.dataset.themeId);
    });
    els.themeMenu.addEventListener("keydown", handleMenuKey);
    document.addEventListener("click", function (e) {
      if (!e.target.closest(".picker")) setMenu(false);
    });

    els.resolution.value = state.resolution;
    els.resolution.addEventListener("change", function () {
      state.resolution = els.resolution.value;
      saveState();
    });

    els.exportBtn.addEventListener("click", doExport);
    document.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        doExport();
      }
    });

    els.obsBtn.addEventListener("click", function () {
      var app = window.TournamentApp;
      fetch("/api/poster-stage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + ((app && app.adminToken) || "")
        },
        body: JSON.stringify({ data: currentData(), themeId: state.themeId })
      }).then(function (resp) {
        return resp.json().catch(function () { return {}; }).then(function (json) {
          if (!resp.ok) throw new Error(json.error || ("请求失败 " + resp.status));
          return json;
        });
      }).then(function (json) {
        return copyText(location.origin + json.url).then(function () {
          toast("OBS 源链接已复制，粘贴到 OBS「浏览器」来源即可");
        });
      }).catch(function (e) {
        toast((e && e.message) || "OBS 源生成失败", true);
      });
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); resolve(); } catch (e) { reject(e); }
      ta.remove();
    });
  }

  /* ---------- 重置 ---------- */

  var resetArmed = false;
  var resetTimer = null;
  function disarmReset() {
    resetArmed = false;
    clearTimeout(resetTimer);
    var btn = $("btn-reset");
    btn.classList.remove("btn--confirm");
    btn.textContent = "重置";
  }

  /* ---------- 初始化 ---------- */

  /* 旧版自由手填遗留的 side(无 rosterId 的假数据)一律清空,
   * 保证"未选择"状态干净;带 rosterId 的延续上次选择 */
  function normalizeSides() {
    SIDES.forEach(function (side) {
      var d = state.data[side];
      if (!d || !d.rosterId) {
        state.data[side] = Object.assign({}, EMPTY_SIDE);
      } else {
        state.data[side] = Object.assign({}, EMPTY_SIDE, d);
      }
    });
  }

  function syncForm() {
    var d = state.data;
    els.matchName.value = d.matchName;
    els.stage.value = d.stage;
    if (!els.stage.value) els.stage.value = "总决赛";
    els.bo.value = d.bo;
    els.date.value = d.date;
    els.venue.value = d.venue;
    els.leftColor.value = d.left.color || "#ff2d2d";
    els.rightColor.value = d.right.color || "#1e6bff";
    els.resolution.value = state.resolution;
  }

  var booted = false;
  function boot() {
    if (booted) return;
    booted = true;

    // 页头控件由 common.js renderHeader 渲染,ts:ready 后才存在
    els.themePicker = $("poster-theme-picker");
    els.themePickerDot = $("poster-theme-dot");
    els.themePickerName = $("poster-theme-name");
    els.themeMenu = $("poster-theme-menu");
    els.resolution = $("poster-resolution");
    els.exportBtn = $("poster-export");
    els.exportLabel = $("poster-export-label");
    els.obsBtn = $("poster-obs");

    normalizeSides();
    renderThemeMenu();
    bindHeaderControls();
    bindFormControls();
    syncForm();
    refreshLists();
    render();

    /* 选手库变更(个人中心改资料/管理员增删)后刷新列表与已选摘要 */
    document.addEventListener("ts:changed", function () {
      refreshLists();
      render();
    });
  }

  document.addEventListener("ts:ready", boot, { once: true });
  if (window.TournamentAppInit) {
    window.TournamentAppInit("poster").catch(function (e) {
      console.error("[poster] init 失败:", e);
      if (window.TournamentApp && window.TournamentApp.fatalError) {
        window.TournamentApp.fatalError(e);
      }
    });
  }
})();
