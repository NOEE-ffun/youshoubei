# 网站加载性能优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除右手杯网站首屏加载慢的四大主因——全站禁缓存、启动链路串行双请求(`/api/health`+`/api/data`)、OSS 图片无缓存头、大图最后加载。

**Architecture:** 保持"零依赖静态多页站 + Vercel Serverless + 阿里云 OSS"现状。全部原地修改:`vercel.json`、`server.js`、`api/oss.js`、`common.js`、四个 HTML。不引入打包器、不迁移架构、不加 npm 依赖(回填脚本复用已有 `ali-oss`)。执行顺序已确认:性能计划先行,美术改版在其后基于优化后的代码进行(不并行,避免 common.js 冲突)。

**Tech Stack:** 原生 JS(浏览器 IIFE + UMD)、Node http/zlib、Vercel Serverless、ali-oss(已有依赖)。

## Global Constraints

- 不新增任何运行时 npm 依赖(Task 3 的回填脚本复用已有 `ali-oss`)。
- 不引入构建/打包步骤;HTML 仍直接引用源码 JS。
- CSP 头与 `/api/*` 路由、载荷格式保持不变。
- 所有 UI 文案保持中文;代码注释风格与现有文件一致(说明"为什么"的中文注释)。
- 每个任务结束时 `npm test`(3 个 node 测试)必须全绿——浏览器侧改动没有自动化测试覆盖,步骤中的手动验证(命令 + 期望输出)代替 TDD 红绿循环,不可跳过。
- 提交信息用 `perf:` 前缀,一次任务一提交。

## 背景速览(执行者需要的最小上下文)

- 站点是 JS 渲染一切的多页应用:HTML 里 `#app-header`/`#app-sidebar`/跑马灯/背景都是空容器,等 `common.js` 的 `init()` 走完 `detectMode()`(fetch `/api/health`)→ 云端模式再 `fetch('/api/data')` → `refreshApp()` → 派发 `ts:ready` 后才有内容。
- 云端数据在阿里云杭州 OSS 的 `data.json`,由 Vercel 函数(默认美国区域)读取;图片以 UUID 文件名上传到同一 bucket 的 `images/` 前缀,公共读。
- `vercel.json` 与 `server.js` 目前对所有路径一律 `Cache-Control: no-cache`。
- 本地模式数据存 IndexedDB;云端模式数据是纯 JSON(图片是 URL 字符串),可安全 `JSON.stringify`。

---

### Task 1: vercel.json——函数区域改香港 + 静态资源缓存

**Files:**
- Modify: `vercel.json`(整文件替换)

**Interfaces:**
- Consumes: 无。
- Produces: 部署后函数跑在 `hkg1`(邻近杭州 OSS);JS/CSS/SVG 响应头 `Cache-Control: public, max-age=300, stale-while-revalidate=604800`,HTML 与 `/api/*` 保持 `no-cache`。

- [ ] **Step 1: 用以下内容整体替换 `vercel.json`**

```json
{
  "version": 2,
  "regions": ["hkg1"],
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "no-cache" }
      ]
    },
    {
      "source": "/(.*)\\.(js|css|svg)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=300, stale-while-revalidate=604800" }
      ]
    }
  ]
}
```

要点:`regions` 让 `/api/*` 函数部署到香港(若部署报区域权限错误,删除 `regions` 行,改为 Vercel 控制台 → Settings → Functions → Region 选 Hong Kong);资源规则放在兜底规则**之后**,Vercel 对同名 header 后匹配的规则生效;`max-age=300` 是"改代码后最多 5 分钟生效"的折中,紧急修复时可临时加 `?v=` 查询参数。

- [ ] **Step 2: 本地校验 JSON 语法**

