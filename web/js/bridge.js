// 本地桥接层（浏览器预览 / 桌面打包共用）
// 为纯本地 / 桌面应用提供 app.js 所需的 EABridge 接口。
// - 浏览器预览：localStorage 草稿 + <a> 下载（无原生能力）。
// - Tauri 桌面端：自动检测 window.__TAURI__（需在 tauri.conf.json 开启 withGlobalTauri），
//   用原生保存对话框 / 文件夹选择器 / 打开文件夹，提供真实文件写出能力。
(function () {
  let lastError = null;
  let pasteImageOk = null;
  const STORE_PREFIX = 'ea_ann_';

  function storeKey(item) { return 'ea_ann_' + (item && item.id); }
  function loadStore(item) {
    try { return JSON.parse(localStorage.getItem(storeKey(item)) || '[]'); }
    catch (e) { return []; }
  }
  function saveStore(item, annotations) {
    try { localStorage.setItem(storeKey(item), JSON.stringify(annotations)); }
    catch (e) { console.warn('localStorage 写入失败', e); }
  }

  // 检测 Tauri 全局 API（tauri.conf.json 的 app.withGlobalTauri=true 时注入 window.__TAURI__）
  function getTauri() {
    try {
      if (typeof window !== 'undefined' && window.__TAURI__) return window.__TAURI__;
    } catch (e) {}
    return null;
  }
  const isTauri = !!getTauri();

  // data URL -> Uint8Array（供 Tauri fs.writeBinaryFile 直接写入）
  function dataURLToBytes(dataURL) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(dataURL);
    if (!m) throw new Error('图片数据格式不支持');
    const bin = atob(m[2]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  // 首次启动演示图（相对路径指向 index.html 同目录的 sample.svg）
  function getSelectedItem() {
    return Promise.resolve({
      id: 'mock-sample',
      name: 'sample.svg',
      fileURL: './sample.svg',
      filePath: null,
      metadataFilePath: null,
      tags: [],
      isLocal: false,
    });
  }

  function diag() {
    let localStorageOk = false;
    try { localStorage.setItem('__ea_diag__', '1'); localStorage.removeItem('__ea_diag__'); localStorageOk = true; } catch (e) {}
    const canvasOk = (function () { try { return !!(document.createElement('canvas').getContext && document.createElement('canvas').getContext('2d')); } catch (e) { return false; } })();
    let webpOk = false;
    try { webpOk = (document.createElement('canvas').toDataURL('image/webp').indexOf('data:image/webp') === 0); } catch (e) {}
    return {
      isTauri: isTauri,
      localStorageOk: localStorageOk,
      clipboardOk: !!(navigator.clipboard && typeof navigator.clipboard.write === 'function' && typeof window.ClipboardItem === 'function'),
      canvasOk: canvasOk,
      webpSupport: webpOk,
      userAgent: navigator.userAgent,
      lastError: lastError,
    };
  }

  function setLastError(msg) { lastError = msg; }
  function setPasteImageOk(v) { pasteImageOk = v; }
  function typeLabel(t) {
    return ({ rect: '框选', arrow: '箭头', free: '画笔', text: '文本', number: '编号', highlight: '高亮', mosaic: '马赛克', watermark: '水印', image: '图片' })[t] || t;
  }
  function clearCache() {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(STORE_PREFIX) === 0) keys.push(k);
      }
      keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) {} });
    } catch (e) {}
  }

  // ---- Tauri 桌面端原生能力（仅当 window.__TAURI__ 存在时可用）----

  // 用户取消保存时抛出的专用错误类型，便于调用方区分「取消」与「失败」
  class SaveCanceledError extends Error {
    constructor(msg) { super(msg || '已取消保存'); this.name = 'SaveCanceledError'; this.canceled = true; }
  }

  // 用原生保存对话框把 dataURL 写成 PNG；成功返回保存路径，
  // 用户取消抛 SaveCanceledError，其它真实失败上抛原错误，不再用 null 掩盖取消。
  async function saveDataUrl(dataURL, defaultName) {
    const t = getTauri();
    if (!t || !t.dialog || !t.fs) return null; // 非 Tauri 环境：调用方走浏览器下载兜底
    try {
      let defaultPath = defaultName || 'annotated.png';
      // 默认保存位置：macOS 用「下载」目录（~/Downloads），其它平台用「桌面」（见 platform.js）
      const dirFn = Platform.defaultSaveDirFn(t);
      if (dirFn) {
        try {
          const dir = await dirFn();
          if (dir) {
            defaultPath = (t.path.join && typeof t.path.join === 'function')
              ? await t.path.join(dir, defaultPath)
              : (dir.replace(/[\\/]$/, '') + Platform.pathSep + defaultPath);
          }
        } catch (e) { /* 取不到目录时退回纯文件名（系统会用上次目录） */ }
      }
      const filePath = await t.dialog.save({
        defaultPath,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      });
      if (!filePath) throw new SaveCanceledError(); // 用户在系统弹窗点了取消
      // Tauri v2 fs.writeFile 接受位置参数 writeFile(path, contents)，不是对象参数
      await t.fs.writeFile(filePath, dataURLToBytes(dataURL));
      return filePath;
    } catch (e) {
      // 取消类错误统一抛 SaveCanceledError，让调用方中止且不提示成功
      if (e && (e.canceled || e instanceof SaveCanceledError || (e.message && /cancel/i.test(e.message)))) {
        throw new SaveCanceledError();
      }
      console.warn('Tauri 保存文件失败', e);
      setLastError('saveDataUrl: ' + String((e && e.message) || e));
      throw e; // 真实失败（含 fs 作用域不允许）上抛，调用方显示「导出失败」
    }
  }

  // 把 dataURL 直接写入「用户已在面板选好的目录」，不再弹原生保存对话框。
  // 带去重：目录内已存在同名文件时追加 (1)/(2)…，避免直接覆盖。
  // 失败（目录无效/权限不足等）时上抛，由调用方回退到原生对话框或提示。
  async function saveDataUrlToDir(dataURL, dir, defaultName) {
    const t = getTauri();
    if (!t || !t.fs) return null;
    try {
      if (!dir) throw new Error('未指定导出目录');
      const base = defaultName || 'annotated.png';
      const join = (d, n) => (t.path && typeof t.path.join === 'function')
        ? t.path.join(d, n)
        : (d.replace(/[\\/]$/, '') + '\\' + n);
      let outPath = await join(dir, base);
      // 去重（fs.exists 不可用时退化为覆盖）
      if (t.fs.exists && typeof t.fs.exists === 'function') {
        try {
          const ext = (base.match(/\.[^.]+$/) || [''])[0];
          const stem = ext ? base.slice(0, -ext.length) : base;
          let n = 1; let cand = outPath;
          while (await t.fs.exists(cand)) {
            cand = await join(dir, stem + ' (' + n + ')' + ext);
            n++; if (n > 999) break;
          }
          outPath = cand;
        } catch (e) { /* exists 检查失败则保持原名（覆盖） */ }
      }
      await t.fs.writeFile(outPath, dataURLToBytes(dataURL));
      return outPath;
    } catch (e) {
      console.warn('Tauri 写入目录失败', e);
      setLastError('saveDataUrlToDir: ' + String((e && e.message) || e));
      throw e; // 上抛，调用方决定回退原生对话框或提示失败
    }
  }

  // 打开文件夹选择器，返回路径或 null
  async function pickFolder(current) {
    const t = getTauri();
    if (!t || !t.dialog) return null;
    try {
      const res = await t.dialog.open({ directory: true, multiple: false, defaultPath: current || '' });
      if (typeof res === 'string') return res;
      if (Array.isArray(res) && res.length) return res[0];
      return null;
    } catch (e) {
      console.warn('Tauri 选择文件夹失败', e);
      return null;
    }
  }

  // 用系统文件管理器打开指定路径（自定义 Rust 命令优先，shell 插件兜底）
  async function openPath(p) {
    const t = getTauri();
    console.log('[openPath] called with', p, 'tauri=', !!t, 'core=', !!(t && t.core), 'shell=', !!(t && t.shell));
    if (!t || !p) { console.log('[openPath] early return: no tauri or no path'); return false; }
    // 方案1：自定义 Tauri 命令（Rust 端直接调 explorer.exe / open / xdg-open）
    if (t.core && typeof t.core.invoke === 'function') {
      try { await t.core.invoke('open_in_system', { path: p }); console.log('[openPath] open_in_system OK'); return true; }
      catch (e) { console.warn('[openPath] open_in_system 失败', e); }
    } else {
      console.warn('[openPath] t.core.invoke 不可用');
    }
    // 方案2~4：shell 插件（可能不可用，保留作为最终兜底）
    if (t.shell && typeof t.shell.openPath === 'function') {
      try { await t.shell.openPath(p); return true; } catch (e) { console.warn('[openPath] shell.openPath 失败', e); }
    }
    if (t.shell && typeof t.shell.open === 'function') {
      try { await t.shell.open(p); return true; } catch (e) { console.warn('[openPath] shell.open 失败', e); }
    }
    try {
      if (t.core && typeof t.core.invoke === 'function') {
        await t.core.invoke('plugin:shell|open', { path: p, withStatus: false });
        return true;
      }
    } catch (e) { console.warn('[openPath] invoke plugin:shell|open 失败', e); }
    console.log('[openPath] all methods failed');
    return false;
  }

  window.EABridge = {
    get isTauri() { return isTauri; },
    whenReady: function () { return Promise.resolve(true); },
    getSelectedItem: getSelectedItem,
    loadAnnotations: function (item) { return loadStore(item); },
    saveLocal: function (item, annotations) { saveStore(item, annotations); },
    saveDataUrl: saveDataUrl,
    saveDataUrlToDir: saveDataUrlToDir,
    pickFolder: pickFolder,
    openPath: openPath,
    diag: diag,
    setLastError: setLastError,
    setPasteImageOk: setPasteImageOk,
    typeLabel: typeLabel,
    clearCache: clearCache,
  };
})();
