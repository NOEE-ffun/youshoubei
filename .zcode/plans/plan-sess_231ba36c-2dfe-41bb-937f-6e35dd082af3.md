# 网站加载性能优化实施计划

> 批准后第一步:将本计划落盘到 `docs/superpowers/plans/2026-08-17-site-load-optimization.md`,然后按任务逐个执行、逐个提交。执行顺序已确认:性能计划先行,美术改版在其后基于优化后的代码进行(不并行,避免 common.js 冲突)。

**Goal:** 消除右手杯网站首屏加载慢的四大主因——全站禁缓存、启动链路串行双请求(`/api/health`+`/api/data`)、OSS 图片无缓存头、大图最后加载。

**Architecture:** 保持"零依赖静态多页站 + Vercel Serverless + 阿里云 OSS"现状。全部原地修改:`vercel.json`、`server.js`、`api/oss.js`、`common.js`、四个 HTML。不引入打包器、不迁移架构、不加 npm 依赖(回填脚本复用已有 `ali-oss`)。

**Global Constraints:** CSP 与 `/api/*` 路由、载荷格式不变;UI 文案中文;每任务结束 `npm test` 必须全绿;浏览器侧改动无自动化测试覆盖,以步骤中的手动验证(命令+期望输出)代替,不可跳过;提交信息用 `perf:` 前缀。

---

### Task 1: vercel.json——函数区域改香港 + 静态资源缓存
**Files:** Modify `vercel.json`(整体替换)

用以下内容替换(`regions` 让 API 函数部署到 hkg1,邻近杭州 OSS,砍掉跨太平洋往返;资源规则放兜底规则之后,后匹配的生效):

```json
{
  "version": 2,
  "regions": ["hkg1"],
  "headers": [
    { "source": "/(.*)", "headers": [{ "key": "Cache-Control", "value": "no-cache" }] },
    { "source": "/(.*)\\.(js|css|svg)", "headers": [{ "key": "Cache-Control", "value": "public, max-age=300, stale-while-revalidate=604800" }] }
  ]
}
```

若部署报区域权限错误:删 `regions` 行,改在控制台 Settings→Functions→Region 选 Hong Kong。若资源头规则不生效(path-to-regexp 差异),拆成 `/(.*)\\.js`、`/(.*)\\.css`、`/(.*)\\.svg` 三条。
- 验证:`node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8'))"` → ok;部署后 `curl -sI https://<域名>/common.js | grep -i cache-control` → `public, max-age=300...`,`/index.html` 与 `/api/data` → `no-cache`(执行者无法部署时标注"待部署验证")。
- Commit: `perf: 函数区域改 hkg1,静态资源启用 5 分钟缓存+SWR`

### Task 2: server.js——本地服务器加 br/gzip 与缓存头
**Files:** Modify `server.js`

1. `const path = require('path');` 后加 `const zlib = require('zlib');`
2. `MIME` 常量后加:

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

3. `fs.readFile` 成功分支替换为:

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

- 验证:`node --check server.js`;`npm start` 后 `curl -sI -H 'Accept-Encoding: gzip' http://localhost:8000/common.js` → 含 `content-encoding: gzip` + `max-age=300`;`curl -s --compressed http://localhost:8000/common.js | head -c 13` → `(function ()`;`npm test`。
- Commit: `perf: 本地服务器按类型输出缓存头并支持 br/gzip 压缩`

### Task 3: OSS 图片缓存头——上传写入 + 存量回填脚本
**Files:** Modify `api/oss.js:44-51`;Create `scripts/backfill-oss-cache.js`

1. `uploadImageBuffer` 的 `client.put` headers 改为:

```js
    headers: {
      'Content-Type': contentType,
      /* key 是 UUID,内容不会变,可放心长缓存 */
      'Cache-Control': 'public, max-age=31536000, immutable'
    }
```

2. 新建 `scripts/backfill-oss-cache.js`(一次性脚本,环境变量读 OSS 配置,参数默认前缀 `images/`):

