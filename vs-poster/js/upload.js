/**
 * 图片上传处理:文件选择 / 拖拽 / URL
 * 校验类型与大小 → 等比压缩 → dataURL(内嵌进 SVG,导出无 CORS 问题)
 */
(function () {
  "use strict";

  var MAX_FILE = 10 * 1024 * 1024; // 10MB
  var MAX_EDGE = 1024;             // 压缩到最长边 ≤1024px

  /** URL 白名单(纯函数,可单测):http/https、image data: 与 blob:(本地 Blob 头像/称号)。
   * 放行 http: 与主站 safeUrl(仅 https)有意不同:这里是编辑器本机取图转 dataURL,
   * https 生产页面上 http 图会被浏览器混合内容拦截,放行只对本机 http 调试有意义 */
  function isAllowedURL(raw) {
    var url = String(raw || "").trim();
    if (!url) return false;
    if (/^https?:\/\//i.test(url)) return true;
    if (/^data:image\//i.test(url)) return true;
    if (/^blob:/i.test(url)) return true;
    return false;
  }

  function loadImage(src, withCors) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("图片加载失败,请检查链接")); };
      if (withCors) img.crossOrigin = "anonymous";
      img.src = src;
    });
  }

  /** 等比缩放并转 dataURL(透明图走 PNG,其余 JPEG) */
  function downscale(img, maxEdge, preferPng) {
    var scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    var w = Math.max(1, Math.round(img.naturalWidth * scale));
    var h = Math.max(1, Math.round(img.naturalHeight * scale));
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    if (preferPng) return canvas.toDataURL("image/png");
    return canvas.toDataURL("image/jpeg", 0.92);
  }

  /** 文件上传:校验 + 压缩 */
  function handleFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file) return reject(new Error("没有选择文件"));
      if (!/^image\//.test(file.type)) return reject(new Error("只支持图片文件"));
      if (file.size > MAX_FILE) return reject(new Error("图片超过 10MB 限制"));
      var url = URL.createObjectURL(file);
      loadImage(url, false)
        .then(function (img) {
          URL.revokeObjectURL(url);
          resolve(downscale(img, MAX_EDGE, /png|svg|gif/i.test(file.type)));
        })
        .catch(function (e) { URL.revokeObjectURL(url); reject(e); });
    });
  }

  /** URL 加载:scheme 校验 → 先尝试 CORS 直读,失败降级(仍可能被跨域拦截) */
  function handleURL(raw) {
    var url = String(raw || "").trim();
    if (!isAllowedURL(url)) return Promise.reject(new Error("仅支持 http(s) 或图片 data: 链接"));
    var preferPng = /\.png$/i.test(url);
    return loadImage(url, true)
      .then(function (img) { return downscale(img, MAX_EDGE, preferPng); })
      .catch(function () {
        // CORS 直读失败:降级不带 crossOrigin 再试(canvas 会被污染则报错)
        return loadImage(url, false)
          .then(function (img) {
            try { return downscale(img, MAX_EDGE, preferPng); }
            catch (e) { throw new Error("远程图片有跨域限制,请下载后上传本地文件"); }
          });
      });
  }

  window.VSUpload = {
    isAllowedURL: isAllowedURL,
    handleFile: handleFile,
    handleURL: handleURL
  };
})();
