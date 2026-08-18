/**
 * 状态管理 + localStorage 持久化
 * 头像以 dataURL 存储(≤512px 压缩,控制体积)
 */
(function () {
  "use strict";

  var KEY = "vs-poster-state";
  var ROSTER_KEY = "vs-poster-roster";
  var STORE_EDGE = 512;

  function today() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function defaults() {
    return {
      data: {
        matchName: "电竞巅峰对决",
        stage: "总决赛",
        bo: "BO3",
        date: today(),
        venue: "上海体育馆",
        left: { name: "烈焰", tag: "DK.FIRE", img: null, color: null, rosterId: null, tagImg: null, tagImgRatio: null, tagImgSize: null, title: { type: "text", text: "", image: null } },
        right: { name: "冰霜", tag: "ICE.BLIZZ", img: null, color: null, rosterId: null, tagImg: null, tagImgRatio: null, tagImgSize: null, title: { type: "text", text: "", image: null } }
      },
      themeId: "red-blue",
      resolution: "1080p"
    };
  }

  /** 深合并:以 base 为准,用 saved 覆盖(损坏/缺字段容错) */
  function deepMerge(base, saved) {
    if (saved == null || typeof saved !== "object") return JSON.parse(JSON.stringify(base));
    var out = Array.isArray(base) ? base.slice() : {};
    Object.keys(base).forEach(function (k) {
      if (saved[k] === undefined) out[k] = base[k];
      else if (base[k] && typeof base[k] === "object" && !Array.isArray(base[k]) && saved[k] && typeof saved[k] === "object") {
        out[k] = deepMerge(base[k], saved[k]);
      } else {
        out[k] = saved[k];
      }
    });
    return out;
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return defaults();
      return deepMerge(defaults(), JSON.parse(raw));
    } catch (e) {
      return defaults();
    }
  }

  /** 头像压缩到 ≤512px 再写入(异步);PNG/SVG/GIF 含透明通道,JPEG 会涂黑底 —— 保留 PNG */
  function compressForStorage(dataURL) {
    return new Promise(function (resolve) {
      if (!dataURL) return resolve(null);
      var img = new Image();
      img.onload = function () {
        try {
          var scale = Math.min(1, STORE_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
          var w = Math.max(1, Math.round(img.naturalWidth * scale));
          var h = Math.max(1, Math.round(img.naturalHeight * scale));
          var canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          var ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          var keepAlpha = /^data:image\/(png|svg\+xml|gif)/i.test(dataURL);
          resolve(canvas.toDataURL(keepAlpha ? "image/png" : "image/jpeg", 0.85));
        } catch (e) {
          resolve(dataURL); // 压缩失败保底原样
        }
      };
      img.onerror = function () { resolve(dataURL); };
      img.src = dataURL;
    });
  }

  function save(state) {
    var leftTitle = (state.data.left.title && state.data.left.title.image) || null;
    var rightTitle = (state.data.right.title && state.data.right.title.image) || null;
    return Promise.all([
      compressForStorage(state.data.left.img || null),
      compressForStorage(state.data.right.img || null),
      compressForStorage(state.data.left.tagImg || null),
      compressForStorage(state.data.right.tagImg || null),
      compressForStorage(leftTitle),
      compressForStorage(rightTitle)
    ]).then(function (imgs) {
      var copy = JSON.parse(JSON.stringify(state));
      copy.data.left.img = imgs[0];
      copy.data.right.img = imgs[1];
      copy.data.left.tagImg = imgs[2];
      copy.data.right.tagImg = imgs[3];
      if (copy.data.left.title) copy.data.left.title.image = imgs[4];
      if (copy.data.right.title) copy.data.right.title.image = imgs[5];
      try { localStorage.setItem(KEY, JSON.stringify(copy)); } catch (e) { /* 存储满时静默 */ }
    });
  }

  function reset() {
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  }

  /* ---------- 选手库(独立存储) ---------- */

  /** 选手条目:{ id, name, tag, img, color|null, tagImg, tagImgRatio|null } */
  function loadRoster() {
    try {
      var raw = localStorage.getItem(ROSTER_KEY);
      if (!raw) return [];
      var list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  /** 头像/队标压缩到 ≤512px 后写入(异步) */
  function saveRoster(list) {
    var jobs = list.map(function (item) {
      return Promise.all([
        compressForStorage(item.img || null),
        compressForStorage(item.tagImg || null)
      ]).then(function (out) {
        item.img = out[0];
        item.tagImg = out[1];
      });
    });
    return Promise.all(jobs).then(function () {
      try { localStorage.setItem(ROSTER_KEY, JSON.stringify(list)); } catch (e) { /* 存储满时静默 */ }
    });
  }

  /* ---------- OBS 舞台模式 payload(纯函数,可单测) ---------- */

  /** 打包海报状态为 URL 参数(自包含,任何浏览器/OBS 实例均可渲染) */
  function packPayload(partial) {
    return encodeURIComponent(JSON.stringify({
      data: (partial && partial.data) || null,
      themeId: (partial && partial.themeId) || null
    }));
  }

  /** 解包 payload;非法/缺失返回 null */
  function unpackPayload(str) {
    try {
      var parsed = JSON.parse(decodeURIComponent(String(str || "")));
      return parsed && parsed.data ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  window.VSState = {
    defaults: defaults,
    load: load,
    save: save,
    reset: reset,
    loadRoster: loadRoster,
    saveRoster: saveRoster,
    packPayload: packPayload,
    unpackPayload: unpackPayload
  };
})();
