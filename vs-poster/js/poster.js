/**
 * SVG 海报构建器(纯函数,不依赖 DOM —— 可在 node 中单测)
 * 输入:数据对象 + 主题对象 → 输出:完整 SVG 字符串(1920×1080 viewBox)
 * 预览与导出共用这一份字符串,所见即所得。
 * 预览动效类(p-*)只由 css/poster.css 驱动,导出静态渲染时无副作用。
 */
(function () {
  "use strict";

  var W = 1920, H = 1080, CX = 960, CY = 540;

  /* ---------- 工具 ---------- */

  /** XML 转义:所有用户文本进 SVG 前必须经过 */
  function escapeXml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** 可复现伪随机(保证三主题粒子位置一致、导出可复现) */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 中英文混合宽度估计:CJK 按 1.05em,拉丁按 0.55em */
  function textWidth(s, fontSize) {
    var w = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      var isCjk = (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || c >= 0x20000;
      w += isCjk ? 1.05 : 0.56;
    }
    return w * fontSize;
  }

  /** 名字字号自适应:不超 maxWidth,保底 minFont */
  function fitFontSize(s, maxWidth, maxFont, minFont) {
    var per = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      per += (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || c >= 0x20000 ? 1.05 : 0.56;
    }
    var size = Math.floor(maxWidth / Math.max(per, 0.1));
    return Math.max(minFont, Math.min(maxFont, size));
  }

  /** 撕裂边缘:在直线两点间生成锯齿折线(种子可复现,首尾归零) */
  function jaggedEdge(x1, y1, x2, y2, seg, amp, seed, mirror) {
    var dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    var nx = -dy / len, ny = dx / len;
    if (mirror) { nx = -nx; ny = -ny; }
    var rnd = mulberry32(seed);
    var pts = [x1 + "," + y1];
    for (var i = 1; i < seg; i++) {
      var t = i / seg;
      var env = Math.sin(Math.PI * t);           // 首尾渐弱
      var sign = (i % 2 === 1 ? 1 : -0.45) * (0.55 + rnd() * 0.9);
      var off = sign * amp * env;
      var px = x1 + dx * t + nx * off;
      var py = y1 + dy * t + ny * off;
      pts.push(Math.round(px) + "," + Math.round(py));
    }
    pts.push(x2 + "," + y2);
    return pts.join(" ");
  }

  function hexToRgb(hex) {
    var h = hex.replace("#", "");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  var HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  /** 颜色会被拼进 SVG 属性,非法值(如手工改过的 localStorage 状态)回退中性色,杜绝属性注入 */
  var FALLBACK_COLOR = "#4a5568";
  function rgba(hex, a) {
    var r = hexToRgb(hex);
    return "rgba(" + r[0] + "," + r[1] + "," + r[2] + "," + a + ")";
  }

  /** 主色 → 完整选手色 {main, glow, dark}:glow 提亮、dark 加深(自由选色只需一个主色) */
  function deriveColor(main) {
    var hex = HEX_COLOR_RE.test(String(main || "")) ? main : FALLBACK_COLOR;
    var r = hexToRgb(hex);
    var mix = function (t, target) {
      var tgt = hexToRgb(target);
      var c = r.map(function (v, i) { return Math.round(v * (1 - t) + tgt[i] * t); });
      return "#" + c.map(function (v) { return v.toString(16).padStart(2, "0"); }).join("");
    };
    return { main: hex, glow: mix(0.35, "#ffffff"), dark: mix(0.5, "#000000") };
  }

  /* ---------- 图片链接白名单 ---------- */

  /** 与 VSUpload.isAllowedURL 同源(http/https、image data:、blob:);poster.js 可被单独加载,内置兜底 */
  function isAllowedImgURL(raw) {
    if (window.VSUpload && window.VSUpload.isAllowedURL) return window.VSUpload.isAllowedURL(raw);
    var url = String(raw || "").trim();
    return /^(https?:\/\/|data:image\/|blob:)/i.test(url);
  }

  /* ---------- 占位头像 ---------- */

  /** 无头像时生成「首字符 + 主题渐变」占位头像(data URL);col 可为选手色或主题侧色 */
  function placeholderAvatar(char, col) {
    var ch = (char || "?").trim().slice(0, 1).toUpperCase() || "?";
    var s =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
      "<defs>" +
      '<linearGradient id="pb" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="' + col.dark + '"/>' +
      '<stop offset="1" stop-color="#101018"/>' +
      "</linearGradient>" +
      '<linearGradient id="pg" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#ffffff"/>' +
      '<stop offset="1" stop-color="' + col.glow + '"/>' +
      "</linearGradient>" +
      "</defs>" +
      '<rect width="512" height="512" fill="url(#pb)"/>' +
      '<circle cx="256" cy="256" r="210" fill="' + rgba(col.main, 0.16) + '"/>' +
      '<circle cx="256" cy="256" r="210" fill="none" stroke="' + col.main + '" stroke-width="10" opacity="0.55"/>' +
      '<path d="M160 0 L512 0 L512 140 L0 512 L0 300 Z" fill="#ffffff" opacity="0.07"/>' +
      '<text x="256" y="330" text-anchor="middle" font-family="Impact, Arial Black, PingFang SC, sans-serif" ' +
      'font-size="280" font-weight="900" fill="url(#pg)">' + escapeXml(ch) + "</text>" +
      "</svg>";
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s);
  }

  /* ---------- 海报主体 ---------- */

  /** 构建完整海报 SVG——按主题的 layout 字段分发版式 */
  function build(data, theme) {
    if (theme && theme.layout === "pixel") return buildPixel(data, theme);
    if (theme && theme.layout === "minimal") return buildMinimal(data, theme);
    if (theme && theme.layout === "ornate") return buildOrnate(data, theme);
    if (theme && theme.layout === "cyber") return buildCyber(data, theme);
    return buildRift(data, theme);
  }

  /** 构建完整海报 SVG(撕裂分屏版式)。data: { matchName, stage, bo, date, venue, left:{name,tag,img,tagImg,tagImgRatio,tagImgSize}, right:{...同} } */
  function buildRift(data, theme) {

    var name = String(data.matchName || "VS 巅峰对决").trim();
    var metaParts = [data.date, data.venue, data.stage, data.bo].filter(Boolean);
    var meta = metaParts.join(" · ") || "VS";

    var leftName = String(data.left.name || "").trim();
    var rightName = String(data.right.name || "").trim();
    var leftTag = (String(data.left.tag || "").trim() || leftName).slice(0, 14);
    var rightTag = (String(data.right.tag || "").trim() || rightName).slice(0, 14);

    var leftFont = fitFontSize(leftName || "?", 640, 96, 42);
    var rightFont = fitFontSize(rightName || "?", 640, 96, 42);

    // 选手自定义颜色优先,未设置回退全局主题侧色
    var L = theme.left, R = theme.right;
    var leftCol = data.left.color ? deriveColor(data.left.color) : L;
    var rightCol = data.right.color ? deriveColor(data.right.color) : R;

    var leftImg = isAllowedImgURL(data.left.img) ? data.left.img : placeholderAvatar(leftName, leftCol);
    var rightImg = isAllowedImgURL(data.right.img) ? data.right.img : placeholderAvatar(rightName, rightCol);

    // 撕裂边缘(左右对称,mirror 使锯齿镜像)
    var jagAmp = 34, jagSeed = 7;
    var leftEdge = jaggedEdge(1060, 0, 860, H, 13, jagAmp, jagSeed, false);
    var rightEdge = jaggedEdge(860, 0, 1060, H, 13, jagAmp, jagSeed, true);

    var parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080" role="img" aria-label="' + escapeXml(leftName + " vs " + rightName) + '">');

    /* ---- defs ---- */
    var d = ["<defs>"];
    d.push('<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + theme.bg.from + '"/>' +
      '<stop offset="1" stop-color="' + theme.bg.to + '"/></linearGradient>');
    // 半场光晕:选手自定义色优先(回退主题侧色);自定义时增强光晕强度
    var leftGlowOp = data.left.color ? 0.58 : 0.42;
    var rightGlowOp = data.right.color ? 0.58 : 0.42;
    d.push('<radialGradient id="gl" cx="0.35" cy="0.5" r="0.75">' +
      '<stop offset="0" stop-color="' + leftCol.main + '" stop-opacity="' + leftGlowOp + '"/>' +
      '<stop offset="1" stop-color="' + leftCol.main + '" stop-opacity="0"/></radialGradient>');
    d.push('<radialGradient id="gr" cx="0.65" cy="0.5" r="0.75">' +
      '<stop offset="0" stop-color="' + rightCol.main + '" stop-opacity="' + rightGlowOp + '"/>' +
      '<stop offset="1" stop-color="' + rightCol.main + '" stop-opacity="0"/></radialGradient>');
    d.push('<radialGradient id="vsglow" cx="0.5" cy="0.5" r="0.5">' +
      '<stop offset="0" stop-color="' + theme.vs.glow + '" stop-opacity="0.30"/>' +
      '<stop offset="1" stop-color="' + theme.vs.glow + '" stop-opacity="0"/></radialGradient>');
    d.push('<linearGradient id="vsgrad" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="' + theme.vs.from + '"/>' +
      '<stop offset="0.45" stop-color="#ffffff"/>' +
      '<stop offset="0.62" stop-color="' + theme.vs.from + '"/>' +
      '<stop offset="1" stop-color="' + theme.vs.to + '"/></linearGradient>');
    d.push('<linearGradient id="line" x1="0" y1="0" x2="1" y2="0">' +
      '<stop offset="0" stop-color="' + theme.accent + '" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="' + theme.accent + '" stop-opacity="0.9"/></linearGradient>');
    d.push('<pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse">' +
      '<rect width="4" height="1" fill="#ffffff" opacity="0.04"/></pattern>');
    d.push('<radialGradient id="vig" cx="0.5" cy="0.5" r="0.72">' +
      '<stop offset="0.55" stop-color="#000000" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="#000000" stop-opacity="0.55"/></radialGradient>');
    // 发光滤镜
    d.push('<filter id="fglow" x="-40%" y="-40%" width="180%" height="180%">' +
      '<feGaussianBlur in="SourceGraphic" stdDeviation="10" result="b"/>' +
      '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>');
    d.push('<filter id="fsoft" x="-40%" y="-40%" width="180%" height="180%">' +
      '<feGaussianBlur in="SourceGraphic" stdDeviation="14"/></filter>');
    d.push('<filter id="fvs" x="-40%" y="-40%" width="180%" height="180%">' +
      '<feDropShadow dx="0" dy="10" stdDeviation="22" flood-color="' + theme.vs.glow + '" flood-opacity="0.85"/></filter>');
    // 头像圆形裁剪
    d.push('<clipPath id="clipL"><circle cx="430" cy="520" r="205"/></clipPath>');
    d.push('<clipPath id="clipR"><circle cx="1490" cy="520" r="205"/></clipPath>');
    d.push("</defs>");
    parts.push(d.join(""));

    /* ---- 背景 ---- */
    parts.push('<rect width="1920" height="1080" fill="url(#bg)"/>');

    /* ---- 左右半场(撕裂 X 分割) ---- */
    parts.push('<polygon points="0,0 ' + leftEdge + ' 0,' + H + '" fill="url(#gl)"/>');
    parts.push('<polygon points="' + W + ',0 ' + rightEdge + ' ' + W + ',' + H + '" fill="url(#gr)"/>');
    // 撕裂边缘发光描边(用选手色)
    parts.push('<polyline points="' + leftEdge + '" fill="none" stroke="' + leftCol.glow + '" stroke-width="10" opacity="0.5" filter="url(#fsoft)"/>');
    parts.push('<polyline points="' + rightEdge + '" fill="none" stroke="' + rightCol.glow + '" stroke-width="10" opacity="0.5" filter="url(#fsoft)"/>');

    /* ---- 网格(霓虹主题强化) ---- */
    if (theme.grid) {
      var grid = '';
      for (var gx = 0; gx <= W; gx += 96) grid += '<line x1="' + gx + '" y1="0" x2="' + gx + '" y2="' + H + '" stroke="' + theme.accent + '" opacity="0.08"/>';
      for (var gy = 0; gy <= H; gy += 96) grid += '<line x1="0" y1="' + gy + '" x2="' + W + '" y2="' + gy + '" stroke="' + theme.accent + '" opacity="0.08"/>';
      parts.push('<g>' + grid + '</g>');
    }

    /* ---- 能量光线(斜向光锥) ---- */
    parts.push('<polygon points="0,140 0,320 920,540 830,540" fill="' + leftCol.main + '" opacity="0.07"/>');
    parts.push('<polygon points="' + W + ',140 ' + W + ',320 1000,540 1090,540" fill="' + rightCol.main + '" opacity="0.07"/>');
    parts.push('<line x1="300" y1="540" x2="1620" y2="540" stroke="' + theme.accent + '" stroke-width="4" opacity="0.35" filter="url(#fsoft)" class="p-ray"/>');

    /* ---- 中心 VS 辉光 + 菱形环 ---- */
    parts.push('<circle cx="960" cy="540" r="430" fill="url(#vsglow)"/>');
    parts.push('<polygon points="960,240 1220,540 960,840 700,540" fill="rgba(0,0,0,0.35)" stroke="' + theme.accent + '" stroke-width="3" opacity="0.85" class="p-diamond"/>');

    /* ---- 粒子 ---- */
    var rnd = mulberry32(42);
    var particles = "";
    for (var i = 0; i < 42; i++) {
      var px = 60 + Math.floor(rnd() * 1800);
      var py = 90 + Math.floor(rnd() * 900);
      var pr = 2 + Math.floor(rnd() * 5);
      var pc = theme.particles[i % 2];
      var po = (0.2 + rnd() * 0.45).toFixed(2);
      var isDiamond = i % 7 === 0;
      if (isDiamond) {
        var sz = 6 + Math.floor(rnd() * 6);
        particles += '<rect x="' + (px - sz / 2) + '" y="' + (py - sz / 2) + '" width="' + sz + '" height="' + sz + '" fill="' + theme.accent + '" opacity="' + po + '" transform="rotate(45 ' + px + ' ' + py + ')" class="p-sparkle"/>';
      } else {
        particles += '<circle cx="' + px + '" cy="' + py + '" r="' + pr + '" fill="' + pc + '" opacity="' + po + '" class="p-particle"/>';
      }
    }
    parts.push('<g>' + particles + '</g>');

    /* ---- VS 徽章 ---- */
    parts.push('<g class="p-vs">');
    parts.push('<text x="960" y="628" text-anchor="middle" font-family="Impact, Arial Black, sans-serif" font-size="360" font-style="italic" font-weight="900" letter-spacing="12" fill="url(#vsgrad)" stroke="' + theme.vs.stroke + '" stroke-width="10" stroke-linejoin="round" paint-order="stroke" filter="url(#fvs)">VS</text>');
    parts.push('<text x="960" y="716" text-anchor="middle" font-family="ui-monospace, SF Mono, Menlo, monospace" font-size="40" letter-spacing="22" font-weight="700" fill="' + theme.accent + '" opacity="0.9">VERSUS</text>');
    parts.push("</g>");
    // 两侧小闪电
    parts.push('<path d="M712,500 L712,560 L736,560 L716,600" fill="none" stroke="' + theme.accent + '" stroke-width="6" stroke-linejoin="round" class="p-bolt"/>');
    parts.push('<path d="M1208,560 L1208,500 L1184,500 L1204,460" fill="none" stroke="' + theme.accent + '" stroke-width="6" stroke-linejoin="round" class="p-bolt"/>');

    /* ---- 选手侧 ---- */
    parts.push(sideGroup("left", data.left, leftName, leftTag, leftFont, leftImg, theme, 430, leftCol));
    parts.push(sideGroup("right", data.right, rightName, rightTag, rightFont, rightImg, theme, 1490, rightCol));

    /* ---- 顶部比赛信息 ---- */
    parts.push('<g class="p-title">');
    parts.push('<line x1="200" y1="128" x2="560" y2="128" stroke="url(#line)" stroke-width="3" opacity="0.9"/>');
    parts.push('<line x1="1720" y1="128" x2="1360" y2="128" stroke="url(#line)" stroke-width="3" opacity="0.9" transform="scale(-1,1) translate(-1920,0)"/>');
    parts.push('<rect x="188" y="116" width="16" height="16" fill="' + theme.accent + '" transform="rotate(45 196 124)" opacity="0.95"/>');
    parts.push('<rect x="1716" y="116" width="16" height="16" fill="' + theme.accent + '" transform="rotate(45 1724 124)" opacity="0.95"/>');
    parts.push('<text x="960" y="150" text-anchor="middle" font-family="Impact, Arial Black, PingFang SC, Microsoft YaHei, sans-serif" font-size="64" font-weight="900" letter-spacing="8" fill="#ffffff" filter="url(#fglow)">' + escapeXml(name) + "</text>");
    parts.push('<text x="960" y="212" text-anchor="middle" font-family="ui-monospace, SF Mono, Menlo, monospace" font-size="27" letter-spacing="7" font-weight="600" fill="#9aa2bd">' + escapeXml(meta) + "</text>");
    parts.push("</g>");

    /* ---- 底部 LIVE 信息条 ---- */
    parts.push('<rect x="0" y="1000" width="1920" height="80" fill="rgba(0,0,0,0.5)"/>');
    parts.push('<line x1="0" y1="1000" x2="1920" y2="1000" stroke="rgba(255,255,255,0.14)" stroke-width="1"/>');
    parts.push('<rect x="0" y="1000" width="1920" height="3" fill="' + theme.accent + '" opacity="0.3" class="p-scan"/>');
    parts.push('<circle cx="150" cy="1040" r="11" fill="#ff2d2d" class="p-live"/>');
    parts.push('<text x="180" y="1048" font-family="ui-monospace, SF Mono, Menlo, monospace" font-size="30" font-weight="800" letter-spacing="4" fill="#ff4d5e">LIVE NOW</text>');
    parts.push('<text x="1770" y="1048" text-anchor="end" font-family="ui-monospace, SF Mono, Menlo, monospace" font-size="28" font-weight="600" letter-spacing="3" fill="#cdd2e2">' + escapeXml(data.stage + " · " + data.bo) + "</text>");
    parts.push('<rect x="930" y="1022" width="60" height="4" fill="' + theme.accent + '" opacity="0.8"/>');

    /* ---- 扫描线 + 暗角 ---- */
    parts.push('<rect width="1920" height="1080" fill="url(#scan)"/>');
    parts.push('<rect width="1920" height="1080" fill="url(#vig)"/>');

    parts.push("</svg>");
    return parts.join("");
  }

  /** 单个选手组:旋转光环 + 头像 + ID 胶囊 + 大号名字;col 为选手色或主题侧色 */
  function sideGroup(side, data, displayName, tag, fontSize, img, theme, cx, col) {
    var parts = [];
    var cy = 520, r = 205;

    parts.push('<g class="p-side">');
    // 旋转虚线光环
    parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="262" fill="none" stroke="' + col.main + '" stroke-width="2" stroke-dasharray="10 18" opacity="0.8" class="p-ring"/>');
    // 辉光环 + 主环
    parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="238" fill="none" stroke="' + col.glow + '" stroke-width="9" opacity="0.5" filter="url(#fsoft)"/>');
    parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="224" fill="none" stroke="' + col.main + '" stroke-width="6"/>');
    // 四角螺栓
    var boltR = 252;
    var boltPts = [[cx, cy - boltR], [cx, cy + boltR], [cx - boltR, cy], [cx + boltR, cy]];
    for (var b = 0; b < 4; b++) {
      parts.push('<rect x="' + (boltPts[b][0] - 6) + '" y="' + (boltPts[b][1] - 6) + '" width="12" height="12" fill="' + theme.accent + '" transform="rotate(45 ' + boltPts[b][0] + ' ' + boltPts[b][1] + ')" opacity="0.95"/>');
    }
    // 头像(圆形裁剪)
    parts.push('<g clip-path="url(#clip' + (side === "left" ? "L" : "R") + ')">');
    parts.push('<image href="' + escapeXml(img) + '" x="' + (cx - r) + '" y="' + (cy - r) + '" width="' + r * 2 + '" height="' + r * 2 + '" preserveAspectRatio="xMidYMid slice"/>');
    parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="url(#vig)" opacity="0.5"/>');
    parts.push("</g>");

    // ID 区:队标图片优先 —— 独立展示(无胶囊,大小可调 tagImgSize,等比缩放,高 24–200 封顶宽 420),否则文字胶囊(回退名字)
    if (isAllowedImgURL(data.tagImg)) {
      var tiRatio = Number(data.tagImgRatio) > 0 ? Number(data.tagImgRatio) : 1;
      var tiH = Math.min(200, Math.max(24, Number(data.tagImgSize) > 0 ? Number(data.tagImgSize) : 56));
      var tiW = tiH * tiRatio;
      if (tiW > 420) { tiW = 420; tiH = tiW / tiRatio; }
      parts.push('<image href="' + escapeXml(data.tagImg) + '" x="' + (cx - tiW / 2).toFixed(1) + '" y="' + (285 - tiH / 2).toFixed(1) + '" width="' + tiW.toFixed(1) + '" height="' + tiH.toFixed(1) + '" preserveAspectRatio="xMidYMid meet"/>');
    } else {
      var tagW = Math.ceil(textWidth(tag, 26)) + 52;
      parts.push('<rect x="' + (cx - tagW / 2) + '" y="258" width="' + tagW + '" height="54" rx="27" fill="rgba(0,0,0,0.55)" stroke="' + col.main + '" stroke-width="2"/>');
      parts.push('<text x="' + cx + '" y="294" text-anchor="middle" font-family="ui-monospace, SF Mono, Menlo, monospace" font-size="26" font-weight="700" letter-spacing="3" fill="' + col.glow + '">' + escapeXml(tag) + "</text>");
    }

    // 大号名字(发光 + 描边;空名字不渲染「?」,避免像故障——2026-08-12 审计)
    parts.push('<text x="' + cx + '" y="810" text-anchor="middle" font-family="Impact, Arial Black, PingFang SC, Microsoft YaHei, sans-serif" font-size="' + fontSize + '" font-style="italic" font-weight="900" letter-spacing="4" fill="#ffffff" stroke="' + col.dark + '" stroke-width="9" stroke-linejoin="round" paint-order="stroke" filter="url(#fglow)">' + escapeXml(displayName) + "</text>");

    // 赛前垃圾话(纯文本,显示在名字下方)
    var title = typeof data.title === "string" ? data.title : ((data.title && data.title.text) || "");
    if (title) {
      var titleFont = Math.max(22, Math.round(fontSize * 0.45));
      parts.push('<text x="' + cx + '" y="876" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, Noto Sans SC, sans-serif" font-size="' + titleFont + '" font-weight="700" letter-spacing="3" fill="' + col.glow + '">' + escapeXml(title) + "</text>");
    }

    parts.push("</g>");
    return parts.join("");
  }

  /* ==================== 像素街机版式 ====================
   * 纯平面、硬边缘(shape-rendering="crispEdges"),无渐变无滤镜——
   * 结构感来自阶梯分隔/像素字/街机 HUD,对抗撕裂版的辉光+毛玻璃。 */

  var MONO = '"Courier New", Courier, ui-monospace, Menlo, monospace';

  /* 3×5 像素字模(大写字母/数字/符号),用于手工拼字 */
  var PIXEL_FONT = {
    V: ["101","101","101","101","010"],
    S: ["111","100","111","001","111"],
    "1": ["010","110","010","010","111"],
    "2": ["111","001","111","100","111"],
    "3": ["111","001","111","001","111"],
    "4": ["101","101","111","001","001"],
    "5": ["111","100","111","001","111"],
    "6": ["111","100","111","101","111"],
    "7": ["111","001","001","001","001"],
    "8": ["111","101","111","101","111"],
    "9": ["111","101","111","001","111"],
    "0": ["111","101","101","101","111"]
  };

  /** 用像素字模拼字符串(仅支持字模表内字符,其他跳过)。
   * 返回 rect 网格;spacingPx 为字符间距(pixelSize 的倍数) */
  function pixelText(str, x, y, pixelSize, fill, shadowFill) {
    var parts = [];
    var cursorX = x;
    var chars = String(str || "").toUpperCase().split("");
    for (var ci = 0; ci < chars.length; ci++) {
      var glyph = PIXEL_FONT[chars[ci]];
      if (!glyph) { cursorX += pixelSize * 4; continue; }
      for (var row = 0; row < glyph.length; row++) {
        for (var col = 0; col < glyph[row].length; col++) {
          if (glyph[row][col] !== "1") continue;
          var rx = cursorX + col * pixelSize;
          var ry = y + row * pixelSize;
          if (shadowFill) {
            parts.push('<rect x="' + (rx + pixelSize) + '" y="' + (ry + pixelSize) + '" width="' + pixelSize + '" height="' + pixelSize + '" fill="' + shadowFill + '"/>');
          }
          parts.push('<rect x="' + rx + '" y="' + ry + '" width="' + pixelSize + '" height="' + pixelSize + '" fill="' + fill + '"/>');
        }
      }
      cursorX += pixelSize * 4; /* 3 列字模 + 1 列间隔 */
    }
    return parts.join("");
  }

  /** 像素字串宽度(用于居中) */
  function pixelTextWidth(str, pixelSize) {
    var chars = String(str || "").toUpperCase().split("");
    var n = 0;
    for (var i = 0; i < chars.length; i++) {
      if (PIXEL_FONT[chars[i]]) n++;
    }
    return n * pixelSize * 4 - pixelSize;
  }

  /** 像素星(十字):5×5 方块十字 */
  function pixelStar(x, y, size, fill) {
    return '<rect x="' + (x + size) + '" y="' + y + '" width="' + size + '" height="' + size * 3 + '" fill="' + fill + '"/>' +
      '<rect x="' + x + '" y="' + (y + size) + '" width="' + size * 3 + '" height="' + size + '" fill="' + fill + '"/>';
  }

  /** 像素心(街机生命):7×6 网格 */
  function pixelHeart(x, y, s, fill) {
    var g = ["01010","11111","11111","01110","00100"];
    var parts = [];
    for (var r = 0; r < g.length; r++) {
      for (var c = 0; c < g[r].length; c++) {
        if (g[r][c] === "1") {
          parts.push('<rect x="' + (x + c * s) + '" y="' + (y + r * s) + '" width="' + s + '" height="' + s + '" fill="' + fill + '"/>');
        }
      }
    }
    return parts.join("");
  }

  function buildPixel(data, theme) {
    var name = String(data.matchName || "VS 巅峰对决").trim();
    var metaParts = [data.date, data.venue, data.stage, data.bo].filter(Boolean);
    var meta = metaParts.join(" · ") || "VS";
    var boText = String(data.bo || "BO3").toUpperCase().replace(/BO(\d+)/, "$1");

    var leftCol = data.left.color ? deriveColor(data.left.color) : { main: theme.left.main, glow: theme.left.glow, dark: theme.left.dark };
    var rightCol = data.right.color ? deriveColor(data.right.color) : { main: theme.right.main, glow: theme.right.glow, dark: theme.right.dark };
    var leftImg = isAllowedImgURL(data.left.img) ? data.left.img : placeholderAvatar(String(data.left.name || "?")[0], leftCol);
    var rightImg = isAllowedImgURL(data.right.img) ? data.right.img : placeholderAvatar(String(data.right.name || "?")[0], rightCol);
    var leftName = String(data.left.name || "").trim();
    var rightName = String(data.right.name || "").trim();
    var leftTitle = typeof data.left.title === "string" ? data.left.title : "";
    var rightTitle = typeof data.right.title === "string" ? data.right.title : "";

    var parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080" role="img" aria-label="' + escapeXml(leftName + " vs " + rightName) + '">');

    /* defs:像素网格 pattern + 扫描线 */
    parts.push('<defs>');
    parts.push('<pattern id="px-grid" width="32" height="32" patternUnits="userSpaceOnUse">' +
      '<rect width="32" height="32" fill="none"/><rect x="0" y="0" width="1" height="1" fill="' + theme.accent + '" opacity="0.06"/></pattern>');
    parts.push('<pattern id="px-scan" width="4" height="4" patternUnits="userSpaceOnUse">' +
      '<rect width="4" height="2" fill="#000" opacity="0.12"/><rect y="2" width="4" height="2" fill="none"/></pattern>');
    parts.push('</defs>');

    /* 背景:平涂暗色 + 像素网格 + 上下色带 */
    parts.push('<g shape-rendering="crispEdges">');
    parts.push('<rect width="1920" height="1080" fill="' + theme.bg.from + '"/>');
    parts.push('<rect width="1920" height="1080" fill="url(#px-grid)"/>');
    parts.push('<rect x="0" y="0" width="1920" height="8" fill="' + leftCol.main + '"/>');
    parts.push('<rect x="0" y="1072" width="1920" height="8" fill="' + rightCol.main + '"/>');
    parts.push('<rect x="0" y="8" width="1920" height="4" fill="' + leftCol.dark + '"/>');
    parts.push('<rect x="0" y="1068" width="1920" height="4" fill="' + rightCol.dark + '"/>');

    /* 中央阶梯分隔:方块台阶交替左右色 */
    var stepW = 48;
    for (var sy = 120; sy < 960; sy += stepW) {
      var stepIdx = Math.floor((sy - 120) / stepW);
      var isLeft = stepIdx % 2 === 0;
      var color = isLeft ? leftCol.main : rightCol.main;
      var offset = isLeft ? 0 : stepW;
      parts.push('<rect x="' + (912 + offset) + '" y="' + sy + '" width="' + stepW + '" height="' + stepW + '" fill="' + color + '"/>');
      parts.push('<rect x="' + (912 + offset) + '" y="' + sy + '" width="' + stepW + '" height="' + (stepW / 8) + '" fill="' + (isLeft ? leftCol.glow : rightCol.glow) + '" opacity="0.6"/>');
    }

    /* 顶部 HUD:比赛名 + BO 像素字 */
    parts.push('<rect x="660" y="28" width="600" height="60" fill="#000" opacity="0.6"/>');
    parts.push('<rect x="660" y="28" width="600" height="4" fill="' + theme.accent + '"/>');
    parts.push('<rect x="660" y="84" width="600" height="4" fill="' + theme.accent + '"/>');
    parts.push('<text x="960" y="70" text-anchor="middle" font-family=' + JSON.stringify(MONO) + ' font-size="34" font-weight="700" letter-spacing="4" fill="#fff">' + escapeXml(name) + '</text>');

    /* BO 像素数字(中央,BEST OF N) */
    var boPx = 12;
    var boW = pixelTextWidth(boText, boPx);
    pixelTextBestOf(parts, boText, 960 - boW / 2, 130, boPx, theme);

    /* 像素 VS(中央大字,5×5 字模 × 30px) */
    var vsPx = 30;
    var vsW = pixelTextWidth("VS", vsPx);
    var vsX = 960 - vsW / 2;
    var vsY = 440;
    parts.push('<rect x="' + (vsX - 30) + '" y="' + (vsY - 20) + '" width="' + (vsW + 60) + '" height="' + (vsPx * 5 + 40) + '" fill="#000"/>');
    parts.push('<rect x="' + (vsX - 30) + '" y="' + (vsY - 20) + '" width="' + (vsW + 60) + '" height="8" fill="' + theme.accent + '"/>');
    parts.push('<rect x="' + (vsX - 30) + '" y="' + (vsY + vsPx * 5 + 12) + '" width="' + (vsW + 60) + '" height="8" fill="' + theme.accent + '"/>');
    parts.push(pixelText("VS", vsX, vsY, vsPx, theme.vs.from, theme.vs.stroke));

    /* 左右选手区 */
    function pixelSide(side, cx, col, img, playerName, title, tag, tagImg) {
      var sp = [];
      var AV = 320; /* 头像显示边长 */

      /* PLAYER 标签 */
      var label = side === "left" ? "PLAYER 1" : "PLAYER 2";
      sp.push('<rect x="' + (cx - 120) + '" y="140" width="240" height="44" fill="' + col.main + '"/>');
      sp.push('<rect x="' + (cx - 120) + '" y="176" width="240" height="8" fill="' + col.dark + '"/>');
      sp.push('<text x="' + cx + '" y="172" text-anchor="middle" font-family=' + JSON.stringify(MONO) + ' font-size="26" font-weight="700" letter-spacing="6" fill="#fff">' + label + '</text>');

      /* 方形头像 + 像素角饰 */
      var ax = cx - AV / 2, ay = 230;
      sp.push('<rect x="' + (ax - 16) + '" y="' + (ay - 16) + '" width="' + (AV + 32) + '" height="' + (AV + 32) + '" fill="' + col.dark + '"/>');
      sp.push('<rect x="' + (ax - 8) + '" y="' + (ay - 8) + '" width="' + (AV + 16) + '" height="' + (AV + 16) + '" fill="' + col.main + '"/>');
      sp.push('<rect x="' + ax + '" y="' + ay + '" width="' + AV + '" height="' + AV + '" fill="' + theme.bg.to + '"/>');
      sp.push('<image href="' + escapeXml(img) + '" x="' + ax + '" y="' + ay + '" width="' + AV + '" height="' + AV + '" preserveAspectRatio="xMidYMid slice" style="image-rendering:pixelated"/>');
      /* 四角像素块 */
      var corner = 24;
      sp.push('<rect x="' + (ax - 16) + '" y="' + (ay - 16) + '" width="' + corner + '" height="' + corner + '" fill="' + theme.accent + '"/>');
      sp.push('<rect x="' + (ax + AV + 16 - corner) + '" y="' + (ay - 16) + '" width="' + corner + '" height="' + corner + '" fill="' + theme.accent + '"/>');
      sp.push('<rect x="' + (ax - 16) + '" y="' + (ay + AV + 16 - corner) + '" width="' + corner + '" height="' + corner + '" fill="' + theme.accent + '"/>');
      sp.push('<rect x="' + (ax + AV + 16 - corner) + '" y="' + (ay + AV + 16 - corner) + '" width="' + corner + '" height="' + corner + '" fill="' + theme.accent + '"/>');

      /* 队标或像素徽章 */
      if (tagImg && isAllowedImgURL(tagImg)) {
        var tagH = Math.max(24, Math.min(120, Number(data[side].tagImgSize) || 56));
        var tagW = tagH * (Number(data[side].tagImgRatio) || 1);
        if (tagW > 300) { tagW = 300; tagH = tagW / (Number(data[side].tagImgRatio) || 1); }
        sp.push('<rect x="' + (cx - tagW / 2 - 12) + '" y="' + (ay + AV + 40 - tagH / 2) + '" width="' + (tagW + 24) + '" height="' + (tagH + 16) + '" fill="#000" opacity="0.7"/>');
        sp.push('<image href="' + escapeXml(tagImg) + '" x="' + (cx - tagW / 2) + '" y="' + (ay + AV + 48 - tagH / 2) + '" width="' + tagW + '" height="' + tagH + '" preserveAspectRatio="xMidYMid meet" style="image-rendering:pixelated"/>');
      }

      /* 大名字(等宽大写) */
      var displayName = playerName || "";
      var fs = Math.min(72, Math.max(36, Math.floor(620 / Math.max(1, displayName.length))));
      sp.push('<text x="' + cx + '" y="' + (ay + AV + 130) + '" text-anchor="middle" font-family=' + JSON.stringify(MONO) + ' font-size="' + fs + '" font-weight="700" letter-spacing="6" fill="#fff">' + escapeXml(displayName) + '</text>');

      /* 垃圾话 */
      if (title) {
        sp.push('<text x="' + cx + '" y="' + (ay + AV + 180) + '" text-anchor="middle" font-family=' + JSON.stringify(MONO) + ' font-size="24" letter-spacing="2" fill="' + col.glow + '">' + escapeXml(title) + '</text>');
      }
      return sp.join("");
    }
    parts.push(pixelSide("left", 430, leftCol, leftImg, leftName, leftTitle, data.left.tag, data.left.tagImg));
    parts.push(pixelSide("right", 1490, rightCol, rightImg, rightName, rightTitle, data.right.tag, data.right.tagImg));

    /* 像素装饰:星 + 心 */
    parts.push(pixelStar(140, 200, 16, theme.accent));
    parts.push(pixelStar(1780, 240, 12, theme.particles[0]));
    parts.push(pixelStar(120, 880, 20, theme.particles[1]));
    parts.push(pixelStar(1800, 860, 14, theme.accent));
    parts.push(pixelHeart(180, 940, 14, leftCol.main));
    parts.push(pixelHeart(1720, 940, 14, rightCol.main));

    /* 底部 HUD:街机台词条 */
    parts.push('<rect x="0" y="1000" width="1920" height="80" fill="#000"/>');
    parts.push('<rect x="0" y="1000" width="1920" height="4" fill="' + theme.accent + '"/>');
    parts.push('<rect x="40" y="1020" width="8" height="40" fill="' + theme.accent + '"/>');
    parts.push('<rect x="56" y="1020" width="8" height="40" fill="' + theme.accent + '" opacity="0.6"/>');
    parts.push('<text x="90" y="1050" font-family=' + JSON.stringify(MONO) + ' font-size="24" letter-spacing="2" fill="#ccc">' + escapeXml(meta) + '</text>');
    /* READY? FIGHT! 双色 */
    parts.push('<text x="1880" y="1050" text-anchor="end" font-family=' + JSON.stringify(MONO) + ' font-size="24" font-weight="700" letter-spacing="4" fill="' + theme.accent + '">READY? </text>');
    parts.push('<text x="1880" y="1050" text-anchor="end" font-family=' + JSON.stringify(MONO) + ' font-size="24" font-weight="700" letter-spacing="4" fill="' + leftCol.main + '" dx="110">FIGHT!</text>');

    /* CRT 扫描线覆盖 */
    parts.push('<rect width="1920" height="1080" fill="url(#px-scan)"/>');
    parts.push('</g>');
    parts.push('</svg>');
    return parts.join("");
  }

  /** BO 像素字 + "BEST OF" 标签 */
  function pixelTextBestOf(parts, boText, x, y, px, theme) {
    parts.push('<text x="' + (x + pixelTextWidth(boText, px) / 2) + '" y="' + (y - 8) + '" text-anchor="middle" font-family=' + JSON.stringify(MONO) + ' font-size="18" letter-spacing="4" fill="#888">BEST OF</text>');
    parts.push(pixelText(boText, x, y + 8, px, theme.accent, theme.vs.stroke));
  }

  /* ==================== 极简刊头版式 ====================
   * 杂志刊头风:超大排版为主视觉、大留白、黑白灰 + 单一强调色;
   * 无装饰无滤镜无渐变,只靠字号层级和留白呼吸。 */

  function buildMinimal(data, theme) {
    var name = String(data.matchName || "VS 巅峰对决").trim();
    var boText = String(data.bo || "BO3").toUpperCase();
    var metaParts = [data.date, data.venue].filter(Boolean);
    var meta = metaParts.join(" / ") || "";

    var leftName = String(data.left.name || "").trim();
    var rightName = String(data.right.name || "").trim();
    var leftTitle = typeof data.left.title === "string" ? data.left.title : "";
    var rightTitle = typeof data.right.title === "string" ? data.right.title : "";

    /* 选手自定义色作为名字下划线色(极简版唯一用色的地方) */
    var leftLine = data.left.color || theme.accent;
    var rightLine = data.right.color || theme.accent;

    var INK = "#1a1a1e";
    var MUTED = "#8a8a96";

    var parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080" role="img" aria-label="' + escapeXml(leftName + " vs " + rightName) + '">');

    /* defs:头像方形裁剪(限制 image 溢出) */
    parts.push('<defs>' +
      '<clipPath id="clipMinL"><rect x="' + (830 - AV) + '" y="' + (520 - nameFs - 40) + '" width="' + AV + '" height="' + AV + '"/></clipPath>' +
      '<clipPath id="clipMinR"><rect x="1090" y="' + (520 - nameFs - 40) + '" width="' + AV + '" height="' + AV + '"/></clipPath>' +
      '</defs>');

    /* 底:纯色平涂 */
    parts.push('<rect width="1920" height="1080" fill="' + theme.bg.from + '"/>');

    /* 顶部细线 + 赛事名(左对齐,杂志刊头式) */
    parts.push('<rect x="120" y="90" width="1680" height="2" fill="' + INK + '"/>');
    parts.push('<text x="120" y="60" font-family="Impact, Arial Black, PingFang SC, sans-serif" font-size="28" letter-spacing="14" fill="' + INK + '">' + escapeXml(name.toUpperCase()) + '</text>');
    parts.push('<text x="1800" y="60" text-anchor="end" font-family=' + JSON.stringify(MONO) + ' font-size="22" letter-spacing="3" fill="' + MUTED + '">' + escapeXml(boText) + '</text>');

    /* 中央:两选手名超大对排 + VS 小号居中 */
    var nameFs = Math.min(140, Math.max(48, Math.floor(700 / Math.max(1, Math.max(leftName.length, rightName.length)))));
    /* 左名字右对齐中央偏左 */
    parts.push('<text x="830" y="520" text-anchor="end" font-family="Impact, Arial Black, PingFang SC, Microsoft YaHei, sans-serif" font-size="' + nameFs + '" font-weight="900" fill="' + INK + '">' + escapeXml(leftName) + '</text>');
    /* 右名字左对齐中央偏右 */
    parts.push('<text x="1090" y="520" text-anchor="start" font-family="Impact, Arial Black, PingFang SC, Microsoft YaHei, sans-serif" font-size="' + nameFs + '" font-weight="900" fill="' + INK + '">' + escapeXml(rightName) + '</text>');

    /* VS:小号大写 + 强调色,中缝 */
    parts.push('<text x="960" y="530" text-anchor="middle" font-family=' + JSON.stringify(MONO) + ' font-size="36" font-weight="700" letter-spacing="8" fill="' + theme.accent + '">VS</text>');

    /* 名字下划线:选手自定义色(或强调色),极简版的唯一彩色 */
    var lineW = 180;
    parts.push('<rect x="' + (830 - lineW) + '" y="560" width="' + lineW + '" height="4" fill="' + leftLine + '"/>');
    parts.push('<rect x="1090" y="560" width="' + lineW + '" height="4" fill="' + rightLine + '"/>');

    /* 头像:小方形,放名字上方 */
    var AV = 200;
    if (isAllowedImgURL(data.left.img)) {
      parts.push('<image href="' + escapeXml(data.left.img) + '" x="' + (830 - AV) + '" y="' + (520 - nameFs - 40) + '" width="' + AV + '" height="' + AV + '" preserveAspectRatio="xMidYMid slice" clip-path="url(#clipMinL)"/>');
    } else {
      parts.push('<rect x="' + (830 - AV) + '" y="' + (520 - nameFs - 40) + '" width="' + AV + '" height="' + AV + '" fill="' + theme.bg.to + '" stroke="' + MUTED + '" stroke-width="2"/>');
      parts.push('<text x="' + (830 - AV / 2) + '" y="' + (520 - nameFs - 40 + AV / 2 + 20) + '" text-anchor="middle" font-family="Impact, Arial Black, sans-serif" font-size="' + Math.floor(AV / 3) + '" fill="' + MUTED + '">' + escapeXml((leftName[0] || "?")) + '</text>');
    }
    if (isAllowedImgURL(data.right.img)) {
      parts.push('<image href="' + escapeXml(data.right.img) + '" x="1090" y="' + (520 - nameFs - 40) + '" width="' + AV + '" height="' + AV + '" preserveAspectRatio="xMidYMid slice" clip-path="url(#clipMinR)"/>');
    } else {
      parts.push('<rect x="1090" y="' + (520 - nameFs - 40) + '" width="' + AV + '" height="' + AV + '" fill="' + theme.bg.to + '" stroke="' + MUTED + '" stroke-width="2"/>');
      parts.push('<text x="' + (1090 + AV / 2) + '" y="' + (520 - nameFs - 40 + AV / 2 + 20) + '" text-anchor="middle" font-family="Impact, Arial Black, sans-serif" font-size="' + Math.floor(AV / 3) + '" fill="' + MUTED + '">' + escapeXml((rightName[0] || "?")) + '</text>');
    }

    /* 垃圾话:名字下方,小号灰 */
    if (leftTitle) {
      parts.push('<text x="830" y="620" text-anchor="end" font-family="PingFang SC, Microsoft YaHei, Noto Sans SC, sans-serif" font-size="22" fill="' + MUTED + '">' + escapeXml(leftTitle) + '</text>');
    }
    if (rightTitle) {
      parts.push('<text x="1090" y="620" text-anchor="start" font-family="PingFang SC, Microsoft YaHei, Noto Sans SC, sans-serif" font-size="22" fill="' + MUTED + '">' + escapeXml(rightTitle) + '</text>');
    }

    /* 队标/ID:名字上方小号 */
    var leftTag = String(data.left.tag || "").trim();
    var rightTag = String(data.right.tag || "").trim();
    if (leftTag) {
      parts.push('<text x="830" y="' + (520 - nameFs - 60) + '" text-anchor="end" font-family=' + JSON.stringify(MONO) + ' font-size="20" letter-spacing="4" fill="' + MUTED + '">' + escapeXml(leftTag.toUpperCase()) + '</text>');
    }
    if (rightTag) {
      parts.push('<text x="1090" y="' + (520 - nameFs - 60) + '" text-anchor="start" font-family=' + JSON.stringify(MONO) + ' font-size="20" letter-spacing="4" fill="' + MUTED + '">' + escapeXml(rightTag.toUpperCase()) + '</text>');
    }
    /* 队标图片:替代文字,名字上方居中于头像区 */
    if (data.left.tagImg && isAllowedImgURL(data.left.tagImg)) {
      var ltH = Math.max(20, Math.min(80, Number(data.left.tagImgSize) || 40));
      var ltW = ltH * (Number(data.left.tagImgRatio) || 1);
      if (ltW > 200) { ltW = 200; ltH = ltW / (Number(data.left.tagImgRatio) || 1); }
      parts.push('<image href="' + escapeXml(data.left.tagImg) + '" x="' + (830 - AV + (AV - ltW) / 2) + '" y="' + (520 - nameFs - 40 + AV + 20) + '" width="' + ltW + '" height="' + ltH + '" preserveAspectRatio="xMidYMid meet"/>');
    }
    if (data.right.tagImg && isAllowedImgURL(data.right.tagImg)) {
      var rtH = Math.max(20, Math.min(80, Number(data.right.tagImgSize) || 40));
      var rtW = rtH * (Number(data.right.tagImgRatio) || 1);
      if (rtW > 200) { rtW = 200; rtH = rtW / (Number(data.right.tagImgRatio) || 1); }
      parts.push('<image href="' + escapeXml(data.right.tagImg) + '" x="' + (1090 + (AV - rtW) / 2) + '" y="' + (520 - nameFs - 40 + AV + 20) + '" width="' + rtW + '" height="' + rtH + '" preserveAspectRatio="xMidYMid meet"/>');
    }

    /* 底部:细线 + meta(左) + stage(右) */
    parts.push('<rect x="120" y="990" width="1680" height="2" fill="' + INK + '"/>');
    if (meta) {
      parts.push('<text x="120" y="1030" font-family=' + JSON.stringify(MONO) + ' font-size="20" letter-spacing="2" fill="' + MUTED + '">' + escapeXml(meta) + '</text>');
    }
    if (data.stage) {
      parts.push('<text x="1800" y="1030" text-anchor="end" font-family=' + JSON.stringify(MONO) + ' font-size="20" letter-spacing="4" fill="' + theme.accent + '">' + escapeXml(String(data.stage)) + '</text>');
    }

    parts.push('</svg>');
    return parts.join("");
  }

  /* ==================== 魔纹华饰版式 ====================
   * 奇幻纹章风:魔法阵圆环 + 对称纹饰 + 金属质感渐变 + 衬线字体。
   * 贴合影之诗世界观——法阵环绕头像,VS 像纹章徽记,暗底金属色。 */

  var SERIF = '"Palatino Linotype", Palatino, "Times New Roman", Georgia, serif';

  /** 魔法阵圆环:多层同心圆 + 刻度线 + 符文小球 + 内接多边形 */
  function magicCircle(cx, cy, radius, strokeCol, accentCol) {
    var parts = [];
    /* 外环(双线) */
    parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + radius + '" fill="none" stroke="' + strokeCol + '" stroke-width="3"/>');
    parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + (radius - 8) + '" fill="none" stroke="' + strokeCol + '" stroke-width="1" opacity="0.6"/>');
    /* 刻度:12 等分短线 */
    for (var i = 0; i < 12; i++) {
      var angle = (i / 12) * Math.PI * 2 - Math.PI / 2;
      var x1 = cx + Math.cos(angle) * (radius - 4);
      var y1 = cy + Math.sin(angle) * (radius - 4);
      var x2 = cx + Math.cos(angle) * (radius + 6);
      var y2 = cy + Math.sin(angle) * (radius + 6);
      parts.push('<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + accentCol + '" stroke-width="2"/>');
    }
    /* 符文小球:6 个,交替放在外环上 */
    for (var j = 0; j < 6; j++) {
      var a2 = (j / 6) * Math.PI * 2;
      var bx = cx + Math.cos(a2) * (radius + 18);
      var by = cy + Math.sin(a2) * (radius + 18);
      parts.push('<circle cx="' + bx + '" cy="' + by + '" r="6" fill="' + accentCol + '" opacity="0.8"/>');
    }
    /* 内接六边形 */
    var hexPts = [];
    for (var k = 0; k < 6; k++) {
      var a3 = (k / 6) * Math.PI * 2 - Math.PI / 2;
      hexPts.push((cx + Math.cos(a3) * (radius * 0.72)).toFixed(1) + ',' + (cy + Math.sin(a3) * (radius * 0.72)).toFixed(1));
    }
    parts.push('<polygon points="' + hexPts.join(' ') + '" fill="none" stroke="' + strokeCol + '" stroke-width="1.5" opacity="0.4"/>');
    /* 内环虚线 */
    parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + (radius * 0.85) + '" fill="none" stroke="' + accentCol + '" stroke-width="1" stroke-dasharray="4 6" opacity="0.5"/>');
    return parts.join("");
  }

  /** 纹章装饰角:对称花纹线(简洁的卷曲线) */
  function cornerFlourish(x, y, scale, col, flipX, flipY) {
    var fx = flipX ? -1 : 1;
    var fy = flipY ? -1 : 1;
    function tx(px, py) { return (x + px * fx * scale).toFixed(1) + ',' + (y + py * fy * scale).toFixed(1); }
    return '<path d="M ' + tx(0, 40) + ' Q ' + tx(30, 40) + ' ' + tx(40, 10) + ' Q ' + tx(45, -8) + ' ' + tx(30, -20) + ' Q ' + tx(18, -30) + ' ' + tx(8, -20) + '" fill="none" stroke="' + col + '" stroke-width="2.5" stroke-linecap="round"/>' +
      '<circle cx="' + (x + 42 * fx * scale) + '" cy="' + (y + 14 * fy * scale) + '" r="' + (4 * scale) + '" fill="' + col + '"/>';
  }

  function buildOrnate(data, theme) {
    var name = String(data.matchName || "VS 决斗").trim();
    var boText = String(data.bo || "BO3").toUpperCase();
    var metaParts = [data.date, data.venue, data.stage, data.bo].filter(Boolean);
    var meta = metaParts.join(" · ");

    var leftCol = data.left.color ? deriveColor(data.left.color) : { main: theme.left.main, glow: theme.left.glow, dark: theme.left.dark };
    var rightCol = data.right.color ? deriveColor(data.right.color) : { main: theme.right.main, glow: theme.right.glow, dark: theme.right.dark };
    var leftImg = isAllowedImgURL(data.left.img) ? data.left.img : placeholderAvatar(String(data.left.name || "?")[0], leftCol);
    var rightImg = isAllowedImgURL(data.right.img) ? data.right.img : placeholderAvatar(String(data.right.name || "?")[0], rightCol);
    var leftName = String(data.left.name || "").trim();
    var rightName = String(data.right.name || "").trim();
    var leftTitle = typeof data.left.title === "string" ? data.left.title : "";
    var rightTitle = typeof data.right.title === "string" ? data.right.title : "";

    var GOLD = theme.accent;
    var parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080" role="img" aria-label="' + escapeXml(leftName + " vs " + rightName) + '">');

    /* defs:金属渐变 + 暗角滤镜 */
    parts.push('<defs>');
    parts.push('<linearGradient id="or-bg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + theme.bg.from + '"/><stop offset="1" stop-color="' + theme.bg.to + '"/></linearGradient>');
    parts.push('<linearGradient id="or-gold" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#fff3c4"/><stop offset="0.5" stop-color="' + GOLD + '"/><stop offset="1" stop-color="#8a6e1a"/></linearGradient>');
    parts.push('<linearGradient id="or-left" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + leftCol.main + '" stop-opacity="0.35"/><stop offset="1" stop-color="' + leftCol.dark + '" stop-opacity="0.1"/></linearGradient>');
    parts.push('<linearGradient id="or-right" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + rightCol.main + '" stop-opacity="0.35"/><stop offset="1" stop-color="' + rightCol.dark + '" stop-opacity="0.1"/></linearGradient>');
    parts.push('<radialGradient id="or-vig" cx="0.5" cy="0.5" r="0.7">' +
      '<stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.5"/></radialGradient>');
    parts.push('<filter id="or-glow"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>');
    parts.push('<clipPath id="or-clip-l"><circle cx="430" cy="480" r="160"/></clipPath>');
    parts.push('<clipPath id="or-clip-r"><circle cx="1490" cy="480" r="160"/></clipPath>');
    parts.push('</defs>');

    /* 背景:暗底渐变 + 左右半场微光 + 中心装饰线 */
    parts.push('<rect width="1920" height="1080" fill="url(#or-bg)"/>');
    parts.push('<polygon points="0,0 960,0 960,1080 0,1080" fill="url(#or-left)"/>');
    parts.push('<polygon points="960,0 1920,0 1920,1080 960,1080" fill="url(#or-right)"/>');

    /* 中央装饰柱:竖线 + 菱形 + 上下花纹 */
    parts.push('<line x1="960" y1="80" x2="960" y2="1000" stroke="' + GOLD + '" stroke-width="1.5" opacity="0.4"/>');
    parts.push('<line x1="950" y1="80" x2="950" y2="1000" stroke="' + GOLD + '" stroke-width="0.8" opacity="0.2"/>');
    parts.push('<line x1="970" y1="80" x2="970" y2="1000" stroke="' + GOLD + '" stroke-width="0.8" opacity="0.2"/>');

    /* 顶部纹章:赛事名(衬线大写)+ 上方菱形 + 两侧渐变线 */
    parts.push('<polygon points="960,40 980,60 960,80 940,60" fill="url(#or-gold)"/>');
    parts.push('<line x1="500" y1="60" x2="930" y2="60" stroke="' + GOLD + '" stroke-width="1" opacity="0.5"/>');
    parts.push('<line x1="990" y1="60" x2="1420" y2="60" stroke="' + GOLD + '" stroke-width="1" opacity="0.5"/>');
    parts.push('<text x="960" y="128" text-anchor="middle" font-family=' + JSON.stringify(SERIF) + ' font-size="44" font-weight="700" letter-spacing="8" fill="url(#or-gold)" filter="url(#or-glow)">' + escapeXml(name) + '</text>');
    parts.push('<text x="960" y="164" text-anchor="middle" font-family=' + JSON.stringify(SERIF) + ' font-size="20" font-style="italic" letter-spacing="4" fill="' + GOLD + '" opacity="0.7">' + escapeXml(meta) + '</text>');

    /* 魔法阵:左右各一,环绕头像 */
    parts.push(magicCircle(430, 480, 230, leftCol.main, GOLD));
    parts.push(magicCircle(1490, 480, 230, rightCol.main, GOLD));

    /* 头像:圆形裁剪,金环 */
    parts.push('<circle cx="430" cy="480" r="164" fill="' + theme.bg.to + '" stroke="url(#or-gold)" stroke-width="5"/>');
    parts.push('<circle cx="1490" cy="480" r="164" fill="' + theme.bg.to + '" stroke="url(#or-gold)" stroke-width="5"/>');
    parts.push('<image href="' + escapeXml(leftImg) + '" x="270" y="320" width="320" height="320" preserveAspectRatio="xMidYMid slice" clip-path="url(#or-clip-l)"/>');
    parts.push('<image href="' + escapeXml(rightImg) + '" x="1330" y="320" width="320" height="320" preserveAspectRatio="xMidYMid slice" clip-path="url(#or-clip-r)"/>');

    /* 队标/ID:头像下方,纹章徽带 */
    var leftTag = String(data.left.tag || "").trim();
    var rightTag = String(data.right.tag || "").trim();
    if (leftTag) {
      var ltW = Math.max(120, leftTag.length * 16 + 40);
      parts.push('<rect x="' + (430 - ltW / 2) + '" y="730" width="' + ltW + '" height="40" rx="20" fill="' + leftCol.dark + '" stroke="' + GOLD + '" stroke-width="1.5"/>');
      parts.push('<text x="430" y="758" text-anchor="middle" font-family=' + JSON.stringify(SERIF) + ' font-size="20" letter-spacing="3" fill="' + GOLD + '">' + escapeXml(leftTag) + '</text>');
    }
    if (rightTag) {
      var rtW = Math.max(120, rightTag.length * 16 + 40);
      parts.push('<rect x="' + (1490 - rtW / 2) + '" y="730" width="' + rtW + '" height="40" rx="20" fill="' + rightCol.dark + '" stroke="' + GOLD + '" stroke-width="1.5"/>');
      parts.push('<text x="1490" y="758" text-anchor="middle" font-family=' + JSON.stringify(SERIF) + ' font-size="20" letter-spacing="3" fill="' + GOLD + '">' + escapeXml(rightTag) + '</text>');
    }

    /* 选手名:衬线大字,头像/徽带下方 */
    var nameFs = Math.min(72, Math.max(36, Math.floor(560 / Math.max(1, Math.max(leftName.length, rightName.length)))));
    parts.push('<text x="430" y="860" text-anchor="middle" font-family=' + JSON.stringify(SERIF) + ' font-size="' + nameFs + '" font-weight="700" fill="#fff" stroke="' + leftCol.dark + '" stroke-width="1" paint-order="stroke">' + escapeXml(leftName) + '</text>');
    parts.push('<text x="1490" y="860" text-anchor="middle" font-family=' + JSON.stringify(SERIF) + ' font-size="' + nameFs + '" font-weight="700" fill="#fff" stroke="' + rightCol.dark + '" stroke-width="1" paint-order="stroke">' + escapeXml(rightName) + '</text>');

    /* 垃圾话:名字下方,斜体 */
    if (leftTitle) {
      parts.push('<text x="430" y="910" text-anchor="middle" font-family=' + JSON.stringify(SERIF) + ' font-size="22" font-style="italic" fill="' + leftCol.glow + '">' + escapeXml(leftTitle) + '</text>');
    }
    if (rightTitle) {
      parts.push('<text x="1490" y="910" text-anchor="middle" font-family=' + JSON.stringify(SERIF) + ' font-size="22" font-style="italic" fill="' + rightCol.glow + '">' + escapeXml(rightTitle) + '</text>');
    }

    /* 中央 VS:纹章徽记(盾形+VS字) */
    parts.push('<g filter="url(#or-glow)">');
    /* 盾形 */
    parts.push('<path d="M 960 400 L 1030 430 L 1030 500 Q 1030 560 960 590 Q 890 560 890 500 L 890 430 Z" fill="' + theme.bg.to + '" stroke="url(#or-gold)" stroke-width="4"/>');
    parts.push('<path d="M 960 415 L 1018 440 L 1018 500 Q 1018 550 960 575 Q 902 550 902 500 L 902 440 Z" fill="none" stroke="' + GOLD + '" stroke-width="1" opacity="0.5"/>');
    parts.push('<text x="960" y="520" text-anchor="middle" font-family=' + JSON.stringify(SERIF) + ' font-size="64" font-weight="900" font-style="italic" fill="url(#or-gold)">VS</text>');
    /* 盾上方十字纹 */
    parts.push('<line x1="960" y1="375" x2="960" y2="395" stroke="' + GOLD + '" stroke-width="3"/>');
    parts.push('<line x1="948" y1="385" x2="972" y2="385" stroke="' + GOLD + '" stroke-width="3"/>');
    /* 盾下方装饰菱形链 */
    parts.push('<polygon points="960,610 972,625 960,640 948,625" fill="' + GOLD + '"/>');
    parts.push('<polygon points="960,648 968,658 960,668 952,658" fill="' + GOLD + '" opacity="0.6"/>');
    parts.push('</g>');

    /* 四角花纹装饰 */
    parts.push(cornerFlourish(80, 80, 1.2, GOLD, false, false));
    parts.push(cornerFlourish(1840, 80, 1.2, GOLD, true, false));
    parts.push(cornerFlourish(80, 1000, 1.2, GOLD, false, true));
    parts.push(cornerFlourish(1840, 1000, 1.2, GOLD, true, true));

    /* 底部 BO 徽记:左右两侧 */
    parts.push('<text x="200" y="1040" font-family=' + JSON.stringify(SERIF) + ' font-size="24" letter-spacing="3" fill="' + GOLD + '" opacity="0.7">' + escapeXml(boText) + '</text>');
    parts.push('<text x="1720" y="1040" text-anchor="end" font-family=' + JSON.stringify(SERIF) + ' font-size="24" letter-spacing="3" fill="' + GOLD + '" opacity="0.7">' + escapeXml(boText) + '</text>');

    /* 暗角 */
    parts.push('<rect width="1920" height="1080" fill="url(#or-vig)"/>');

    parts.push('</svg>');
    return parts.join("");
  }

  /* ==================== 赛博霓虹版式 ====================
   * 赛博朋克风:透视网格地面 + 霓虹描边 + 扫描线 + 故障色偏移。
   * OBS 直播时视觉效果最强——高对比荧光色对 + 动感透视线。 */

  var CYBER_MONO = '"Courier New", Courier, ui-monospace, Menlo, monospace';

  function buildCyber(data, theme) {
    var name = String(data.matchName || "NEON DUEL").trim();
    var boText = String(data.bo || "BO3").toUpperCase();
    var metaParts = [data.date, data.venue].filter(Boolean);
    var meta = metaParts.join(" / ") || "";

    var leftCol = data.left.color ? deriveColor(data.left.color) : { main: theme.left.main, glow: theme.left.glow, dark: theme.left.dark };
    var rightCol = data.right.color ? deriveColor(data.right.color) : { main: theme.right.main, glow: theme.right.glow, dark: theme.right.dark };
    var leftImg = isAllowedImgURL(data.left.img) ? data.left.img : placeholderAvatar(String(data.left.name || "?")[0], leftCol);
    var rightImg = isAllowedImgURL(data.right.img) ? data.right.img : placeholderAvatar(String(data.right.name || "?")[0], rightCol);
    var leftName = String(data.left.name || "").trim();
    var rightName = String(data.right.name || "").trim();
    var leftTitle = typeof data.left.title === "string" ? data.left.title : "";
    var rightTitle = typeof data.right.title === "string" ? data.right.title : "";
    var leftTag = String(data.left.tag || "").trim();
    var rightTag = String(data.right.tag || "").trim();

    var NEON = theme.accent;
    var parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080" role="img" aria-label="' + escapeXml(leftName + " vs " + rightName) + '">');

    /* defs:渐变 + 滤镜 + 图案 */
    parts.push('<defs>');
    parts.push('<linearGradient id="cy-bg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + theme.bg.from + '"/><stop offset="1" stop-color="' + theme.bg.to + '"/></linearGradient>');
    /* 地平线辉光 */
    parts.push('<linearGradient id="cy-horizon" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + NEON + '" stop-opacity="0.3"/><stop offset="1" stop-color="' + NEON + '" stop-opacity="0"/></linearGradient>');
    /* 扫描线 pattern */
    parts.push('<pattern id="cy-scan" width="6" height="6" patternUnits="userSpaceOnUse">' +
      '<rect width="6" height="3" fill="#000" opacity="0.15"/><rect y="3" width="6" height="3" fill="none"/></pattern>');
    /* 霓虹发光滤镜 */
    parts.push('<filter id="cy-neon" x="-20%" y="-20%" width="140%" height="140%">' +
      '<feGaussianBlur stdDeviation="8" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>');
    parts.push('<filter id="cy-neon-thin" x="-20%" y="-20%" width="140%" height="140%">' +
      '<feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>');
    parts.push('<clipPath id="cy-clip-l"><rect x="240" y="220" width="380" height="380"/></clipPath>');
    parts.push('<clipPath id="cy-clip-r"><rect x="1300" y="220" width="380" height="380"/></clipPath>');
    parts.push('</defs>');

    /* 背景 */
    parts.push('<rect width="1920" height="1080" fill="url(#cy-bg)"/>');

    /* 顶部氛围:渐变光晕(左紫右青) */
    parts.push('<ellipse cx="480" cy="100" rx="600" ry="250" fill="' + leftCol.main + '" opacity="0.08"/>');
    parts.push('<ellipse cx="1440" cy="100" rx="600" ry="250" fill="' + rightCol.main + '" opacity="0.08"/>');

    /* ===== 透视网格地面(下半,地平线在 y=650) ===== */
    var HORIZON = 650;
    /* 地平线光带 */
    parts.push('<rect x="0" y="' + (HORIZON - 3) + '" width="1920" height="6" fill="' + NEON + '" opacity="0.6" filter="url(#cy-neon-thin)"/>');
    parts.push('<rect x="0" y="' + HORIZON + '" width="1920" height="' + (1080 - HORIZON) + '" fill="url(#cy-horizon)"/>');
    /* 透视放射线(从消失点 960,HORIZON 向下发散) */
    parts.push('<g stroke="' + NEON + '" stroke-width="1" opacity="0.25">');
    for (var rx = -10; rx <= 10; rx++) {
      var bottomX = 960 + rx * 200;
      parts.push('<line x1="960" y1="' + HORIZON + '" x2="' + bottomX + '" y2="1080"/>');
    }
    parts.push('</g>');
    /* 横向网格线(透视间距:越来越密靠近地平线) */
    parts.push('<g stroke="' + NEON + '" stroke-width="1" opacity="0.2">');
    var gridYs = [680, 720, 775, 845, 930, 1030];
    for (var gi = 0; gi < gridYs.length; gi++) {
      parts.push('<line x1="0" y1="' + gridYs[gi] + '" x2="1920" y2="' + gridYs[gi] + '"/>');
    }
    parts.push('</g>');

    /* ===== 顶部 HUD:赛事名 + BO ===== */
    parts.push('<text x="960" y="70" text-anchor="middle" font-family=' + JSON.stringify(CYBER_MONO) + ' font-size="32" font-weight="700" letter-spacing="12" fill="' + NEON + '" filter="url(#cy-neon)">' + escapeXml(name.toUpperCase()) + '</text>');
    /* 装饰:两侧短横线 */
    parts.push('<line x1="600" y1="60" x2="750" y2="60" stroke="' + NEON + '" stroke-width="2" opacity="0.5"/>');
    parts.push('<line x1="1170" y1="60" x2="1320" y2="60" stroke="' + NEON + '" stroke-width="2" opacity="0.5"/>');
    /* BO 标签(故障双色偏移) */
    var boLabel = boText;
    parts.push('<text x="956" y="110" text-anchor="middle" font-family=' + JSON.stringify(CYBER_MONO) + ' font-size="24" letter-spacing="6" fill="' + leftCol.main + '" opacity="0.7">' + escapeXml(boLabel) + '</text>');
    parts.push('<text x="964" y="110" text-anchor="middle" font-family=' + JSON.stringify(CYBER_MONO) + ' font-size="24" letter-spacing="6" fill="' + rightCol.main + '" opacity="0.7">' + escapeXml(boLabel) + '</text>');
    parts.push('<text x="960" y="110" text-anchor="middle" font-family=' + JSON.stringify(CYBER_MONO) + ' font-size="24" font-weight="700" letter-spacing="6" fill="#fff">' + escapeXml(boLabel) + '</text>');
    if (meta) {
      parts.push('<text x="960" y="142" text-anchor="middle" font-family=' + JSON.stringify(CYBER_MONO) + ' font-size="16" letter-spacing="3" fill="#888">' + escapeXml(meta) + '</text>');
    }

    /* ===== 选手区:方形霓虹框头像 ===== */
    function cyberSide(cx, col, img, playerName, title, tag, clipId) {
      var sp = [];
      var AV = 380;
      var ax = cx - AV / 2, ay = 220;

      /* 霓虹方框:双线(外粗内细)+ 四角L型加粗 */
      sp.push('<rect x="' + (ax - 12) + '" y="' + (ay - 12) + '" width="' + (AV + 24) + '" height="' + (AV + 24) + '" fill="none" stroke="' + col.main + '" stroke-width="4" filter="url(#cy-neon)"/>');
      sp.push('<rect x="' + (ax - 4) + '" y="' + (ay - 4) + '" width="' + (AV + 8) + '" height="' + (AV + 8) + '" fill="none" stroke="' + col.glow + '" stroke-width="1" opacity="0.6"/>');
      /* 四角 L 型 */
      var L = 36, T = 6;
      sp.push('<path d="M ' + ax + ' ' + (ay + L) + ' L ' + ax + ' ' + ay + ' L ' + (ax + L) + ' ' + ay + '" fill="none" stroke="' + NEON + '" stroke-width="' + T + '" stroke-linecap="square" filter="url(#cy-neon-thin)"/>');
      sp.push('<path d="M ' + (ax + AV - L) + ' ' + ay + ' L ' + (ax + AV) + ' ' + ay + ' L ' + (ax + AV) + ' ' + (ay + L) + '" fill="none" stroke="' + NEON + '" stroke-width="' + T + '" stroke-linecap="square" filter="url(#cy-neon-thin)"/>');
      sp.push('<path d="M ' + (ax + AV) + ' ' + (ay + AV - L) + ' L ' + (ax + AV) + ' ' + (ay + AV) + ' L ' + (ax + AV - L) + ' ' + (ay + AV) + '" fill="none" stroke="' + NEON + '" stroke-width="' + T + '" stroke-linecap="square" filter="url(#cy-neon-thin)"/>');
      sp.push('<path d="M ' + (ax + L) + ' ' + (ay + AV) + ' L ' + ax + ' ' + (ay + AV) + ' L ' + ax + ' ' + (ay + AV - L) + '" fill="none" stroke="' + NEON + '" stroke-width="' + T + '" stroke-linecap="square" filter="url(#cy-neon-thin)"/>');

      /* 头像 */
      sp.push('<rect x="' + ax + '" y="' + ay + '" width="' + AV + '" height="' + AV + '" fill="' + theme.bg.to + '"/>');
      sp.push('<image href="' + escapeXml(img) + '" x="' + ax + '" y="' + ay + '" width="' + AV + '" height="' + AV + '" preserveAspectRatio="xMidYMid slice" clip-path="url(#' + clipId + ')" style="image-rendering:auto"/>');

      /* 队标/ID */
      if (tag) {
        var tagW = Math.max(100, tag.length * 14 + 24);
        sp.push('<rect x="' + (cx - tagW / 2) + '" y="' + (ay + AV + 24) + '" width="' + tagW + '" height="32" fill="' + col.dark + '" stroke="' + col.main + '" stroke-width="1.5"/>');
        sp.push('<text x="' + cx + '" y="' + (ay + AV + 46) + '" text-anchor="middle" font-family=' + JSON.stringify(CYBER_MONO) + ' font-size="18" letter-spacing="2" fill="' + NEON + '">' + escapeXml(tag.toUpperCase()) + '</text>');
      }

      /* 选手名:超大等宽 + 故障色偏移 */
      var nfs = Math.min(80, Math.max(36, Math.floor(600 / Math.max(1, playerName.length))));
      var nameY = ay + AV + 130;
      sp.push('<text x="' + (cx - 3) + '" y="' + nameY + '" text-anchor="middle" font-family=' + JSON.stringify(CYBER_MONO) + ' font-size="' + nfs + '" font-weight="700" letter-spacing="4" fill="' + col.main + '" opacity="0.5">' + escapeXml(playerName) + '</text>');
      sp.push('<text x="' + (cx + 3) + '" y="' + nameY + '" text-anchor="middle" font-family=' + JSON.stringify(CYBER_MONO) + ' font-size="' + nfs + '" font-weight="700" letter-spacing="4" fill="' + rightCol.main + '" opacity="0.5">' + escapeXml(playerName) + '</text>');
      sp.push('<text x="' + cx + '" y="' + nameY + '" text-anchor="middle" font-family=' + JSON.stringify(CYBER_MONO) + ' font-size="' + nfs + '" font-weight="700" letter-spacing="4" fill="#fff" filter="url(#cy-neon-thin)">' + escapeXml(playerName) + '</text>');

      /* 垃圾话 */
      if (title) {
        sp.push('<text x="' + cx + '" y="' + (nameY + 42) + '" text-anchor="middle" font-family=' + JSON.stringify(CYBER_MONO) + ' font-size="22" letter-spacing="2" fill="' + col.glow + '" opacity="0.8">' + escapeXml(title) + '</text>');
      }
      return sp.join("");
    }
    parts.push(cyberSide(430, leftCol, leftImg, leftName, leftTitle, leftTag, "cy-clip-l"));
    parts.push(cyberSide(1490, rightCol, rightImg, rightName, rightTitle, rightTag, "cy-clip-r"));

    /* ===== 中央 VS:大字霓虹 + 故障偏移 ===== */
    var vsX = 960, vsY = 470;
    /* 底层偏移(青) */
    parts.push('<text x="' + (vsX - 6) + '" y="' + vsY + '" text-anchor="middle" font-family="Impact, Arial Black, sans-serif" font-size="180" font-weight="900" font-style="italic" fill="' + leftCol.main + '" opacity="0.4">' + "VS" + '</text>');
    /* 底层偏移(品红) */
    parts.push('<text x="' + (vsX + 6) + '" y="' + (vsY + 4) + '" text-anchor="middle" font-family="Impact, Arial Black, sans-serif" font-size="180" font-weight="900" font-style="italic" fill="' + rightCol.main + '" opacity="0.4">' + "VS" + '</text>');
    /* 主层(白+霓虹滤镜) */
    parts.push('<text x="' + vsX + '" y="' + vsY + '" text-anchor="middle" font-family="Impact, Arial Black, sans-serif" font-size="180" font-weight="900" font-style="italic" fill="#fff" filter="url(#cy-neon)">VS</text>');
    /* 上下装饰线 */
    parts.push('<line x1="' + (vsX - 100) + '" y1="' + (vsY - 130) + '" x2="' + (vsX + 100) + '" y2="' + (vsY - 130) + '" stroke="' + NEON + '" stroke-width="2" filter="url(#cy-neon-thin)"/>');
    parts.push('<line x1="' + (vsX - 60) + '" y1="' + (vsY + 60) + '" x2="' + (vsX + 60) + '" y2="' + (vsY + 60) + '" stroke="' + NEON + '" stroke-width="2" filter="url(#cy-neon-thin)"/>');

    /* ===== 侧边装饰竖线(霓虹边框) ===== */
    parts.push('<line x1="30" y1="180" x2="30" y2="900" stroke="' + leftCol.main + '" stroke-width="3" filter="url(#cy-neon)" opacity="0.6"/>');
    parts.push('<line x1="1890" y1="180" x2="1890" y2="900" stroke="' + rightCol.main + '" stroke-width="3" filter="url(#cy-neon)" opacity="0.6"/>');
    /* 边线上的节点 */
    for (var ni = 0; ni < 5; ni++) {
      var ny = 200 + ni * 180;
      parts.push('<rect x="24" y="' + (ny - 6) + '" width="12" height="12" fill="' + leftCol.main + '" transform="rotate(45 30 ' + ny + ')"/>');
      parts.push('<rect x="1884" y="' + (ny - 6) + '" width="12" height="12" fill="' + rightCol.main + '" transform="rotate(45 1890 ' + ny + ')"/>');
    }

    /* ===== 底部 HUD:数据流条 ===== */
    parts.push('<rect x="0" y="1020" width="1920" height="60" fill="#000" opacity="0.7"/>');
    parts.push('<line x1="0" y1="1020" x2="1920" y2="1020" stroke="' + NEON + '" stroke-width="1" opacity="0.5"/>');
    /* 二进制装饰 */
    var binStr = "";
    for (var bi = 0; bi < 40; bi++) binStr += (bi % 3 === 0 ? "1" : "0");
    parts.push('<text x="60" y="1058" font-family=' + JSON.stringify(CYBER_MONO) + ' font-size="18" letter-spacing="4" fill="' + leftCol.main + '" opacity="0.3">' + binStr + '</text>');
    parts.push('<text x="1860" y="1058" text-anchor="end" font-family=' + JSON.stringify(CYBER_MONO) + ' font-size="18" letter-spacing="4" fill="' + rightCol.main + '" opacity="0.3">' + binStr + '</text>');
    /* 中央 LOGO 文字 */
    parts.push('<text x="960" y="1058" text-anchor="middle" font-family=' + JSON.stringify(CYBER_MONO) + ' font-size="20" font-weight="700" letter-spacing="8" fill="' + NEON + '" filter="url(#cy-neon-thin)">' + escapeXml(name.toUpperCase().slice(0, 12)) + '</text>');

    /* 扫描线覆盖 */
    parts.push('<rect width="1920" height="1080" fill="url(#cy-scan)"/>');

    parts.push('</svg>');
    return parts.join("");
  }

  window.VSPoster = {
    escapeXml: escapeXml,
    deriveColor: deriveColor,
    placeholderAvatar: placeholderAvatar,
    build: build,
    pixelText: pixelText,
    pixelTextWidth: pixelTextWidth
  };
})();