```js
'use strict';

/* 一次性回填脚本:为存量 OSS 图片对象补 Cache-Control 元数据。
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

- 验证:`node --check` 两个文件;`npm test`;实际回填需用户 OSS 密钥(拿不到时标注"待用户执行"并在交付说明给出命令),回填后 `curl -sI <图片URL> | grep -i cache-control` → 一年缓存。
- Commit: `perf: OSS 图片上传写入一年缓存头,并提供存量回填脚本`

### Task 4: common.js——砍掉 /api/health,单次请求完成探测+取数
**Files:** Modify `common.js`(`detectMode` 190-207、`init` 1533-1606)

1. 用 `probeCloud` 整体替换 `detectMode`:

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

2. `init()` 的 try 块开头(原 `mode = await detectMode();` 起到云端 catch 块尾)替换为:

```js
      const workspace = await probeCloud();
      if (workspace) {
        cloudWorkspace = normalizeWorkspace(workspace);
      } else {
        mode = 'local';
        await ensureFirstTournament();
      }
```

(删除其后的旧 `if (mode === 'local') { await ensureFirstTournament(); }` 重复块;`api/health.js` 文件保留但前端不再调用。)

- 验证:`node --check common.js && npm test`;本地打开页面,Network 面板确认**无 `/api/health` 请求**、本机模式数据正常。
- Commit: `perf: 合并模式探测与取数为单次 /api/data 请求`

### Task 5: common.js——workspace 本地 SWR 缓存(秒开+后台校新)
**Files:** Modify `common.js`

1. `cloudGetWorkspace` 前加入:

```js
  /* 云端数据是纯 JSON(图片为 URL 字符串),localStorage 可整体序列化;
   * 命中缓存先渲染秒开,超过 TTL 再后台校新 */
  const WORKSPACE_CACHE_KEY = 'ts:workspaceCache';
  const WORKSPACE_CACHE_TTL = 60000;

  function readWorkspaceCache() {
    try {
      const raw = localStorage.getItem(WORKSPACE_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.workspace && parsed.workspace.tournaments)
        || !Number.isFinite(parsed.savedAt)) return null;
      return parsed;
    } catch (error) {
      return null;
    }
  }

  function writeWorkspaceCache(workspace) {
    try {
      localStorage.setItem(WORKSPACE_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), workspace }));
    } catch (error) {
      /* 隐私模式/存储满:缓存写不进不影响主流程 */
    }
  }

  function setCloudWorkspace(workspace) {
    cloudWorkspace = workspace;
    writeWorkspaceCache(workspace);
  }

  async function revalidateWorkspaceQuietly() {
    try {
      const fresh = normalizeWorkspace(await cloudGetWorkspace());
      if (JSON.stringify(fresh) === JSON.stringify(cloudWorkspace)) {
        writeWorkspaceCache(fresh); /* 只刷新时间戳 */
        return;
      }
      setCloudWorkspace(fresh);
      await refreshApp();
      document.dispatchEvent(new CustomEvent('ts:changed'));
    } catch (error) {
      /* 后台校新失败:沿用现有数据 */
    }
  }
```

2. `init()` try 块开头(Task 4 形态)改为缓存优先:

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

3. 写路径 4 处赋值改用 `setCloudWorkspace(...)`:`cloudPutWorkspace` 成功后的 `cloudWorkspace = payload`、`storageDelete`/`storageDeletePlayer` 云端分支的 `cloudWorkspace = latest`、`migrateLocalToCloud` 的 `cloudWorkspace = workspace`。

- 验证:`node --check && npm test`;本地(本机模式)`localStorage.getItem('ts:workspaceCache')` 应为 null、功能正常。
- Commit: `perf: 云端 workspace 本地 SWR 缓存,页面跳转免全量重拉`

### Task 6: 四页 HTML 侧栏静态骨架(侧栏不再等 JS)
**Files:** Modify `index.html:21`、`schedule.html:21`、`players.html:21`、`library.html:21`、`common.js:1304`(renderSidebar)

> 注:静态标记基于**当前**设计。后续美术改版动到侧栏时,需同步更新四个 HTML 的静态标记与 `common.js` 的兜底渲染两处(计划已把该耦合降至一处函数+四处标记)。

1. 四页的 `<aside id="app-sidebar">` 替换为静态导航(与 `renderSidebar` 输出一致):

```html
  <aside id="app-sidebar" class="app-sidebar" aria-label="主导航">
    <nav class="side-nav" aria-label="主导航">
      <a class="side-link is-active" href="index.html" data-page="home" title="主页" aria-label="主页"><span class="side-icon" aria-hidden="true"><img class="icon" src="icons/home.svg" alt="主页" aria-hidden="true"></span></a>
      <a class="side-link" href="schedule.html" data-page="match" title="比赛" aria-label="比赛"><span class="side-icon" aria-hidden="true"><img class="icon" src="icons/emoji_events.svg" alt="比赛" aria-hidden="true"></span></a>
      <a class="side-link" href="players.html" data-page="players" title="选手库" aria-label="选手库"><span class="side-icon" aria-hidden="true"><img class="icon" src="icons/groups.svg" alt="选手库" aria-hidden="true"></span></a>
    </nav>
  </aside>
