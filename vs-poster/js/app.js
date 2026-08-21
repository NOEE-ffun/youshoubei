/**
 * 应用装配:状态 ↔ 表单 ↔ 海报渲染 ↔ 导出 ↔ 主站选手库 ↔ OBS 舞台 API
 * 与主站解耦:等待 ts:ready 后启动,海报主题写 html[data-poster-theme],不覆盖 data-theme。
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
    leftName: $("left-name"),
    leftTag: $("left-tag"),
    rightName: $("right-name"),
    rightTag: $("right-tag"),
    leftColor: $("left-color"),
    rightColor: $("right-color"),
    rosterList: $("roster-list"),
    rosterEmpty: $("roster-empty"),
    slot: $("poster-slot"),
    toast: $("toast"),
    posterStage: $("poster-stage")
  };

  var SIDES = ["left", "right"];
  function sideEl(side, suffix) { return $(side + "-" + suffix); }

  /* 转义/权限/错误提示统一走主站 TournamentUtils(common.js 恒先于本文件加载);
   * 成功类提示保留本页 toast(单例短时样式,与主站堆叠式分工) */
  function esc(s) {
    return window.TournamentUtils.escapeHtml(s);
  }

  function canEdit() {
    return window.TournamentUtils.canEdit();
  }

  function notifyError(msg) {
    window.TournamentUtils.notify(msg, "danger");
  }

  var state = VSState.load();
  var exporting = false;
  var dragDepth = 0;
  /* 槽位图片是否被本页改动过(用于「存为选手」时决定是否回写头像/称号图) */
  var slotChanged = { left: { img: false }, right: { img: false } };

  function currentData() {
    return {
      matchName: els.matchName.value.trim(),
      stage: els.stage.value,
      bo: els.bo.value,
      date: els.date.value,
      venue: els.venue.value.trim(),
      left: {
        name: els.leftName.value.trim(),
        tag: els.leftTag.value.trim(),
        img: state.data.left.img,
        color: state.data.left.color,
        rosterId: state.data.left.rosterId,
        tagImg: state.data.left.tagImg || null,
        tagImgRatio: state.data.left.tagImgRatio || null,
        tagImgSize: state.data.left.tagImgSize || null,
        title: sideEl("left", "title") ? sideEl("left", "title").value.trim() : (state.data.left.title || "")
      },
      right: {
        name: els.rightName.value.trim(),
        tag: els.rightTag.value.trim(),
        img: state.data.right.img,
        color: state.data.right.color,
        rosterId: state.data.right.rosterId,
        tagImg: state.data.right.tagImg || null,
        tagImgRatio: state.data.right.tagImgRatio || null,
        tagImgSize: state.data.right.tagImgSize || null,
        title: sideEl("right", "title") ? sideEl("right", "title").value.trim() : (state.data.right.title || "")
      }
    };
  }

  function syncTitleControls(side) {
    var d = state.data[side] || {};
    var input = sideEl(side, "title");
    if (input) input.value = typeof d.title === "string" ? d.title : "";
  }

  function render() {
    var theme = VSThemes.byId(state.themeId);
    document.documentElement.setAttribute("data-poster-theme", theme.id);

    updateThemePicker(theme);
    els.slot.innerHTML = VSPoster.build(currentData(), theme);

    SIDES.forEach(function (side) {
      sideEl(side, "name").value = state.data[side].name;
      sideEl(side, "tag").value = state.data[side].tag || "";
      var img = state.data[side].img;
      var preview = sideEl(side, "preview");
      var hint = sideEl(side, "hint");
      var remove = sideEl(side, "remove");
      if (img) {
        preview.src = img;
        preview.hidden = false;
        hint.hidden = true;
        remove.hidden = false;
      } else {
        preview.removeAttribute("src");
        preview.hidden = true;
        hint.hidden = false;
        remove.hidden = true;
      }
      var color = state.data[side].color;
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
      syncTitleControls(side);
      sideEl(side, "save-roster").textContent = state.data[side].rosterId ? "⤓ 更新选手" : "＋ 存为选手";
      sideEl(side, "tag-img-remove").hidden = !state.data[side].tagImg;
      sideEl(side, "tag-img").classList.toggle("btn--tag-on", !!state.data[side].tagImg);
      sideEl(side, "tag-size-field").hidden = !state.data[side].tagImg;
      var tagSize = state.data[side].tagImgSize || 56;
      sideEl(side, "tag-size").value = tagSize;
      sideEl(side, "tag-size-val").textContent = tagSize;
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
    if (!els.leftName.value.trim() && !els.rightName.value.trim()) {
      toast("请填写选手名字", true);
      els.leftName.focus();
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

  /* ---------- 图片转换工具 ---------- */

  /* dataURL → Blob:优先走 atob(不经 fetch,兼容 connect-src 'self' CSP),base64 之外回退 fetch */
  function dataUrlToBlob(dataURL) {
    var m = /^data:([^;,]+)(;base64)?,(.*)$/.exec(dataURL);
    if (!m) return Promise.reject(new Error("图片数据无效"));
    var mime = m[1];
    var payload = m[3];
    if (m[2]) {
      try {
        var binary = atob(payload);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return Promise.resolve(new Blob([bytes], { type: mime }));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return fetch(dataURL).then(function (r) { return r.blob(); });
  }

  function imageForStorage(dataURL, app) {
    if (!dataURL) return Promise.resolve(null);
    if (!/^data:/i.test(dataURL)) return Promise.resolve(dataURL);
    return dataUrlToBlob(dataURL).then(function (blob) {
      if (app.mode === "cloud") return app.uploadImage(blob);
      return blob;
    });
  }

  /* ---------- 头像上传 ---------- */

  function setAvatar(side, dataURL) {
    state.data[side].img = dataURL;
    slotChanged[side].img = true;
    sideEl(side, "url").value = "";
    saveState();
    render();
  }

  function measureImageRatio(dataURL) {
    return new Promise(function (resolve) {
      var im = new Image();
      im.onload = function () { resolve(im.naturalWidth && im.naturalHeight ? im.naturalWidth / im.naturalHeight : 1); };
      im.onerror = function () { resolve(1); };
      im.src = dataURL;
    });
  }

  /* 单侧选手控件:头像(点击/拖拽/URL/移除)、队标图、垃圾话、选色、存为选手 */
  function bindSideControls(side) {
    var drop = sideEl(side, "drop");
    var fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.hidden = true;
    drop.appendChild(fileInput);

    drop.addEventListener("click", function () { fileInput.click(); });
    fileInput.addEventListener("change", function () {
      VSUpload.handleFile(fileInput.files[0])
        .then(function (dataURL) { setAvatar(side, dataURL); })
        .catch(function (e) { toast(e.message, true); });
      fileInput.value = "";
    });

    drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("avatar__drop--over"); });
    drop.addEventListener("dragleave", function () { drop.classList.remove("avatar__drop--over"); });
    drop.addEventListener("drop", function (e) {
      e.preventDefault();
      drop.classList.remove("avatar__drop--over");
      var file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) {
        VSUpload.handleFile(file)
          .then(function (dataURL) { setAvatar(side, dataURL); })
          .catch(function (err) { toast(err.message, true); });
      }
    });

    var urlBtn = document.querySelector('[data-url-btn="' + side + '"]');
    function loadFromURL() {
      var url = sideEl(side, "url").value.trim();
      if (!url) {
        toast("请先粘贴图片链接", true);
        return;
      }
      VSUpload.handleURL(url)
        .then(function (dataURL) { setAvatar(side, dataURL); })
        .catch(function (e) { toast(e.message, true); });
    }
    urlBtn.addEventListener("click", loadFromURL);
    sideEl(side, "url").addEventListener("keydown", function (e) { if (e.key === "Enter") loadFromURL(); });

    var remove = sideEl(side, "remove");
    function removeAvatar() {
      setAvatar(side, null);
      sideEl(side, "url").value = "";
    }
    remove.addEventListener("click", removeAvatar);
    remove.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); removeAvatar(); }
    });

    // 队标图片
    var tagImgBtn = sideEl(side, "tag-img");
    var tagRemoveBtn = sideEl(side, "tag-img-remove");
    var tagFileInput = document.createElement("input");
    tagFileInput.type = "file";
    tagFileInput.accept = "image/*";
    tagFileInput.hidden = true;
    tagImgBtn.appendChild(tagFileInput);
    tagImgBtn.addEventListener("click", function () { tagFileInput.click(); });
    tagFileInput.addEventListener("change", function () {
      VSUpload.handleFile(tagFileInput.files[0])
        .then(function (dataURL) {
          measureImageRatio(dataURL).then(function (ratio) {
            state.data[side].tagImg = dataURL;
            state.data[side].tagImgRatio = ratio;
            saveState();
            render();
            toast("队标图片已应用到 ID 胶囊(优先于文字)");
          });
        })
        .catch(function (e) { toast(e.message, true); });
      tagFileInput.value = "";
    });
    tagRemoveBtn.addEventListener("click", function () {
      state.data[side].tagImg = null;
      state.data[side].tagImgRatio = null;
      state.data[side].tagImgSize = null;
      saveState();
      render();
      toast("已移除队标图片,恢复文字显示");
    });

    sideEl(side, "tag-size").addEventListener("input", function () {
      state.data[side].tagImgSize = Number(sideEl(side, "tag-size").value) || null;
      saveState();
      render();
    });

    // 赛前垃圾话(纯文本)
    sideEl(side, "title").addEventListener("input", function () {
      state.data[side].title = sideEl(side, "title").value.trim();
      clearTimeout(titleDebounce[side]);
      titleDebounce[side] = setTimeout(function () { saveState(); render(); }, 160);
    });

    // 自由选色
    sideEl(side, "color").addEventListener("input", function () {
      state.data[side].color = sideEl(side, "color").value;
      saveState();
      render();
    });
    sideEl(side, "color-clear").addEventListener("click", function () {
      state.data[side].color = null;
      saveState();
      render();
      toast("已恢复跟随全局主题");
    });

    // 存为选手
    sideEl(side, "save-roster").addEventListener("click", function () { saveSlotToPlayer(side); });
  }

  /* 整页拖图:按落点左右半区放入对应选手 */
  function bindStageDrop() {
    els.posterStage.addEventListener("dragenter", function (e) { e.preventDefault(); dragDepth++; els.posterStage.classList.add("stage__frame--over"); });
    els.posterStage.addEventListener("dragover", function (e) { e.preventDefault(); });
    els.posterStage.addEventListener("dragleave", function (e) {
      if (--dragDepth <= 0) { dragDepth = 0; els.posterStage.classList.remove("stage__frame--over"); }
    });
    els.posterStage.addEventListener("drop", function (e) {
      e.preventDefault();
      dragDepth = 0;
      els.posterStage.classList.remove("stage__frame--over");
      var file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      var rect = els.posterStage.getBoundingClientRect();
      var side = (e.clientX - rect.left) < rect.width / 2 ? "left" : "right";
      VSUpload.handleFile(file)
        .then(function (dataURL) {
          setAvatar(side, dataURL);
          toast("已放入" + (side === "left" ? "左侧" : "右侧") + "选手头像");
        })
        .catch(function (err) { toast(err.message, true); });
    });
  }

  /* 选手库卡片:左右应用按钮 */
  function bindRosterList() {
    els.rosterList.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("button[data-act]") : null;
      if (!btn) return;
      var card = e.target.closest(".roster__card");
      var id = card ? card.dataset.id : null;
      if (!id) return;
      var player = findPlayer(id);
      var act = btn.dataset.act;
      if (act === "left" && player) applyPlayer("left", player);
      else if (act === "right" && player) applyPlayer("right", player);
    });
  }

  /* 比赛信息字段:文本防抖 + 下拉即时 */
  function bindMatchFields() {
    var inputIds = ["match-name", "venue", "left-name", "left-tag", "right-name", "right-tag"];
    var debounce = {};
    inputIds.forEach(function (id) {
      $(id).addEventListener("input", function () {
        clearTimeout(debounce[id]);
        debounce[id] = setTimeout(function () { saveState(); render(); }, 160);
      });
    });
    ["stage", "bo", "match-date"].forEach(function (id) {
      $(id).addEventListener("change", function () { saveState(); render(); });
    });
  }

  /* 随机对阵与双击确认重置 */
  function bindGlobalActions() {
    $("btn-random").addEventListener("click", function () {
      var pair = RANDOM_PAIRS[Math.floor(Math.random() * RANDOM_PAIRS.length)];
      state.data.left = { name: pair[0], tag: pair[2], img: null, color: null, rosterId: null, tagImg: null, tagImgRatio: null, tagImgSize: null, title: "" };
      state.data.right = { name: pair[1], tag: pair[3], img: null, color: null, rosterId: null, tagImg: null, tagImgRatio: null, tagImgSize: null, title: "" };
      slotChanged.left.img = true;
      slotChanged.right.img = true;
      els.leftName.value = pair[0];
      els.leftTag.value = pair[2];
      els.rightName.value = pair[1];
      els.rightTag.value = pair[3];
      /* currentData 从输入框读 title,随机对阵同样要清空,否则旧垃圾话复活 */
      sideEl("left", "title").value = "";
      sideEl("right", "title").value = "";
      saveState();
      render();
      toast("已生成随机对阵");
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
      syncForm();
      renderRoster();
      render();
      toast("已重置为默认");
    });
  }

  function bindFormControls() {
    SIDES.forEach(bindSideControls);
    bindStageDrop();
    bindRosterList();
    bindMatchFields();
    bindGlobalActions();
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

  function renderRoster() {
    var players = (window.TournamentApp && window.TournamentApp.players) || [];
    els.rosterList.innerHTML = players.map(function (p) {
      var dot = /^#[0-9a-fA-F]{6}$/.test(p.color || "")
        ? '<span class="roster__dot" style="background:' + p.color + '" title="自定义颜色"></span>'
        : '<span class="roster__dot roster__dot--none" title="跟随全局主题"></span>';
      return '<li class="roster__card" data-id="' + esc(p.id) + '">' +
        rosterAvatarMarkup(p) + dot +
        '<div class="roster__meta">' +
        '<span class="roster__name">' + esc(p.name || "?") + (p.tag ? ' <em class="roster__id">' + esc(p.tag) + "</em>" : "") + "</span>" +
        '<span class="roster__tag">' + esc(titleDisplayText(p)) + "</span>" +
        "</div>" +
        '<div class="roster__ops">' +
        '<button type="button" class="btn btn--ghost btn--sm" data-act="left">←左</button>' +
        '<button type="button" class="btn btn--ghost btn--sm" data-act="right">右→</button>' +
        "</div></li>";
    }).join("");
    els.rosterEmpty.hidden = players.length > 0;
  }

  function applyPlayer(side, player) {
    var d = state.data[side];
    var sameRoster = d.rosterId === player.id;
    /* 换选手时带出选手库的 ID/队名(tag),同人重应用则保留现场编辑值 */
    var tag = sameRoster ? (d.tag || "") : (player.tag || "");
    var tagImg = sameRoster ? (d.tagImg || null) : null;
    var tagImgRatio = sameRoster ? (d.tagImgRatio || null) : null;
    var tagImgSize = sameRoster ? (d.tagImgSize || null) : null;

    var app = window.TournamentApp;
    var avatarJob = player.avatar
      ? Promise.resolve(app.blobUrl(player.avatar)).then(function (u) { return VSUpload.handleURL(u); }).catch(function () { return null; })
      : Promise.resolve(null);
    var title = typeof player.title === "string" ? player.title : ((player.title && player.title.text) || "");

    avatarJob.then(function (img) {
      d.name = player.name;
      d.color = player.color || null;
      d.rosterId = player.id;
      d.tag = tag;
      d.tagImg = tagImg;
      d.tagImgRatio = tagImgRatio;
      d.tagImgSize = tagImgSize;
      d.img = img;
      d.title = title;
      slotChanged[side].img = false;

      /* currentData() 会从输入框反向读取 name/tag/title 重建 state,
       * 三个输入框必须全部同步,否则旧输入值会覆盖刚应用的选手数据 */
      sideEl(side, "name").value = player.name;
      sideEl(side, "tag").value = tag || "";
      sideEl(side, "title").value = title || "";
      saveState();
      render();
      toast("已应用「" + player.name + "」到" + (side === "left" ? "左侧" : "右侧"));
    });
  }

  function saveSlotToPlayer(side) {
    if (!canEdit()) { toast("需要管理员权限才能保存选手", true); return; }
    var app = window.TournamentApp;
    var utils = window.TournamentUtils;
    var d = state.data[side];
    var name = sideEl(side, "name").value.trim();
    if (!name) {
      toast("请先填写选手名字再保存", true);
      sideEl(side, "name").focus();
      return;
    }

    var players = (app.players || []).slice();
    var player = d.rosterId ? players.filter(function (x) { return x.id === d.rosterId; })[0] : null;
    var isNew = false;
    if (!player) {
      isNew = true;
      player = {
        id: window.CanvasModel.uid("p"),
        name: name,
        avatar: null,
        title: "",
        tag: "",
        color: null,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      players.unshift(player);
      d.rosterId = player.id;
      slotChanged[side].img = true;
    }

    var titleText = typeof d.title === "string" ? d.title : ((d.title && d.title.text) || "");
    var needAvatar = slotChanged[side].img || isNew;

    var avatarJob = needAvatar ? imageForStorage(d.img, app) : Promise.resolve(null);

    avatarJob.then(function (avatar) {
      player.name = name;
      player.color = /^#[0-9a-fA-F]{6}$/.test(d.color || "") ? d.color : null;
      player.title = titleText;
      player.tag = String(d.tag || "").trim().slice(0, 16);
      player.updatedAt = Date.now();
      if (needAvatar) player.avatar = avatar;

      app.storagePutPlayers(players).then(function () {
        app.players = players;
        slotChanged[side].img = false;
        renderRoster();
        saveState();
        render();
        toast("已更新选手「" + name + "」");
      }).catch(function (e) {
        notifyError("保存选手失败：" + (utils && utils.errMsg ? utils.errMsg(e) : e.message));
      });
    }).catch(function (e) {
      notifyError("保存选手失败：" + (utils && utils.errMsg ? utils.errMsg(e) : e.message));
    });
  }

  var titleDebounce = {};

  /* ---------- 主题选择器(页头) ---------- */

  var menuOpen = false;
  var menuIndex = 0;

  function renderThemeMenu() {
    els.themeMenu.innerHTML = VSThemes.map(function (t, i) {
      return '<li role="option" data-theme-id="' + t.id + '" data-index="' + i + '" aria-selected="false" tabindex="-1">' +
        '<span class="theme-menu__dot" style="background:linear-gradient(135deg,' + t.left.main + " 50%," + t.right.main + " 50%)\"></span>" +
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

  /* ---------- 随机示例 / 重置 ---------- */

  var RANDOM_PAIRS = [
    ["烈焰", "冰霜", "DK.FIRE", "ICE.BLIZZ"],
    ["雷霆", "疾风", "TD.LEI", "WIND.NIN"],
    ["猛虎", "雄鹰", "TIGER.01", "EAGLE.X"],
    ["暗夜", "黎明", "NIGHT.S", "DAWN.K"],
    ["狂龙", "灵狐", "DRAGON.CN", "FOX.9"]
  ];

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

  function syncForm() {
    var d = state.data;
    els.matchName.value = d.matchName;
    els.stage.value = d.stage;
    if (!els.stage.value) els.stage.value = "总决赛";
    els.bo.value = d.bo;
    els.date.value = d.date;
    els.venue.value = d.venue;
    els.leftName.value = d.left.name;
    els.leftTag.value = d.left.tag;
    els.leftColor.value = d.left.color || "#ff2d2d";
    els.rightName.value = d.right.name;
    els.rightTag.value = d.right.tag;
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

    renderThemeMenu();
    bindHeaderControls();
    bindFormControls();
    syncForm();
    renderRoster();
    render();
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
