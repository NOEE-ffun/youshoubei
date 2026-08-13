# 选手头像功能设计

日期:2026-08-13
状态:已获用户批准

## 背景

赛程网站(8 人双败淘汰赛)的选手名单、对局卡片、卡组弹窗中,选手目前只有姓名,没有头像。本次为选手增加头像功能:支持上传图片,未上传时自动生成「首字母 + 彩色背景」占位头像。

## 数据模型

选手对象(`record.players[]`)新增字段:

```js
{
  id: 'p_xxx',
  name: '选手 1',
  avatar: null            // 新增:Blob(本地模式)/ 图片 URL(云端模式)/ null(未上传)
}
```

- 与卡组图片存储方式一致:本地模式存 `Blob`(IndexedDB 原生支持),云端模式存 Vercel Blob URL 字符串
- 旧数据无 `avatar` 字段 → 视为未上传,显示占位头像,无需数据迁移

## 显示

三处显示,共用同一套渲染逻辑(头像 HTML 生成函数放 `common.js`):

| 位置 | 尺寸 | 说明 |
|---|---|---|
| 选手名单 `roster-grid` | 48px 圆形 | 位于姓名输入框左侧 |
| 对局卡片 `match-card` 选手行 | 24px 圆形 | 位于姓名左侧 |
| 卡组弹窗 `deck-player` 标题 | 28px 圆形 | 位于选手姓名左侧 |

**占位头像**:无 `avatar` 时显示圆形色块 + 选手名首字符(白字)。背景色从预定义柔和色板(约 8 色,与现有 `--accent` 色系协调)中按选手 id 确定性选取——同一选手在任何位置颜色一致。

纯函数 `avatarColor(seed)` 放入 `bracket-model.js`(可测试),返回色板索引。

## 交互(选手名单内,悬停式)

- 头像容器悬停时显示操作按钮(交互与卡组图片的 `slot-actions` 一致):
  - 无头像:`上传` 按钮(点击触发隐藏 file input)
  - 有头像:`更换`、`删除` 两个小按钮
- 上传流程复用现有图片链路:
  1. `compressImage(file, 200)` 压缩并**中心裁切成 200×200 方形**(canvas 裁切后转 JPEG)
  2. 本地模式:结果 Blob 直接存入 `player.avatar`
  3. 云端模式:先 `uploadCloudImage(blob)` 得到 URL 再存入
  4. `save()` 持久化,`renderRoster()` 刷新
- 云端访客模式(`canEdit() === false`):隐藏所有操作按钮,头像只读
- `file input` 为隐藏元素,`accept="image/*"`,处理完清空 value 以便重复选择

## 存储与迁移

- `migrateLocalToCloud`(本机 → 云端)中补充:`player.avatar` 为 Blob 时先 `uploadCloudImage` 转为 URL,与背景图/卡组图片处理一致
- `ensureMatchDecks` 等既有迁移逻辑不涉及头像,无需改动

## 测试

- `test/bracket.test.js` 增加 `avatarColor` 断言:
  - 同一 seed 返回同一索引(确定性)
  - 返回索引在色板长度范围内
- 现有 10 组测试保持通过

## 范围外(YAGNI)

- 不做:裁剪拖拽 UI、多张头像、从 URL 粘贴、动图(GIF 动画)、头像文件独立删除接口(随选手删除)
- 上传即自动中心裁切方形,不做用户裁剪交互
