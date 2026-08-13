# 选手头像功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为赛程网站的选手增加头像:选手名单/对局卡片/卡组弹窗三处显示,无头像时自动生成「首字母 + 确定性配色」占位,管理员在选手名单内悬停上传/更换/删除。

**Architecture:** 纯函数 `avatarColor(seed)` 放入 `bracket-model.js`(node 可测);`compressAvatar`(方形裁切)与 `avatarMarkup`(头像 HTML)放入 `common.js`;`bracket.js` 负责选手名单交互与对局卡片显示,`deck-modal.js` 负责卡组弹窗显示;`styles.css` 追加头像样式;`migrateLocalToCloud` 补充 avatar 云端迁移。

**Tech Stack:** 原生 HTML/CSS/JS(无构建),IndexedDB 本地存储 + Vercel Blob 云端存储,node:assert 测试。工作目录:`youshoubei-dev/`(git 仓库),完成后同步至 `tournament-site/`。

## Global Constraints

- 代码风格:IIFE + `'use strict'`、中文注释、`escapeHtml` 转义所有用户输入
- 头像存储与卡组图片一致:本地模式存 `Blob`,云端模式存 URL 字符串,未上传为 `null`/`undefined`
- 云端访客模式(`canEdit() === false`)下不渲染任何头像操作按钮
- 头像裁切输出:200×200 JPEG,质量 0.85
- 不引入任何新依赖
- 每次任务结束时提交一次(中文提交信息),并保持两个目录文件一致

---

### Task 1: `avatarColor` 纯函数(TDD)

**Files:**
- Modify: `bracket-model.js`(文件末尾 export 前增加色板与函数)
- Test: `test/bracket.test.js`(文件末尾新增第 11 组断言)

**Interfaces:**
- Produces: `AVATAR_COLORS`(数组,8 个色值)、`avatarColor(seed: string) => string`(确定性返回色板中的颜色)
- Consumes: 无

- [ ] **Step 1: 写失败测试**

在 `test/bracket.test.js` 末尾(`console.log` 之前)追加:

```js
// 11. 头像占位色：确定性 + 在色板范围内
const { AVATAR_COLORS, avatarColor } = require('../bracket-model.js');
assert.equal(avatarColor('P1'), avatarColor('P1'), '同一选手颜色应稳定');
assert.ok(AVATAR_COLORS.includes(avatarColor('P1')), '颜色应来自色板');
assert.equal(AVATAR_COLORS.length, 8, '色板应有 8 色');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL,报 `avatarColor is not a function`

- [ ] **Step 3: 实现**

在 `bracket-model.js` 的 `getFormatLabel` 附近(纯函数区)追加:

```js
  /* 头像占位色板：柔和色系，与设计令牌协调 */
  const AVATAR_COLORS = [
    '#3563e9', '#7a5af8', '#0e9f6e', '#d97706',
    '#d64545', '#0e7490', '#be185d', '#4d7c0f'
  ];

  /* 按选手 id 确定性取色：同一选手任何位置颜色一致 */
  function avatarColor(seed) {
    let hash = 0;
    const str = String(seed || '');
    for (let i = 0; i < str.length; i += 1) {
      hash = (hash * 31 + str.charCodeAt(i)) | 0;
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  }
```

并在 `return {` 对象中追加 `AVATAR_COLORS, avatarColor`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS,"bracket-model 全部 11 组测试通过 ✓"

- [ ] **Step 5: 提交**

```bash
git add bracket-model.js test/bracket.test.js
git commit -m "头像占位色：avatarColor 确定性取色"
```

---

### Task 2: `compressAvatar` 与 `avatarMarkup` 公共工具

**Files:**
- Modify: `common.js`(`compressImage` 函数后追加 `compressAvatar`;`renderHeader` 前追加 `avatarMarkup`;`init` 的 `appInstance` 对象中追加 `compressAvatar`)

**Interfaces:**
- Consumes: `compressAvatar` 由 Task 3 的 roster 交互调用;`avatarMarkup` 由 Task 3/4 渲染调用
- Produces:
  - `compressAvatar(file: File) => Promise<Blob>`:中心裁切成 200×200 方形 JPEG
  - `avatarMarkup(player: {id, name, avatar}, sizeClass: 'avatar-lg'|'avatar-md'|'avatar-sm') => string`:返回头像 HTML;无头像时返回首字符占位(白字,背景 `avatarColor(player.id)`);有头像时返回 `<img>`
  - `TournamentApp.compressAvatar`(挂到 appInstance)

- [ ] **Step 1: 实现 `compressAvatar`**

在 `common.js` 的 `compressImage` 函数结束后追加:

```js
  /* 头像压缩：中心裁切成 200×200 方形后转 JPEG */
  function compressAvatar(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type || !file.type.startsWith('image/')) {
        reject(new Error('请选择图片文件'));
        return;
      }
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        const size = Math.min(image.naturalWidth, image.naturalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = 200;
        canvas.height = 200;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image,
          (image.naturalWidth - size) / 2,
          (image.naturalHeight - size) / 2,
          size, size,
          0, 0, 200, 200);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('图片压缩失败'));
        }, 'image/jpeg', 0.85);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('无法读取图片'));
      };
      image.src = url;
    });
  }
