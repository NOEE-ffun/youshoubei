# 对阵图编辑器:框选与多选编辑(对标 CAD/Photoshop/Figma)

**决策默认值**(问题未答,采用推荐项,均可改):交叉命中;Ctrl+X 免确认(剪贴板有副本可找回,Del 仍确认);含方向键微调 + Ctrl+D 原位副本。撤销/重做**不做**(工程量大,建议后续单独立项)。

## 一、专业软件范式分析 → 适配决策

| 能力 | Photoshop | AutoCAD | Figma | 右手杯适配决策 |
|---|---|---|---|---|
| 框选 | 选框工具,交叉命中 | 窗口(完全包含)/交叉(按方向) | 空白拖拽,交叉命中 | select 工具空白处拖拽,**交叉命中**(卡片稀疏,一扫即中) |
| 加选 | Shift 加 / Alt 减 | Shift 加减 | Shift+拖 加选,Shift+点 切换 | 同 Figma:Shift+拖 并集,Shift+点 切换 |
| 移动 | 移动工具拖选区 | 夹点拖拽 | 拖选中任一对象整组移动 | 拖选中任一卡 → **整组网格步进移动**(±1 格吸附) |
| 复制/粘贴 | C/V 居中粘贴,J 原位 | COPYCLIP/PASTECLIP/原坐标 | C/V 偏移粘贴,D 原位副本 | C/V **偏移粘贴(+1,+1)保持组内相对位置**;Ctrl+D 原位副本 |
| 剪切 | Ctrl+X 无确认 | 无确认 | 无确认 | **Ctrl+X 免确认**(副本在剪贴板);Del 保持 uiConfirm |
| 粘贴保关系 | 图层跟随 | 原坐标 | 约束跟随 | **内部连线随 idMap 重映射**(集外引用保留——CAD/Figma 同语义) |
| 退出选择 | Ctrl+D/点空白 | Esc | Esc/点空白 | **Esc + 空白单击**清空;进行中的框选/拖拽 Esc 取消 |
| 微调 | 方向键 1px(Shift×10) | 方向键 | 方向键(Shift×10) | 方向键 1 格(Shift×3 格)——兼作 WCAG 2.2 拖拽替代(ui-ux-pro-max UX #103) |

保留现有 delete 工具(点击切换批量删)不动:它是框选的单击替代,也满足单指针无障碍要求。

## 二、实现设计(全部在 canvas-editor.js + 少量 bracket.js/styles.css)

### 1. 统一选择模型
- `batchSelected`(现仅 delete 工具生效)升级为**全工具生效的多选集合**:`selectedIds()` 改为始终返回 `[...batchSelected]`(delete 工具行为不变)。
- `selectedCardId` 保留为"最近操作锚"(卡片弹窗等用);`setTool` 不再清空选择(切工具保留,Esc/空白点清空)——对齐 Figma;`exit()` 清空不变。

### 2. 框选(空格按下接入点:onPointerDown L248 现在直接 return)
- select 工具按下空白(非 port/按钮):无 Shift 先清空集合,启动 `marqueeState`(记录起点 client 坐标 + shift)。
- 移动时:临时矩形 `div.marquee-rect` 挂 body(fixed、z-index 9998、pointer-events:none——参照现有 canvas-temp-line 挂法,**不放 board 内**,renderCanvas 会 innerHTML='' 整体重建)。
- 命中判定:矩形换算到 board 网格坐标(屏幕→网格换算照抄 onDblClick L339-342),遍历 `.canvas-card` 用 `offsetLeft/offsetTop/offsetWidth/offsetHeight` 做**矩形相交**测试;每 move 实时 highlightSelected(卡片几十张内,无性能问题)。
- 松开:位移 <4px 视为空白单击 → 清空选择(退出框选);否则定稿集合(Shift 为并集),移除矩形,refreshToolbarUI。
- 光标提示:select 工具下画布空白 `cursor: crosshair`(新增 `.tool-select` 类,setTool 一并 toggle)。

### 3. 整组移动(dragState 扩展)
- dragState 从单卡改为 `{ cards: [{id, originX, originY}], startX, startY, moved }`:按下**已选中**卡 → 整组;按下未选中卡 → 先清空再单选该卡(现行为);Shift+按下卡 → 仅切换选中,不启动拖拽。
- onPointerMove 的网格步进换算(`dx/(COL_GAP*scale)` 取整)套用到组内每卡,只改 `el.style.left/top`(不整板重渲染,沿 L293-297 先例);up 时 moved → 一次 saveCanvas + renderCanvas。

### 4. 多卡剪贴板(重构单卡 copiedCard)
- `copiedCards` 数组替换 `copiedCard`;Ctrl+C 深拷贝全部选中;Ctrl+V → `pasteCards()`:每卡新 id,idMap 覆盖**全部**被复制卡,slots 引用集内旧 id → 新 id(集外引用保留);整体偏移 (+1,+1) 保持相对位置;粘贴后自动选中新集合并 notify「已粘贴 N 张」,**不弹卡片设置窗**(现单卡粘贴会弹窗,多卡弹 N 个不合理)。
- Ctrl+X = 拷贝 + 静默删除(新 `removeCardsSilent` 复用 deleteCards 的连线/scores/matchDecks 清理但不 uiConfirm)。
- Ctrl+D = 拷贝选中 + 原位偏移 (+1,+1) 粘贴。
- 重映射逻辑抽成**纯函数放 canvas-model.js**:`cloneCardsForPaste(cards, dx, dy)` 返回带新 id 与重映射 slots 的数组——可进 node 单测(canvas-editor.js 是 IIFE 依赖 window,不能直接 require)。

### 5. 键盘(onKeyDown 增补)
- Esc:取消进行中框选/拖拽(还原),清空选择。
- 方向键:选中卡 ±1 格(Shift ±3 格),防抖 500ms 后 saveCanvas + renderCanvas(沿 roster 输入防抖先例);输入控件守卫已有。
- 保留:Ctrl+C/V(改多卡)、Delete/Backspace(deleteCards 含确认)。

### 6. 工具栏联动(bracket.js)
- `#edit-delete-selected-btn` 显隐从 `tool==='delete' && count>0` 放宽为 `count>0`(任何工具有选中即可删,提升可发现性);aria-label 带数量「删除选中 N 张卡片」。
- 工具栏不动结构,不新增按钮(框选是 select 工具的自然延伸)。

### 7. 样式(styles.css)
- `.marquee-rect`:1px dashed accent 边框 + accent-soft 8% 填充,fixed,pointer-events none。
- `.canvas-board.editing.tool-select` 空白 cursor: crosshair;选中描边沿用现有 accent 样式(delete 工具红 outline 保持)。
- 所有过渡用现有 `--dur-fast/--ease-out` 令牌;无新动画依赖。

## 三、文件清单
- `canvas-editor.js`:选择模型/框选/组拖拽/剪贴板/键盘(主战场)
- `canvas-model.js`:+`cloneCardsForPaste` 纯函数
- `bracket.js`:updateToolbarState 删除按钮显隐放宽
- `styles.css`:.marquee-rect / crosshair 光标
- `test/`:+ `clipboard-remap.test.js`(重映射纯函数:集内引用跟随、集外保留、id 全新);package.json test 串入

## 四、验证与交付
- `npm test` 全绿(含新增重映射测试)。
- 浏览器手动验收清单:框选/Shift 加选/空白单击退出/Esc 退出/整组拖动(吸附)/多卡复制粘贴(连线跟随)/剪切/Del(有确认)/方向键微调/Ctrl+D/单卡场景回归(原选中拖拽、Ctrl+C/V 单卡、delete 工具)。
- 在 main 上直接开发(现状即 main 直提)或建分支——**沿用当前习惯:main 小步提交**,每步一个 commit 可回退;完成后推送上线。

## 五、范围外(明确不做)
撤销/重做历史栈、对齐分布、旋转、框选尺寸手柄——建议撤销栈单独立项(需要快照/命令双轨设计,约等于本功能再加五成工作量)。