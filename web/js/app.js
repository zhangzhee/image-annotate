document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);

  function showFatal(msg) {
    let f = document.getElementById('fatal');
    if (!f) { f = document.createElement('div'); f.id = 'fatal'; document.body.appendChild(f); }
    f.style.display = 'block';
    f.textContent = '⚠️ 运行错误（请把这段截图反馈给我）：\n' + msg;
  }
  window.addEventListener('error', (e) => showFatal(((e && e.message) || '未知错误') + '\n' + ((e && e.error && e.error.stack) || '')));

  if (typeof Konva === 'undefined') {
    showFatal('Konva 未加载：js/lib/konva.min.js 不存在或加载被拦截。请确认文件存在。');
    return;
  }
  if (typeof EABridge === 'undefined') {
    showFatal('EABridge 未加载：bridge.js 加载失败。');
    return;
  }

  let STAGE_W = 760, STAGE_H = 540; // 运行时按容器尺寸动态更新

  // ---------- 状态 ----------
  let tool = 'select';
  let style = { stroke: '#ff4d4f', strokeWidth: 3, fontSize: 18, fill: 'rgba(255,77,79,0.18)', bg: '#ffe58f', bgOpacity: 1, radius: 20, mosaicStyle: 'pixel', frostStrength: 0.6, mosaicSize: 12,
    // 水印默认样式：文字水印、平铺、30° 斜角、30% 透明度、间距 80、无 Logo
    wmType: 'text', wmLayout: 'tile', wmAngle: 30, wmOpacity: 0.3, wmGap: 80, logoDataURL: null };
  let wmLastText = '水印'; // 记忆上次水印文字，新建文字水印时作为默认内容
  const wmLogos = {};      // logoDataURL -> HTMLImageElement 缓存（避免重复解码）
  let annotations = [];
  const nodes = {};
  const imgEls = {};            // src -> 已加载的 HTMLImageElement（粘贴图片缓存，避免重复解码）
  let selectedId = null;
  let pasteBuffer = null; // 复制粘贴：暂存被复制标注的深拷贝
  // 透明占位图：粘贴图片解码完成前的占位，避免 Konva.Image 无 image 报错
  const PLACEHOLDER_IMG = (function () { const c = document.createElement('canvas'); c.width = 1; c.height = 1; return c; })();
  let seqCounters = {};   // 各类型标注的序号计数（名称 = 功能 + 序号，如「马赛克1」）；编号 badge 文字也取自 seqCounters.number，保证二致
  let drawing = null;
  let dragTarget = null;
  let dragOffset = { x: 0, y: 0 };
  let imgDrag = null;         // 选择工具下拖动图片（仅当图片小于画板时可用）
  // 撤销/重做历史栈：history[i] = 某一时刻的完整状态快照，histIndex 指向当前所处状态。
  // 每次「提交」(snapshot) 会把当前实时状态写入栈尾并把 histIndex 移到末尾；
  // undo → histIndex 前移并还原；redo → histIndex 后移并还原。这是标准的线性历史模型，
  // 解决了旧实现（在变更后才记录当前状态，导致 undo 还原的还是当前状态=无效）的问题。
  let history = [];
  let histIndex = -1;
  // 底图 imgEl 仅在「载入新图」时变更（该路径会重置 history），故无需平行保存底图引用栈。
  let imgEl = null, displayedW = 0, displayedH = 0;
  let imgTainted = false;    // 图片是否跨域/不可读（被污染）：一旦 tainted，马赛克/磨砂改用装饰性回退贴图，避免导出时整张画布被污染
  let currentItem = null;
  // 图片信息（选择工具下显示的「图片信息」面板数据源）
  let imgInfo = { name: '—', format: '—', width: 0, height: 0, size: 0, dpi: null };
  // 裁剪 / 画板
  let crop = null;            // { x, y, w, h } 当前裁剪选框（画板坐标）
  let cropDrag = null;        // { mode:'draw'|'move'|'resize', handle, startX, startY, orig }
  let imgOffsetX = 0, imgOffsetY = 0; // 原图左上角在画板坐标系中的位置（裁剪后可能为负）
  let isCropped = false;      // 当前画布是否已被裁剪为自定义画板
  let boardColor = '#ffffff';
  let boardTransparent = true;
  const EDGE_PAD = 10; // 画板边缘留白：裁切后画板四周内移 10px，边缘框画在留白里，绝不遮挡图片内容
  const SNAP_THR = 6;  // 裁剪吸附阈值：选区边缘靠近图片边缘 6px 内自动吸附，防止留下白条
  // 导出分辨率倍率：1× = 原图分辨率（不放大不压缩）；其它倍率在此之上缩放。持久化到 localStorage。
  const RES_KEY = 'ea_res_scale';
  let exportScale = 1;
  try { const s = parseFloat(localStorage.getItem(RES_KEY)); if (s && s > 0) exportScale = s; } catch (e) {}
  // canvas toDataURL 最大输出尺寸（像素）；超出可能导致导出失败或空白，自动降级到此上限
  const MAX_EXPORT_DIM = 16384;

  // ---------- Konva ----------
  const _wrap = document.querySelector('.stage-wrap');
  // 让 stage 画布 DOM 始终填满 .stage-wrap（左右紧贴功能区），不再留黑边
  function syncStageDOM() {
    if (!_wrap) return;
    const w = Math.max(100, _wrap.clientWidth || window.innerWidth || 760);
    const h = Math.max(100, _wrap.clientHeight || window.innerHeight || 540);
    stage.width(w); stage.height(h);
  }
  // 将画板（STAGE_W × STAGE_H + EDGE_PAD）适配进容器，计算初始缩放+居中
  function fitBoardToView() {
    syncStageDOM();
    const p = edgePad();
    const bw = STAGE_W + 2 * p;   // 含留白的画板总宽
    const bh = STAGE_H + 2 * p;   // 含留白的画板总高
    const sw = stage.width();      // 容器/画布像素宽
    const sh = stage.height();     // 容器/画布像素高
    const s = Math.min(sw / bw, sh / bh);  // 适配缩放（≤1 表示缩小以完整显示）
    stage.scale({ x: s, y: s });
    stage.position({
      x: (sw - bw * s) / 2,
      y: (sh - bh * s) / 2,
    });
    stageScale = s;
    updateZoomLabel();
  }
  const stage = new Konva.Stage({ container: 'canvas', width: 800, height: 600 });
  syncStageDOM();
  const bgLayer = new Konva.Layer();
  const annLayer = new Konva.Layer();
  const maskLayer = new Konva.Layer({ listening: false }); // 画板外遮罩：裁切后盖住画板外内容（底图/矢量均不破坏）
  const cropLayer = new Konva.Layer({ listening: false, visible: false }); // 裁剪框 UI（纯视觉，命中检测用坐标计算）
  stage.add(bgLayer);
  stage.add(annLayer);
  stage.add(maskLayer);
  stage.add(cropLayer);
  // 画板边缘留白：裁切后画板四周内移 EDGE_PAD，给"边缘指示框"留出 10px 空间，
  // 使框永远画在图片内容之外（平移时也绝不遮挡图片）
  function edgePad() { return isCropped ? EDGE_PAD : 0; }
  function applyStageSize() {
    const p = edgePad();
    bgLayer.position({ x: p, y: p });
    annLayer.position({ x: p, y: p });
    maskLayer.position({ x: p, y: p });
    cropLayer.position({ x: p, y: p });
    stage.batchDraw();
  }
  applyStageSize();
  // Transformer 放在裁剪容器之外（不受裁切影响，始终可见）
  const tr = new Konva.Transformer({ rotateEnabled: false, borderStroke: '#4a9eff', anchorStroke: '#4a9eff', anchorSize: 8 });
  annLayer.add(tr);

  const mosaicTile = makeMosaicTile();
  function makeMosaicTile() {
    const c = document.createElement('canvas'); c.width = c.height = 12;
    const x = c.getContext('2d');
    for (let i = 0; i < 12; i += 3) for (let j = 0; j < 12; j += 3) {
      const v = 150 + Math.floor(Math.random() * 80);
      x.fillStyle = `rgb(${v},${v},${v})`; x.fillRect(i, j, 3, 3);
    }
    return c;
  }
  // 透明棋盘格贴图（仅编辑视图指示“透明区域”，导出时隐藏 → 真正透明 PNG）
  const checkerTile = makeCheckerTile();
  function makeCheckerTile() {
    const c = document.createElement('canvas'); c.width = c.height = 16;
    const x = c.getContext('2d');
    x.fillStyle = '#f0f3f8'; x.fillRect(0, 0, 16, 16);
    x.fillStyle = '#c2c9d6'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
    return c;
  }
  // 简单的可复现伪随机（mulberry32）：保证同一标注的“光斑”位置在重绘时稳定，不会每次拖动都乱跳
  function makePRNG(seed) {
    let t = (seed >>> 0) || 1;
    return function () {
      t += 0x6D2B79F5;
      let x = Math.imul(t ^ (t >>> 15), 1 | t);
      x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashSeed(str) {
    let h = 2166136261 >>> 0;
    str = String(str || 'x');
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  // 跨域回退（马赛克模式）：白色与中性灰相交的小格子，格子边长 = 马赛克大小（可调）
  function drawCheckerFallback(octx, w, h, cell) {
    const c = Math.max(4, Math.min(60, Math.round(cell || 12))); // 与马赛克大小滑块一致
    for (let y = 0; y < h; y += c) {
      for (let x = 0; x < w; x += c) {
        const white = ((Math.floor(x / c) + Math.floor(y / c)) % 2) === 0;
        octx.fillStyle = white ? '#ffffff' : '#9aa0aa'; // 白 / 中性灰 相交
        octx.fillRect(x, y, Math.min(c, w - x), Math.min(c, h - y));
      }
    }
  }
  // 跨域回退（磨砂玻璃模式）：中性灰底 + 随机参杂蓝色/黄色柔光斑，密度随磨砂强度（滑块）变化
  function drawFrostFallback(octx, w, h, strength, seed) {
    const fr = (strength != null) ? strength : 0.6; // 0~1
    octx.fillStyle = '#EDEDED'; // 浅灰底
    octx.fillRect(0, 0, w, h);
    const rng = makePRNG(hashSeed(seed));
    // 面积越大、强度越高 → 光斑越多；每 4000px² 约一个，再乘强度系数
    const count = Math.max(4, Math.round((w * h) / 4000 * (0.25 + fr)));
    for (let i = 0; i < count; i++) {
      const cx = rng() * w;
      const cy = rng() * h;
      const r = (6 + rng() * 16) * (0.6 + fr); // 光斑半径随强度增大
      const blue = rng() < 0.5;
      const rgb = blue ? '60,150,255' : '255,205,60'; // 蓝 / 黄
      const grad = octx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, 'rgba(' + rgb + ',0.55)');
      grad.addColorStop(1, 'rgba(' + rgb + ',0)');
      octx.fillStyle = grad;
      octx.beginPath();
      octx.arc(cx, cy, r, 0, Math.PI * 2);
      octx.fill();
    }
  }
  //   size：单个马赛克方块在“显示尺寸”下的边长(px)，越大方块越粗、越模糊
  // 生成“当前画板可见内容”的离屏合成图（1:1 画板像素），作为马赛克/磨砂的采样底图。
  // 包含：① 画板底色（透明棋盘格→白底 / 有色→该色）② 底图（按当前偏移/缩放）③ 所有已有标注（排除 skipId 自身）。
  // 这样在已有标注之上再次使用马赛克/磨砂时，会基于“包含这些标注的当前画面”做处理（而非只取底图）。
  function buildMosaicSource(skipId) {
    if (imgTainted) return null; // 跨域：交给回退贴图，不合成
    const cv = document.createElement('canvas');
    cv.width = STAGE_W; cv.height = STAGE_H;
    const ctx = cv.getContext('2d');
    // 1) 画板底色：透明棋盘格不采样棋盘本身→填白底；有色画板填该色（与画板融为一体）
    ctx.fillStyle = boardTransparent ? '#ffffff' : boardColor;
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);
    // 2) 底图（按当前偏移/缩放绘制）
    if (imgEl && displayedW > 0 && displayedH > 0) {
      try { ctx.drawImage(imgEl, imgOffsetX, imgOffsetY, displayedW, displayedH); } catch (e) {}
    }
    // 3) 现有标注（排除正在创建的马赛克 skipId；隐藏的标注不参与）
    annotations.forEach((a) => {
      if (a.id === skipId || a.visible === false) return;
      const n = nodes[a.id];
      if (!n) return;
      try {
        const rect = n.getClientRect({ relativeTo: stage });
        const nc = n.toCanvas({ pixelRatio: 1 });
        if (nc) ctx.drawImage(nc, rect.x, rect.y);
      } catch (e) {}
    });
    return cv;
  }

  function makeMosaicFill(g, size, skipId) {
    if (!g || g.width <= 0 || g.height <= 0) return null;
    const w = Math.max(1, Math.round(g.width));
    const h = Math.max(1, Math.round(g.height));
    // 跨域/不可读：白/灰相交小格子回退，格子大小由滑块控制
    if (imgTainted) {
      const out = document.createElement('canvas');
      out.width = w; out.height = h;
      const octx = out.getContext('2d');
      octx.imageSmoothingEnabled = false;
      drawCheckerFallback(octx, w, h, size || 12);
      return out;
    }
    const src = buildMosaicSource(skipId);
    if (!src) return null;
    const block = Math.max(2, size || 12);
    const cols = Math.max(2, Math.min(80, Math.round(w / block)));
    const rows = Math.max(2, Math.min(80, Math.round(h / block)));
    try {
      // 合成图即 1:1 画板分辨率，画板坐标 == 合成图像素坐标，直接采样（已含底图+所有标注）
      const sx = Math.max(0, g.x), sy = Math.max(0, g.y), sw = g.width, sh = g.height;
      const small = document.createElement('canvas');
      small.width = cols; small.height = rows;
      const sctx = small.getContext('2d');
      sctx.imageSmoothingEnabled = true;
      sctx.drawImage(src, sx, sy, sw, sh, 0, 0, cols, rows);
      const out = document.createElement('canvas');
      out.width = w; out.height = h;
      const octx = out.getContext('2d');
      octx.imageSmoothingEnabled = false;
      octx.fillStyle = boardTransparent ? '#ffffff' : boardColor;
      octx.fillRect(0, 0, w, h);
      octx.drawImage(small, 0, 0, cols, rows, 0, 0, w, h);
      return out;
    } catch (e) {
      return null;
    }
  }
  // 把马赛克贴图应用到矩形节点（有底图→真实采样；无底图→回退灰色平铺）
  function setMosaicFill(node, g, size, skipId) {
    const img = makeMosaicFill(g, size, skipId);
    if (img) {
      node.fillPatternImage(img);
      node.fillPatternRepeat('no-repeat');
      node.fillPatternX(0); node.fillPatternY(0);
      node.fillPatternScale(1);
      node.opacity(1); // 真实采样为不透明覆盖，观感更干净
    } else {
      node.fillPatternImage(mosaicTile);
      node.fillPatternRepeat('repeat');
      node.fillPatternX(0); node.fillPatternY(0);
      node.opacity(0.95);
    }
  }
  // 马赛克面板下方的“单一滑动条”随当前样式切换语义：
  //   pixel（马赛克）→ 标签=马赛克大小，范围 4~60（方块边长 px）
  //   frost（磨砂玻璃）→ 标签=磨砂强度，范围 0~100（%）
  // s 为当前生效的样式对象（全局 style 或某个标注的 style）
  // 滑块轨道填充：已滑过部分紫色(#8b5cf6)，未滑过部分灰色(#e2e4e9)
  // 用 background-image 避免与 CSS background 简写冲突；加 0.5% 过渡带消除硬切
  // （定义在此处，因 syncMosaicParamUI / syncStylePanel 均需提前调用）
  function fillSliderTrack(el) {
    const min = +el.min, max = +el.max, val = +el.value;
    const pct = Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100));
    el.style.backgroundImage = 'linear-gradient(to right, #8b5cf6 ' + pct + '%, #e2e4e9 ' + (pct + 0.5) + '%)';
  }

  // ---------- 图片信息面板 ----------
  function formatBytes(n) {
    if (!n || n <= 0) return '—';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)) + ' ' + u[i];
  }
  // 从图片二进制解析分辨率（DPI/PPi），优先 PNG(pHYs)、JPEG(EXIF)；解析失败返回 null
  function detectDPI(buf) {
    // 归一化：probeDPI 可能传入 ArrayBuffer（data URL 走 buf.buffer、fetch 走 r.arrayBuffer()），
    // 而下方按 buf[0]/buf[1] 索引是 Uint8Array 方式；ArrayBuffer 直接索引会得到 undefined，导致探测失败。
    if (buf instanceof ArrayBuffer) buf = new Uint8Array(buf);
    try {
      const dv = new DataView(buf);
      // PNG: 89 50 4E 47 0D 0A 1A 0A
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        let off = 8;
        while (off + 8 <= buf.byteLength) {
          const len = dv.getUint32(off);
          const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
          if (type === 'pHYs') {
            const ppuX = dv.getUint32(off + 8);
            const unit = buf[off + 15]; // 0=未知, 1=米
            if (unit === 1) return Math.round(ppuX * 0.0254); // 每米像素 → 每英寸
            if (ppuX > 0 && ppuX < 6000) return ppuX; // 某些编辑器把 DPI 直接存这里
            return null;
          }
          if (type === 'IEND') break;
          off += 12 + len;
        }
        return null;
      }
      // JPEG: FF D8 ...
      if (buf[0] === 0xff && buf[1] === 0xd8) {
        let off = 2;
        while (off + 4 <= buf.byteLength) {
          if (buf[off] !== 0xff) break;
          const marker = buf[off + 1];
          if (marker === 0xe1) { // APP1 (Exif)
            const start = off + 4;
            if (buf[start] === 0x45 && buf[start + 1] === 0x78 && buf[start + 2] === 0x69 && buf[start + 3] === 0x66) {
              // TIFF 头位于 "Exif\0\0" 之后
              const tiff = start + 6;
              const little = dv.getUint16(tiff) === 0x4949;
              const ifd0 = tiff + dv.getUint32(tiff + 4, little);
              const count = dv.getUint16(ifd0, little);
              let xRes = null, unit = 0;
              for (let i = 0; i < count; i++) {
                const e = ifd0 + 2 + i * 12;
                const tag = dv.getUint16(e, little);
                const type = dv.getUint16(e + 2, little);
                const valOff = (type === 3) ? e + 8 : tiff + dv.getUint32(e + 8, little);
                if (tag === 0x011a) xRes = dv.getUint32(valOff, little) / (dv.getUint32(valOff + 4, little) || 1);
                else if (tag === 0x0128) unit = dv.getUint16(e + 8, little);
              }
              if (xRes) {
                if (unit === 2) return Math.round(xRes); // 英寸
                if (unit === 3) return Math.round(xRes / 2.54); // 厘米
                return Math.round(xRes);
              }
            }
            break;
          }
          if (marker === 0xda) break; // 到达图像数据
          const len = dv.getUint16(off + 2);
          off += 2 + len;
        }
        return null;
      }
      return null;
    } catch (e) { return null; }
  }
  // 异步从 url/dataURL 取二进制并探测 DPI，结果写回 imgInfo.dpi 后刷新面板
  function probeDPI(url) {
    try {
      if (url && url.indexOf('data:') === 0) {
        const base64 = url.slice(url.indexOf(',') + 1);
        const bin = atob(base64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        imgInfo.dpi = detectDPI(buf);
        updateImageInfo();
      } else if (url) {
        fetch(url).then((r) => r.ok ? r.arrayBuffer() : null).then((ab) => {
          if (ab) { imgInfo.dpi = detectDPI(ab); updateImageInfo(); }
        }).catch(() => {});
      }
    } catch (e) { /* 忽略：DPI 探测失败不影响主流程 */ }
  }
  // 把 imgInfo + 实时状态（标注数量/画板尺寸）填充进图片信息面板
  function updateImageInfo() {
    $('iiName').textContent = imgInfo.name || '—';
    $('iiFormat').textContent = imgInfo.format || '—';
    $('iiDim').textContent = (imgInfo.width && imgInfo.height) ? (imgInfo.width + ' × ' + imgInfo.height + ' px') : '—';
    $('iiDpi').textContent = (imgInfo.dpi != null) ? (imgInfo.dpi + ' PPI') : '—';
    $('iiSize').textContent = formatBytes(imgInfo.size);
    $('iiCount').textContent = annotations.length;
    $('iiBoard').textContent = (STAGE_W && STAGE_H) ? (STAGE_W + ' × ' + STAGE_H + ' px') : '—';
  }

  function syncMosaicParamUI(s) {
    const ms = (s && s.mosaicStyle) || 'pixel';
    const isFrost = ms === 'frost';
    const lbl = $('mosaicParamLabel');
    const inp = $('mosaicParam');
    const val = $('mosaicParamVal');
    if (isFrost) {
      lbl.textContent = '磨砂强度';
      inp.min = 0; inp.max = 100;
      const fr = (s.frostStrength != null) ? s.frostStrength : 0.6;
      inp.value = Math.round(fr * 100);
      val.textContent = Math.round(fr * 100);
    } else {
      lbl.textContent = '马赛克大小';
      inp.min = 4; inp.max = 60;
      const sz = (s.mosaicSize != null) ? s.mosaicSize : 12;
      inp.value = sz;
      val.textContent = sz;
    }
    fillSliderTrack(inp);
  }
  // 磨砂玻璃贴图（iOS 风格）：
  //   ① 背景 = 框选内容（底图对应区域）
  //   ② 对背景做高斯模糊（降采样→放大，避开部分环境下不生效的 ctx.filter）
  //   注意：本函数仅生成"模糊后的底图"，不含任何玻璃材质（薄雾/高光/阴影）
  //   玻璃材质由 renderMosaicNode 以独立半透明子层叠加，确保多个磨砂重叠时 alpha 自然混合
  function makeFrostFill(g, strength, seed, skipId) {
    if (!g || g.width <= 0 || g.height <= 0) return null;
    const w = Math.max(1, Math.round(g.width));
    const h = Math.max(1, Math.round(g.height));
    // 跨域/不可读：#EDEDED 浅灰底 + 蓝/黄柔光斑回退，密度由磨砂强度滑块控制
    if (imgTainted) {
      const out = document.createElement('canvas');
      out.width = w; out.height = h;
      const octx = out.getContext('2d');
      octx.imageSmoothingEnabled = true;
      drawFrostFallback(octx, w, h, strength, seed);
      return out;
    }
    const src = buildMosaicSource(skipId);
    if (!src) return null;
    // 合成图即 1:1 画板分辨率，画板坐标 == 合成图像素坐标，直接采样
    const sx = Math.max(0, g.x), sy = Math.max(0, g.y), sw = g.width, sh = g.height;

    // 多轮降采样模糊：每轮 compounding 模糊半径
    const r1 = 2.5 + strength * 8;                       // 第一轮：约 2.5 ~ 10.5 倍
    const w1 = Math.max(6, Math.round(w / r1));
    const h1 = Math.max(6, Math.round(h / r1));
    const c1 = document.createElement('canvas');
    c1.width = w1; c1.height = h1;
    const ctx1 = c1.getContext('2d');
    ctx1.imageSmoothingEnabled = true;
    ctx1.drawImage(src, sx, sy, sw, sh, 0, 0, w1, h1);

    let blurred;
    if (strength > 0.4 && w1 > 8 && h1 > 8) {
      const r2 = 2 + strength * 5;                        // 第二轮：约 2 ~ 7 倍
      const w2 = Math.max(4, Math.round(w1 / r2));
      const h2 = Math.max(4, Math.round(h1 / r2));
      const c2 = document.createElement('canvas');
      c2.width = w2; c2.height = h2;
      const ctx2 = c2.getContext('2d');
      ctx2.imageSmoothingEnabled = true;
      ctx2.drawImage(c1, 0, 0, w1, h1, 0, 0, w2, h2);
      blurred = c2;
    } else {
      blurred = c1;
    }

    // 放大回目标尺寸（双线性插值=平滑模糊底图）
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d');
    octx.imageSmoothingEnabled = true;
    octx.fillStyle = boardTransparent ? '#ffffff' : boardColor;
    octx.fillRect(0, 0, w, h);
    octx.drawImage(blurred, 0, 0, blurred.width, blurred.height, 0, 0, w, h);
    return out;
  }
  // 按标注样式渲染马赛克节点：pixel=真实采样方块(Rect)；frost=磨砂玻璃(Group 分层)
  //   frost Group 结构（解决多层叠加时材质不自然堆叠的问题）：
  //     Group( x, y, shadow* )
  //     ├── Rect('blur')  : 模糊底图贴图 fillPatternImage
  //     ├── Rect('tint')  : 半透明白色薄雾（alpha 叠加，多层重叠时自然混合）
  //     ├── Rect('hl')    : 左上高光
  //     └── Rect('border'): 1px 浅色边框
  //   关键：拖拽/调强度时复用同一个 Group 实例（仅清空子层重建内容），
  //   避免像旧逻辑那样“重建新 Group 替换旧节点”导致 Transformer 失联、坐标飞移。
  function renderMosaicNode(node, a) {
    const s = a.style || {};
    if ((s.mosaicStyle || 'pixel') === 'frost') {
      const strength = (s.frostStrength != null) ? s.frostStrength : 0.6;
      const g = a.geometry || {};
      const w = g.width || 1, h = g.height || 1;
      const cr = Math.min(14, Math.max(6, Math.min(w, h) * 0.07));
      const blurImg = makeFrostFill(g, strength, a.id, a.id);

      // 复用传入的 Group（已是 frost Group 时）；首次(Rect)才新建 Group
      const grp = (node && node.findOne && node.findOne('.blur')) ? node : new Konva.Group({ x: g.x || 0, y: g.y || 0 });
      grp.removeChildren(); // 清空旧子层，按最新几何/强度重建（保留 Group 自身 x/y 与 id）

      // Layer 1 — 模糊底图
      const blurRect = new Konva.Rect({ name: 'blur', x: 0, y: 0, width: w, height: h, cornerRadius: cr });
      if (blurImg) {
        blurRect.fillPatternImage(blurImg);
        blurRect.fillPatternRepeat('no-repeat');
        blurRect.fillPatternX(0); blurRect.fillPatternY(0);
        blurRect.fillPatternScale(1);
      } else {
        blurRect.fill('#ddd');
      }
      // 投影放在最底层 Rect 上（Group 在本打包版本无 shadow 方法）
      blurRect.shadowColor('rgba(0,0,0,0.30)');
      blurRect.shadowBlur(12);
      blurRect.shadowOffsetX(0);
      blurRect.shadowOffsetY(5);
      blurRect.shadowEnabled(true);
      grp.add(blurRect);

      // Layer 2 — 玻璃薄雾（半透明白色均匀薄雾，模拟 iOS vibrancy 提亮）
      const tintA = 0.10 + strength * 0.16;             // 0.10 ~ 0.26（比之前低，因为不再独占不透明层）
      grp.add(new Konva.Rect({
        name: 'tint', x: 0, y: 0, width: w, height: h, cornerRadius: cr,
        fill: `rgba(255,255,255,${tintA})`, listening: false,
      }));

      // Layer 3 — 左上高光（径向白色渐变）
      if (strength > 0.2 && w > 20 && h > 20) {
        grp.add(new Konva.Rect({
          name: 'hl', x: 0, y: 0, width: w, height: h, cornerRadius: cr,
          fillPriority: 'color', listening: false,
          fillRadialGradientStartPoint: { x: 0, y: 0 },
          fillRadialGradientStartRadius: 0,
          fillRadialGradientEndPoint: { x: 0, y: 0 },
          fillRadialGradientEndRadius: Math.min(w, h) * 0.7,
          fillRadialGradientColorStops: [0, `rgba(255,255,255,${0.22 + strength * 0.18})`, 1, 'rgba(255,255,255,0)'],
        }));
      }

      // Layer 4 — 底部弱阴影（内侧压暗）
      if (strength > 0.15 && h > 12) {
        const shBand = Math.min(h * 0.40, 40);
        grp.add(new Konva.Rect({
          name: 'shadow', x: 0, y: 0, width: w, height: h, cornerRadius: cr,
          fillPriority: 'color', listening: false,
          fillLinearGradientStartPoint: { x: 0, y: h },
          fillLinearGradientEndPoint: { x: 0, y: h - shBand },
          fillLinearGradientColorStops: [0, 'rgba(0,0,0,0.10)', 1, 'rgba(0,0,0,0)'],
        }));
      }

      // Layer 5 — 1px 玻璃边框（最上层，确保边缘锐利）
      grp.add(new Konva.Rect({
        name: 'border', x: 0, y: 0, width: w, height: h, cornerRadius: cr,
        stroke: 'rgba(255,255,255,0.55)', strokeWidth: 1, fill: null, listening: false,
      }));

      return grp; // 拖拽/调强度时为“原 Group 实例”；createNode/finishDraw 首次为新建 Group
    }
    // pixel 样式：真实采样方块（Rect）
    if (node && node.findOne && node.findOne('.blur')) {
      // 旧节点是 frost Group，需转换为 Rect（Group 不会渲染 fillPatternImage，否则样式切换不生效）
      const rect = new Konva.Rect({ x: node.x(), y: node.y(), width: g.width || 1, height: g.height || 1 });
      setMosaicFill(rect, g, s.mosaicSize || 12, a.id);
      rect.stroke(null); rect.shadowEnabled(false);
      rect.cornerRadius((a.style && a.style.radius != null) ? a.style.radius : 0);
      if (a.id) rect.id(a.id);
      return rect;
    }
    setMosaicFill(node, a.geometry || {}, s.mosaicSize || 12, a.id);
    node.stroke(null);
    node.shadowEnabled(false);
    node.cornerRadius((a.style && a.style.radius != null) ? a.style.radius : 0);
    return node; // ← 返回原 Rect
  }

  // 文本标注 = Group( 背景Rect + 文字Text )，支持背景色与圆角
  function textPadding(fs) { return Math.max(4, Math.round(fs * 0.25)); }
  function measureTextWidth(text, fs) { return new Konva.Text({ text: text || '', fontSize: fs }).width(); }
  function buildTextGroup(a) {
    const s = a.style || {};
    const fs = s.fontSize || 18;
    const stroke = s.stroke || '#ff4d4f';
    const bg = s.bg || null;
    const radius = (s.radius != null) ? s.radius : 0;
    const bgOpacity = (s.bgOpacity != null) ? s.bgOpacity : 1;
    const text = a.text || '';
    const pad = textPadding(fs);
    const w = measureTextWidth(text, fs) + pad * 2;
    const h = (new Konva.Text({ text, fontSize: fs }).height()) + pad * 2;
    const g = a.geometry || {};
    const group = new Konva.Group({ x: g.x || 0, y: g.y || 0 });
    // 透明命中区：即便没有背景色，文字在画布上也始终可被点击/拖动（无背景时 Group 原本没有命中区）
    group.add(new Konva.Rect({ name: 'hit', x: 0, y: 0, width: w, height: h, fill: 'rgba(0,0,0,0.001)', listening: true }));
    // 文字背景：不再用「启用」开关控制，改由背景不透明度滑块调节（0 = 无背景）
    if (bg) {
      group.add(new Konva.Rect({ name: 'bgrect', x: 0, y: 0, width: w, height: h, fill: bg, opacity: bgOpacity, cornerRadius: radiusPx(radius, w, h), stroke: stroke, strokeWidth: (s.strokeWidth || 0), listening: false }));
    }
    group.add(new Konva.Text({ name: 'txt', x: pad, y: pad, text, fontSize: fs, fill: stroke, listening: false }));
    return group;
  }
  function rebuildTextGroup(group, a) {
    const s = a.style || {};
    const fs = s.fontSize || 18;
    const stroke = s.stroke || '#ff4d4f';
    const bg = s.bg || null;
    const radius = (s.radius != null) ? s.radius : 0;
    const bgOpacity = (s.bgOpacity != null) ? s.bgOpacity : 1;
    const text = a.text || '';
    const pad = textPadding(fs);
    const w = measureTextWidth(text, fs) + pad * 2;
    const h = (new Konva.Text({ text, fontSize: fs }).height()) + pad * 2;
    const hitNode = group.findOne('.hit');
    if (hitNode) { hitNode.width(w); hitNode.height(h); }
    const txtNode = group.findOne('.txt');
    if (txtNode) { txtNode.text(text); txtNode.fill(stroke); txtNode.fontSize(fs); txtNode.x(pad); txtNode.y(pad); }
    let bgNode = group.findOne('.bgrect');
    // 文字背景：由背景不透明度滑块调节（0 = 无背景），不再依赖「启用」开关
    if (bg) {
      if (!bgNode) { bgNode = new Konva.Rect({ name: 'bgrect' }); group.add(bgNode); }
      bgNode.width(w); bgNode.height(h); bgNode.fill(bg); bgNode.opacity(bgOpacity); bgNode.cornerRadius(radiusPx(radius, w, h)); bgNode.x(0); bgNode.y(0);
      bgNode.stroke(stroke); bgNode.strokeWidth(s.strokeWidth || 0); // 线宽控制背景边框宽度，颜色跟随前景色
      bgNode.moveToBottom(); // 背景永远压到最底层，避免盖住文字
      if (txtNode) txtNode.moveToTop();
    } else if (bgNode) {
      bgNode.destroy();
    }
  }

  // ---------- 水印 ----------
  // 加载/缓存 Logo 图片；加载完成后自动重绘所有引用该 Logo 的水印节点。
  function loadWmLogo(src) {
    if (!src) return null;
    if (wmLogos[src]) return wmLogos[src];
    const im = new Image();
    im.onload = () => { wmLogos[src] = im; redrawWatermarks(src); };
    im.onerror = () => { /* 解码失败：保留占位，不崩溃 */ };
    im.src = src;
    wmLogos[src] = im; // 先存占位引用（complete 之前 naturalWidth=0）
    return im;
  }
  function redrawWatermarks(src) {
    let changed = false;
    annotations.forEach((a) => {
      if (a.type !== 'watermark' || !nodes[a.id]) return;
      const s = a.style || {};
      if (s.wmType === 'logo' && s.logoDataURL === src) {
        const fresh = buildWatermarkNode(a);
        if (fresh) { replaceAnnNode(a.id, fresh); changed = true; }
      }
    });
    if (changed) annLayer.batchDraw();
  }
  // 就地替换某标注对应的 Konva 节点（保持原图层顺序、id 与选中态），供水印/Logo 重绘复用。
  function replaceAnnNode(id, fresh) {
    const old = nodes[id];
    if (!old) { fresh.id(id); fresh.draggable(false); annLayer.add(fresh); nodes[id] = fresh; return; }
    const idx = annLayer.getChildren().indexOf(old);
    old.destroy();
    fresh.id(id); fresh.draggable(false);
    if (idx >= 0) { annLayer.add(fresh); fresh.setZIndex(idx); } else annLayer.add(fresh);
    nodes[id] = fresh;
    if (selectedId === id) { const a = annotations.find((x) => x.id === id); if (!(a && a.type === 'watermark')) tr.nodes([fresh]); }
  }
  // 文本测量（离屏 2D canvas，复用单例避免频繁创建）
  let _wmMeasCv = null;
  function wmMeasureText(text, font) {
    if (!_wmMeasCv) _wmMeasCv = document.createElement('canvas');
    const ctx = _wmMeasCv.getContext('2d');
    ctx.font = font;
    const m = ctx.measureText(text || '');
    const fs = parseInt(font, 10) || 18;
    const asc = m.actualBoundingBoxAscent || fs * 0.8;
    const desc = m.actualBoundingBoxDescent || fs * 0.3;
    return { w: Math.max(1, Math.ceil(m.width) + 8), h: Math.max(1, Math.ceil(asc + desc) + 8) };
  }
  // 生成“单个水印标记”的离屏 canvas（文字或 Logo），旋转已烘焙进画布，画布尺寸=旋转后包围盒。
  // Logo 未加载完成时返回 null（加载完成后由 redrawWatermarks 触发重绘）。
  function makeWatermarkUnit(a) {
    const s = a.style || {};
    const angle = ((s.wmAngle || 0) % 360) * Math.PI / 180;
    const color = s.stroke || '#ff4d4f';
    const fs = Math.max(8, s.fontSize || 18);
    let cw, ch, drawFn;
    if (s.wmType === 'logo' && s.logoDataURL) {
      const im = loadWmLogo(s.logoDataURL);
      if (!im || !im.complete || !im.naturalWidth) return null; // 尚未就绪
      const maxDim = Math.max(24, fs * 4); // Logo 大小随「字号」滑块联动（fs×4）
      const sc = Math.min(1, maxDim / Math.max(im.naturalWidth, im.naturalHeight));
      cw = Math.max(1, Math.round(im.naturalWidth * sc));
      ch = Math.max(1, Math.round(im.naturalHeight * sc));
      drawFn = (ctx) => { ctx.drawImage(im, -cw / 2, -ch / 2, cw, ch); };
    } else {
      const text = ((a.text || '').replace(/\s*\n\s*/g, ' ').trim()) || '水印';
      const font = 'bold ' + fs + 'px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      const m = wmMeasureText(text, font);
      cw = m.w; ch = m.h;
      drawFn = (ctx) => {
        ctx.font = font; ctx.fillStyle = color;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(text, 0, 0);
      };
    }
    const cos = Math.abs(Math.cos(angle)), sin = Math.abs(Math.sin(angle));
    const bw = Math.max(1, Math.ceil(cw * cos + ch * sin));
    const bh = Math.max(1, Math.ceil(cw * sin + ch * cos));
    const cv = document.createElement('canvas');
    cv.width = bw; cv.height = bh;
    const ctx = cv.getContext('2d');
    ctx.translate(bw / 2, bh / 2);
    ctx.rotate(angle);
    drawFn(ctx);
    return { canvas: cv, w: bw, h: bh };
  }
  // 构建水印 Konva 节点：
  //   平铺(tile) → 覆盖整块画板的 Rect，用「单元+间距」作重复贴图（listening:false，避免遮住其它标注的点选）
  //   居中(center)/单角(corner) → 单个 Konva.Image，可拖动微调（listening:true）
  function buildWatermarkNode(a) {
    const s = a.style || {};
    const layout = s.wmLayout || 'tile';
    const opacity = (s.wmOpacity != null) ? s.wmOpacity : 0.3;
    const gap = (s.wmGap != null) ? s.wmGap : 80;
    const unit = makeWatermarkUnit(a);
    const g = a.geometry || (a.geometry = {});
    if (layout === 'tile') {
      const rect = new Konva.Rect({ x: 0, y: 0, width: STAGE_W, height: STAGE_H, opacity, listening: false });
      if (unit) {
        const cell = document.createElement('canvas');
        cell.width = unit.w + gap; cell.height = unit.h + gap;
        cell.getContext('2d').drawImage(unit.canvas, gap / 2, gap / 2);
        rect.fillPatternImage(cell);
        rect.fillPatternRepeat('repeat');
        rect.fillPatternX(0); rect.fillPatternY(0);
      } else {
        rect.fill('rgba(0,0,0,0.001)'); // Logo 加载中的透明占位
      }
      g.x = 0; g.y = 0; g.width = STAGE_W; g.height = STAGE_H;
      return rect;
    }
    // center / corner：单个图像
    const iw = unit ? unit.w : 10, ih = unit ? unit.h : 10;
    const node = new Konva.Image({ image: unit ? unit.canvas : PLACEHOLDER_IMG, width: iw, height: ih, opacity, listening: true });
    let x, y;
    if (g._placed && g.x != null && g.y != null) {
      x = g.x; y = g.y; // 用户已拖动过：沿用其位置
    } else if (layout === 'center') {
      x = Math.round((STAGE_W - iw) / 2); y = Math.round((STAGE_H - ih) / 2);
    } else { // corner：右下角，留 gap 作为边距
      x = Math.max(0, STAGE_W - iw - gap); y = Math.max(0, STAGE_H - ih - gap);
    }
    node.x(x); node.y(y);
    g.x = x; g.y = y; g.width = iw; g.height = ih;
    return node;
  }
  // 缩放上传的 Logo 到 ≤512px 再转 dataURL（防止大图撑爆 localStorage 草稿），完成后回调。
  function scaleLogoFile(file, cb) {
    const reader = new FileReader();
    reader.onload = () => {
      const im = new Image();
      im.onload = () => {
        const max = 512;
        const sc = Math.min(1, max / Math.max(im.naturalWidth || 1, im.naturalHeight || 1));
        const w = Math.max(1, Math.round((im.naturalWidth || 1) * sc));
        const h = Math.max(1, Math.round((im.naturalHeight || 1) * sc));
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(im, 0, 0, w, h);
        let out;
        try { out = cv.toDataURL('image/png'); } catch (e) { out = String(reader.result); }
        cb(out);
      };
      im.onerror = () => cb(null);
      im.src = String(reader.result);
    };
    reader.onerror = () => cb(null);
    reader.readAsDataURL(file);
  }

  // ---------- 初始化 ----------
  async function init() {
    initTheme(); // 先套用上次保存的主题（深色 / 浅色暖灰）
    try {
      await EABridge.whenReady();
      const item = await EABridge.getSelectedItem();
      if (item) {
        await openItem(item);
      } else {
        $('imgName').textContent = '未选择图片 — 请点「导入图片」选择本地文件';
      }
    } catch (e) {
      EABridge.setLastError('init: ' + String((e && e.message) || e));
      toast('初始化失败，请检查配置或重试');
      showFatal('初始化失败：' + (e && e.message) + '\n' + ((e && e.stack) || ''));
    }
    bindEvents(); // 无论如何都绑定事件，保证按键可用
  }

  // 由 item 推断图片格式（JPEG/PNG/...），优先 ext 字段，其次文件名后缀
  function guessFormat(item) {
    const ext = (item.ext || '').toLowerCase() || (item.name || '').split('.').pop().toLowerCase();
    const map = { jpg: 'JPEG', jpeg: 'JPEG', png: 'PNG', gif: 'GIF', webp: 'WebP', bmp: 'BMP', svg: 'SVG', avif: 'AVIF', heic: 'HEIC', tiff: 'TIFF' };
    return map[ext] || (ext ? ext.toUpperCase() : '—');
  }

  async function openItem(item) {
    currentItem = item;
    // 载入新图时重置画板状态，避免沿用上一张图的裁剪/底色设置（fitImage 会再重置 isCropped）
    boardTransparent = true;
    boardColor = '#ffffff';
    crop = null; cropDrag = null;
    const bm = document.querySelector('input[name="boardMode"][value="transparent"]');
    if (bm) bm.checked = true;
    $('boardColorRow').style.display = 'none';
    $('boardColor').value = '#ffffff';
    const tag = item.isLocal ? '  (本地)' : '  (预览)';
    $('imgName').textContent = item.name + tag;
    const url = item.fileURL;
    await loadImage(url).catch((err) => {
      EABridge.setLastError('loadImage: ' + String((err && err.message) || err));
      toast('图片加载失败：' + (err && err.message || err));
    });
    // 收集图片信息（选择工具下「图片信息」面板数据源）
    const nw = imgEl ? (imgEl.naturalWidth || imgEl.width) : 0;
    const nh = imgEl ? (imgEl.naturalHeight || imgEl.height) : 0;
    imgInfo = { name: item.name || '—', format: guessFormat(item), width: nw, height: nh, size: item.size || 0, dpi: null };
    updateImageInfo();
    probeDPI(url);
    annotations = await EABridge.loadAnnotations(item);
    seqCounters = {}; // 每张图重新从 1 开始编号
    syncSeqCounters(); // 为导入的标注补齐/校准「功能+序号」名称（内部已调用 recalcCounters）
    selectedId = null; tr.nodes([]); showEditor(null);
    updateTextCtlVisibility();
    renderAll();
    // 以"载入后的初始状态"作为撤销基线（histIndex=0），使第一次操作也能被撤销回空标注
    history.length = 0; histIndex = -1; snapshot();
  }

  function rescaleAnnotations(r) {
    annotations.forEach((a) => {
      const g = a.geometry; if (!g) return;
      if (g.points) { g.points = g.points.map((v) => v * r); }
      else {
        g.x = (g.x || 0) * r; g.y = (g.y || 0) * r;
        if (g.width != null) g.width *= r;
        if (g.height != null) g.height *= r;
      }
    });
    renderAll();
  }

  // 计算图片显示尺寸（画板/逻辑尺寸），然后 fitBoardToView 将其适配进容器填满
  // isLoad=true 表示正在载入新图：此时 annotations 仍是上一张图的旧数据（随后会被 loadAnnotations 整体替换），
  // 不应对其做坐标缩放（D2：加载路径下的 rescale 是空操作，去掉避免无谓改写）。
  function fitImage(isLoad) {
    if (!imgEl) return;
    const nw = imgEl.naturalWidth || imgEl.width;
    const nh = imgEl.naturalHeight || imgEl.height;
    if (!nw || !nh) return;
    const availW = _wrap ? _wrap.clientWidth : (window.innerWidth || 760);
    const availH = _wrap ? _wrap.clientHeight : (window.innerHeight || 540);
    const fit = Math.min(availW / nw, availH / nh);
    const newW = Math.max(1, Math.round(nw * fit));
    const newH = Math.max(1, Math.round(nh * fit));
    const r = displayedW ? (newW / displayedW) : 1;
    displayedW = newW; displayedH = newH;
    imgOffsetX = 0; imgOffsetY = 0; // 重置为整图视图
    isCropped = false;              // 取消裁剪状态，回到以图片外边框为画布
    crop = null; cropDrag = null;  // 清除残留裁剪选框
    STAGE_W = newW; STAGE_H = newH;
    applyStageSize();
    // 仅在非“载入新图”场景缩放标注坐标（载入时旧标注随后会被 loadAnnotations 整体替换，无需缩放）
    if (!isLoad && r !== 1) rescaleAnnotations(r);
    annLayer.x(0); annLayer.y(0);
    drawBoardBackground();
    resetZoom(); // 重适配时归位缩放/平移
  }

  function loadImage(url) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        imgEl = img;
        // 跨域检测：尝试读取 1px 像素，若抛出（tainted）→ 标记不可读，
        // 后续马赛克/磨砂改为装饰性回退贴图（格子 / 光斑），不再触碰被污染的原图。
        try {
          const tc = document.createElement('canvas'); tc.width = 1; tc.height = 1;
          const tctx = tc.getContext('2d');
          tctx.drawImage(img, 0, 0, 1, 1);
          tctx.getImageData(0, 0, 1, 1);
          imgTainted = false;
        } catch (e) {
          imgTainted = true;
        }
        fitImage(true); // 载入新图：跳过对旧标注的冗余缩放（D2）
        res();
      };
      img.onerror = () => rej(new Error('图片源无法加载（请确认文件路径正确，或用 http 方式打开本应用）'));
      img.src = url;
    });
  }

  // ---------- 渲染 ----------
  function createNode(a) {
    const s = a.style || {};
    const stroke = s.stroke || '#ff4d4f';
    const sw = s.strokeWidth || 3;
    const fs = s.fontSize || 18;
    const fill = s.bg || 'rgba(255,77,79,0.18)'; // 矩形/高亮内部填充 = 背景色（未设置时回退默认红）
    const bgOp = (s.bgOpacity != null) ? s.bgOpacity : 1; // 背景透明度，作用于所有"背景色"填充（矩形/高亮/编号圆/文字底）
    const radius = (s.radius != null) ? s.radius : 0;
    const g = a.geometry || {};
    let node;
    if (a.type === 'rect') {
      node = new Konva.Rect({ x: g.x, y: g.y, width: g.width, height: g.height, stroke, strokeWidth: sw, fill: hexToRgba(fill, bgOp), cornerRadius: radiusPx(radius, g.width, g.height) });
    } else if (a.type === 'highlight') {
      node = new Konva.Rect({ x: g.x, y: g.y, width: g.width, height: g.height, fill: hexToRgba(fill, bgOp), cornerRadius: radiusPx(radius, g.width, g.height) });
    } else if (a.type === 'mosaic') {
      node = new Konva.Rect({ x: g.x, y: g.y, width: g.width, height: g.height, cornerRadius: radiusPx(radius, g.width, g.height) });
      const result = renderMosaicNode(node, a);
      if (result && result !== node) node = result; // frost 返回 Group 替换原 Rect
    } else if (a.type === 'number') {
      const r = Math.max(8, fs * 0.9); // 圆角半径随字号等比放大 → 整体大小由字号控制
      const numBgOp = (s.bgOpacity != null) ? s.bgOpacity : 0; // 编号背景不透明度默认 0（圆形背景默认透明，仅描边+数字）
      node = new Konva.Group({ x: g.x, y: g.y });
      // 圆形：填充=背景色(默认透明)，描边=前景色，描边宽度=线宽(可为 0)
      node.add(new Konva.Circle({ radius: r, fill: hexToRgba(s.bg || 'rgba(255,77,79,0.18)', numBgOp), stroke: stroke, strokeWidth: (s.strokeWidth != null ? s.strokeWidth : 0) }));
      node.add(new Konva.Text({ text: String(a.text || '?'), fill: stroke, fontSize: fs, fontStyle: 'bold', x: -r, y: -fs / 2, width: 2 * r, align: 'center' })); // 文字 = 前景色
    } else if (a.type === 'arrow') {
      node = makeArrow(g.points, stroke, sw, radius);
    } else if (a.type === 'free') {
      node = new Konva.Line({ points: g.points, stroke, strokeWidth: sw, lineCap: 'round', lineJoin: 'round', tension: 0 });
    } else if (a.type === 'text') {
      node = buildTextGroup(a);
    } else if (a.type === 'watermark') {
      node = buildWatermarkNode(a);
    } else if (a.type === 'image') {
      const im = loadImgEl(a.src);
      const ready = im && im.complete && im.naturalWidth;
      node = new Konva.Image({ x: g.x, y: g.y, width: g.width, height: g.height, image: ready ? im : PLACEHOLDER_IMG });
    }
    if (node) {
      node.id(a.id);
      node.draggable(false); // 关闭 Konva 内置拖拽，改用自定义拖拽（见 dragTarget 逻辑）
    }
    return node;
  }
  // 加载/缓存粘贴图片，加载完成后自动重绘引用该 src 的所有节点
  function loadImgEl(src) {
    if (imgEls[src]) return imgEls[src];
    const im = new Image();
    im.onload = () => { imgEls[src] = im; redrawImageNodes(src); };
    im.onerror = () => { /* 解码失败：保留占位，不崩溃 */ };
    im.src = src;
    imgEls[src] = im; // 先存占位引用（complete 之前 naturalWidth=0）
    return im;
  }
  function redrawImageNodes(src) {
    annotations.forEach((a) => {
      if (a.type === 'image' && a.src === src && nodes[a.id]) {
        const im = imgEls[src];
        if (im && im.complete && im.naturalWidth) {
          const n = nodes[a.id];
          if (typeof n.image === 'function') { n.image(im); annLayer.batchDraw(); }
        }
      }
    });
  }

  function renderAll() {
    Object.values(nodes).forEach((n) => n.destroy());
    for (const k in nodes) delete nodes[k];
    annotations.forEach((a) => {
      const n = createNode(a);
      if (n) { annLayer.add(n); nodes[a.id] = n; }
    });
    if (selectedId && nodes[selectedId]) tr.nodes([nodes[selectedId]]);
    else tr.nodes([]);
    annLayer.batchDraw();
    renderList();
  }

  // ---------- 列表 / 搜索 ----------
  function renderList() {
    const q = ($('searchInput').value || '').trim().toLowerCase();
    const list = $('annList');
    list.innerHTML = '';
    let shown = 0;
    annotations.forEach((a) => {
      const label = a.name || a.text || EABridge.typeLabel(a.type);
      // 搜索同时匹配名称与文字内容
      const hay = ((a.name || '') + ' ' + (a.text || '') + ' ' + EABridge.typeLabel(a.type)).toLowerCase();
      if (q && !hay.includes(q)) return;
      shown++;
      const row = document.createElement('div');
      row.className = 'ann-row' + (a.id === selectedId ? ' sel' : '');
      row.dataset.id = a.id;
      row.innerHTML =
        `<span class="ann-type">${typeIcon(a.type)}</span>` +
        `<span class="ann-text" title="${escapeHtml(label)}">${escapeHtml(label)}</span>` +
        `<span class="ann-act">` +
        `<button data-act="vis">${a.visible === false ? '显' : '隐'}</button>` +
        `<button data-act="lock">${a.locked ? '解锁' : '锁定'}</button>` +
        `<button data-act="del" class="del">删</button>` +
        `</span>`;
      row.addEventListener('click', (e) => {
        if (e.target.dataset.act) return;
        selectNode(a.id);
      });
      row.querySelector('[data-act="vis"]').addEventListener('click', (e) => { e.stopPropagation(); toggleVisible(a.id); });
      row.querySelector('[data-act="lock"]').addEventListener('click', (e) => { e.stopPropagation(); toggleLock(a.id); });
      row.querySelector('[data-act="del"]').addEventListener('click', (e) => { e.stopPropagation(); deleteAnnotation(a.id); });
      list.appendChild(row);
    });
    $('annCount').textContent = shown;
    // 图片信息面板的「标注数量」始终与右侧列表真实数量(annotations)同步
    updateImageInfo();
  }

  function typeIcon(t) {
    return ({ rect: '▭', arrow: '↗', free: '✎', text: 'T', number: '①', highlight: '▦', mosaic: '▩', image: '▣', watermark: '💧' })[t] || '•';
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  // 按「功能名 + 序号」生成标注名称（如「马赛克01」）。序号从 1 起、按类型各自递增，不设上限。
  // padStart(2,'0') 保证 1~99 补零（01..99），达到 100 自然变为三位（100），不会再出现重名。
  function allocName(type) {
    seqCounters[type] = (seqCounters[type] || 0) + 1;
    return EABridge.typeLabel(type) + String(seqCounters[type]).padStart(2, '0');
  }
  // 导入/还原的标注若缺名称，则补齐；同时按已有名称的数字后缀校准计数，避免新编号与导入内容冲突。
  // 复用 recalcCounters() 完成“按现有名称校准计数”这一步，避免两份重复逻辑（D1 合并）。
  function syncSeqCounters() {
    recalcCounters(); // 先按现有名称校准计数，避免与导入内容冲突
    annotations.forEach((a) => { if (!a.name) a.name = allocName(a.type); });
  }

  // ---------- 复制 / 粘贴 ----------
  // 复制选中标注到剪贴板（深拷贝，断开与原对象的引用，避免多次粘贴共享同一 style 等对象）。
  function copySelected() {
    if (!selectedId) { toast('请先选中一个标注'); return; }
    const a = annotations.find((x) => x.id === selectedId);
    if (!a) { toast('未找到选中的标注'); return; }
    pasteBuffer = JSON.parse(JSON.stringify(a));
    toast('已复制：' + (a.name || EABridge.typeLabel(a.type)));
  }
  // 粘贴：在选中标注「向下一点」的位置生成一模一样的副本，名称按序号规则递增（如 文本01 → 文本02）。
  function pasteAnnotation() {
    if (!pasteBuffer) { toast('请先选中并复制一个标注'); return; }
    const src = pasteBuffer;
    const a = JSON.parse(JSON.stringify(src)); // 再深拷贝一次，支持连续粘贴同一源
    a.id = 'a_' + Date.now();
    a.name = allocName(a.type); // 名称重分配（序号递增），如 文本02
    const g = a.geometry || (a.geometry = {});
    // 向下偏移量：自适应画板高度（约 6%），且不小于 16px，保证「向下一点」直观可见
    const dy = Math.max(16, Math.round(STAGE_H * 0.06));
    if (a.type === 'arrow' || a.type === 'free') {
      if (g.points) g.points = g.points.map((v, i) => (i % 2 === 1 ? v + dy : v)); // 仅 y 分量偏移
    } else if (g.y != null) {
      g.y += dy;
    }
    // 防止偏移后超出画板底部：若超出则上移回可见范围（保留向下意图，仅在越界时回弹）
    if (g.y != null) {
      const h = (g.height != null) ? g.height : ((a.type === 'number') ? 24 : 0);
      if (g.y + h > STAGE_H) g.y = Math.max(0, STAGE_H - h - 4);
    }
    const node = createNode(a);
    if (!node) { toast('无法粘贴该标注'); return; }
    annLayer.add(node); nodes[a.id] = node; annotations.push(a);
    snapshot(); // 变更后提交当前状态
    // 连续粘贴：把剪贴板几何更新为本次实际落点，下次粘贴基于新位置继续向下累积（而非每次重叠回原位）
    if (pasteBuffer.geometry) pasteBuffer.geometry = JSON.parse(JSON.stringify(a.geometry));
    syncSeqCounters(); // 统一校准序号计数（保证各类型名称序号与编号 badge 一致）
    renderList(); annLayer.batchDraw();
    setTool('select'); selectNode(a.id);
    toast('已粘贴副本：' + a.name);
  }
  // 从系统剪贴板粘贴图片：作为可移动/缩放/删除的「图片」标注叠加到画布中心
  function pasteImageFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataURL = reader.result;
      const im = new Image();
      im.onload = () => addImageAnnotation(dataURL, im.naturalWidth || 100, im.naturalHeight || 100);
      im.onerror = () => toast('粘贴的图片解码失败');
      im.src = dataURL;
    };
    reader.onerror = () => toast('读取剪贴板图片失败');
    reader.readAsDataURL(file);
  }
  function addImageAnnotation(src, nW, nH) {
    // 适配大小：最大不超过画板的 60%，保持原始比例
    const maxW = STAGE_W * 0.6, maxH = STAGE_H * 0.6;
    const scale = Math.min(1, maxW / (nW || 1), maxH / (nH || 1));
    const w = Math.max(8, Math.round((nW || 100) * scale));
    const h = Math.max(8, Math.round((nH || 100) * scale));
    const x = Math.max(0, Math.round((STAGE_W - w) / 2));
    const y = Math.max(0, Math.round((STAGE_H - h) / 2));
    const id = 'a_' + Date.now();
    const a = { id, type: 'image', src, name: allocName('image'), geometry: { x, y, width: w, height: h }, visible: true, locked: false, createdAt: new Date().toISOString() };
    loadImgEl(src); // 触发加载（完成后自动重绘该节点）
    annotations.push(a);
    renderAll();
    snapshot(); // 变更后提交当前状态（新历史模型：快照即"可还原到的状态"）
    setTool('select'); selectNode(id);
    toast('已粘贴图片：' + a.name);
  }

  // ---------- 选择 / 编辑器 ----------
  function selectNode(id) {
    // 选中列表项时，自动切到选择模式（拖拽由自定义逻辑处理，locked 节点不可拖）
    if (tool !== 'select') {
      tool = 'select';
      document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === 'select'));
    }
    selectedId = id;
    const a = annotations.find((x) => x.id === id);
    const n = nodes[id];
    // 水印尺寸/角度由滑块控制，不挂 Transformer 缩放手柄（仅允许拖动微调）
    const noTransform = a && a.type === 'watermark';
    tr.nodes((n && !noTransform) ? [n] : []);
    // 仅「文本 / 编号」选中时弹出“选中标注”组件；其余工具（矩形/高亮/马赛克/箭头/画笔）
    // 选中只做画布高亮，不再弹出该组件（减少干扰，操作仍可经列表的删/快捷键完成）。
    if (a && (a.type === 'text' || a.type === 'number')) {
      showEditor(a);
    } else {
      showEditor(null);
    }
    if (a) syncStylePanel(a);
    updateTextCtlVisibility();
    renderList();
  }

  function showEditor(a) {
    const ed = $('editor');
    if (!a) { ed.style.display = 'none'; return; }
    ed.style.display = 'block';
    $('edText').value = a.text || '';
    const el = $('edLock'); if (el) el.textContent = a.locked ? '解锁' : '锁定';
    const ev = $('edVis'); if (ev) ev.textContent = a.visible === false ? '显示' : '隐藏';
  }
  // 让某组预设圆中与 color 匹配的项高亮（边缘加粗），其余取消
  function syncPresetSelection(target, color) {
    const group = document.querySelector(`.presets[data-target="${target}"]`);
    if (!group || !color) return;
    const c = String(color).toLowerCase();
    group.querySelectorAll('.preset').forEach((p) => {
      p.classList.toggle('selected', p.dataset.color.toLowerCase() === c);
    });
  }
  // 根据“有效类型”刷新右侧面板与滑块显隐：
  //   有效类型 = 已选中标注的类型；否则 = 当前激活工具。
  //   这样在列表里点选某标注时，上方样式面板会对应显示该标注类型的样式
  //   （如选中马赛克→显示马赛克样式组，选中矩形→显示前景/背景/圆角等）。
  function applyCtxVisibility(type) {
    const isCrop = (type === 'crop');
    const isMosaic = (type === 'mosaic');
    const isNumber = (type === 'number');
    const isHighlight = (type === 'highlight');
    const isTextLike = (type === 'text' || type === 'number');
    const isArrowFree = (type === 'arrow' || type === 'free');
    const isImage = (type === 'image');
    const isWater = (type === 'watermark');
    // 选择工具且未选中任何标注(type==='select')→ 显示「图片信息」面板，隐藏样式/马赛克面板
    const isImgInfo = (type === 'select');
    $('imageInfo').style.display = isImgInfo ? 'block' : 'none';
    // 显示图片信息面板时立即刷新内容（否则会带着旧数据出现，标注数量不同步）
    if (isImgInfo) updateImageInfo();
    // 马赛克控件组：马赛克工具激活 OR 选中了马赛克标注 → 显示
    $('mosaicCtl').style.display = isMosaic ? 'block' : 'none';
    // 水印控件组：水印工具激活 OR 选中了水印标注 → 显示
    const wc = $('waterCtl'); if (wc) wc.style.display = isWater ? 'block' : 'none';
    // 样式面板（前景/背景/圆角/线宽/字号/背景不透明度）：裁切、马赛克、图片标注、图片信息态 不需要 → 隐藏
    // 水印仍需样式面板里的「前景色 + 字号」，故保留显示，仅隐藏无关行（见下）。
    $('styleCtl').style.display = (isImgInfo || isCrop || isMosaic || isImage) ? 'none' : 'block';
    // 标题随当前类型变化（与标注列表里的类型命名一致，如 文本样式 / 箭头样式 / 框选样式）
    if (!isCrop && !isMosaic && !isImgInfo && !isImage) {
      const lbl = (EABridge && EABridge.typeLabel && EABridge.typeLabel(type)) ? EABridge.typeLabel(type) : '';
      $('styleTitle').textContent = lbl ? (lbl + '样式') : '样式';
    }
    // 线宽：高亮无背景描边概念、水印不用描边 → 隐藏；其余显示
    $('swRow').style.display = (isHighlight || isWater) ? 'none' : 'flex';
    // 圆角：编号（圆形）、水印 无圆角概念 → 隐藏；其余显示
    $('radiusRow').style.display = (isNumber || isWater) ? 'none' : 'flex';
    // 背景不透明度：箭头 / 画笔（free）无背景填充、水印用自己的透明度滑块 → 隐藏；其余显示
    $('bgOpacityRow').style.display = (isArrowFree || isWater) ? 'none' : 'flex';
    // 背景色：水印无背景色概念 → 隐藏；其余显示
    const bgcr = $('bgColorRow'); if (bgcr) bgcr.style.display = isWater ? 'none' : 'flex';
    // 字号：文字 / 编号 / 水印 上下文 → 显示（水印字号驱动文字大小 / Logo 尺寸）
    $('fsRow').style.display = (isTextLike || isWater) ? 'flex' : 'none';
    // 文字/编号上下文：线宽 min=0（背景边框/圆形描边，可无边框）
    const swMin = isTextLike ? 0 : 1;
    $('sw').min = swMin;
    if (+$('sw').value < swMin) { $('sw').value = swMin; style.strokeWidth = swMin; $('swVal').textContent = swMin; }
    fillSliderTrack($('sw'));
    fillSliderTrack($('fs'));
    // 马赛克：同步风格单选 + 参数滑块（工具态用全局 style，选中态用该标注 style）
    if (isMosaic) {
      const sel = (selectedId) ? annotations.find((x) => x.id === selectedId) : null;
      const st = (sel ? sel.style : style);
      const ms = (st && st.mosaicStyle) || 'pixel';
      const rEl = document.querySelector(`input[name="mosaicStyle"][value="${ms}"]`);
      if (rEl) rEl.checked = true;
      syncMosaicParamUI(st);
    }
    // 水印：同步类型/文字/布局/透明度/角度/间距/Logo（工具态用全局 style，选中态用该标注 style）
    if (isWater) {
      const sel = (selectedId) ? annotations.find((x) => x.id === selectedId) : null;
      syncWaterPanel(sel ? sel.style : style, sel);
    }
  }
  // 把水印样式回填进右侧「水印设置」面板控件（含 Logo 预览与文字框）
  function syncWaterPanel(s, a) {
    s = s || {};
    const type = s.wmType || 'text';
    const rt = document.querySelector('input[name="wmType"][value="' + type + '"]'); if (rt) rt.checked = true;
    const isLogo = (type === 'logo');
    const txtRow = $('wmTextRow'); if (txtRow) txtRow.style.display = isLogo ? 'none' : 'flex';
    const logoRow = $('wmLogoRow'); if (logoRow) logoRow.style.display = isLogo ? 'flex' : 'none';
    const wt = $('wmText'); if (wt) wt.value = a ? (a.text || '') : (wmLastText || '');
    const layout = s.wmLayout || 'tile';
    const rl = document.querySelector('input[name="wmLayout"][value="' + layout + '"]'); if (rl) rl.checked = true;
    const op = (s.wmOpacity != null) ? Math.round(s.wmOpacity * 100) : 30;
    if ($('wmOpacity')) { $('wmOpacity').value = op; $('wmOpacityVal').textContent = op; fillSliderTrack($('wmOpacity')); }
    const ang = (s.wmAngle != null) ? s.wmAngle : 30;
    if ($('wmAngle')) { $('wmAngle').value = ang; $('wmAngleVal').textContent = ang; fillSliderTrack($('wmAngle')); }
    const gap = (s.wmGap != null) ? s.wmGap : 80;
    if ($('wmGap')) { $('wmGap').value = gap; $('wmGapVal').textContent = gap; fillSliderTrack($('wmGap')); }
    const gapLbl = $('wmGapLabel'); if (gapLbl) gapLbl.textContent = (layout === 'tile') ? '间距' : (layout === 'corner' ? '边距' : '间距');
    const prev = $('wmLogoPreview');
    if (prev) {
      if (s.logoDataURL) { prev.src = s.logoDataURL; prev.style.display = 'inline-block'; }
      else { prev.removeAttribute('src'); prev.style.display = 'none'; }
    }
  }
  // 原有入口：根据"是否已选中标注"推导有效类型后转发
  function updateTextCtlVisibility() {
    const sel = (selectedId) ? annotations.find((x) => x.id === selectedId) : null;
    applyCtxVisibility(sel ? sel.type : tool);
  }
  // 把颜色串（#rgb / #rrggbb / rgba()）转成带透明度的 rgba 串，alpha∈[0,1]
  function hexToRgba(c, a) {
    if (!c) return c;
    c = String(c).trim();
    const m = c.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const p = m[1].split(',').map((x) => parseFloat(x));
      return `rgba(${p[0]},${p[1]},${p[2]},${a})`;
    }
    if (c[0] === '#') {
      let h = c.slice(1);
      if (h.length === 3) h = h.split('').map((x) => x + x).join('');
      const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
      return `rgba(${r},${g},${b},${a})`;
    }
    return c;
  }
  // 圆角百分比 → 实际像素半径：0% 无圆角；100% = 短边的一半（矩形呈"药丸"胶囊形）
  function radiusPx(pct, w, h) {
    const p = Math.max(0, Math.min(100, (pct != null ? pct : 0)));
    const half = Math.min(Math.abs(w || 0), Math.abs(h || 0)) / 2;
    return (p / 100) * half;
  }
  // 箭头头部尺寸随线宽等比放大：线宽越大，箭头整体（杆身+头部）越粗越大
  function arrowHead(sw) {
    const s = Math.max(1, sw || 3);
    return { pl: Math.max(8, s * 3.2), pw: Math.max(6, s * 2.2) };
  }
  // 创建圆角可控的箭头：复用 Konva.Arrow（保留 points()/变换兼容），但用自定义 sceneFunc 绘制
  //   —— 用同一个"圆角"参数(roundPct)控制：①杆身两端圆头 ②箭头头部三个角的圆化程度
  function makeArrow(points, stroke, sw, radiusPct) {
    const pct = Math.max(0, Math.min(100, (radiusPct != null ? radiusPct : 0)));
    const { pl, pw } = arrowHead(sw);
    const node = new Konva.Arrow({
      points, stroke, fill: stroke, strokeWidth: sw,
      pointerLength: pl, pointerWidth: pw,
      lineCap: pct > 0 ? 'round' : 'butt', lineJoin: 'round', roundPct: pct,
    });
    node.sceneFunc(drawRoundedArrow);
    return node;
  }
  function drawRoundedArrow(ctx, shape) {
    const pts = (typeof shape.points === 'function') ? shape.points() : shape.getAttr('points');
    if (!pts || pts.length < 4) return;
    const x1 = pts[0], y1 = pts[1];
    const x2 = pts[pts.length - 2], y2 = pts[pts.length - 1];
    const PL = shape.pointerLength() || 10;
    const PW = shape.pointerWidth() || 10;
    const pct = Math.max(0, Math.min(100, shape.getAttr('roundPct') || 0));
    const t = pct / 100;
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const bx = x2 - PL * cos, by = y2 - PL * sin; // 头部底边中心
    const nx = -sin, ny = cos;                    // 法线方向
    const tip = { x: x2, y: y2 };
    const left = { x: bx + (PW / 2) * nx, y: by + (PW / 2) * ny };
    const right = { x: bx - (PW / 2) * nx, y: by - (PW / 2) * ny };
    // 杆身：画到头部底边，避免与实心头部重叠
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(bx, by);
    ctx.strokeShape(shape);
    // 头部三角，按圆度圆化三个角（cr 随圆角百分比线性增长，最大为头部半宽）
    const cr = t * (Math.min(PL, PW) / 2);
    ctx.beginPath();
    if (cr <= 0.5) {
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(left.x, left.y);
      ctx.lineTo(right.x, right.y);
      ctx.closePath();
    } else {
      roundedPoly(ctx, [tip, left, right], cr);
    }
    ctx.fillStrokeShape(shape);
  }
  // 用 arcTo 把任意多边形的每个角按半径 r 圆化
  function roundedPoly(ctx, p, r) {
    const n = p.length;
    for (let i = 0; i < n; i++) {
      const prev = p[(i - 1 + n) % n], cur = p[i], next = p[(i + 1) % n];
      let v1x = prev.x - cur.x, v1y = prev.y - cur.y;
      let v2x = next.x - cur.x, v2y = next.y - cur.y;
      const l1 = Math.hypot(v1x, v1y) || 1, l2 = Math.hypot(v2x, v2y) || 1;
      v1x /= l1; v1y /= l1; v2x /= l2; v2y /= l2;
      const rr = Math.min(r, l1 / 2, l2 / 2);
      const ax = cur.x + v1x * rr, ay = cur.y + v1y * rr;
      const bx2 = cur.x + v2x * rr, by2 = cur.y + v2y * rr;
      if (i === 0) ctx.moveTo(ax, ay); else ctx.lineTo(ax, ay);
      ctx.arcTo(cur.x, cur.y, bx2, by2, rr);
    }
    ctx.closePath();
  }
  // 选中标注时，把其样式同步进面板（含背景透明度），并把面板值并入全局 style，
  // 使后续单字段改动只覆盖该字段、保留其余样式，不被全局默认值冲掉
  function syncStylePanel(a) {
    const s = a.style || {};
    const isText = a.type === 'text';
    // 选中标注时，把"前景/背景"预设圆中与当前颜色匹配的一项高亮（边缘加粗）
    syncPresetSelection('stroke', s.stroke);
    syncPresetSelection('bg', s.bg);
    const textCtx = (tool === 'text') || isText;
    // 背景透明度：箭头 / 画笔工具下隐藏（无背景填充）；其余工具显示
    const hideBgOpacity = (tool === 'arrow' || tool === 'free');
    $('bgOpacityRow').style.display = hideBgOpacity ? 'none' : 'flex';
    // 圆角滑块：编号无圆角概念，隐藏；其余显示
    $('radiusRow').style.display = (a.type === 'number') ? 'none' : 'flex';
    // 背景不透明度默认值：编号为 0，其余为 1
    const opDefault = (a.type === 'number') ? 0 : 1;
    const op = (s.bgOpacity != null) ? s.bgOpacity : opDefault;
    $('bgOpacity').value = Math.round(op * 100);
    $('bgOpacityVal').textContent = Math.round(op * 100);
    fillSliderTrack($('bgOpacity'));
    if (s.radius != null) { $('radius').value = s.radius; $('radiusVal').textContent = s.radius; }
    fillSliderTrack($('radius'));
    // 文字/编号上下文下线宽从 0 起（控制背景边框/圆形描边），回显时按 min 钳制
    const swMin = (textCtx || a.type === 'number') ? 0 : 1;
    $('sw').min = swMin;
    if (s.strokeWidth != null) { const v = Math.max(swMin, s.strokeWidth); $('sw').value = v; $('swVal').textContent = v; }
    fillSliderTrack($('sw'));
    if (s.fontSize != null) { $('fs').value = s.fontSize; $('fsVal').textContent = s.fontSize; }
    fillSliderTrack($('fs'));
    if (a.type === 'mosaic') {
      const ms = s.mosaicStyle || 'pixel';
      const rEl = document.querySelector(`input[name="mosaicStyle"][value="${ms}"]`);
      if (rEl) rEl.checked = true;
      syncMosaicParamUI(s);
    }
    if (a.type === 'watermark') syncWaterPanel(s, a);
    style = { ...style, ...s };
  }

  // ---------- 绘制交互 ----------
  stage.on('mousedown touchstart', (e) => {
    if (spaceDown) return; // 空格按住时平移，不画
    if (e.evt && e.evt.button && e.evt.button !== 0) return; // 仅左键
    if (tool === 'select') { handleSelectMouseDown(e); return; }
    const p = annLayer.getRelativePointerPosition();
    if (!p) return;
    if (tool === 'crop') { cropMouseDown(e, p); return; }
    if (tool === 'text') { createTextAt(p); return; }
    if (tool === 'number') { createNumberAt(p); return; }
    if (tool === 'watermark') { createWatermarkAt(p); return; }
    startDraw(tool, p);
  });
  stage.on('mousemove touchmove', () => {
    if (drawing) updateDraw();
    else if (dragTarget) { updateDrag(); _stageContainer.style.cursor = 'move'; }
    else if (imgDrag) { updateImgDrag(); _stageContainer.style.cursor = 'move'; }
    else if (cropDrag) { updateCrop(); _stageContainer.style.cursor = 'move'; }
    else updateHoverCursor();
  });
  stage.on('mouseup touchend', () => {
    if (drawing) finishDraw();
    else if (dragTarget) endDrag();
    else if (imgDrag) endImgDrag();
    else if (cropDrag) endCrop();
  });

  // ---------- 选择模式下的自定义拖拽（带 move 光标反馈） ----------
  // 不再依赖 Konva 内置 draggable：hover→出现四向箭头光标，按住→拖动，松手→同步几何
  function isTransformerTarget(t) {
    let n = t;
    while (n) { if (n === tr) return true; n = n.getParent && n.getParent(); }
    return false;
  }
  function handleSelectMouseDown(e) {
    const t = e.target;
    if (isTransformerTarget(t)) return; // 交给 Konva Transformer 处理缩放，不介入
    let ann = null;
    if (t && t.id && nodes[t.id()]) ann = t;
    else if (t && t.getParent && t.getParent() && nodes[t.getParent().id()]) ann = t.getParent();
    if (ann) {
      const a = annotations.find((x) => x.id === ann.id());
      if (!a) return;
      selectNode(a.id);
      if (a.locked) return; // 锁定节点不可拖动
      const p = annLayer.getRelativePointerPosition();
      if (!p) return;
      dragTarget = ann;
      dragOffset = { x: p.x - ann.x(), y: p.y - ann.y() };
      if (e.evt) e.evt.preventDefault();
    } else {
      // 空白处：若图片小于画板且点击落在图片上 → 拖动图片；否则取消选中
      const p = annLayer.getRelativePointerPosition();
      if (canMoveImage() && p && p.x >= imgOffsetX && p.x <= imgOffsetX + displayedW && p.y >= imgOffsetY && p.y <= imgOffsetY + displayedH) {
        imgDrag = { startX: p.x, startY: p.y, origX: imgOffsetX, origY: imgOffsetY };
        if (e.evt) e.evt.preventDefault();
        return;
      }
      if (selectedId) {
        selectedId = null; tr.nodes([]); showEditor(null); updateTextCtlVisibility(); renderList();
      }
    }
  }
  // 图片是否可移动：
  //   ① 普通模式：图片在某一维度小于画板时（画板大于图片，四周有留白）
  //   ② 裁切模式：始终允许（用户需要平移图片来调整"裁切框内显示哪部分"）
  function canMoveImage() {
    if (!imgEl) return false;
    if (isCropped) return true; // 裁切后始终可拖动
    return displayedW < STAGE_W - 0.5 || displayedH < STAGE_H - 0.5;
  }
  function updateImgDrag() {
    if (!imgDrag) return;
    const p = annLayer.getRelativePointerPosition();
    if (!p) return;
    let nx = imgDrag.origX + (p.x - imgDrag.startX);
    let ny = imgDrag.origY + (p.y - imgDrag.startY);
    if (isCropped) {
      // 裁切模式：允许自由平移（含负偏移），让用户调整"裁切框内显示哪部分"
      // 不做硬限制，只做宽松的"不要完全移出可视区"提示（±3倍画板尺寸）
      nx = Math.min(STAGE_W * 2, Math.max(-displayedW + STAGE_W * 0.1, nx));
      ny = Math.min(STAGE_H * 2, Math.max(-displayedH + STAGE_H * 0.1, ny));
    } else {
      // 普通模式：限制在画板范围内
      nx = Math.max(0, Math.min(STAGE_W - displayedW, nx));
      ny = Math.max(0, Math.min(STAGE_H - displayedH, ny));
    }
    imgOffsetX = nx; imgOffsetY = ny;
    drawBoardBackground();
  }
  function endImgDrag() {
    const d = imgDrag; imgDrag = null;
    if (!d) return;
    // 位置确有变化时才记入撤销栈（记录移动前状态）
    if (imgOffsetX !== d.origX || imgOffsetY !== d.origY) {
      snapshot();
    }
  }
  function updateDrag() {
    if (!dragTarget) return;
    const p = annLayer.getRelativePointerPosition();
    if (!p) return;
    dragTarget.x(p.x - dragOffset.x);
    dragTarget.y(p.y - dragOffset.y);
    annLayer.batchDraw();
  }
  function endDrag() {
    if (!dragTarget) return;
    const id = dragTarget.id();
    dragTarget = null;
    syncGeomFromNode(id);
    // 不再拉回画板：允许标注移动到画板外，溢出部分由遮罩隐藏（与图片处理一致）
    if (tr.nodes().length) tr.forceUpdate();
    annLayer.batchDraw();
  }
  // 选择模式下，鼠标移到任意控件的矩形选区内 → 四向箭头光标（move）；锁定项 → not-allowed
  // 用包围盒命中检测统一覆盖所有控件类型（文字/箭头/矩形/编号/画笔等），不再依赖细线命中区
  function updateHoverCursor() {
    if (dragTarget) return; // 拖拽中由 updateDrag 维持光标
    if (tool === 'crop' && crop) {
      const p = annLayer.getRelativePointerPosition();
      if (p) {
        const hs = 10, tol = 7;
        for (let i = 0; i < 4; i++) {
          const hx = (i === 0 || i === 3) ? crop.x : crop.x + crop.w;
          const hy = (i === 0 || i === 1) ? crop.y : crop.y + crop.h;
          if (Math.abs(p.x - hx) <= hs / 2 + tol && Math.abs(p.y - hy) <= hs / 2 + tol) {
            _stageContainer.style.cursor = (i === 0 || i === 2) ? 'nwse-resize' : 'nesw-resize';
            return;
          }
        }
        if (p.x >= crop.x && p.x <= crop.x + crop.w && p.y >= crop.y && p.y <= crop.y + crop.h) {
          _stageContainer.style.cursor = 'move'; return;
        }
      }
      _stageContainer.style.cursor = 'crosshair'; return;
    }
    if (tool !== 'select' || spaceDown || isPanning || drawing) {
      // 绘制工具悬停时显示十字光标；平移/拖拽时光标由各自逻辑维持
      if (!spaceDown && !isPanning && !dragTarget && !drawing) {
        _stageContainer.style.cursor = (tool === 'select' ? '' : 'crosshair');
      }
      return;
    }
    const p = annLayer.getRelativePointerPosition();
    if (!p) { _stageContainer.style.cursor = ''; return; }
    let hit = null;
    for (const id in nodes) {
      const a = annotations.find((x) => x.id === id);
      if (!a) continue;
      const r = nodes[id].getClientRect({ relativeTo: annLayer });
      if (p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height) {
        hit = a; break;
      }
    }
    if (hit) { _stageContainer.style.cursor = hit.locked ? 'not-allowed' : 'move'; return; }
    // 无标注命中时：图片可移动且指针在图片上 → 抓手光标
    if (canMoveImage() && p.x >= imgOffsetX && p.x <= imgOffsetX + displayedW && p.y >= imgOffsetY && p.y <= imgOffsetY + displayedH) {
      _stageContainer.style.cursor = 'grab'; return;
    }
    _stageContainer.style.cursor = '';
  }
  // 光标反馈已统一交由全局 updateHoverCursor（按包围盒命中）处理

  // ---------- 画布缩放（滚轮，以指针为锚点） ----------
  let stageScale = 1;
  const MIN_SCALE = 0.2, MAX_SCALE = 8, SCALE_STEP = 1.08;
  function updateZoomLabel() {
    const el = $('zoomLabel');
    if (el) el.textContent = Math.round(stageScale * 100) + '%';
  }
  function applyZoom(newScale, center) {
    newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
    const oldScale = stage.scaleX();
    const pointer = center || stage.getPointerPosition();
    if (!pointer) return;
    const mousePointTo = {
      x: (pointer.x - stage.x()) / oldScale,
      y: (pointer.y - stage.y()) / oldScale,
    };
    stage.scale({ x: newScale, y: newScale });
    stage.position({
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale,
    });
    stageScale = newScale;
    stage.batchDraw();
    updateZoomLabel();
  }
  function resetZoom() {
    fitBoardToView();
  }
  // 用原生 DOM 监听 wheel，避免依赖 Konva 在 wheel 事件中是否更新指针坐标
  // （某些 Konva 版本下 getPointerPosition() 在 wheel 时返回 null，导致缩放失效）
  function getContainerPointer(evt) {
    const rect = stage.container().getBoundingClientRect();
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  }
  const _stageContainer = stage.container();
  _stageContainer.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dy = e.deltaY;
    applyZoom(stage.scaleX() * (dy > 0 ? SCALE_STEP : 1 / SCALE_STEP), getContainerPointer(e));
  }, { passive: false });

  // ---------- 画布平移（放大后拖动查看） ----------
  // 触发方式：① 中键拖拽 ② 按住空格 + 左键拖拽
  let spaceDown = false;
  let isPanning = false;
  let panOrigin = null;
  function startPan(clientX, clientY) {
    isPanning = true;
    panOrigin = { mx: clientX, my: clientY, sx: stage.x(), sy: stage.y() };
    _stageContainer.style.cursor = 'grabbing';
  }
  function doPan(clientX, clientY) {
    if (!isPanning) return;
    stage.position({ x: panOrigin.sx + (clientX - panOrigin.mx), y: panOrigin.sy + (clientY - panOrigin.my) });
    stage.batchDraw();
  }
  function endPan() {
    if (!isPanning) return;
    isPanning = false;
    _stageContainer.style.cursor = spaceDown ? 'grab' : '';
  }
  _stageContainer.addEventListener('mousedown', (e) => {
    const wantPan = e.button === 1 || (e.button === 0 && spaceDown);
    if (wantPan) { e.preventDefault(); startPan(e.clientX, e.clientY); }
  });
  window.addEventListener('mousemove', (e) => doPan(e.clientX, e.clientY));
  window.addEventListener('mouseup', endPan);
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && spaceDown) {
      spaceDown = false;
      _stageContainer.style.cursor = '';
    }
  });
  // 基础像素倍率：原图像素 / 显示尺寸（1× = 原图分辨率）。SVG 等无 naturalWidth 时退回 displayedW。
  function basePixelRatio() {
    const nw = (imgEl && (imgEl.naturalWidth || imgEl.width)) || displayedW;
    return (displayedW > 0 && nw) ? nw / displayedW : 1;
  }
  // 按当前倍率计算导出尺寸（像素）。
  function exportDims(scale) {
    const pr = basePixelRatio() * (scale || exportScale);
    return { w: Math.max(1, Math.round(STAGE_W * pr)), h: Math.max(1, Math.round(STAGE_H * pr)) };
  }
  // 截取当前画布为图片（导出/复制时临时复位缩放，始终按用户设定的分辨率倍率）
  function captureDataURL(scale) {
    const sc = (scale != null) ? scale : exportScale;
    const prevScale = stage.scaleX();
    const prevPos = stage.position();
    // 导出时隐藏“仅编辑视图”的元素（透明棋盘格、画板边缘描边），保证导出的是真实内容
    const hide = bgLayer.find('.noexport');
    const vis = hide.map((n) => n.visible());
    // 用 try/finally 保证即使 toDataURL 抛异常，也一定还原 stage 的缩放/位置与隐藏元素，
    // 否则画布会卡在「缩放=1、位置复位」的错位状态，后续绘制全部跟着歪。
    try {
      hide.forEach((n) => n.visible(false));
      stage.scale({ x: 1, y: 1 });
      stage.position({ x: 0, y: 0 });
      stage.batchDraw();
      const p = edgePad();
      // 像素倍率 = 基础倍率 × 用户倍率（exportScale）。scale 可临时覆盖（如复制/保存沿用当前设置）。
      const pr = basePixelRatio() * sc;
      // 只截取画板本体（避开四周 EDGE_PAD 留白与边缘框），导出真实内容
      const uri = stage.toDataURL({ x: p, y: p, width: STAGE_W, height: STAGE_H, pixelRatio: pr, mimeType: 'image/png' });
      return uri;
    } finally {
      hide.forEach((n, i) => n.visible(vis[i]));
      stage.scale({ x: prevScale, y: prevScale });
      stage.position(prevPos);
      stage.batchDraw();
    }
  }

  function startDraw(type, p) {
    // 不再钳制到画板内：允许标注超出画板，超出部分由 maskLayer 遮罩隐藏（与图片处理一致）
    const id = 'a_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const a = { id, type, text: '', style: { ...style }, geometry: {}, visible: true, locked: false, createdAt: new Date().toISOString() };
    let node;
    if (type === 'rect' || type === 'highlight' || type === 'mosaic') {
      const bgOp = (style.bgOpacity != null) ? style.bgOpacity : 1;
      const radius = (style.radius != null) ? style.radius : 0;
      const common = type === 'highlight'
        ? { fill: hexToRgba(style.bg || 'rgba(255,77,79,0.18)', bgOp), cornerRadius: 0 }
        : type === 'mosaic'
          ? { fillPatternImage: mosaicTile, fillPatternRepeat: 'repeat', opacity: 0.6 }
          : { stroke: style.stroke, strokeWidth: style.strokeWidth, fill: hexToRgba(style.bg || 'rgba(255,77,79,0.18)', bgOp), cornerRadius: 0 };
      node = new Konva.Rect({ x: p.x, y: p.y, width: 0, height: 0, ...common });
      a.geometry = { x: p.x, y: p.y, width: 0, height: 0, radius };
    } else if (type === 'arrow') {
      node = makeArrow([p.x, p.y, p.x, p.y], style.stroke, style.strokeWidth, style.radius);
      a.geometry = { points: [p.x, p.y, p.x, p.y] };
    } else if (type === 'free') {
      // tension=0：纯折线段连接，不使用样条/贝塞尔。
      // 原因：tension>0 时曲线会在控制点包围盒外"鼓出"，即使所有点都已钳制到画板范围内，
      //       快速转向或边缘密集点仍会导致笔画大幅画出界（用户已反馈多次）。
      node = new Konva.Line({ points: [p.x, p.y], stroke: style.stroke, strokeWidth: style.strokeWidth, lineCap: 'round', lineJoin: 'round', tension: 0 });
      a.geometry = { points: [p.x, p.y] };
    }
    node.draggable(false); node.id(id);
    annLayer.add(node); nodes[id] = node;
    drawing = { a, node, startX: p.x, startY: p.y, startPts: [p.x, p.y, p.x, p.y] };
  }

  function updateDraw() {
    const p0 = annLayer.getRelativePointerPosition();
    if (!p0) return;
    const p = p0; // 不钳制：允许绘制超出画板，溢出部分由遮罩隐藏
    const { a, node } = drawing;
    if (a.type === 'rect' || a.type === 'highlight' || a.type === 'mosaic') {
      const x = Math.min(drawing.startX, p.x), y = Math.min(drawing.startY, p.y);
      const w = Math.abs(p.x - drawing.startX), h = Math.abs(p.y - drawing.startY);
      node.x(x); node.y(y); node.width(w); node.height(h);
      if (typeof node.cornerRadius === 'function') node.cornerRadius(radiusPx(style.radius, w, h));
      a.geometry = { x, y, width: w, height: h, radius: style.radius };
    } else if (a.type === 'arrow') {
      node.points([drawing.startPts[0], drawing.startPts[1], p.x, p.y]);
      a.geometry.points = [drawing.startPts[0], drawing.startPts[1], p.x, p.y];
    } else if (a.type === 'free') {
      const pts = node.points();
      const lastX = pts[pts.length - 2], lastY = pts[pts.length - 1];
      // 去重：若采样点与上一个点完全相同（鼠标未移动），跳过以避免点堆积
      if (p.x === lastX && p.y === lastY) return;
      pts.push(p.x, p.y);
      node.points(pts); a.geometry.points = pts;
    }
    annLayer.batchDraw();
  }

  function finishDraw() {
    let { a, node } = drawing;
    drawing = null;
    const g = a.geometry;
    const tiny = (a.type === 'rect' || a.type === 'highlight' || a.type === 'mosaic')
      ? (g.width < 3 && g.height < 3)
      : (a.type === 'arrow' ? Math.hypot(g.points[2] - g.points[0], g.points[3] - g.points[1]) < 5
        : (a.type === 'free' && g.points.length <= 2));
    if (tiny) { node.destroy(); delete nodes[a.id]; annLayer.batchDraw(); return; }
    if (a.type === 'mosaic') { const r = renderMosaicNode(node, a); if (r && r !== node) { node.destroy(); annLayer.add(r); nodes[a.id] = node = r; node.id(a.id); node.draggable(false); } } // 拖完再采样底图，得到真实马赛克/磨砂
    a.name = allocName(a.type); // 在落笔成功（非取消）后分配「功能+序号」名称，避免取消时浪费序号
    annotations.push(a);
    node.draggable(false);
    renderList(); snapshot(); annLayer.batchDraw();
  }

  // ---------- 裁剪 / 画板 ----------
  // 画板背景：颜色/透明 + 原图（真实画布坐标，用于普通模式与退出裁剪后重绘）
  // 透明模式用“棋盘格”指示（仅编辑视图，导出时隐藏 → 真正透明）；
  // 裁剪后的画板边缘画一圈描边，明确裁切边界（导出时一并隐藏，不烤进 PNG）。
  function drawBoardBackground() {
    bgLayer.destroyChildren();
    if (!boardTransparent) {
      bgLayer.add(new Konva.Rect({ x: 0, y: 0, width: STAGE_W, height: STAGE_H, fill: boardColor, listening: false }));
    } else {
      const ck = new Konva.Rect({ name: 'noexport', x: 0, y: 0, width: STAGE_W, height: STAGE_H, listening: false });
      ck.fillPatternImage(checkerTile);
      ck.fillPatternRepeat('repeat');
      bgLayer.add(ck);
    }
    if (imgEl) {
      // 非破坏性：完整底图按当前偏移/缩放绘制，画板外部分由 maskLayer 遮罩盖住（不裁剪、不栅格化）
      bgLayer.add(new Konva.Image({ image: imgEl, x: imgOffsetX, y: imgOffsetY, width: displayedW, height: displayedH, listening: false }));
    }
    bgLayer.draw();
    drawMask(); // 同步画板外遮罩（与底图一起刷新）
  }
  // 当前工作区背景色（主题自适应）：遮罩用同色填充，使画板外区域与周围工作区无缝衔接
  function workspaceColor() {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--bg-elev-2').trim();
      if (v) return v;
    } catch (e) {}
    return '#1b1f2e';
  }
  // 工作区实际底色（读取 .stage-wrap 的计算背景色，忽略点阵图案）：非裁切态遮罩用它无缝衔接
  function stageBgColor() {
    try {
      const w = document.querySelector('.stage-wrap');
      if (w) {
        const c = getComputedStyle(w).backgroundColor;
        if (c && c !== 'transparent' && c !== 'rgba(0, 0, 0, 0)') return c;
      }
    } catch (e) {}
    return '#0a0c11';
  }
  // 画板外遮罩填充色：裁切态用较亮的工作面板色（--bg-elev-2）形成明显“裁切外框”；
  // 非裁切态用工作区底色，使画板外区域与周围无缝衔接（看不出遮罩）。
  function maskFill() { return isCropped ? workspaceColor() : stageBgColor(); }
  // 画板外遮罩：始终盖住画板外部区域，使超出画板的标注/图片不可见但数据不丢失（与图片处理方式一致）；
  // 移动图片/标注时遮罩相对画板固定，内容在遮罩下方平移 → 自然露出/隐藏画板外部分。
  function drawMask() {
    maskLayer.destroyChildren();
    const fill = maskFill();
    const BIG = Math.max(STAGE_W, STAGE_H, 6000);
    const add = (cfg) => maskLayer.add(new Konva.Rect(Object.assign({ name: 'noexport', listening: false, fill }, cfg)));
    // 四边矩形精确覆盖画板外区域（画板内部 [0,STAGE_W]×[0,STAGE_H] 留空）
    add({ x: -BIG, y: -BIG, width: BIG, height: BIG * 2 + STAGE_H });   // 左（含上下延伸）
    add({ x: STAGE_W, y: -BIG, width: BIG, height: BIG * 2 + STAGE_H }); // 右
    add({ x: 0, y: -BIG, width: STAGE_W, height: BIG });               // 上
    add({ x: 0, y: STAGE_H, width: STAGE_W, height: BIG });            // 下
    maskLayer.batchDraw();
  }
  // 裁剪显示：直接在真实画布坐标（图片大小）上呈现，选区外暗化 + 蓝色虚线选框，清晰指示裁切区域
  // 允许选区超出画布（原图）范围：超出部分在预览中提示“含透明区”，应用后以透明棋盘格（或用户指定颜色）呈现
  function drawCropUI() {
    cropLayer.destroyChildren();
    if (tool !== 'crop' || !crop) { cropLayer.batchDraw(); return; }
    const x = crop.x, y = crop.y, w = crop.w, h = crop.h;
    const dim = 'rgba(8,10,16,1)'; // 几乎全黑：选区外彻底盖住，预览即所见即裁切结果
    // 选区与画布的交集（用于盖住“选区之外”、高亮“选区之内”的可见部分）
    const ix1 = Math.max(0, x), iy1 = Math.max(0, y), ix2 = Math.min(STAGE_W, x + w), iy2 = Math.min(STAGE_H, y + h);
    // 选区之外的画布区域统一用不透明遮罩盖住（不依赖 Konva 对 Image 的裁剪）
    if (iy1 > 0) cropLayer.add(new Konva.Rect({ x: 0, y: 0, width: STAGE_W, height: iy1, fill: dim, listening: false }));
    if (iy2 < STAGE_H) cropLayer.add(new Konva.Rect({ x: 0, y: iy2, width: STAGE_W, height: STAGE_H - iy2, fill: dim, listening: false }));
    if (ix1 > 0) cropLayer.add(new Konva.Rect({ x: 0, y: iy1, width: ix1, height: iy2 - iy1, fill: dim, listening: false }));
    if (ix2 < STAGE_W) cropLayer.add(new Konva.Rect({ x: ix2, y: iy1, width: STAGE_W - ix2, height: iy2 - iy1, fill: dim, listening: false }));
    // 选区内（画布内交集）半透明高亮，提示“此处将保留”
    if (ix2 > ix1 && iy2 > iy1) cropLayer.add(new Konva.Rect({ x: ix1, y: iy1, width: ix2 - ix1, height: iy2 - iy1, fill: 'rgba(124,140,255,0.10)', listening: false }));
    // 选区边框（允许超出画布，超出部分自动被画布裁剪）
    cropLayer.add(new Konva.Rect({ x, y, width: w, height: h, stroke: '#7c8cff', strokeWidth: 1.5, dash: [6, 4], listening: false }));
    // 吸附指示：若某条边已对齐图片边缘，用绿色实线高亮，提示已“吸附”到位
    const IL = imgOffsetX, IR = imgOffsetX + displayedW, IT = imgOffsetY, IB = imgOffsetY + displayedH;
    const L = x, R = x + w, T = y, B = y + h;
    const snapLine = (ax, ay, bx, by, on) => { if (on) cropLayer.add(new Konva.Line({ points: [ax, ay, bx, by], stroke: '#3ad29f', strokeWidth: 2.5, listening: false })); };
    snapLine(L, T, L, B, Math.abs(L - IL) <= SNAP_THR || Math.abs(L - IR) <= SNAP_THR);
    snapLine(R, T, R, B, Math.abs(R - IL) <= SNAP_THR || Math.abs(R - IR) <= SNAP_THR);
    snapLine(L, T, R, T, Math.abs(T - IT) <= SNAP_THR || Math.abs(T - IB) <= SNAP_THR);
    snapLine(L, B, R, B, Math.abs(B - IT) <= SNAP_THR || Math.abs(B - IB) <= SNAP_THR);
    // 四角手柄（超出画布的部分不可见，但仍可拖拽）
    const hs = 10;
    for (let i = 0; i < 4; i++) {
      const hx = (i === 0 || i === 3) ? x : x + w;
      const hy = (i === 0 || i === 1) ? y : y + h;
      const cx = Math.max(hs / 2, Math.min(STAGE_W - hs / 2, hx));
      const cy = Math.max(hs / 2, Math.min(STAGE_H - hs / 2, hy));
      cropLayer.add(new Konva.Rect({ x: cx - hs / 2, y: cy - hs / 2, width: hs, height: hs, fill: '#fff', stroke: '#7c8cff', strokeWidth: 1.5, listening: false }));
    }
    // 尺寸标签 + 超出原图提示
    const beyond = (x < 0 || y < 0 || x + w > STAGE_W || y + h > STAGE_H);
    cropLayer.add(new Konva.Text({
      x: Math.max(2, Math.min(x, STAGE_W - 2)),
      y: Math.max(2, iy1 - 18),
      text: `${Math.round(w)} × ${Math.round(h)}` + (beyond ? '  (含透明区)' : ''),
      fontSize: 12, fill: '#fff', shadowColor: '#000', shadowBlur: 3, listening: false,
    }));
    cropLayer.batchDraw();
    updateBoardHint(beyond);
  }
  function updateBoardHint(beyond) {
    const el = $('boardHint');
    if (!el) return;
    el.textContent = beyond
      ? '裁剪范围已超出原图：超出部分将显示为透明（棋盘格），可在下方切换为纯色。'
      : '在画布上拖拽框选裁剪区域，或手动输入画板尺寸（可超出原图范围）。';
  }
  function syncBoardInputs() {
    if (!crop) {
      $('boardX').value = 0; $('boardY').value = 0;
      $('boardW').value = STAGE_W; $('boardH').value = STAGE_H;
      return;
    }
    $('boardX').value = Math.round(crop.x);
    $('boardY').value = Math.round(crop.y);
    $('boardW').value = Math.round(crop.w);
    $('boardH').value = Math.round(crop.h);
  }
  function applyBoardInputs() {
    const x = parseInt($('boardX').value, 10);
    const y = parseInt($('boardY').value, 10);
    let w = parseInt($('boardW').value, 10);
    let h = parseInt($('boardH').value, 10);
    if (isNaN(x) || isNaN(y)) return;
    if (isNaN(w) || w < 1) w = 1;
    if (isNaN(h) || h < 1) h = 1;
    crop = { x, y, w, h };
    drawBoardBackground(); drawCropUI();
  }
  function cropMouseDown(e, p) {
    if (crop) {
      const hs = 10, tol = 7;
      for (let i = 0; i < 4; i++) {
        const hx = (i === 0 || i === 3) ? crop.x : crop.x + crop.w;
        const hy = (i === 0 || i === 1) ? crop.y : crop.y + crop.h;
        if (Math.abs(p.x - hx) <= hs / 2 + tol && Math.abs(p.y - hy) <= hs / 2 + tol) {
          cropDrag = { mode: 'resize', handle: i, startX: p.x, startY: p.y, orig: { ...crop } };
          return;
        }
      }
      if (p.x >= crop.x && p.x <= crop.x + crop.w && p.y >= crop.y && p.y <= crop.y + crop.h) {
        cropDrag = { mode: 'move', startX: p.x, startY: p.y, orig: { ...crop } };
        return;
      }
    }
    crop = { x: p.x, y: p.y, w: 0, h: 0 };
    cropDrag = { mode: 'draw', startX: p.x, startY: p.y };
    drawCropUI(); syncBoardInputs();
  }
  // 将数值 v 吸附到 a 或 b（距离 <= 阈值时），否则原样返回
  function snapVal(v, a, b) {
    if (Math.abs(v - a) <= SNAP_THR) return a;
    if (Math.abs(v - b) <= SNAP_THR) return b;
    return v;
  }
  // 把裁剪矩形的四条边吸附到图片四边（防止边缘白条），超出图片的部分仍允许保留
  function snapCropRect(rc) {
    const IL = imgOffsetX, IR = imgOffsetX + displayedW;
    const IT = imgOffsetY, IB = imgOffsetY + displayedH;
    let left = snapVal(rc.x, IL, IR);
    let right = snapVal(rc.x + rc.w, IL, IR);
    let top = snapVal(rc.y, IT, IB);
    let bottom = snapVal(rc.y + rc.h, IT, IB);
    if (left > right) { const t = left; left = right; right = t; }
    if (top > bottom) { const t = top; top = bottom; bottom = t; }
    return { x: left, y: top, w: Math.max(1, right - left), h: Math.max(1, bottom - top) };
  }
  function updateCrop() {
    if (!cropDrag) return;
    const p = annLayer.getRelativePointerPosition();
    if (!p) return;
    const m = cropDrag.mode;
    if (m === 'draw') {
      crop = {
        x: Math.min(cropDrag.startX, p.x), y: Math.min(cropDrag.startY, p.y),
        w: Math.abs(p.x - cropDrag.startX), h: Math.abs(p.y - cropDrag.startY),
      };
    } else if (m === 'move') {
      const nx = cropDrag.orig.x + (p.x - cropDrag.startX);
      const ny = cropDrag.orig.y + (p.y - cropDrag.startY);
      crop = { ...cropDrag.orig, x: nx, y: ny };
    } else if (m === 'resize') {
      const o = cropDrag.orig, i = cropDrag.handle;
      let left = o.x, top = o.y, right = o.x + o.w, bottom = o.y + o.h;
      if (i === 0) { left = p.x; top = p.y; }
      else if (i === 1) { right = p.x; top = p.y; }
      else if (i === 2) { right = p.x; bottom = p.y; }
      else { left = p.x; bottom = p.y; }
      const nl = Math.min(left, right), nr = Math.max(left, right);
      const nt = Math.min(top, bottom), nb = Math.max(top, bottom);
      crop = { x: nl, y: nt, w: Math.max(1, nr - nl), h: Math.max(1, nb - nt) };
    }
    crop = snapCropRect(crop);
    drawBoardBackground(); // 裁切拖拽中实时更新图片 clip 区域
    drawCropUI(); syncBoardInputs();
  }
  function endCrop() {
    cropDrag = null;
    if (crop && crop.w < 3 && crop.h < 3) { crop = null; drawCropUI(); syncBoardInputs(); }
    annLayer.batchDraw();
  }
  // 整体平移所有标注（board 坐标系）：裁切时底图平移了 (-cx,-cy)，标注必须同步平移，
  // 否则标注会相对图片发生偏移（视觉上"标记跑位"）。与图片一起移动，保持二者相对位置不变。
  function shiftAnnotations(dx, dy) {
    annotations.forEach((a) => {
      const g = a.geometry;
      if (!g) return;
      if (g.points) {
        // 箭头/画笔：points 为绝对 board 坐标，逐点平移
        g.points = g.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy));
      } else {
        if (g.x != null) g.x += dx;
        if (g.y != null) g.y += dy;
      }
    });
  }
  function applyCrop() {
    if (!crop || crop.w < 1 || crop.h < 1) { toast('请先在画布上拖拽框选裁剪区域'); return; }
    const cx = Math.round(crop.x), cy = Math.round(crop.y), cw = Math.round(crop.w), ch = Math.round(crop.h);
    // 非破坏性裁剪（裁剪视窗）：只把画板尺寸收为选区大小，并把底图整体平移，
    // 使选区左上角对齐到画板原点 (0,0)。底图 imgEl 与 displayedW/H 保持不变 ——
    //   ① 画板之外的内容只是被遮罩盖住、并未删除，拖动图片即可露出其他部分；
    //   ② 矢量文件始终保持矢量，绝不会被像素化/栅格化。
    imgOffsetX -= cx;
    imgOffsetY -= cy;
    shiftAnnotations(-cx, -cy); // 标注随底图同步平移，避免裁切后标记相对图片偏移
    STAGE_W = cw; STAGE_H = ch;
    isCropped = true; // 先标记裁切状态，再 applyStageSize（更新层位置 + 遮罩）
    applyStageSize();
    drawBoardBackground(); // 重绘底图与画板外遮罩
    // 标注不做删除：画板外的标注由遮罩隐藏，需要时可拖动图片/标注回到画板内。
    crop = null; cropDrag = null;
    setTool('select');
    // 裁切后保持「选区内容」在屏幕上位置不变：只收小画板并平移底图，
    // 不再调用 resetZoom()（否则画板会被重新居中缩放，整图跳到画板中央，不符合预期）。
    // 旧：选区左上角 board 坐标 (cx,cy)，屏幕位置 = stageScale * (edgePad_old + cx) + stage.x()
    // 新：选区左上角已对齐到 board 原点 (0,0)，屏幕位置 = stageScale * (edgePad_new + 0) + newX
    // 令二者相等 → newX = stage.x() + stageScale * (cx - edgePad_new)
    const s0 = stage.scaleX();
    stage.position({
      x: stage.x() + s0 * (cx - edgePad()),
      y: stage.y() + s0 * (cy - edgePad()),
    });
    stage.batchDraw();
    updateZoomLabel();
    renderAll();
    snapshot(); // 提交当前状态（裁剪视窗），撤销可回到裁切前
    toast('已应用裁剪：画板外内容已隐藏，拖动图片可查看其余部分');
  }
  function clearCrop() {
    crop = null; cropDrag = null;
    drawBoardBackground(); drawCropUI(); syncBoardInputs();
  }

  // 自定义文字输入浮层（替代不支持的 window.prompt）
  function askText(title, def) {
    return new Promise((resolve) => {
      const modal = $('textModal'), input = $('textModalInput');
      $('textModalTitle').textContent = title || '输入文字';
      input.value = def || '';
      modal.style.display = 'flex';
      setTimeout(() => { input.focus(); input.select(); }, 0);
      let done = false;
      const cleanup = () => {
        modal.style.display = 'none';
        $('textModalOk').removeEventListener('click', onOk);
        $('textModalCancel').removeEventListener('click', onCancel);
        input.removeEventListener('keydown', onKey);
      };
      const onOk = () => { if (done) return; done = true; cleanup(); resolve(input.value); };
      const onCancel = () => { if (done) return; done = true; cleanup(); resolve(null); };
      const onKey = (e) => {
        // 回车换行（textarea 默认行为）；Ctrl/Cmd+Enter 确认；Esc 取消
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onOk(); }
        else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      };
      $('textModalOk').addEventListener('click', onOk);
      $('textModalCancel').addEventListener('click', onCancel);
      input.addEventListener('keydown', onKey);
    });
  }

  function showInfo(title, text) {
    $('infoModalTitle').textContent = title || '信息';
    $('infoModalBody').textContent = text;
    $('infoModal').style.display = 'flex';
  }

  async function createTextAt(p) {
    const txt = await askText('输入标注文字', '');
    if (txt === null) return;
    // 不钳制：允许文本落在画板外，溢出部分由遮罩隐藏
    const id = 'a_' + Date.now();
    const a = { id, type: 'text', text: txt, name: allocName('text'), style: { ...style }, geometry: { x: p.x, y: p.y }, visible: true, locked: false, createdAt: new Date().toISOString() };
    const node = buildTextGroup(a);
    node.id(id);
    node.draggable(false);
    annLayer.add(node); nodes[id] = node;
    annotations.push(a);
    renderList(); snapshot(); annLayer.batchDraw();
    setTool('select'); selectNode(a.id);
    toast('已添加文本，可直接用鼠标拖动调整位置');
  }

  // 编号工具限定在画板内创建：以 (x,y) 为圆心、r 为半径的整圆必须完全落在画板 [0,STAGE_W]×[0,STAGE_H] 内
  function isInsideBoard(x, y, r) {
    return x - r >= 0 && y - r >= 0 && x + r <= STAGE_W && y + r <= STAGE_H;
  }
  function createNumberAt(p) {
    const fs = style.fontSize || 18;
    const r = Math.max(8, fs * 0.9); // 圆角半径随字号等比放大 → 整体大小由字号控制
    const cx = p.x, cy = p.y;
    // 编号不允许创建在画板之外：整圆越界则拒绝并提示（浮动提示显示在画板上方 10px 处）
    if (!isInsideBoard(cx, cy, r)) {
      showBoardTip('编号必须创建在画板范围内');
      return;
    }
    const id = 'a_' + Date.now();
    const name = allocName('number'); // 递增 seqCounters.number 并返回「编号NN」
    const a = { id, type: 'number', text: String(seqCounters.number), name: name, style: { ...style }, geometry: { x: cx - r, y: cy - r }, visible: true, locked: false, createdAt: new Date().toISOString() };
    const node = createNode(a); // 复用统一渲染（圆形描边=前景色、背景不透明度默认 0）
    annLayer.add(node); nodes[id] = node; annotations.push(a);
    renderList(); snapshot(); annLayer.batchDraw();
  }

  // 水印：点击画布放置一个水印标注（平铺铺满画板；居中/单角为可拖动的单个标记）。
  // 点击位置仅用于单角/居中在“已拖动”前的初始参考；实际排布由布局决定。
  function createWatermarkAt(p) {
    const isLogo = (style.wmType === 'logo');
    if (isLogo && !style.logoDataURL) { toast('请先在右侧「水印设置」上传 Logo 图片'); return; }
    if (!isLogo) wmLastText = ((wmLastText || '').trim()) || '水印';
    const id = 'a_' + Date.now();
    const a = {
      id, type: 'watermark',
      text: isLogo ? '' : wmLastText,
      name: allocName('watermark'),
      style: { ...style },
      geometry: {}, // 由 buildWatermarkNode 按布局填充
      visible: true, locked: false, createdAt: new Date().toISOString(),
    };
    const node = createNode(a);
    if (!node) { toast('无法创建水印'); return; }
    annLayer.add(node); nodes[id] = node; annotations.push(a);
    renderList(); snapshot(); annLayer.batchDraw();
    setTool('select'); selectNode(id);
    toast('已添加水印：' + a.name);
  }

  // ---------- 几何同步 / 变换 ----------
  tr.on('transformend', () => {
    const n = tr.nodes()[0];
    if (n) syncGeomFromNode(n.id());
  });

  function syncGeomFromNode(id) {
    const a = annotations.find((x) => x.id === id);
    let n = nodes[id];
    if (!a || !n) return;
    const g = a.geometry;
    if (a.type === 'arrow' || a.type === 'free') {
      // 拖拽/变换可能给节点加了平移(x,y)与缩放，统一并入 points 并复位自身变换
      const dx = n.x() || 0, dy = n.y() || 0;
      const sx = n.scaleX() || 1, sy = n.scaleY() || 1;
      const pts = (n.points() || []).map((v, i) => (i % 2 === 0 ? v * sx + dx : v * sy + dy));
      n.scaleX(1); n.scaleY(1); n.x(0); n.y(0); n.points(pts); g.points = pts;
    } else if (a.type === 'text' || a.type === 'number') {
      g.x = n.x(); g.y = n.y();
    } else if (a.type === 'watermark') {
      // 平铺水印固定铺满画板（拖拽无效，复位到 0,0）；居中/单角记录拖后位置并标记为“已放置”
      if ((a.style && a.style.wmLayout || 'tile') === 'tile') {
        n.x(0); n.y(0);
        g.x = 0; g.y = 0; g.width = STAGE_W; g.height = STAGE_H;
      } else {
        g.x = n.x(); g.y = n.y(); g._placed = true;
      }
    } else if (a.type === 'mosaic') {
      // 缩放后需把 scale 烘焙进几何尺寸，否则下次重绘会还原（Transformer 缩放失效）；
      // 复用同一节点/Group 实例重采样贴图，避免节点被替换导致 Transformer 失联/飞移
      g.x = n.x(); g.y = n.y();
      const sx = n.scaleX() || 1, sy = n.scaleY() || 1;
      if (g.width != null) g.width = Math.max(1, g.width * sx);
      if (g.height != null) g.height = Math.max(1, g.height * sy);
      n.scaleX(1); n.scaleY(1); n.x(g.x); n.y(g.y);
      renderMosaicNode(n, a);
    } else {
      g.x = n.x(); g.y = n.y();
      g.width = n.width() * (n.scaleX() || 1);
      g.height = n.height() * (n.scaleY() || 1);
      n.scaleX(1); n.scaleY(1); n.width(g.width); n.height(g.height);
      // 圆角是百分比：缩放后按新短边重算像素半径，保证"药丸"在任意尺寸都成立
      if ((a.type === 'rect' || a.type === 'highlight') && typeof n.cornerRadius === 'function') {
        n.cornerRadius(radiusPx(a.style && a.style.radius, g.width, g.height));
      }
    }
    annLayer.batchDraw();
    snapshot();
  }

  // ---------- 列表操作 ----------
  function toggleVisible(id) {
    const a = annotations.find((x) => x.id === id); if (!a) return;
    a.visible = a.visible === false;
    if (nodes[id]) nodes[id].visible(a.visible !== false);
    if (selectedId === id) { const ev = $('edVis'); if (ev) ev.textContent = a.visible === false ? '显示' : '隐藏'; }
    annLayer.batchDraw(); renderList(); snapshot();
  }
  function toggleLock(id) {
    const a = annotations.find((x) => x.id === id); if (!a) return;
    a.locked = !a.locked;
    const el = $('edLock'); if (el && selectedId === id) el.textContent = a.locked ? '解锁' : '锁定';
    renderList(); snapshot();
  }
  function deleteAnnotation(id) {
    const a = annotations.find((x) => x.id === id); if (!a) return;
    if (nodes[id]) nodes[id].destroy();
    delete nodes[id];
    annotations = annotations.filter((x) => x.id !== id);
    recalcCounters(); // 重新计算各类型计数器，避免删除中间项后新建编号与现存编号重名
    if (selectedId === id) { selectedId = null; tr.nodes([]); showEditor(null); updateTextCtlVisibility(); }
    annLayer.batchDraw(); renderList(); snapshot();
  }

  // ---------- 撤销 / 重做 ----------
  // 快照同时记录标注与画板（裁剪）状态，使撤销/重做能正确还原画布尺寸与底色
  function captureDoc() {
    return {
      annotations,
      counters: { ...seqCounters },
      board: { w: STAGE_W, h: STAGE_H, dispW: displayedW, dispH: displayedH, imgX: imgOffsetX, imgY: imgOffsetY, cropped: isCropped, color: boardColor, transparent: boardTransparent },
    };
  }
  function restoreDoc(doc) {
    annotations = doc.annotations || [];
    if (doc.counters) seqCounters = { ...doc.counters };
    const b = doc.board || {};
    STAGE_W = b.w != null ? b.w : STAGE_W;
    STAGE_H = b.h != null ? b.h : STAGE_H;
    displayedW = b.dispW != null ? b.dispW : displayedW;
    displayedH = b.dispH != null ? b.dispH : displayedH;
    imgOffsetX = b.imgX || 0; imgOffsetY = b.imgY || 0;
    isCropped = !!b.cropped;
    boardColor = b.color || '#ffffff';
    boardTransparent = b.transparent !== false;
    applyStageSize();
    drawBoardBackground();
    crop = null; cropDrag = null;
    fitBoardToView();
    renderAll();
  }
  // 提交当前实时状态：截断 redo 分支后追加到栈尾，并把 histIndex 移到末尾。
  // 这样任何一次"提交"都成为新的"当前状态"，撤销时只需向前一步。
  function snapshot() {
    if (histIndex < history.length - 1) history = history.slice(0, histIndex + 1);
    history.push(JSON.stringify(captureDoc()));
    if (history.length > 60) history.shift();
    histIndex = history.length - 1;
  }
  function undo() {
    if (histIndex <= 0) return;
    histIndex -= 1;
    restoreDoc(JSON.parse(history[histIndex]));
    recalcCounters();
    selectedId = null; tr.nodes([]); showEditor(null); updateTextCtlVisibility(); renderList();
  }
  function redo() {
    if (histIndex >= history.length - 1) return;
    histIndex += 1;
    restoreDoc(JSON.parse(history[histIndex]));
    recalcCounters();
    selectedId = null; tr.nodes([]); showEditor(null); updateTextCtlVisibility(); renderList();
  }
  // 重新计算各类型标注的序号计数器：取现存标注名称末尾数字后缀的最大值。
  // 这样删除中间项 / 撤销删除后，再新建编号不会与现存编号重名（修复旧版仅对 number 做 -1 导致的碰撞）。
  function recalcCounters() {
    const max = {};
    annotations.forEach((a) => {
      if (!a.type) return;
      const m = String(a.name || '').match(/(\d+)$/);
      if (m) max[a.type] = Math.max(max[a.type] || 0, parseInt(m[1], 10));
    });
    Object.keys(max).forEach((t) => { seqCounters[t] = max[t]; });
  }

  // ---------- 导出 ----------
  function exportPNG() {
    if (!imgEl) { toast('图片尚未加载完成'); return; }
    openResModal(); // 点击「导出 PNG」→ 先弹分辨率设置，确认后再真正导出
  }
  const DIR_KEY = 'ea_export_dir';
  // 系统下载文件夹（Node 环境用 os.homedir + Downloads；纯浏览器无法获知精确路径时返回 ''）
  function defaultDownloadDir() {
    try {
      if (typeof require === 'function') {
        const os = require('os'); const path = require('path');
        return path.join(os.homedir(), 'Downloads');
      }
    } catch (e) {}
    return '';
  }
  function loadExportDir() {
    try { const v = localStorage.getItem(DIR_KEY); if (v) return v; } catch (e) {}
    return defaultDownloadDir();
  }
  function saveExportDir(v) {
    try { localStorage.setItem(DIR_KEY, (v || '').trim()); } catch (e) {}
  }
  // data URL → Uint8Array（供 Node fs.writeFileSync 直接写入目标文件夹）
  function dataURLToBuffer(dataURL) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(dataURL);
    if (!m) throw new Error('图片数据格式不支持');
    const bin = atob(m[2]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  // 选择导出文件夹：Node/桌面环境用原生目录选择框；否则（纯浏览器）回退 prompt 手动输入
  async function pickFolder(current) {
    if (EABridge.isTauri) {
      const p = await EABridge.pickFolder(current);
      if (p) return p;
      // Tauri 选择器取消时回退 prompt，避免空路径
    }
    try {
      const p = window.prompt('请输入目标文件夹路径', current || '');
      return (p && p.trim()) ? p.trim() : null;
    } catch (e) { return null; }
  }
  // 打开指定文件夹（folder 缺省时回退系统下载文件夹）；Node 环境可用 require 调系统命令，纯浏览器静默失败
  async function openExportFolder(folder) {
    // 从完整文件路径中提取目录（如 C:\Users\Desktop\sample.png → C:\Users\Desktop）
    if (folder) {
      var lastSep = Math.max(folder.lastIndexOf('/'), folder.lastIndexOf('\\'));
      if (lastSep > 0 && lastSep < folder.length - 1) { folder = folder.substring(0, lastSep); }
    }
    try {
      if (EABridge.isTauri && folder) {
        const ok = await EABridge.openPath(folder); // 桌面端：用系统文件管理器打开
        if (ok) return;
        // 自动打开失败：弹出路径提示,让用户手动前往(不再静默无反馈)
      }
    } catch (e) {
      console.warn('openPath 异常', e);
    }
    // 无论 Tauri 命令成功/失败/异常，只要到了这里就给用户可见反馈：
    var msg = folder ? '无法自动打开文件夹，请手动前往：\n\n' + folder : '未记录保存位置';
    try { showOk('打开文件夹', msg); } catch (_) { alert(msg); }
  }
  // 目标文件夹内若已存在同名文件，则追加递增序号（name (1).png / name (2).png …），避免直接覆盖
  function uniqueExportPath(targetDir, name) {
    if (!targetDir || typeof require !== 'function') return name;
    try {
      const fs = require('fs');
      const path = require('path');
      const ext = path.extname(name);
      const base = path.basename(name, ext);
      let candidate = path.join(targetDir, name);
      let n = 1;
      while (fs.existsSync(candidate)) {
        candidate = path.join(targetDir, base + ' (' + n + ')' + ext);
        n++;
      }
      return candidate;
    } catch (e) {
      return name; // 取不到 fs/path 时退化为原始名（仍是覆盖，但环境极少见）
    }
  }
  // 分辨率设置面板确认后执行真正导出（沿用面板中已选定/持久化的 exportScale）
  async function doExportPNG() {
    if (!imgEl) return;
    const baseName = currentItem ? String(currentItem.name).replace(/\.[^.]+$/, '') : 'annotated';
    const name = (baseName || 'annotated') + '.png';
    let targetDir = ($('resDirInput').value || '').trim();
    if (!targetDir) targetDir = defaultDownloadDir();
    // 大图导出时 toDataURL（同步渲染画布）与保存都可能在主线程卡顿数秒，
    // 先显示「导出中」遮罩并等一帧渲染，再执行重活，避免用户以为程序卡死。
    showExporting('正在生成图片，请稍候…');
    let savedPath = null;
    let finalName = name;
    try {
      await nextFrame();
      // 分辨率上限检查：canvas toDataURL 单边超过浏览器上限可能导出失败或空白，自动降级到上限
      const dims = exportDims(exportScale);
      let usedScale = exportScale;
      let capNote = '';
      if (dims.w > MAX_EXPORT_DIM || dims.h > MAX_EXPORT_DIM) {
        const maxDim = Math.max(dims.w, dims.h);
        usedScale = exportScale * (MAX_EXPORT_DIM / maxDim);
        const cd = exportDims(usedScale);
        capNote = '\n\n（提示：您选择的导出分辨率 ' + dims.w + '×' + dims.h +
          ' 像素超出了浏览器支持上限 ' + MAX_EXPORT_DIM + '×' + MAX_EXPORT_DIM +
          '，已自动调整为最大支持分辨率 ' + cd.w + '×' + cd.h + ' 像素。）';
      }
      const uri = captureDataURL(usedScale); // 同步重活，遮罩已显示在前一帧
      if (!uri || typeof uri !== 'string' || uri.indexOf('data:image') !== 0) {
        throw new Error('生成图片数据失败（画布内容为空或格式不支持）');
      }
      updateExporting('正在保存文件…');
      await nextFrame();
      if (EABridge.isTauri) {
        if (targetDir) {
          // 面板已选好导出文件夹：直接写入该目录，不再弹原生保存对话框。
          // 若写入失败（目录无效/权限不足/被 fs 作用域拒绝等）直接报错，
          // 不再回退原生保存对话框——否则会出现“选了文件夹仍弹系统框”的体验。
          const p = await EABridge.saveDataUrlToDir(uri, targetDir, name);
          if (p) { savedPath = p; finalName = p.split(/[\\/]/).pop(); }
          else { throw new Error('无法写入所选目录（路径无效或不可写）'); }
        } else {
          // 未选文件夹：用原生保存对话框（默认落桌面）
          const p = await EABridge.saveDataUrl(uri, name);
          if (p) { savedPath = p; finalName = p.split(/[\\/]/).pop(); }
          else { await downloadURI(uri, name); savedPath = null; }
        }
      } else if (targetDir && typeof require === 'function') {
        try {
          const fs = require('fs');
          const path = require('path');
          if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
          const finalPath = uniqueExportPath(targetDir, name);
          fs.writeFileSync(finalPath, dataURLToBuffer(uri));
          savedPath = finalPath;
          finalName = path.basename(finalPath);
        } catch (we) {
          console.warn('写入目标文件夹失败，回退浏览器下载：', we);
          await downloadURI(uri, name);
          savedPath = null;
        }
      } else {
        await downloadURI(uri, name); // 纯浏览器预览：落浏览器默认下载目录
      }
      hideExporting();
      const locText = savedPath
        ? savedPath
        : (targetDir ? ('「' + targetDir + '」或浏览器默认下载目录') : '浏览器默认下载目录');
      showOk('导出成功',
        'PNG 已成功导出。\n\n文件名：' + finalName +
        '\n保存位置：' + locText + capNote,
        { withFolder: true, onFolderClick: () => openExportFolder(savedPath || targetDir) });
    } catch (e) {
      hideExporting();
      // 用户在系统保存对话框点了「取消」= 主动放弃，静默中止，不弹「导出失败」误报
      if (e && (e.canceled || e.name === 'SaveCanceledError' || /cancel|取消/i.test(e.message || ''))) {
        return;
      }
      console.error('导出 PNG 失败:', e);
      showOk('导出失败', '导出 PNG 失败：\n' + (e && e.message ? e.message : String(e)));
    }
  }
  async function copyClipboard() {
    if (!imgEl) return;
    // 分辨率上限检查（与 doExportPNG 一致，避免复制超高分辨率导致静默失败）
    const dims = exportDims(exportScale);
    let usedScale = exportScale;
    if (dims.w > MAX_EXPORT_DIM || dims.h > MAX_EXPORT_DIM) {
      const maxDim = Math.max(dims.w, dims.h);
      usedScale = exportScale * (MAX_EXPORT_DIM / maxDim);
    }
    // 大图 toDataURL 是同步阻塞主线程的重活，先显示遮罩再生成，避免界面“假死”引发恐慌
    showExporting('正在复制图片…');
    await nextFrame();
    const uri = captureDataURL(usedScale);
    hideExporting();
    try {
      const blob = await (await fetch(uri)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('已复制到剪贴板');
    } catch (e) {
      downloadURI(uri, 'annotated.png');
      toast('剪贴板不可用，已改为下载');
    }
  }
  // 下载导出的图片。关键点：把 data URL 转成 Blob 再用 object URL 触发下载，
  // 避免超大 / 高倍率 PNG 直接塞进 a.href 触发浏览器对 URL 长度/大小的上限而静默失败（B4 修复）。
  // 返回 Promise，便于调用方（doExportPNG）用 try/catch 捕获异常并提示失败原因。
  function downloadURI(uri, name) {
    if (uri && typeof uri === 'string' && uri.indexOf('data:') === 0) {
      return fetch(uri).then((r) => r.blob()).then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 4000);
      }).catch((e) => {
        console.warn('Blob 下载失败，回退 a.href：', e);
        const a = document.createElement('a');
        a.href = uri; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      });
    }
    if (!uri || typeof uri !== 'string') return Promise.resolve();
    const a = document.createElement('a');
    a.href = uri; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    return Promise.resolve();
  }
  // 让浏览器先完成一次绘制（双 rAF），常用于「执行重活前先展示遮罩」，
  // 避免主线程被同步任务（如大图 toDataURL）阻塞时界面毫无反馈。
  function nextFrame() {
    return new Promise((res) => {
      requestAnimationFrame(() => requestAnimationFrame(res));
    });
  }
  // 导出大图时的「导出中」遮罩：覆盖 toDataURL 与保存的同步阻塞，避免用户误以为卡死。
  function showExporting(msg) {
    const ov = $('exportOverlay');
    if (!ov) return;
    const sub = $('exportSub');
    if (sub && msg) sub.textContent = msg;
    ov.style.display = 'flex';
  }
  function updateExporting(msg) {
    const sub = $('exportSub');
    if (sub && msg) sub.textContent = msg;
  }
  function hideExporting() {
    const ov = $('exportOverlay');
    if (ov) ov.style.display = 'none';
  }
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t.__t); t.__t = setTimeout(() => t.classList.remove('show'), 1500);
  }
  // 画板上方的浮动提示：固定在「画板顶部上方 10px」居中显示，确保创建编号越界时用户能看到
  function showBoardTip(msg) {
    const tip = $('boardTip');
    if (!tip) return;
    tip.textContent = msg;
    const boardTop = stage.y() + stage.scaleY() * edgePad(); // 画板顶边在 stage-wrap 内的相对位置
    tip.classList.add('show');
    const h = tip.offsetHeight || 30;
    const above = boardTop - 10; // 期望提示框底边位于画板上方 10px 处
    if (above - h >= 4) {
      tip.style.top = above + 'px';
      tip.style.transform = 'translate(-50%, -100%)';
    } else {
      // 画板太靠顶、上方空间不足时，固定在 stage-wrap 顶端（仍位于画板上方，保证可见）
      tip.style.top = '6px';
      tip.style.transform = 'translate(-50%, 0)';
    }
    clearTimeout(tip.__t); tip.__t = setTimeout(() => tip.classList.remove('show'), 1600);
  }

  // 主题切换：深色(dark) / 浅色(light，暖灰)。偏好存 localStorage，下次启动沿用。
  const THEME_KEY = 'ea_theme';
  const ICON_MOON = '<svg id="themeIcon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" fill="currentColor"/></svg>';
  const ICON_SUN = '<svg id="themeIcon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="4.6" fill="none" stroke="currentColor" stroke-width="2"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="2.5" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="21.5"/><line x1="2.5" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="21.5" y2="12"/><line x1="5.2" y1="5.2" x2="6.9" y2="6.9"/><line x1="17.1" y1="17.1" x2="18.8" y2="18.8"/><line x1="5.2" y1="18.8" x2="6.9" y2="17.1"/><line x1="17.1" y1="6.9" x2="18.8" y2="5.2"/></g></svg>';
  function applyTheme(t) {
    const theme = (t === 'light') ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
    const btn = $('btnTheme');
    if (btn) btn.innerHTML = (theme === 'light') ? ICON_SUN : ICON_MOON; // 图标表示当前主题：太阳=浅色，月亮=深色
    // 画板外遮罩用工作区背景色填充，主题切换后需重绘以同步遮罩颜色
    if (typeof bgLayer !== 'undefined') { try { drawBoardBackground(); } catch (e) {} }
  }
  function initTheme() {
    let saved = 'dark';
    try { saved = localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) {}
    applyTheme(saved);
  }
  // 需手动点击「确定」才能关闭的提示框（用于保存成功等关键反馈）
  // opts 可选：{ withFolder: false, onFolderClick: null } — 显示「打开文件夹」按钮
  function showOk(title, msg, opts) {
    $('okModalTitle').textContent = title || '提示';
    $('okModalBody').textContent = msg || '';
    const fb = $('okModalFolder');
    if (opts && opts.withFolder && typeof opts.onFolderClick === 'function') {
      fb.style.display = '';
      fb.onclick = opts.onFolderClick;
    } else {
      fb.style.display = 'none';
      fb.onclick = null;
    }
    $('okModal').style.display = 'flex';
  }
  function closeOk() { $('okModal').style.display = 'none'; }

  // ---------- 导出分辨率设置 ----------
  function fmtRes(scale) {
    const d = exportDims(scale);
    const tag = (scale === 1) ? '（1× 原图）' : '';
    return `${d.w} × ${d.h} 像素${tag}`;
  }
  function refreshResPreview() {
    const pv = $('resPreview');
    if (pv) pv.textContent = '输出尺寸：' + fmtRes(exportScale);
  }
  function markResPreset() {
    const chips = document.querySelectorAll('#resPresets .res-chip');
    chips.forEach((c) => {
      const s = parseFloat(c.getAttribute('data-scale'));
      c.classList.toggle('sel', Math.abs(s - exportScale) < 1e-6);
    });
  }
  function setResScale(s) {
    if (!(s > 0)) return;
    exportScale = s;
    try { localStorage.setItem(RES_KEY, String(s)); } catch (e) {}
    refreshResPreview();
    markResPreset();
    const wi = $('resWidthInput'); if (wi) wi.value = '';
  }
  function openResModal() {
    markResPreset();
    refreshResPreview();
    const di = $('resDirInput'); if (di) di.value = loadExportDir();
    $('resModal').style.display = 'flex';
  }
  function closeResModal() { $('resModal').style.display = 'none'; }

  // ---------- 图片导入 ----------
  function importLocalImages(fileList) {
    const files = Array.from(fileList || []).filter((f) => (f.type || '').indexOf('image/') === 0);
    if (!files.length) { toast('请选择图片文件'); return; }
    const file = files[0];
    const reader = new FileReader();
    reader.onload = async () => {
      const dataURL = reader.result;
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const item = { id: 'local-' + Date.now(), name: file.name, fileURL: dataURL, isLocal: true, tags: [], size: file.size || 0, ext: ext };
      await openItem(item);
      toast(files.length > 1 ? '已导入首张图片（MVP 仅支持单图）' : '已导入本地图片，开始标注吧');
    };
    reader.onerror = () => toast('读取文件失败');
    reader.readAsDataURL(file);
  }
  // ---------- 事件绑定 ----------
  function bindEvents() {
    document.querySelectorAll('.tool').forEach((btn) => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });
    // 颜色应用（前景=stroke，背景=bg），供预设圆与系统调色板共用
    function applyColor(target, value) {
      if (target === 'bg') {
        style.bg = value;
      } else {
        style.stroke = value;
      }
      refreshSelectedStyle();
    }
    // 圆形预设：单击=选中并应用该色（边缘加粗）；再次单击同一圆=弹出系统调色板
    document.querySelectorAll('.presets').forEach((group) => {
      const target = group.dataset.target;
      const picker = group.querySelector('.picker');
      const presets = Array.from(group.querySelectorAll('.preset'));
      let selected = null;
      presets.forEach((btn) => {
        btn.addEventListener('click', () => {
          if (selected === btn) {
            picker.value = btn.dataset.color; // 已选中 → 再点弹出调色板
            picker.click();
          } else {
            presets.forEach((p) => p.classList.remove('selected'));
            btn.classList.add('selected');
            selected = btn;
            applyColor(target, btn.dataset.color);
          }
        });
      });
      picker.addEventListener('input', (e) => {
        const v = e.target.value;
        if (selected) { selected.dataset.color = v; selected.style.background = v; }
        applyColor(target, v);
      });
    });
  // 初始化所有滑块轨道填充
  document.querySelectorAll('input[type="range"]').forEach(fillSliderTrack);

  $('sw').addEventListener('input', (e) => { style.strokeWidth = +e.target.value; $('swVal').textContent = e.target.value; fillSliderTrack(e.target); refreshSelectedStyle(); });
  $('fs').addEventListener('input', (e) => { style.fontSize = +e.target.value; $('fsVal').textContent = e.target.value; fillSliderTrack(e.target); refreshSelectedStyle(); });
    $('bgOpacity').addEventListener('input', (e) => {
      let v = +e.target.value;
      if (tool === 'highlight') v = Math.max(50, v); // 高亮透明度上限 50%（不透明度下限 50%）
      style.bgOpacity = v / 100;
      $('bgOpacityVal').textContent = v;
      fillSliderTrack(e.target);
      refreshSelectedStyle();
    });
    $('radius').addEventListener('input', (e) => { style.radius = +e.target.value; $('radiusVal').textContent = e.target.value; fillSliderTrack(e.target); refreshSelectedStyle(); });
    // 画板（裁剪）控件
    ['boardX', 'boardY', 'boardW', 'boardH'].forEach((id) => {
      $(id).addEventListener('input', applyBoardInputs);
    });
    document.querySelectorAll('input[name="boardMode"]').forEach((r) => r.addEventListener('change', (e) => {
      boardTransparent = (e.target.value === 'transparent');
      $('boardColorRow').style.display = boardTransparent ? 'none' : 'flex';
      drawBoardBackground();
    }));
    $('boardColor').addEventListener('input', (e) => { boardColor = e.target.value; drawBoardBackground(); });
    $('btnApplyCrop').addEventListener('click', applyCrop);
    $('btnClearCrop').addEventListener('click', clearCrop);
    // 马赛克样式：马赛克 / 磨砂玻璃（单选）→ 切换下方滑动条含义
    document.querySelectorAll('input[name="mosaicStyle"]').forEach((r) => r.addEventListener('change', (e) => {
      style.mosaicStyle = e.target.value;
      syncMosaicParamUI(style); // 切换“马赛克大小 / 磨砂强度”标签与取值
      refreshSelectedStyle();
    }));
    // 马赛克参数滑动条：马赛克样式=大小；磨砂玻璃=强度（实时跟随面板刷新）
    $('mosaicParam').addEventListener('input', (e) => {
      const v = +e.target.value;
      $('mosaicParamVal').textContent = v;
      if ((style.mosaicStyle || 'pixel') === 'frost') style.frostStrength = v / 100;
      else style.mosaicSize = v;
      fillSliderTrack(e.target);
      refreshSelectedStyle();
    });
    // ---------- 水印面板 ----------
    // 当前选中的水印标注（若有）——面板改动需同时作用到它
    const selWater = () => {
      if (!selectedId) return null;
      const a = annotations.find((x) => x.id === selectedId);
      return (a && a.type === 'watermark') ? a : null;
    };
    // 类型：文字 / Logo 图片
    document.querySelectorAll('input[name="wmType"]').forEach((r) => r.addEventListener('change', (e) => {
      style.wmType = e.target.value;
      const isLogo = (style.wmType === 'logo');
      $('wmTextRow').style.display = isLogo ? 'none' : 'flex';
      $('wmLogoRow').style.display = isLogo ? 'flex' : 'none';
      refreshSelectedStyle();
    }));
    // 水印文字内容
    $('wmText').addEventListener('input', (e) => {
      const v = e.target.value;
      wmLastText = v;
      const a = selWater();
      if (a) { a.text = v; refreshSelectedStyle(); }
    });
    // 布局：单角 / 居中 / 平铺（切换时清除“已放置”标记，让单角/居中回到默认排布）
    document.querySelectorAll('input[name="wmLayout"]').forEach((r) => r.addEventListener('change', (e) => {
      style.wmLayout = e.target.value;
      const lbl = $('wmGapLabel'); if (lbl) lbl.textContent = (style.wmLayout === 'corner') ? '边距' : '间距';
      const a = selWater();
      if (a) { a.geometry = {}; refreshSelectedStyle(); }
    }));
    // 透明度
    $('wmOpacity').addEventListener('input', (e) => {
      const v = +e.target.value;
      style.wmOpacity = v / 100;
      $('wmOpacityVal').textContent = v;
      fillSliderTrack(e.target);
      refreshSelectedStyle();
    });
    // 角度
    $('wmAngle').addEventListener('input', (e) => {
      const v = +e.target.value;
      style.wmAngle = v;
      $('wmAngleVal').textContent = v;
      fillSliderTrack(e.target);
      refreshSelectedStyle();
    });
    // 间距 / 边距
    $('wmGap').addEventListener('input', (e) => {
      const v = +e.target.value;
      style.wmGap = v;
      $('wmGapVal').textContent = v;
      fillSliderTrack(e.target);
      refreshSelectedStyle();
    });
    // 上传 Logo：缩放 ≤512px 后存入 style.logoDataURL（防草稿撑爆），并自动切到 Logo 类型
    $('wmLogoBtn').addEventListener('click', () => $('wmLogoInput').click());
    $('wmLogoInput').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      scaleLogoFile(f, (dataURL) => {
        if (!dataURL) { toast('Logo 读取失败，请换一张图片'); return; }
        style.logoDataURL = dataURL;
        style.wmType = 'logo';
        loadWmLogo(dataURL); // 预解码，加载完成后自动重绘
        const rt = document.querySelector('input[name="wmType"][value="logo"]'); if (rt) rt.checked = true;
        $('wmTextRow').style.display = 'none';
        $('wmLogoRow').style.display = 'flex';
        const prev = $('wmLogoPreview'); if (prev) { prev.src = dataURL; prev.style.display = 'inline-block'; }
        const a = selWater();
        if (a) { a.style = { ...a.style, logoDataURL: dataURL, wmType: 'logo' }; refreshSelectedStyle(); }
        toast('Logo 已就绪，点击画布放置水印');
      });
    });
    $('searchInput').addEventListener('input', renderList);
    // 搜索框：默认收起为图标，点击展开并聚焦；失焦且内容为空时收起
    const searchBox = document.querySelector('.search-box');
    searchBox.addEventListener('click', (e) => {
      if (!searchBox.classList.contains('open')) {
        searchBox.classList.add('open');
        $('searchInput').focus();
      }
    });
    $('searchInput').addEventListener('blur', () => {
      if (!$('searchInput').value.trim()) searchBox.classList.remove('open');
    });
    $('btnUndo').addEventListener('click', undo);
    $('btnRedo').addEventListener('click', redo);
    $('btnExport').addEventListener('click', exportPNG);
    $('btnCopy').addEventListener('click', copyClipboard);
    $('resCancel').addEventListener('click', closeResModal);
    $('resOk').addEventListener('click', () => { closeResModal(); doExportPNG(); });
    $('resModal').addEventListener('click', (e) => { if (e.target === $('resModal')) closeResModal(); });
    document.querySelectorAll('#resPresets .res-chip').forEach((chip) => {
      chip.addEventListener('click', () => setResScale(parseFloat(chip.getAttribute('data-scale'))));
    });
    $('resWidthApply').addEventListener('click', () => {
      const v = parseInt($('resWidthInput').value, 10);
      if (!(v > 0)) { toast('请输入有效的宽度'); return; }
      const base = STAGE_W * basePixelRatio(); // 1× 对应的输出宽度
      if (base <= 0) { toast('图片尚未就绪'); return; }
      setResScale(v / base);
    });
    $('resWidthInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('resWidthApply').click(); } });
    $('resDirInput').addEventListener('input', () => saveExportDir($('resDirInput').value));
    $('resDirBrowse').addEventListener('click', async () => {
      const picked = await pickFolder($('resDirInput').value);
      if (picked) { $('resDirInput').value = picked; saveExportDir(picked); }
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('resModal').style.display !== 'none') closeResModal();
    });
    $('btnZoomIn').addEventListener('click', () => applyZoom(stage.scaleX() * SCALE_STEP, { x: stage.width() / 2, y: stage.height() / 2 }));
    $('btnZoomOut').addEventListener('click', () => applyZoom(stage.scaleX() / SCALE_STEP, { x: stage.width() / 2, y: stage.height() / 2 }));
    $('btnZoomReset').addEventListener('click', resetZoom);
    $('zoomLabel').addEventListener('click', resetZoom);
    $('btnImportLocal').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => { importLocalImages(e.target.files); e.target.value = ''; });
    $('btnHelp').addEventListener('click', () => { $('helpModal').style.display = 'flex'; });
    $('helpModalClose').addEventListener('click', () => { $('helpModal').style.display = 'none'; });
    // 清除缓存：删除 localStorage 中的标注草稿，并同步清空当前画布（含撤销基线重置）
    $('btnClearCache').addEventListener('click', () => {
      const sure = (typeof window.confirm === 'function')
        ? window.confirm('确定清除所有本地缓存（已保存的标注草稿）吗？\n当前画布也会被清空，此操作不可撤销。')
        : true;
      if (!sure) return;
      try { if (EABridge.clearCache) EABridge.clearCache(); } catch (e) { console.warn('clearCache 失败', e); }
      // 同步清空内存中的文档，使清除立即生效
      annotations = [];
      try { Object.keys(nodes).forEach((id) => { try { nodes[id].destroy(); } catch (_) {} }); } catch (_) {}
      for (const k in nodes) delete nodes[k];
      selectedId = null;
      try { tr.nodes([]); } catch (_) {}
      showEditor(null);
      history.length = 0; histIndex = -1; snapshot();
      renderAll();
      if (typeof renderList === 'function') renderList();
      updateTextCtlVisibility();
      toast('缓存已清除');
      $('helpModal').style.display = 'none';
    });
    $('btnTheme').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      applyTheme(cur === 'light' ? 'dark' : 'light');
    });
    // 点击遮罩或按 Esc 关闭帮助
    $('helpModal').addEventListener('click', (e) => { if (e.target === $('helpModal')) $('helpModal').style.display = 'none'; });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('helpModal').style.display !== 'none') $('helpModal').style.display = 'none'; });
    $('infoModalClose').addEventListener('click', () => { $('infoModal').style.display = 'none'; });
    $('okModalBtn').addEventListener('click', closeOk);
    $('infoModalCopy').addEventListener('click', () => {
      const t = $('infoModalBody').textContent;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(() => toast('已复制'), () => toast('复制失败，请手动选择'));
      } else {
        const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); toast('已复制'); } catch (e) { toast('复制失败，请手动选择'); }
        document.body.removeChild(ta);
      }
    });
    const wrap = document.querySelector('.stage-wrap');
    if (wrap) {
      wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('drag'); });
      wrap.addEventListener('dragleave', () => wrap.classList.remove('drag'));
      wrap.addEventListener('drop', (e) => {
        e.preventDefault(); wrap.classList.remove('drag');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) importLocalImages(e.dataTransfer.files);
      });
    }
    $('edText').addEventListener('input', (e) => {
      const a = annotations.find((x) => x.id === selectedId); if (!a) return;
      a.text = e.target.value;
      const n = nodes[a.id];
      if (n && a.type === 'text') { rebuildTextGroup(n, a); annLayer.batchDraw(); }
      renderList();
    });
    $('edDelete').addEventListener('click', () => { if (selectedId) deleteAnnotation(selectedId); });
    $('edLock').addEventListener('click', () => { if (selectedId) toggleLock(selectedId); });
    $('edVis').addEventListener('click', () => { if (selectedId) toggleVisible(selectedId); });

    // 快捷键
    const isFormField = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    window.addEventListener('keydown', (e) => {
      if (isFormField(e.target)) return; // 在输入框/下拉里打字时，让原生撤销/重做等生效，不劫持全局快捷键
      if (e.code === 'Space') {
        e.preventDefault(); // 防止页面滚动
        if (!spaceDown) {
          spaceDown = true;
          _stageContainer.style.cursor = 'grab';
        }
        return;
      }
      const map = { r: 'rect', a: 'arrow', b: 'free', t: 'text', n: 'number', h: 'highlight', m: 'mosaic', w: 'watermark', v: 'select', c: 'crop' };
      const k = e.key.toLowerCase();
      // 工具切换仅在「未按 Ctrl/Cmd」时生效，否则会劫持 Ctrl+C / Ctrl+V 等系统快捷键（导致复制粘贴无效）
      if (map[k] && !e.ctrlKey && !e.metaKey) setTool(map[k]);
      // 撤销/重做：Ctrl/Cmd+Z 撤销；Ctrl/Cmd+Y 或 Ctrl/Cmd+Shift+Z 重做。
      // 用 e.code 兜底识别物理按键，兼容不同键盘布局下 e.key 为空/异常的情况。
      const keyName = (e.code === 'KeyZ') ? 'z' : (e.code === 'KeyY') ? 'y' : k;
      if ((e.ctrlKey || e.metaKey) && keyName === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && (keyName === 'y' || (keyName === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      // 画布缩放快捷键
      if ((e.ctrlKey || e.metaKey) && k === '=') { e.preventDefault(); applyZoom(stage.scaleX() * SCALE_STEP); }
      if ((e.ctrlKey || e.metaKey) && k === '-') { e.preventDefault(); applyZoom(stage.scaleX() / SCALE_STEP); }
      if ((e.ctrlKey || e.metaKey) && k === '0') { e.preventDefault(); resetZoom(); }
      // Delete / Backspace：删除当前选中的标注，等价于列表上的「删」按钮
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault();
        deleteAnnotation(selectedId);
      }
      // 复制：选中标注后 Ctrl/Cmd+C 复制（粘贴改由 paste 事件统一路由，见下方监听）
      if ((e.ctrlKey || e.metaKey) && k === 'c') { e.preventDefault(); copySelected(); }
      // 帮助：按 ? 打开使用说明（不与其他快捷键冲突）
      if (e.key === '?' ) { e.preventDefault(); $('helpModal').style.display = 'flex'; }
    });

    // 粘贴：系统剪贴板含图片 → 作为「图片」标注叠加到画布；否则若内部已复制标注且焦点不在输入框 → 粘贴标注副本
    document.addEventListener('paste', (e) => {
      const cd = e.clipboardData || (window.clipboardData && window.clipboardData);
      if (cd && cd.items) {
        for (const it of cd.items) {
          if (it.kind === 'file' && it.type && it.type.indexOf('image/') === 0) {
            e.preventDefault();
            if (EABridge.setPasteImageOk) EABridge.setPasteImageOk(true);
            pasteImageFile(it.getAsFile());
            return;
          }
        }
      }
      // 无图片：内部复制了标注且当前焦点不在可编辑输入 → 粘贴标注副本（保留原 Ctrl+V 行为）
      const tgt = e.target;
      const inEditable = tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable);
      if (pasteBuffer && !inEditable) { e.preventDefault(); pasteAnnotation(); }
    });

    // 窗口尺寸变化时：重新适配画布到容器（紧贴功能区）
    let resizeSnapTimer = null;
    window.addEventListener('resize', () => {
      if (isCropped) {
        fitBoardToView();
        const n = selectedId ? nodes[selectedId] : null;
        tr.nodes(n ? [n] : []);
        annLayer.batchDraw();
        return;
      }
      fitImage();  // 内部会调用 fitBoardToView
      // 缩放后把“当前显示尺寸 + 标注坐标”记入撤销历史，避免 Undo 直接跳回旧尺寸（B1）。
      // 连续 resize 防抖，避免历史被刷屏。
      if (resizeSnapTimer) clearTimeout(resizeSnapTimer);
      resizeSnapTimer = setTimeout(() => { snapshot(); }, 300);
    });
  }

  // 选中组件时，实时应用样式面板的改动（背景色/圆角/颜色/字号/线宽）
  function refreshSelectedStyle() {
    if (!selectedId) return;
    const a = annotations.find((x) => x.id === selectedId); if (!a) return;
    a.style = { ...a.style, ...style };
    const n = nodes[a.id]; if (!n) return;
    if (a.type === 'text') {
      rebuildTextGroup(n, a);
    } else if (a.type === 'rect' || a.type === 'highlight') {
      if (typeof n.cornerRadius === 'function') n.cornerRadius(radiusPx(style.radius, n.width() * (n.scaleX() || 1), n.height() * (n.scaleY() || 1)));
      if (a.type === 'rect' && typeof n.strokeWidth === 'function') n.strokeWidth(style.strokeWidth);
      // 内部填充 = 背景色（实时跟随面板）；背景透明度作用于填充 alpha
      if (typeof n.fill === 'function') n.fill(hexToRgba(style.bg || 'rgba(255,77,79,0.18)', (style.bgOpacity != null ? style.bgOpacity : 1)));
    } else if (a.type === 'number') {
      // 编号圆形 = 背景色，编号文字 = 前景色；字号实时驱动文字大小，圆角半径随字号等比放大（整体大小由字号控制）
      const fs = style.fontSize || 18;
      const r = Math.max(8, fs * 0.9);
      const t = n.findOne('Text');
      if (t && typeof t.fontSize === 'function') { t.fontSize(fs); t.x(-r); t.y(-fs / 2); t.width(2 * r); }
      if (t && typeof t.fill === 'function') t.fill(style.stroke);
      const c = n.findOne('Circle');
      if (c && typeof c.radius === 'function') c.radius(r);
      if (c && typeof c.fill === 'function') c.fill(hexToRgba(style.bg || 'rgba(255,77,79,0.18)', (style.bgOpacity != null ? style.bgOpacity : 1)));
      // 线宽调节编号圆形描边（可为 0），颜色跟随前景色
      if (c && typeof c.stroke === 'function') c.stroke(style.stroke);
      if (c && typeof c.strokeWidth === 'function') c.strokeWidth(style.strokeWidth != null ? style.strokeWidth : 0);
    } else if (a.type === 'arrow') {
      // 箭头：前景色/线宽实时跟随，圆角滑块控制头部与尾端圆度；头部尺寸随线宽等比缩放
      if (typeof n.stroke === 'function') { n.stroke(style.stroke); n.fill(style.stroke); }
      if (typeof n.strokeWidth === 'function') n.strokeWidth(style.strokeWidth);
      const { pl, pw } = arrowHead(style.strokeWidth || 3);
      if (typeof n.pointerLength === 'function') n.pointerLength(pl);
      if (typeof n.pointerWidth === 'function') n.pointerWidth(pw);
      const pct = Math.max(0, Math.min(100, style.radius || 0));
      n.setAttr('roundPct', pct);
      if (typeof n.lineCap === 'function') n.lineCap(pct > 0 ? 'round' : 'butt');
    } else if (a.type === 'free') {
      // 自由画笔：前景色 / 线宽实时跟随面板
      if (typeof n.stroke === 'function') n.stroke(style.stroke);
      if (typeof n.strokeWidth === 'function') n.strokeWidth(style.strokeWidth);
    } else if (a.type === 'mosaic') {
      // 就地刷新磨砂贴图（renderMosaicNode 会复用同一个 Group 实例，避免重建节点导致 Transformer 失联/飞移）
      const r = renderMosaicNode(n, a);
      if (r && r !== n) {
        // 仅“像素↔磨砂”切换时才会真正返回新 Group，需替换并重新挂接事件/Transformer
        const idx = annLayer.getChildren().indexOf(n);
        if (idx >= 0) { n.destroy(); annLayer.insertAt(r, idx); } else { n.destroy(); annLayer.add(r); }
        nodes[a.id] = r; r.id(a.id); r.draggable(false);
      }
      if (selectedId === a.id) tr.nodes([nodes[a.id]]);
    } else if (a.type === 'watermark') {
      // 水印整体重建（文字/Logo/布局/角度/透明度/间距任一变化都需重绘贴图与排布）
      const fresh = buildWatermarkNode(a);
      replaceAnnNode(a.id, fresh);
    }
    annLayer.batchDraw();
  }

  function setTool(t) {
    tool = t;
    tr.nodes([]); selectedId = null; showEditor(null);
    document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    // 仅当马赛克工具选中时，侧边栏显示其样式控件组
    const isMosaic = (t === 'mosaic');
    $('mosaicCtl').style.display = isMosaic ? 'block' : 'none';
    // 裁剪工具：显示"画板"面板与裁剪选框层；离开时清除选框（画布即图片，选区外暗化呈现）
    // 已裁剪为自定义画板后，也保持"画板"面板可见，方便用户随时切换 透明/颜色
    const isCrop = (t === 'crop');
    const showBoard = isCrop || isCropped;
    $('boardCtl').style.display = showBoard ? 'block' : 'none';
    cropLayer.visible(isCrop);
    if (!isCrop) { crop = null; cropDrag = null; }
    if (isCrop) { drawCropUI(); syncBoardInputs(); }
    // 背景不透明度：各工具进入时应用其默认值
    //   · 高亮：不透明度默认 70%（透明度 30%），且下限 50%
    //   · 编号：背景默认不透明 100%（实心圆，仍可用滑块调低为透明）
    //   · 矩形 / 文字：背景默认不透明 100%（避免用完编号后切回来仍是透明）
    if (t === 'highlight') {
      style.bgOpacity = 0.7;
      $('bgOpacity').min = 50;
    } else {
      $('bgOpacity').min = 0;
      if (t === 'rect' || t === 'text' || t === 'number') style.bgOpacity = 1;
    }
    // 同步背景不透明度滑块显示（反映当前工具默认值）
    if (style.bgOpacity != null) {
      const bv = Math.round(style.bgOpacity * 100);
      $('bgOpacity').value = bv; $('bgOpacityVal').textContent = bv; fillSliderTrack($('bgOpacity'));
    }
    // 统一刷新右侧面板/滑块显隐（按当前工具类型）
    applyCtxVisibility(t);
    renderList();
  }

  init();
});
