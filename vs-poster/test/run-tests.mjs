/**
 * 零依赖单测:node test/run-tests.mjs
 * 用 node 内置 vm 加载经典 script(兼容 file:// 运行方式),只测纯函数部分。
 */
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 在沙箱中执行一个经典 script,返回全局对象 */
function loadScript(file, sandbox) {
  const code = fs.readFileSync(path.join(ROOT, file), "utf8");
  const box = sandbox || {};
  box.window = box;
  vm.createContext(box);
  vm.runInContext(code, box, { filename: file });
  return box;
}

const S = loadScript("js/themes.js");
loadScript("js/poster.js", S);
loadScript("js/upload.js", S);
loadScript("js/state.js", S); // 顶层无 DOM 依赖,payload 纯函数可测

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    console.error("  ✗ " + name);
    console.error("    " + (e && e.message ? e.message : e));
  }
}

console.log("\n[themes.js] 主题数据");
test("存在 7 个主题(3 基础 + 4 配色调研新增)", () => {
  assert.equal(S.VSThemes.length, 7);
});
test("主题 id 覆盖预期集合", () => {
  const ids = S.VSThemes.map((t) => t.id).sort();
  assert.equal(ids.join(","), ["aurora", "black-gold", "ice-fire", "neon", "purple-gold", "red-blue", "toxic"].join(","));
});
test("id 唯一且非空", () => {
  const ids = S.VSThemes.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  ids.forEach((id) => assert.ok(typeof id === "string" && id.length > 0));
});
test("每个主题字段完整且值合法", () => {
  for (const t of S.VSThemes) {
    assert.ok(t.name, "name 缺失: " + t.id);
    for (const side of ["left", "right"]) {
      for (const k of ["main", "glow", "dark"]) {
        assert.ok(/^#[0-9a-fA-F]{6}$/.test(t[side][k]), t.id + "." + side + "." + k + " 不是合法 hex: " + t[side][k]);
      }
    }
    assert.ok(/^#[0-9a-fA-F]{6}$/.test(t.accent), t.id + ".accent");
    assert.ok(/^#[0-9a-fA-F]{6}$/.test(t.bg.from) && /^#[0-9a-fA-F]{6}$/.test(t.bg.to), t.id + ".bg");
    for (const k of ["from", "to", "stroke", "glow"]) {
      assert.ok(/^#[0-9a-fA-F]{6}$/.test(t.vs[k]), t.id + ".vs." + k);
    }
    assert.equal(t.particles.length, 2, t.id + ".particles 长度");
    assert.equal(typeof t.grid, "boolean", t.id + ".grid");
  }
});
test("byId 查找与回退", () => {
  assert.equal(S.VSThemes.byId("neon").id, "neon");
  assert.equal(S.VSThemes.byId("不存在的").id, S.VSThemes[0].id);
});

console.log("\n[poster.js] SVG 构建");
const THEME = S.VSThemes[0];
const BASE_DATA = {
  matchName: "2026 电竞巅峰对决",
  stage: "总决赛", bo: "BO5", date: "2026-08-12", venue: "上海体育馆",
  left: { name: "烈焰", tag: "DK.FIRE", img: null },
  right: { name: "冰霜", tag: "ICE.BLIZZ", img: null },
};

test("escapeXml 全符号转义", () => {
  assert.equal(S.VSPoster.escapeXml(`<b>&"'`), "&lt;b&gt;&amp;&quot;&#39;");
});
test("escapeXml 普通文本不变", () => {
  assert.equal(S.VSPoster.escapeXml("烈焰 vs 冰霜"), "烈焰 vs 冰霜");
});
test("escapeXml 空值安全", () => {
  assert.equal(S.VSPoster.escapeXml(null), "");
  assert.equal(S.VSPoster.escapeXml(undefined), "");
});

test("占位头像为合法 data URL 且含首字符与主题色", () => {
  const url = S.VSPoster.placeholderAvatar("龙", THEME.left);
  assert.ok(url.startsWith("data:image/svg+xml"), "前缀不对");
  const decoded = decodeURIComponent(url);
  assert.ok(decoded.includes("龙"), "缺少首字符");
  assert.ok(decoded.includes(THEME.left.main), "缺少主题色");
});

test("build 输出基本结构", () => {
  const svg = S.VSPoster.build(BASE_DATA, THEME);
  assert.ok(svg.startsWith("<svg"), "不以 <svg 开头");
  assert.ok(svg.includes('viewBox="0 0 1920 1080"'), "viewBox 缺失");
  assert.ok(svg.includes("VERSUS"), "缺 VERSUS");
  assert.ok(svg.includes("clipPath"), "缺 clipPath");
  assert.ok(svg.includes("feGaussianBlur"), "缺滤镜");
  assert.ok(svg.includes("data:image/svg+xml"), "无头像时应含占位头像");
});

test("build 用户文本全部转义,防注入", () => {
  const evil = {
    matchName: `<img src=x onerror=alert(1)>`,
    stage: '总决赛"加引号', bo: "BO3", date: "", venue: "",
    left: { name: `<script>alert(1)</script>`, tag: "T&G", img: null },
    right: { name: "正常", tag: "", img: null },
  };
  const svg = S.VSPoster.build(evil, THEME);
  assert.ok(!svg.includes("<script>"), "出现了未转义的 <script>");
  assert.ok(!svg.includes("<img "), "出现了未转义的 <img");
  assert.ok(svg.includes("&lt;script&gt;"), "名字未转义");
  assert.ok(svg.includes("&amp;"), "& 未转义");
  assert.ok(svg.includes("&quot;"), "引号未转义");
});

test("build 有头像时内嵌 data URL 图片", () => {
  const withImg = JSON.parse(JSON.stringify(BASE_DATA));
  withImg.left.img = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  withImg.right.img = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  const svg = S.VSPoster.build(withImg, THEME);
  assert.ok(svg.includes("<image"), "缺 <image>");
  assert.ok(svg.includes("iVBORw0KGgo"), "data URL 未内嵌");
});

test("三个主题都能构建且输出长度合理", () => {
  for (const t of S.VSThemes) {
    const svg = S.VSPoster.build(BASE_DATA, t);
    assert.ok(svg.length > 4000, t.id + " 输出过短");
    assert.ok(svg.includes(t.accent), t.id + " 未使用主题点缀色");
  }
});

test("名字过长时字号自适应不溢出", () => {
  const long = JSON.parse(JSON.stringify(BASE_DATA));
  long.left.name = "超级无敌烈焰战神龙王降临2026";
  const svg = S.VSPoster.build(long, THEME);
  assert.ok(svg.includes('font-size="42"') || svg.includes('font-size="4'), "未降到最小字号");
});

test("空名字不渲染问号(占位头像的 ? 为编码 %3F,除外)", () => {
  const empty = JSON.parse(JSON.stringify(BASE_DATA));
  empty.left.name = "";
  empty.right.name = "";
  const svg = S.VSPoster.build(empty, THEME);
  const stripped = svg.replace(/data:image\/svg\+xml;[^"]+/g, ""); // 去掉 data URL
  assert.ok(!stripped.includes("?"), "名字区域不应出现 ?");
  assert.ok(svg.includes("%3F"), "占位头像应含编码后的 %3F");
});

console.log("\n[poster.js] ID 区队标图片");
test("有队标图时独立渲染图片(无胶囊)并替代文字,无图侧保持文字胶囊", () => {
  const withLogo = JSON.parse(JSON.stringify(BASE_DATA));
  withLogo.left.tagImg = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  withLogo.left.tagImgRatio = 2;
  const svg = S.VSPoster.build(withLogo, THEME);
  assert.ok(!svg.includes(">DK.FIRE<"), "有图时左侧 ID 文本应被替代");
  assert.ok(svg.includes(">ICE.BLIZZ<"), "无图侧应保持文字");
  assert.ok(svg.includes('preserveAspectRatio="xMidYMid meet"'), "队标图应等比缩放");
  assert.ok(svg.includes('href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="'), "队标 data URL 未内嵌");
  // 文字胶囊矩形(rx=27)只应存在于右侧:图片侧不再有胶囊
  assert.equal((svg.match(/rx="27"/g) || []).length, 1, "图片侧不应再有胶囊底板");
});
test("队标大小可调且按宽高比计算:默认高 56,超宽封顶宽 420 等比缩高", () => {
  const sized = JSON.parse(JSON.stringify(BASE_DATA));
  sized.left.tagImg = "data:image/png;base64,AAA";
  sized.left.tagImgRatio = 2;
  sized.left.tagImgSize = 120;
  const svg1 = S.VSPoster.build(sized, THEME);
  assert.ok(svg1.includes('width="240.0"') && svg1.includes('height="120.0"'), "size=120 ratio=2 应为 240×120");

  const square = JSON.parse(JSON.stringify(BASE_DATA));
  square.right.tagImg = "data:image/png;base64,AAA";
  square.right.tagImgRatio = 1; // 未给 size → 默认高 56
  const svg2 = S.VSPoster.build(square, THEME);
  assert.ok(svg2.includes('width="56.0"') && svg2.includes('height="56.0"'), "方形队标默认 56×56: " + (svg2.match(/<image[^>]*preserveAspectRatio[^>]*/g) || []).join(" "));

  const wide = JSON.parse(JSON.stringify(BASE_DATA));
  wide.left.tagImg = "data:image/png;base64,AAA";
  wide.left.tagImgRatio = 10; // 超宽 wordmark,默认 56 → 宽 560 封顶 420
  const svg3 = S.VSPoster.build(wide, THEME);
  assert.ok(svg3.includes('width="420.0"'), "超宽队标宽应封顶 420");
  assert.ok(svg3.includes('height="42.0"'), "封顶后高应等比缩为 42");
});
test("大小/比例缺省回退与越界钳制,无队标时输出与旧版一致(纯文字胶囊)", () => {
  const fallback = JSON.parse(JSON.stringify(BASE_DATA));
  fallback.left.tagImg = "data:image/png;base64,AAA";
  fallback.left.tagImgRatio = null;
  const svg = S.VSPoster.build(fallback, THEME);
  assert.ok(svg.includes('width="56.0"'), "缺比例应按 1:1、缺大小按默认 56 处理");

  const clamp = JSON.parse(JSON.stringify(BASE_DATA));
  clamp.right.tagImg = "data:image/png;base64,AAA";
  clamp.right.tagImgRatio = 1;
  clamp.right.tagImgSize = 999; // 越界(OBS payload 可携带)→ 钳到 200
  const svg2 = S.VSPoster.build(clamp, THEME);
  assert.ok(svg2.includes('height="200.0"'), "大小越界应钳制到 200");

  const legacy = S.VSPoster.build(BASE_DATA, THEME);
  assert.ok(legacy.includes(">DK.FIRE<") && legacy.includes(">ICE.BLIZZ<"), "无队标数据时保持文字胶囊");
});

console.log("\n[poster.js] 赛前垃圾话 title(纯文本)");
test("title 文字渲染在名字下方并转义", () => {
  const t = JSON.parse(JSON.stringify(BASE_DATA));
  t.left.title = "今天你必输";
  const svg = S.VSPoster.build(t, THEME);
  assert.ok(svg.includes(">今天你必输<"), "赛前垃圾话应渲染");
});
test("title 文字转义防注入", () => {
  const t = JSON.parse(JSON.stringify(BASE_DATA));
  t.left.title = "<b>&";
  const svg = S.VSPoster.build(t, THEME);
  assert.ok(!svg.includes("<b>"), "赛前垃圾话不应出现未转义标签");
  assert.ok(svg.includes("&lt;b&gt;"), "赛前垃圾话应转义");
});
test("title 空/缺失不渲染", () => {
  const plain = S.VSPoster.build(BASE_DATA, THEME);
  assert.ok(!plain.includes("今天你必输"), "无 title 不应渲染");
  const t = JSON.parse(JSON.stringify(BASE_DATA));
  t.left.title = "";
  const svg = S.VSPoster.build(t, THEME);
  assert.ok(!svg.includes('y="876"'), "空 title 不额外输出文字节点");
});

console.log("\n[upload.js] URL 白名单");
test("允许 http/https/data", () => {
  assert.equal(S.VSUpload.isAllowedURL("https://a.com/x.png"), true);
  assert.equal(S.VSUpload.isAllowedURL("http://a.com/x.png"), true);
  assert.equal(S.VSUpload.isAllowedURL("data:image/png;base64,AAA"), true);
  assert.equal(S.VSUpload.isAllowedURL("  https://b.com/y.jpg  "), true, "应先去空白");
  assert.equal(S.VSUpload.isAllowedURL("blob:http://localhost/abc"), true, "本地 Blob 头像/称号应放行");
});
test("拒绝危险 scheme", () => {
  assert.equal(S.VSUpload.isAllowedURL("javascript:alert(1)"), false);
  assert.equal(S.VSUpload.isAllowedURL("vbscript:msgbox(1)"), false);
  assert.equal(S.VSUpload.isAllowedURL("file:///etc/passwd"), false);
  assert.equal(S.VSUpload.isAllowedURL("data:text/html,<script>"), false, "非图片 data:");
  assert.equal(S.VSUpload.isAllowedURL(""), false);
});

console.log("\n[poster.js] 选手颜色");
function lumOf(hex) {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  const f = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

test("deriveColor 输出合法且亮度 glow > main > dark", () => {
  const c = S.VSPoster.deriveColor("#ff2d2d");
  for (const k of ["main", "glow", "dark"]) {
    assert.ok(/^#[0-9a-fA-F]{6}$/.test(c[k]), k + " 不是合法 hex: " + c[k]);
  }
  assert.ok(lumOf(c.glow) > lumOf(c.main), "glow 应比 main 亮");
  assert.ok(lumOf(c.main) > lumOf(c.dark), "main 应比 dark 亮");
});

test("build: 选手自定义色覆盖主题侧色,未设置回退主题", () => {
  const withColor = JSON.parse(JSON.stringify(BASE_DATA));
  withColor.left.color = "#ff00ff";
  withColor.right.color = null;
  const svg = S.VSPoster.build(withColor, THEME);
  const derived = S.VSPoster.deriveColor("#ff00ff");
  assert.ok(svg.includes("#ff00ff"), "左侧应使用选手主色");
  assert.ok(svg.includes(derived.glow), "左侧应使用选手辉光");
  assert.ok(svg.includes("%23ff00ff"), "左侧占位头像应使用选手色");
  assert.ok(svg.includes("%23" + THEME.right.main.slice(1)), "右侧未设色应回退主题色");
});

test("build: 半场背景渐变跟随选手色(背景色 bug 回归)", () => {
  const withColor = JSON.parse(JSON.stringify(BASE_DATA));
  withColor.left.color = "#ff00ff";
  withColor.right.color = "#00ff00";
  const svg = S.VSPoster.build(withColor, THEME);
  // gl 渐变应含选手色而非主题色
  const gl = svg.slice(svg.indexOf('id="gl"'), svg.indexOf('id="gl"') + 220);
  const gr = svg.slice(svg.indexOf('id="gr"'), svg.indexOf('id="gr"') + 220);
  assert.ok(gl.includes("#ff00ff"), "左侧半场渐变未跟随选手色: " + gl);
  assert.ok(!gl.includes(THEME.left.main), "左侧半场渐变仍为主题色");
  assert.ok(gr.includes("#00ff00"), "右侧半场渐变未跟随选手色");
  // 无自定义色时回退主题色
  const plain = S.VSPoster.build(BASE_DATA, THEME);
  const glPlain = plain.slice(plain.indexOf('id="gl"'), plain.indexOf('id="gl"') + 220);
  assert.ok(glPlain.includes(THEME.left.main), "无选手色时应回退主题色");
});

test("build: 无选手色时两侧默认主题色", () => {
  const svg = S.VSPoster.build(BASE_DATA, THEME);
  assert.ok(svg.includes("%23" + THEME.left.main.slice(1)), "左侧占位头像应为主题左色");
  assert.ok(svg.includes("%23" + THEME.right.main.slice(1)), "右侧占位头像应为主题右色");
});

console.log("\n[state.js] OBS payload");
test("packPayload/unpackPayload 往返一致", () => {
  const sample = { data: { matchName: "测试", left: { name: "A", img: "data:image/png;base64,AAA" }, right: { name: "B" } }, themeId: "ice-fire" };
  const packed = S.VSState.packPayload(sample);
  assert.ok(packed.length > 10, "payload 过短");
  const back = S.VSState.unpackPayload(packed);
  assert.equal(back.data.matchName, "测试");
  assert.equal(back.data.left.name, "A");
  assert.equal(back.data.left.img, "data:image/png;base64,AAA");
  assert.equal(back.themeId, "ice-fire");
});
test("unpackPayload 非法输入返回 null", () => {
  assert.equal(S.VSState.unpackPayload(""), null);
  assert.equal(S.VSState.unpackPayload("not json"), null);
  assert.equal(S.VSState.unpackPayload(encodeURIComponent(JSON.stringify({ foo: 1 }))), null);
  assert.equal(S.VSState.unpackPayload(encodeURIComponent(JSON.stringify({ data: null }))), null);
});

console.log("\n[app.js] 装配回归");

test("els 对象无重复键(防 stage 被海报容器覆盖的回归)", () => {
  const appSrc = fs.readFileSync(path.join(ROOT, "js/app.js"), "utf8");
  const m = appSrc.match(/var els = \{([\s\S]*?)\n  \};/);
  assert.ok(m, "未找到 els 对象字面量");
  const keys = [...m[1].matchAll(/^\s{4}(\w+):/gm)].map((k) => k[1]);
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepEqual(dup, [], "els 存在重复键: " + dup.join(", "));
  assert.ok(keys.includes("stage"), "els.stage(赛制 select)缺失");
});

test("stage 变更可到达渲染数据(通过 poster 单测路径)", () => {
  const svg = S.VSPoster.build(JSON.parse(JSON.stringify(BASE_DATA)), THEME);
  assert.ok(svg.includes("总决赛"), "poster 应渲染赛制");
  const changed = S.VSPoster.build({ ...BASE_DATA, stage: "半决赛" }, THEME);
  assert.ok(changed.includes("半决赛") && !changed.includes("总决赛 · BO5"), "换赛制后应渲染新值");
});

console.log(`\n结果:${passed} 通过,${failed} 失败`);
process.exit(failed ? 1 : 0);
