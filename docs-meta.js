(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DocsMeta = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 官方文档分类常量(Node 校验与前端渲染共用一份,双端模式同 canvas-model.js)。
   * 数组顺序即分组展示顺序。 */
  const DOC_CATEGORIES = [
    { key: 'rules', label: '赛事规则' },
    { key: 'guide', label: '新手指南' },
    { key: 'notice', label: '公告' },
    { key: 'internal', label: '内部规程' }
  ];
  const DOC_CATEGORY_KEYS = DOC_CATEGORIES.map((c) => c.key);

  function docCategoryLabel(key) {
    const c = DOC_CATEGORIES.find((x) => x.key === key);
    return c ? c.label : String(key);
  }
  function docCategoryOrder(key) {
    return DOC_CATEGORY_KEYS.indexOf(key);
  }
  return { DOC_CATEGORIES, DOC_CATEGORY_KEYS, docCategoryLabel, docCategoryOrder };
});