```

- [ ] **Step 2: 实现 `avatarMarkup`**

在 `common.js` 的 `applyBackground` 前追加:

```js
  /* 头像 HTML：有图显示图片，无图显示首字符占位（颜色按选手 id 确定性取） */
  function avatarMarkup(player, sizeClass) {
    const cls = 'avatar ' + sizeClass;
    if (player && player.avatar) {
      return '<img class="' + cls + '" src="' + blobUrl(player.avatar) + '"' +
        ' alt="' + escapeHtml(player.name || '') + ' 的头像">';
    }
    const initial = String((player && player.name) || '?').trim().charAt(0) || '?';
    const color = (typeof BracketModel !== 'undefined' && BracketModel.avatarColor)
      ? BracketModel.avatarColor(player ? player.id : '')
      : '#3563e9';
    return '<span class="' + cls + ' avatar-fallback" style="background:' + color + '">' +
      escapeHtml(initial) + '</span>';
  }
```

- [ ] **Step 3: 挂到 appInstance**

`init()` 中 `appInstance = {` 对象内 `compressImage,` 后追加 `compressAvatar,`。

- [ ] **Step 4: 浏览器冒烟验证**

Run: `npm start`,打开 `http://localhost:8000`
Expected: 页面正常加载无 JS 报错(头像未接入,无可见变化)

- [ ] **Step 5: 提交**

```bash
git add common.js
git commit -m "头像公共工具：compressAvatar 方形裁切与 avatarMarkup 渲染"
```

---

### Task 3: 选手名单头像与上传交互

**Files:**
- Modify: `bracket.js`(renderRoster、新增 bindRosterAvatars、init 中追加头像文件选择器)
- Modify: `styles.css`(:root 后追加头像样式段)

**Interfaces:**
- Consumes: `TournamentApp.compressAvatar`、`TournamentApp.uploadImage`(云端)、`TournamentApp.mode`、`canEdit()`、`avatarMarkup`、`BracketModel.avatarColor`
- Produces: roster 中每个选手显示 48px 圆形头像;悬停出现操作按钮(上传/更换/删除);删除头像置 `player.avatar = null`

- [ ] **Step 1: 追加头像样式**

`styles.css` 末尾追加:

```css
/* 头像 */
.avatar {
  display: inline-block;
  border-radius: 50%;
  object-fit: cover;
  flex: none;
  background: var(--surface-3);
}
.avatar-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-weight: 600;
  line-height: 1;
  user-select: none;
}
.avatar-lg { width: 48px; height: 48px; font-size: 1.25rem; }
.avatar-md { width: 28px; height: 28px; font-size: 0.8125rem; }
.avatar-sm { width: 24px; height: 24px; font-size: 0.6875rem; }
.roster-avatar {
  position: relative;
  display: flex;
  align-items: center;
}
.roster-avatar .avatar-actions {
  position: absolute;
  inset-inline-start: 50%;
  transform: translateX(-50%);
  top: -6px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s var(--ease);
}
.roster-avatar:hover .avatar-actions,
.roster-avatar:focus-within .avatar-actions {
  opacity: 1;
}
.avatar-action {
  font-size: 0.6875rem;
  padding: 2px 6px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  box-shadow: var(--shadow-sm);
}
.avatar-action.danger { color: var(--danger); }
```

- [ ] **Step 2: 修改 `renderRoster` 渲染头像区**

`bracket.js` 的 `renderRoster()` 中,把当前 roster-item 模板改为(在 index 后、input 前插入头像区,`editable` 变量 = `canEdit()`):

```js
    const editable = canEdit();
    grid.innerHTML = record.players.map((player, index) =>
      '<div class="roster-item">' +
      '<span class="roster-index">' + (index + 1) + '</span>' +
      '<div class="roster-avatar" data-avatar="' + player.id + '">' +
      avatarMarkup(player, 'avatar-lg') +
      (editable ? avatarActions(player) : '') +
      '</div>' +
      '<label class="visually-hidden" for="roster-name-' + player.id + '">选手 ' + (index + 1) + ' 姓名</label>' +
      '<input id="roster-name-' + player.id + '" value="' + escapeHtml(player.name) + '" autocomplete="off"' +
      (editable ? '' : ' disabled') + '>' +
      '</div>'
    ).join('');
```

其中 `avatarActions` 与 `avatarMarkup` 同文件定义:

```js
  function avatarActions(player) {
    const has = Boolean(player.avatar);
    return (
      '<span class="avatar-actions">' +
      '<button type="button" class="avatar-action" data-avatar-upload="' + player.id + '">' +
      (has ? '更换' : '上传') + '</button>' +
      (has
        ? '<button type="button" class="avatar-action danger" data-avatar-delete="' + player.id + '">删除</button>'
        : '') +
      '</span>'
    );
  }
```

- [ ] **Step 3: 绑定头像操作事件 + 隐藏文件选择器**

`bracket.js` 新增(在 `bindToolbar` 后):

```js
  /* 头像上传文件选择器（隐藏，页面级共用一个） */
  let avatarFileInput = null;
  let pendingAvatarId = null;

  function ensureAvatarFileInput() {
    if (avatarFileInput) return;
    avatarFileInput = document.createElement('input');
    avatarFileInput.type = 'file';
    avatarFileInput.accept = 'image/*';
    avatarFileInput.hidden = true;
    document.body.appendChild(avatarFileInput);
    avatarFileInput.addEventListener('change', async () => {
      const file = avatarFileInput.files && avatarFileInput.files[0];
      avatarFileInput.value = '';
      const playerId = pendingAvatarId;
      pendingAvatarId = null;
      if (!file || !playerId) return;
      const record = currentRecord();
      const player = record.players.find((p) => p.id === playerId);
      if (!player) return;
      try {
        const blob = await window.TournamentApp.compressAvatar(file);
        player.avatar = window.TournamentApp.mode === 'cloud'
          ? await window.TournamentApp.uploadImage(blob)
          : blob;
        await save();
        renderAll();
      } catch (error) {
        alert(error.message);
      }
    });
  }

  function bindRosterAvatars() {
    ensureAvatarFileInput();
    const grid = document.getElementById('roster-grid');
    grid.querySelectorAll('[data-avatar-upload]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!canEdit()) return;
        pendingAvatarId = btn.dataset.avatarUpload;
        avatarFileInput.click();
      });
    });
    grid.querySelectorAll('[data-avatar-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!canEdit()) return;
        const record = currentRecord();
        const player = record.players.find((p) => p.id === btn.dataset.avatarDelete);
        if (!player) return;
        player.avatar = null;
        await save();
        renderAll();
      });
    });
  }
```

- [ ] **Step 4: 在渲染后调用绑定**

`renderRoster()` 的 input 绑定代码(末尾 `});`)之后追加一行:`bindRosterAvatars();`

- [ ] **Step 5: 浏览器验证**

Run: `npm start`,打开页面:
- 无头像选手显示首字符彩色占位,悬停出现「上传」按钮
- 上传图片后显示 200×200 方形裁切头像,悬停出现「更换/删除」
- 删除后恢复占位
- 刷新页面数据保留(本地模式存 IndexedDB)

- [ ] **Step 6: 提交**

```bash
git add bracket.js styles.css
git commit -m "选手名单头像：悬停上传/更换/删除"
```

---

### Task 4: 对局卡片与卡组弹窗显示头像

**Files:**
- Modify: `bracket.js`(`playerRow` 函数)
- Modify: `deck-modal.js`(`playerColumn` 函数)

**Interfaces:**
- Consumes: `avatarMarkup`、`names` Map、match 的 `a`/`b` 选手 id、`record.players`

- [ ] **Step 1: 对局卡片头像**

`bracket.js` 的 `playerRow(match, side, names)` 中,构造 `name` 后追加:

```js
    const app = window.TournamentApp;
    const avatarPlayer = app && app.current
      ? app.current.players.find((p) => p.id === participant)
      : null;
```

并将返回值改为在姓名前插入 `avatarMarkup(avatarPlayer, 'avatar-sm')`:

```js
    return (
      '<div class="' + className + '">' +
      avatarMarkup(avatarPlayer, 'avatar-sm') +
      '<span class="player-name">' + escapeHtml(name) + '</span>' +
      '<span class="player-score">' + (score == null ? '' : score) + '</span>' +
      '</div>'
    );
```

同时给 `.match-player` 补充 flex 对齐(styles.css 追加):

```css
.match-player { display: flex; align-items: center; gap: 0.5rem; }
```

- [ ] **Step 2: 卡组弹窗头像**

`deck-modal.js` 的 `playerColumn(side, match, names)` 中,在 `<h3>` 前插入头像:

```js
    const avatarPlayer = record.players.find((p) => p.id === playerId);
    return (
      '<section class="deck-player" data-player="' + playerId + '">' +
      '<h3 class="deck-player-head">' +
      avatarMarkup(avatarPlayer, 'avatar-md') +
      '<span>' + escapeHtml(names.get(playerId) || '选手') + '</span>' +
      '</h3>' +
      decks.map((deck, deckIndex) => deckBlock(playerId, deck, deckIndex, editable)).join('') +
      '</section>'
    );
```

补充样式:

```css
.deck-player-head { display: flex; align-items: center; gap: 0.625rem; }
```

- [ ] **Step 3: 浏览器验证**

Run: `npm start`:
- 对局卡片上每位选手名字旁显示 24px 头像
- 卡组弹窗选手标题旁显示 28px 头像
- 未上传头像的选手显示首字符占位
- 上传/删除头像后,三处同步刷新(头像读同一 `player.avatar`)

- [ ] **Step 4: 提交**

```bash
git add bracket.js deck-modal.js styles.css
git commit -m "对局卡片与卡组弹窗显示选手头像"
```

---

### Task 5: 云端迁移、双目录同步与全量验证

**Files:**
- Modify: `common.js`(`migrateLocalToCloud` 中选手循环内)

**Interfaces:**
- Consumes: `uploadCloudImage`
- Produces: 云端 workspace 中所有选手 `avatar` 均为 URL 字符串

- [ ] **Step 1: 迁移补全**

`common.js` 的 `migrateLocalToCloud()` 中,`players.map` 复制后追加(在 `for (const player of copy.players) { delete player.decks; }` 之前):

```js
      for (const player of copy.players) {
        if (player.avatar && typeof player.avatar !== 'string') {
          player.avatar = await uploadCloudImage(player.avatar);
        }
      }
```

- [ ] **Step 2: 同步双目录并跑全量测试**

```bash
cp -r docs /Users/noee/Documents/YouShou_Cup_Web/tournament-site/docs 2>/dev/null; true
cd /Users/noee/Documents/YouShou_Cup_Web
for f in bracket-model.js common.js bracket.js deck-modal.js styles.css; do
  cp "youshoubei-dev/$f" "tournament-site/$f"
done
cmp -s youshoubei-dev/$f tournament-site/$f && echo OK
cd youshoubei-dev && npm test
```

Expected: 全部通过;`cmp` 无差异;`npm test` 输出「bracket-model 全部 11 组测试通过 ✓」

- [ ] **Step 3: 浏览器回归**

Run: `npm start`:
- 上传/更换/删除头像、刷新持久化
- 对局卡片/卡组弹窗头像显示
- 云端模式(部署后):访客不可见操作按钮

- [ ] **Step 4: 提交**

```bash
git add common.js
git commit -m "云端迁移：头像 Blob 转 URL"
```

- [ ] **Step 5: 推送**

`git push origin main`(GitDoc 若已自动推送则跳过;推送前确认本地领先远端的提交均为本次功能相关)

---

## Self-Review 记录

- **Spec 覆盖**:数据模型(avatar 字段,T1 不涉及/T3 写入)✓;三处显示(T3 名单、T4 卡片+弹窗)✓;占位色(T1+T2)✓;交互(T3)✓;方形裁切(T2)✓;云端迁移(T5)✓;测试(T1)✓;范围外项未纳入 ✓
- **占位符扫描**:无 TBD/TODO;每个步骤含实际代码
- **类型一致性**:`avatarMarkup(player, sizeClass)`、`compressAvatar(file)`、`avatarColor(seed)`、`avatar-lg/md/sm` 尺寸类名在 T2/T3/T4 中一致;`data-avatar-upload`/`data-avatar-delete` 属性名在 T3 内部一致
