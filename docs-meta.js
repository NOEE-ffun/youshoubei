(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DocsMeta = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 官方文档分类(Node 校验与前端渲染共用一份,双端模式同 canvas-model.js)。
   * 2026-09-11 起分类为自定义文字(≤ DOC_CATEGORY_MAX 字),新建/编辑不再受
   * 固定清单约束;LEGACY_CATEGORIES 只为存量数据兼容——旧键在展示/分组/排序
   * 时折算为对应文字,编辑保存时也归一为文字(保存后旧键即消失),旧键不再新增。
   * 排序口径:旧分类按原固定序钉在前,自定义文字按中文 locale 排后。 */
  const LEGACY_CATEGORIES = [
    { key: 'rules', label: '赛事规则' },
    { key: 'guide', label: '新手指南' },
    { key: 'notice', label: '公告' },
    { key: 'internal', label: '内部规程' }
  ];
  const DOC_CATEGORY_MAX = 16;

  /* 展示文字:旧键折算为对应文字,其余 trim 原样 */
  function docCategoryLabel(category) {
    const v = String(category == null ? '' : category).trim();
    const c = LEGACY_CATEGORIES.find((x) => x.key === v);
    return c ? c.label : v;
  }

  /* 编辑入参归一(create/update 共用):trim + 旧键折算;空或超长返回 null */
  function normalizeDocCategory(category) {
    const label = docCategoryLabel(category);
    return label && label.length <= DOC_CATEGORY_MAX ? label : null;
  }

  /* 分组排序序:入参为展示文字;旧分类文字命中固定序,自定义一律排其后 */
  function docCategoryRank(label) {
    const i = LEGACY_CATEGORIES.findIndex((x) => x.label === label);
    return i < 0 ? LEGACY_CATEGORIES.length : i;
  }

  return { DOC_CATEGORY_MAX, docCategoryLabel, normalizeDocCategory, docCategoryRank };
});
