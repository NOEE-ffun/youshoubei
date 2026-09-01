(function (root) {
  'use strict';

  /* md 渲染封装(docs 阅读页与后台编辑预览共用):marked.parse → DOMPurify.sanitize。
   * - 外链统一新窗口 + noopener(afterSanitize 钩子)
   * - 标题降一级:md h1 渲染为页面 h2——页头铁律 h1 由页头承担
   * 仅供浏览器(依赖 vendor 的 marked/DOMPurify 全局)。 */
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener');
    }
  });

  const renderer = new marked.Renderer();
  const origHeading = renderer.heading;
  renderer.heading = function (text, level) {
    return origHeading.call(this, text, Math.min(6, level + 1), arguments[2]);
  };

  function render(mdText) {
    const raw = marked.parse(String(mdText || ''), { renderer, breaks: true });
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  }

  root.MDRender = { render };
})(typeof self !== 'undefined' ? self : this);
