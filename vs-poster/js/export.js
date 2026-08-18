/**
 * 导出管线:SVG 字符串 → PNG(1080p / 2K / 4K)
 * 预览与导出共用同一份 SVG,所见即所得
 */
(function () {
  "use strict";

  var RESOLUTIONS = {
    "1080p": [1920, 1080],
    "2k": [2560, 1440],
    "4k": [3840, 2160]
  };

  /** SVG 字符串 → PNG Blob(先经 Image 解码,保证字体/滤镜渲染正确) */
  function svgToPng(svgString, resolution) {
    var size = RESOLUTIONS[resolution] || RESOLUTIONS["1080p"];
    return new Promise(function (resolve, reject) {
      var blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        var canvas = document.createElement("canvas");
        canvas.width = size[0];
        canvas.height = size[1];
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, size[0], size[1]);
        URL.revokeObjectURL(url);
        canvas.toBlob(function (b) {
          if (b) resolve(b);
          else reject(new Error("PNG 编码失败"));
        }, "image/png");
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("SVG 渲染失败"));
      };
      img.src = url;
    });
  }

  /** 清理文件名非法字符 */
  function sanitizeFilename(s) {
    var cleaned = String(s || "").replace(/[\\/:*?"<>|]/g, "_").trim();
    return cleaned.slice(0, 60) || "match";
  }

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  window.VSExport = {
    RESOLUTIONS: RESOLUTIONS,
    svgToPng: svgToPng,
    sanitizeFilename: sanitizeFilename,
    download: download
  };
})();
