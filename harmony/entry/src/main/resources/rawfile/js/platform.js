// platform.js — 跨平台能力检测与适配层
// 把原本散落在 app.js / bridge.js 的「macOS 判断 / 滚轮缩放反转 / 默认保存目录」集中到此处，
// 作为全局 window.Platform 暴露，供其余脚本复用，避免平台逻辑重复与漂移。
(function (global) {
  'use strict';

  // 平台嗅探：优先 userAgentData（Chromium 新接口，含真实平台字符串），
  // 回退到 navigator.userAgent 正则；不使用已废弃的 navigator.platform。
  var hint = '';
  try {
    var uad = global.navigator && global.navigator.userAgentData;
    if (uad && uad.platform) hint = uad.platform;
  } catch (e) { /* 部分环境无 userAgentData，忽略 */ }
  if (!hint && global.navigator) hint = global.navigator.userAgent || '';

  var isMac = /Mac|iPhone|iPad|iPod/i.test(hint);
  var isWin = /Win/i.test(hint);

  // 路径分隔符：Windows 用反斜杠，其余用斜杠
  var pathSep = isWin ? '\\' : '/';

  // 滚轮/触摸板缩放方向：macOS 的 deltaY 与世界习惯相反，这里统一反转。
  // 返回可直接用于「> 0 ? 放大 : 缩小」判定的 deltaY。
  function invertWheelDelta(deltaY) {
    return isMac ? -deltaY : deltaY;
  }

  // 原生保存对话框的默认目录函数：macOS 优先「下载」，其它平台用「桌面」。
  // 返回 Tauri 的 path 函数（需 await），无可用函数时返回 null。
  function defaultSaveDirFn(tauri) {
    if (!tauri || !tauri.path) return null;
    if (isMac && typeof tauri.path.downloadDir === 'function') return tauri.path.downloadDir;
    if (typeof tauri.path.desktopDir === 'function') return tauri.path.desktopDir;
    return null;
  }

  global.Platform = {
    isMac: isMac,
    isWin: isWin,
    pathSep: pathSep,
    invertWheelDelta: invertWheelDelta,
    defaultSaveDirFn: defaultSaveDirFn
  };
})(typeof window !== 'undefined' ? window : this);