Run: `node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: 部署后线上验证(执行者若无法部署,标注"待部署验证"并继续)**

Run(替换为真实域名):
```bash
curl -sI https://<域名>/common.js | grep -i cache-control   # 期望: public, max-age=300, stale-while-revalidate=604800
curl -sI https://<域名>/index.html | grep -i cache-control  # 期望: no-cache
curl -sI https://<域名>/api/data | grep -i cache-control    # 期望: no-cache
```
若资源规则不生效(path-to-regexp 版本差异),把第二条 source 拆成三条:`"/(.*)\\.js"`、`"/(.*)\\.css"`、`"/(.*)\\.svg"`。

- [ ] **Step 4: Commit**

```bash
git add vercel.json
git commit -m "perf: 函数区域改 hkg1,静态资源启用 5 分钟缓存+SWR"
```

---

### Task 2: server.js——本地服务器加 br/gzip 与缓存头

**Files:**
- Modify: `server.js`(requires 区、响应区)

**Interfaces:**
- Consumes: 无。
- Produces: 本地服务器按 `Accept-Encoding` 返回 br/gzip;`cacheControlFor(filePath)` 与 `encodeBody(req, data)` 模块内函数;JS/CSS/SVG 与线上策略一致。

- [ ] **Step 1: 在 `server.js:7`(`const path = require('path');`)之后加一行**

```js
const zlib = require('zlib');
```

- [ ] **Step 2: 在 `MIME` 常量之后加两个函数**

```js
/* 静态资源允许短缓存 + SWR;页面与数据文件保持每次校验 */
function cacheControlFor(filePath) {
  return /\.(js|css|svg)$/i.test(filePath)
    ? 'public, max-age=300, stale-while-revalidate=604800'
    : 'no-cache';
}

/* 本站文件都是小文本,同步压缩足够;按 Accept-Encoding 优先 br */
function encodeBody(req, data) {
  const accept = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(accept)) return { body: zlib.brotliCompressSync(data), encoding: 'br' };
  if (/\bgzip\b/.test(accept)) return { body: zlib.gzipSync(data), encoding: 'gzip' };
  return { body: data, encoding: '' };
}
```

- [ ] **Step 3: 替换 `fs.readFile` 成功分支为**

```js
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControlFor(filePath),
      'X-Content-Type-Options': 'nosniff',
      'Vary': 'Accept-Encoding'
    };
    const { body, encoding } = encodeBody(req, data);
    if (encoding) headers['Content-Encoding'] = encoding;
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(body);
```

- [ ] **Step 4: 语法检查 + 本地验证**

```bash
node --check server.js
npm start &   # 默认端口 8000
sleep 1
curl -sI -H 'Accept-Encoding: gzip' http://localhost:8000/common.js | grep -iE 'content-encoding|cache-control'
# 期望: content-encoding: gzip 与 cache-control: public, max-age=300, stale-while-revalidate=604800
curl -sI -H 'Accept-Encoding: br' http://localhost:8000/index.html | grep -iE 'content-encoding|cache-control'
# 期望: content-encoding: br 与 cache-control: no-cache
curl -s --compressed http://localhost:8000/common.js | head -c 13
# 期望输出: (function ()
kill %1
```

- [ ] **Step 5: 回归测试 + Commit**

```bash
npm test
git add server.js
git commit -m "perf: 本地服务器按类型输出缓存头并支持 br/gzip 压缩"
```

---

### Task 3: OSS 图片缓存头——上传时写入 + 存量回填脚本

**Files:**
- Modify: `api/oss.js:44-51`(`uploadImageBuffer`)
- Create: `scripts/backfill-oss-cache.js`(新目录 `scripts/`)

**Interfaces:**
- Consumes: 无。
- Produces: 新上传图片对象带 `Cache-Control: public, max-age=31536000, immutable`;`scripts/backfill-oss-cache.js` 接受可选参数 `[前缀]`(默认 `images/`),环境变量 `OSS_REGION/OSS_BUCKET/OSS_ACCESS_KEY_ID/OSS_ACCESS_KEY_SECRET` 读配置。

- [ ] **Step 1: 修改 `api/oss.js` 的 `uploadImageBuffer` 的 `client.put`**

```js
  await client.put(key, buffer, {
    headers: {
      'Content-Type': contentType,
      /* key 是 UUID,内容不会变,可放心长缓存 */
      'Cache-Control': 'public, max-age=31536000, immutable'
    }
  });
```

- [ ] **Step 2: 新建 `scripts/backfill-oss-cache.js`**

```js
'use strict';

