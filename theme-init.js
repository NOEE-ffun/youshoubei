'use strict';

/* 主题预置:必须在样式表绘制前同步执行,把 data-theme 写到 <html>,
 * 暗色用户才不会先看到一帧浅色(FOUC)。
 * 显式选择存 localStorage 'ts:theme'('light' | 'dark'),未选择跟随系统。
 * 保持无依赖、同步、极小——在四个页面的 <head> 中位于 styles.css 之前引入。 */
(function () {
  var stored = null;
  try {
    stored = localStorage.getItem('ts:theme');
  } catch (error) {
    /* 隐私模式等存储不可用:仅跟随系统,本次会话生效 */
  }
  var prefersDark = false;
  try {
    prefersDark = window.matchMedia
      && window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (error) {
    /* 不支持 matchMedia 的环境按浅色处理 */
  }
  var theme = (stored === 'light' || stored === 'dark')
    ? stored
    : (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
})();
