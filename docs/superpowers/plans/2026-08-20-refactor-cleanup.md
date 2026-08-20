# 稳健重构计划(屎山清理)

> **For agentic workers:** 按任务 T1→T18 顺序执行,每任务一次提交,提交前 `npm test` 必须全绿。

**Goal:** 清除约 760+ 行死代码、收敛多套重复实现、解除 bracket↔canvas-editor 循环依赖;行为零变化。

**Architecture:** 三阶段推进——阶段一纯删除(零风险)、阶段二机械替换收敛(低风险)、阶段三行为保持的解耦(中风险,需手工回归)。common.js 保持单文件。

**Tech Stack:** 无构建工具的浏览器 IIFE + Node http 服务;测试为 node:test 风格自制断言(`node test/*.js`、`node vs-poster/test/run-tests.mjs`)。

## 全局约束

- 行为零变化:UI 文案、DOM 结构、交互、API 契约保持
- 每个删除项动手前 grep 复验零引用
- 每任务结束 `npm test` 全绿;阶段结束手工冒烟:主页/赛程(编辑+比分+卡组)/选手库/海报(导出+OBS)/舞台页
- 提交信息:`refactor: ...`

## 任务清单

### 阶段一:死代码清理(约 -900 行)

- **T1 common.js**:删不可达的 renderPlayerLibrary/renderRosterEditor(依赖的 DOM id 不存在);删 sidebarHidden/setSidebarHidden/LS_SIDEBAR;TournamentUtils 移出 statusBadgeMarkup;TournamentApp 移除仅内部使用的挂载(migrateLocalToCloud/migrateCloudToLocal/openSettings/openManage/setActiveId/storageDelete/storageGetPlayers/isAdmin/uid,函数本体保留);修失效注释。
- **T2**:删 bracket-model.js(生产零引用,被 canvas-model 取代,AVATAR_COLORS 同名异值)+ test/bracket.test.js;package.json test 命令与 README 同步。
- **T3**:bracket.js 删 resetScores(612-623)、toggleEdit 及 common.js:1670 兜底 else-if、playerRow 未用第三参、未用 debounce;canvas-editor.js 删未绑定 onClick(407-412)、导出 deleteCard、未用 canEdit/errMsg。
- **T4**:deck-modal.js 删 readOnly 死链(唯一调用方 library.js 已删):readOnly 状态、canModify()、6 处分支。
- **T5**:state.js 删 loadRoster/saveRoster/packPayload/unpackPayload;run-tests.mjs 删对应测试段;api/poster-stage.js:37 过期注释修正。
- **T6**:styles.css 删九群死规则(~390 行):.brand/.main-nav、.page-wrap 系、.rules-sidebar 系、.roster-grid 系、.bracket-section 系、.toolbar .spacer、.card-actions、.is-paused、.edit-sidebar 系、.player-card-title*/.player-card-color*(103 行)。逐群 grep 复验。
- **T7**:vs-poster/css/style.css 删 .topbar 系、.theme-picker 系、#poster-app .theme-menu 系、.btn--primary、.kbd、.title-badge、.roster__del--armed(~150 行)。
- **T8**:.gitignore 加 .impeccable/.zcode/.superpowers 并 git rm --cached;删 vercel.json(迁移遗留);README 过期措辞修正。

### 阶段二:低风险收敛

- **T9 画布几何统一**:canvas-model.js 导出 CARD_WIDTH/CARD_HEIGHT/COL_GAP/ROW_GAP/PORT_Y/默认尺寸;bracket.js(10-13、270-272、302/409 字面量)与 canvas-editor.js(6-7、832 裸 280、833)改引用。
- **T10 api/ 公共化**:新建 api/helpers.js(readBody(req, maxBytes) + sendJson);data.js/upload.js/poster-stage.js 三份复制的 chunk 收集替换。
- **T11 common.js 内部去重**:compressImage/compressAvatar 参数化合一;IndexedDB 五连 → withStore;'ts:changed'/'ts:ready' 常量化(14 处裸写);typeof CanvasModel 守卫 9 处 → hasCanvasModel();pad 合一;quota 正则/文案常量化。
- **T12 vs-poster 测试接入**:package.json test 追加 `node vs-poster/test/run-tests.mjs`,先单独跑绿。
- **T13 小 bug**:migrateLocalToCloud 头像循环嵌错位(518-522)移出;probeCloud 无 AbortController 时 timer 泄漏;stage.js 重试上限 10 次;oss.js 客户端模块级复用。
- **T14 vs-poster 工具收敛**:app.js esc() 兜底删除直用 TournamentUtils.escapeHtml;notifyError 桥接简化;safeUrl 与 isAllowedURL 的 http: 策略差异加注释说明。

### 阶段三:关键解耦(行为保持)

- **T15 renderHeader 增量化**:buildHeaderSkeleton(一次构建+一次绑定)+ syncHeaderState(只更新标题/徽章/可见性);修掉海报页头控件被重置的 bug。
- **T16 bracket↔canvas-editor 单向化**:canvas-editor 8 处 window.BracketRender 反向调用改注入回调;bracket→CanvasEditor 14 方法收敛窄接口;hint/editing class 单方归属;跨文件 DOM 内联样式传参改显式参数。回归:拖拽/框选/连线/微调 + 增删卡/粘贴。
- **T17 弹窗拆分**:buildDialogs(240 行)拆 buildManageDialog/buildSettingsDialog;renderManageList(126 行)四组业务拆小函数。
- **T18 poster bindFormControls 拆分**:198 行拆 bindSideControls('left'|'right') + bindGlobalActions;两段式 els 初始化合并到 boot。

## 验证

每任务 npm test + grep 残留;阶段三手工回归;完成后五页面 + 云端模式总冒烟。