/* 一次性回填脚本:为存量 OSS 图片对象补 Cache-Control 元数据。
 * 用法:OSS_REGION=... OSS_BUCKET=... OSS_ACCESS_KEY_ID=... OSS_ACCESS_KEY_SECRET=... \
 *      node scripts/backfill-oss-cache.js [前缀,默认 images/]
 * 同名 copy + REPLACE 会清空原有元数据,因此 Content-Type 要先 head 出来一并重写;
 * copy 后 ACL 可能回落为私有,逐个重设公共读。 */
const OSS = require('ali-oss');

async function main() {
  const prefix = process.argv[2] || 'images/';
  const missing = ['OSS_REGION', 'OSS_BUCKET', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET']
    .filter((name) => !process.env[name]);
  if (missing.length) {
    console.error('缺少环境变量: ' + missing.join(', '));
    process.exit(1);
  }
  const client = new OSS({
    region: process.env.OSS_REGION,
    bucket: process.env.OSS_BUCKET,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    secure: true
  });

  let marker;
  let count = 0;
  do {
    const result = await client.list({ prefix, 'max-keys': 100, marker });
    for (const obj of result.objects || []) {
      if (obj.name.endsWith('/')) continue;
      const head = await client.head(obj.name);
      await client.copy(obj.name, obj.name, {
        headers: {
          'Content-Type': head.headers['content-type'] || 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'x-oss-metadata-directive': 'REPLACE'
        }
      });
      await client.putACL(obj.name, 'public-read');
      count += 1;
      console.log('done:', obj.name);
    }
    marker = result.nextMarker;
  } while (marker);
  console.log('完成,共处理 ' + count + ' 个对象');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 3: 语法检查**

Run: `node --check scripts/backfill-oss-cache.js && node --check api/oss.js`
Expected: 无输出(通过)。

- [ ] **Step 4: 回归测试 + Commit**

```bash
npm test
git add api/oss.js scripts/backfill-oss-cache.js
git commit -m "perf: OSS 图片上传写入一年缓存头,并提供存量回填脚本"
```

- [ ] **Step 5: 实际回填(需要 OSS 密钥;拿不到时标注"待用户执行"并在交付说明给出命令)**

```bash
OSS_REGION=oss-cn-hangzhou OSS_BUCKET=<bucket> OSS_ACCESS_KEY_ID=<id> OSS_ACCESS_KEY_SECRET=<secret> \
  node scripts/backfill-oss-cache.js images/
curl -sI 'https://<bucket>.oss-cn-hangzhou.aliyuncs.com/images/<任一现有文件>' | grep -i cache-control
# 期望: public, max-age=31536000, immutable
```

---

### Task 4: common.js——砍掉 /api/health,单次请求完成探测+取数

**Files:**
- Modify: `common.js`(`detectMode` 190-207、`init` 1533-1606)

**Interfaces:**
- Consumes: `apiErrorMessage`(已有)。
- Produces: `async function probeCloud()` → workspace 对象(云端)或 `null`(本机);失败且 5xx 时设置 `cloudFallbackReason`;`function normalizeWorkspace(workspace)` → 补齐缺省字段后的 workspace。`api/health.js` 保留但前端不再调用。

- [ ] **Step 1: 用 `probeCloud` + `normalizeWorkspace` 整体替换 `detectMode` 函数**

```js
  /* 一次请求同时完成模式探测与云端取数:拿到合法 workspace 即云端模式;
   * 404(未部署 API)/超时/网络错误 → 本机模式,省掉原先 /api/health 的串行往返 */
  async function probeCloud() {
    let timer = null;
    try {
      const hasAbort = typeof AbortController !== 'undefined';
      const controller = hasAbort ? new AbortController() : null;
      timer = setTimeout(() => controller && controller.abort(), 2000);
      const response = await fetch('/api/data', controller ? { signal: controller.signal } : {});
      clearTimeout(timer);
      timer = null;
      if (!response.ok) {
        if (response.status >= 500) {
          const message = await apiErrorMessage(response).catch(() => '');
          cloudFallbackReason = message ? ('云端数据读取失败:' + message) : '云端数据读取失败';
        }
        return null;
      }
      const workspace = await response.json();
      if (!workspace || !Array.isArray(workspace.tournaments)) return null;
      return workspace;
    } catch (error) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /* 补齐 workspace 缺省字段:players/tournaments 为空时造默认数据,activeId 兜底到第一场 */
  function normalizeWorkspace(workspace) {
    if (!workspace.players) workspace.players = [];
    if (!workspace.tournaments || !workspace.tournaments.length) {
      const list = workspace.players.length ? workspace.players : makeDefaultPlayers();
      workspace.players = list;
      const fresh = makeDefaultTournament('我的赛事', list.map((p) => p.id));
      workspace = { players: workspace.players, tournaments: [fresh], activeId: fresh.id };
    }
    if (!workspace.activeId || !workspace.tournaments.some((t) => t.id === workspace.activeId)) {
      workspace.activeId = workspace.tournaments[0].id;
    }
    return workspace;
  }
```

- [ ] **Step 2: `init()` 的 try 块开头(原 `mode = await detectMode();` 起到云端 catch 块尾)替换为**

```js
      const workspace = await probeCloud();
      if (workspace) {
        cloudWorkspace = normalizeWorkspace(workspace);
      } else {
        mode = 'local';
        await ensureFirstTournament();
      }
```

(删除其后的旧 `if (mode === 'local') { await ensureFirstTournament(); }` 重复块。)

- [ ] **Step 3: 语法检查 + 回归**

Run: `node --check common.js && npm test`

- [ ] **Step 4: 本地浏览器验证(本地服务器无 /api,应走本机模式)**

`npm start` 后打开 `http://localhost:8000/`,DevTools → Network:加载期间**无 `/api/health` 请求**、无 2 秒卡顿;页面数据正常(本机 IndexedDB)。`schedule.html` 复查。`kill %1`

- [ ] **Step 5: Commit**

```bash
git add common.js
git commit -m "perf: 合并模式探测与取数为单次 /api/data 请求"
```

---

### Task 5: common.js——workspace 本地 SWR 缓存(秒开+后台校新)

**Files:**
- Modify: `common.js`(缓存工具、`init`、`cloudPutWorkspace`、`storageDelete`、`storageDeletePlayer`、`migrateLocalToCloud`)

**Interfaces:**
- Consumes: `probeCloud`、`normalizeWorkspace`(Task 4)、`cloudGetWorkspace`(已有)。
- Produces: `readWorkspaceCache()` → `{ savedAt, workspace } | null`;`writeWorkspaceCache(workspace)`;`setCloudWorkspace(workspace)`(Task 8 复用);`revalidateWorkspaceQuietly()`;常量 `WORKSPACE_CACHE_TTL = 60000`、键 `'ts:workspaceCache'`(localStorage)。

- [ ] **Step 1: `cloudGetWorkspace` 之前加入缓存工具块(内容见批准稿,含 readWorkspaceCache/writeWorkspaceCache/setCloudWorkspace/revalidateWorkspaceQuietly 四函数与两常量)**

- [ ] **Step 2: `init()` try 块开头改为缓存优先**

```js
      const cached = readWorkspaceCache();
      if (cached) {
        mode = 'cloud';
        setCloudWorkspace(normalizeWorkspace(cached.workspace));
        appInstance.mode = mode;
        await refreshApp();
        document.dispatchEvent(new CustomEvent('ts:ready'));
        if (Date.now() - cached.savedAt > WORKSPACE_CACHE_TTL) revalidateWorkspaceQuietly();
        return;
      }
      const workspace = await probeCloud();
      if (workspace) {
        mode = 'cloud';
        setCloudWorkspace(normalizeWorkspace(workspace));
      } else {
        mode = 'local';
        await ensureFirstTournament();
      }
```

- [ ] **Step 3: 写路径 4 处赋值改用 `setCloudWorkspace(...)`**

`cloudPutWorkspace` 成功后的 `cloudWorkspace = payload;`、`storageDelete` 与 `storageDeletePlayer` 云端分支的 `cloudWorkspace = latest;`、`migrateLocalToCloud` 的 `cloudWorkspace = workspace;`。`admin-unlock`/`migrateCloudToLocal` 的读取型赋值保持原样。

- [ ] **Step 4: 语法检查 + 回归**

Run: `node --check common.js && npm test`

- [ ] **Step 5: 本地验证(本机模式不受影响)**

`npm start` 后 index/schedule 来回切换:无 `/api/data` 请求;Console `localStorage.getItem('ts:workspaceCache')` 为 `null`。`kill %1`

- [ ] **Step 6: Commit**

```bash
git add common.js
git commit -m "perf: 云端 workspace 本地 SWR 缓存,页面跳转免全量重拉"
```

---

### Task 6: 四页 HTML 侧栏静态骨架(侧栏不再等 JS)

**Files:**
- Modify: `index.html:21`、`schedule.html:21`、`players.html:21`、`library.html:21`、`common.js:1304`(`renderSidebar`)

**Interfaces:**
- Consumes: 无。
- Produces: 四页侧栏 HTML 即含完整导航(与 `renderSidebar` 输出一致,按页加 `is-active`);`renderSidebar` 检测到静态骨架直接返回(旧逻辑保留兜底)。

> 注:静态标记基于**当前**设计。后续美术改版动到侧栏时,需同步更新四个 HTML 的静态标记与 `common.js` 的兜底渲染两处。

- [ ] **Step 1: 替换四页 `<aside id="app-sidebar">` 行(index 的完整标记如下;schedule/players/library 同构,仅 `is-active` 位置不同:index→主页链接,schedule→比赛链接,players→选手库链接,library→都不加)**

```html
  <aside id="app-sidebar" class="app-sidebar" aria-label="主导航">
    <nav class="side-nav" aria-label="主导航">
      <a class="side-link is-active" href="index.html" data-page="home" title="主页" aria-label="主页"><span class="side-icon" aria-hidden="true"><img class="icon" src="icons/home.svg" alt="主页" aria-hidden="true"></span></a>
      <a class="side-link" href="schedule.html" data-page="match" title="比赛" aria-label="比赛"><span class="side-icon" aria-hidden="true"><img class="icon" src="icons/emoji_events.svg" alt="比赛" aria-hidden="true"></span></a>
      <a class="side-link" href="players.html" data-page="players" title="选手库" aria-label="选手库"><span class="side-icon" aria-hidden="true"><img class="icon" src="icons/groups.svg" alt="选手库" aria-hidden="true"></span></a>
    </nav>
  </aside>
```

- [ ] **Step 2: `renderSidebar` 开头(`if (!placeholder) return;` 之后)加**

```js
    /* 页面自带静态导航骨架时不再重建,避免闪烁也省一次 innerHTML */
    if (placeholder.querySelector('.side-nav')) return;
```

- [ ] **Step 3: 回归 + 本地验证**

`npm test`;Slow 3G 节流下四页侧栏在数据加载完成前已可见、高亮正确、Console 无报错。

- [ ] **Step 4: Commit**

```bash
git add index.html schedule.html players.html library.html common.js
git commit -m "perf: 侧栏导航静态化进 HTML,不再阻塞首屏"
```

---

### Task 7: 图片压缩改 WebP,背景上限 1920→1600

**Files:**
- Modify: `common.js`(`compressImage` 484-487、`compressAvatar` 518-521、背景上传调用 874)

**Interfaces:**
- Consumes: 无。
- Produces: `compressImage`/`compressAvatar` 优先产出 `image/webp` Blob,不支持 WebP 编码时回退 JPEG(判定:`blob.type !== 'image/webp'`);`api/upload.js` 已支持 webp,无需改。

- [ ] **Step 1: `compressImage` 的 `canvas.toBlob` 回调替换为**

```js
        canvas.toBlob((blob) => {
          if (blob && blob.type === 'image/webp') { resolve(blob); return; }
          /* 不支持 WebP 编码的浏览器回退 JPEG */
          canvas.toBlob((fallback) => {
            if (fallback) resolve(fallback);
            else reject(new Error('图片压缩失败'));
          }, 'image/jpeg', quality || 0.85);
        }, 'image/webp', quality || 0.85);
```

- [ ] **Step 2: `compressAvatar` 的 `canvas.toBlob` 回调同样替换(质量固定 0.85)**

- [ ] **Step 3: 设置弹窗背景上传调用 `compressImage(file, 1920)` → `compressImage(file, 1600, 0.8)`(deck-modal 已是 1600,不动)**

- [ ] **Step 4: 语法检查 + 回归 + 本地验证**

`node --check common.js && npm test`;浏览器上传背景后 Console `window.TournamentApp.current.background.type` → `"image/webp"`(旧 Safari 为 jpeg 亦通过)。

- [ ] **Step 5: Commit**

```bash
git add common.js
git commit -m "perf: 图片压缩输出 WebP,背景上限降为 1600px/0.8"
```

---

### Task 8: 云端管理员写路径批量化 + schemaVersion 跳过迁移

**Files:**
- Modify: `common.js:1456-1506`(`refreshApp`)

**Interfaces:**
- Consumes: `setCloudWorkspace`(Task 5)、`cloudPutWorkspace`/`cloudWorkspace`(已有)。
- Produces: 常量 `SCHEMA_VERSION = 2`;版本最新的记录跳过迁移与全量 stringify(只比较 roster);云端脏记录合并为一次 GET+PUT。

- [ ] **Step 1: `refreshApp` 前加 `const SCHEMA_VERSION = 2;`**

- [ ] **Step 2: 迁移循环替换为**

```js
    for (const record of all) {
      if (!record) continue;
      const needsMigration = record.schemaVersion !== SCHEMA_VERSION;
      const before = needsMigration ? JSON.stringify(record) : JSON.stringify(record.roster || null);
      if (needsMigration) {
        if (typeof CanvasModel !== 'undefined' && CanvasModel.migrateLegacyTournament) {
          CanvasModel.migrateLegacyTournament(record, playerMap);
        }
        if (typeof CanvasModel !== 'undefined' && CanvasModel.ensureCanvasDecks) {
          CanvasModel.ensureCanvasDecks(record);
        }
        record.schemaVersion = SCHEMA_VERSION;
      }
      if (typeof CanvasModel !== 'undefined' && CanvasModel.deriveRoster && record.canvas) {
        record.roster = CanvasModel.deriveRoster(record.canvas).filter((id) => playerMap.has(id));
      }
      const after = needsMigration ? JSON.stringify(record) : JSON.stringify(record.roster || null);
      if (before !== after) dirtyRecords.push(record);
    }
```

- [ ] **Step 3: 脏记录写回替换为**

```js
    // 只回写发生变化的比赛;云端模式合并为一次 GET+PUT,
    // 避免逐条 storagePut 各自先拉云端再覆盖(写放大)
    if (canWrite && dirtyRecords.length) {
      if (mode === 'cloud') {
        for (const record of dirtyRecords) {
          const index = cloudWorkspace.tournaments.findIndex((t) => t.id === record.id);
          if (index >= 0) cloudWorkspace.tournaments[index] = record;
          else cloudWorkspace.tournaments.push(record);
        }
        try {
          await cloudPutWorkspace(cloudWorkspace);
        } catch (error) {
          console.error('[refreshApp] 批量保存失败:', error);
        }
      } else {
        for (const record of dirtyRecords) {
          await storagePut(record);
        }
      }
    }
```

- [ ] **Step 4: 语法检查 + 回归 + 本地验证**

`node --check common.js && npm test`;本地首次加载触发一次迁移写回,第二次刷新后无写动作(比对 `updatedAt` 不变)、功能正常。

- [ ] **Step 5: Commit**

```bash
git add common.js
git commit -m "perf: 云端脏记录合并单次写库,记录加 schemaVersion 跳过重复迁移"
```

---

### Task 9: 终验

- [ ] `npm test` 全绿;四页手工走查(侧栏即时可见、数据正常、设置/保存无报错);部署后执行 Task 1 Step 3 线上 curl 验证;提醒用户择机跑 OSS 回填脚本;云端模式回归:访客只读、管理员解锁/保存/删除、多标签页一致。

## 明确不在本计划内(未来工作)

- esbuild 打包 + minify;
- index.html 去掉 canvas-model.js(与打包一起做);
- 阿里云 CDN / 整体迁国内(依赖 ICP 备案);
- /api/data 服务端内存缓存;
- 美术改版(本计划完成后基于新代码另行规划)。

## 已识别风险与对策

- Vercel 资源头规则不匹配 → 拆三条规则;
- OSS copy REPLACE 清元数据 → 脚本先 head 重写 Content-Type 并重设公共读 ACL;
- Safari WebP 编码缺失 → type 判定回退 JPEG;
- SWR 60 秒窗口他端修改延迟可见 → 后台校新兜底,可接受。