```

`is-active` 位置:index→主页链接;schedule→比赛链接;players→选手库链接;library→三条都不加。

2. `renderSidebar` 开头(`if (!placeholder) return;` 之后)加:

```js
    /* 页面自带静态导航骨架时不再重建,避免闪烁也省一次 innerHTML */
    if (placeholder.querySelector('.side-nav')) return;
```

- 验证:`npm test`;Slow 3G 节流下四页侧栏在数据加载完成前已可见、高亮正确(bracket.js:123 的重复调用变为无害空操作)。
- Commit: `perf: 侧栏导航静态化进 HTML,不再阻塞首屏`

### Task 7: 图片压缩改 WebP,背景上限 1920→1600
**Files:** Modify `common.js`(compressImage 484-487、compressAvatar 518-521、背景上传调用 874)

1. `compressImage` 的 `canvas.toBlob` 回调替换为(不支持 WebP 编码的浏览器回退 JPEG,type 判定天然覆盖旧 Safari 返回 PNG 的情况):

```js
        canvas.toBlob((blob) => {
          if (blob && blob.type === 'image/webp') { resolve(blob); return; }
          canvas.toBlob((fallback) => {
            if (fallback) resolve(fallback);
            else reject(new Error('图片压缩失败'));
          }, 'image/jpeg', quality || 0.85);
        }, 'image/webp', quality || 0.85);
```

2. `compressAvatar` 同样替换(质量参数固定 0.85)。
3. 设置弹窗背景上传:`compressImage(file, 1920)` → `compressImage(file, 1600, 0.8)`(deck-modal 已是 1600,不动)。

- 验证:`node --check && npm test`;浏览器上传背景后 Console `window.TournamentApp.current.background.type` → `"image/webp"`(旧 Safari 为 jpeg 亦通过);`api/upload.js` 扩展名映射已支持 webp,无需改。
- Commit: `perf: 图片压缩输出 WebP,背景上限降为 1600px/0.8`

### Task 8: 云端管理员写路径批量化 + schemaVersion 跳过迁移
**Files:** Modify `common.js:1456-1506`(refreshApp)

1. `refreshApp` 前加:`const SCHEMA_VERSION = 2;`
2. 迁移循环替换为(已是最新版本的记录只做 roster 轻量比较,跳过两次全量 stringify):

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

3. 脏记录写回替换为(云端合并为一次 GET+PUT,消除逐条写放大):

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

- 验证:`node --check && npm test`;本地首次加载触发一次迁移写回,第二次刷新后无写动作(比对 `updatedAt` 不变)、功能正常。
- Commit: `perf: 云端脏记录合并单次写库,记录加 schemaVersion 跳过重复迁移`

### Task 9: 终验
`npm test` 全绿;四页手工走查(侧栏即时可见、数据正常、设置/保存无报错);部署后执行 Task 1 的线上 curl 验证;提醒用户择机跑 OSS 回填脚本;云端模式回归:访客只读、管理员解锁/保存/删除、多标签页一致。

## 明确不在本计划内(未来工作)
esbuild 打包+minify;index.html 去掉 canvas-model.js(与打包一起做);阿里云 CDN/整体迁国内(依赖 ICP 备案);/api/data 服务端内存缓存;美术改版(另行规划,在本计划完成后基于新代码进行)。

## 已识别风险与对策
Vercel 资源头规则不匹配→拆三条规则;OSS copy REPLACE 清元数据→脚本先 head 重写 Content-Type 并重设公共读 ACL;Safari WebP 编码缺失→type 判定回退 JPEG;SWR 60 秒窗口他端修改延迟可见→后台校新兜底,可接受。