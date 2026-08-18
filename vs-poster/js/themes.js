/**
 * 主题数据(单一数据源,驱动 SVG 海报生成)
 * 与 css/themes.css 的页面换肤变量保持同值
 * 字段契约:
 *   id, name,
 *   left/right: { main 主色, glow 辉光, dark 深色描边 },
 *   accent 点缀色, bg: { from, to } 背景渐变,
 *   vs: { from, to 徽章渐变, stroke 描边, glow 发光色 },
 *   particles: [c1, c2] 粒子色, grid: bool 是否强化网格
 */
(function () {
  "use strict";

  var THEMES = [
    {
      id: "red-blue",
      name: "红蓝宿敌",
      left:  { main: "#ff2d2d", glow: "#ff6b4a", dark: "#7a0e0e" },
      right: { main: "#1e6bff", glow: "#4db4ff", dark: "#0e2d7a" },
      accent: "#ffd23d",
      bg: { from: "#0b0b16", to: "#191428" },
      vs: { from: "#ffe27a", to: "#ff9d00", stroke: "#6b2400", glow: "#ffd23d" },
      particles: ["#ff6b4a", "#4db4ff"],
      grid: false
    },
    {
      id: "black-gold",
      name: "黑金暗夜",
      left:  { main: "#d4af37", glow: "#ffe68a", dark: "#5c4a12" },
      right: { main: "#c8ccd4", glow: "#ffffff", dark: "#3f4450" },
      accent: "#ffe68a",
      bg: { from: "#070707", to: "#1c1c1c" },
      vs: { from: "#fff3c4", to: "#b8860b", stroke: "#3a2c06", glow: "#ffe68a" },
      particles: ["#ffe68a", "#8f8f8f"],
      grid: false
    },
    {
      id: "neon",
      name: "霓虹赛博",
      left:  { main: "#ff00e5", glow: "#ff7af0", dark: "#4a0044" },
      right: { main: "#00e5ff", glow: "#7af7ff", dark: "#00384a" },
      accent: "#b7ff00",
      bg: { from: "#0a0418", to: "#170b33" },
      vs: { from: "#d6f7ff", to: "#5c6bff", stroke: "#14143d", glow: "#7af7ff" },
      particles: ["#ff7af0", "#7af7ff"],
      grid: true
    },
    /* 2026-08-12 配色调研新增:互补色对 + 80/20 主导,暗底高饱和 */
    {
      id: "ice-fire",
      name: "冰火对决",
      left:  { main: "#ff5a1f", glow: "#ff9d5c", dark: "#7a2400" },
      right: { main: "#00d0ff", glow: "#6ee7ff", dark: "#00527a" },
      accent: "#ffd23d",
      bg: { from: "#070d13", to: "#101c26" },
      vs: { from: "#fff0d6", to: "#ff7a1f", stroke: "#7a2400", glow: "#ff9d5c" },
      particles: ["#ff9d5c", "#6ee7ff"],
      grid: false
    },
    {
      id: "purple-gold",
      name: "紫金王朝",
      left:  { main: "#8a2be2", glow: "#c084fc", dark: "#3b0a6e" },
      right: { main: "#ffb800", glow: "#ffe27a", dark: "#7a5600" },
      accent: "#ffe27a",
      bg: { from: "#0d0818", to: "#1c1030" },
      vs: { from: "#fff3d6", to: "#d4a017", stroke: "#6e4a00", glow: "#ffd23d" },
      particles: ["#c084fc", "#ffd23d"],
      grid: false
    },
    {
      id: "toxic",
      name: "毒雾猎杀",
      left:  { main: "#00e676", glow: "#69f0ae", dark: "#003d1f" },
      right: { main: "#ff1744", glow: "#ff6b81", dark: "#66001a" },
      accent: "#b7ff00",
      bg: { from: "#060d08", to: "#0f1a10" },
      vs: { from: "#eaffd6", to: "#a6ff00", stroke: "#2b4a00", glow: "#b7ff00" },
      particles: ["#69f0ae", "#ff6b81"],
      grid: false
    },
    {
      id: "aurora",
      name: "极光幻境",
      left:  { main: "#00ffc8", glow: "#7dffea", dark: "#004d3d" },
      right: { main: "#7c4dff", glow: "#b39dff", dark: "#2e0a66" },
      accent: "#e8f6ff",
      bg: { from: "#061018", to: "#0e1c2e" },
      vs: { from: "#e8f6ff", to: "#7c4dff", stroke: "#1c0f4a", glow: "#b39dff" },
      particles: ["#7dffea", "#b39dff"],
      grid: true
    }
  ];

  // 按 id 取主题,缺省回退第一个
  THEMES.byId = function (id) {
    for (var i = 0; i < THEMES.length; i++) {
      if (THEMES[i].id === id) return THEMES[i];
    }
    return THEMES[0];
  };

  window.VSThemes = THEMES;
})();
