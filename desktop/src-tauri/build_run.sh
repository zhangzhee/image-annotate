#!/usr/bin/env bash
cd "C:/Users/MR/Desktop/图片标注app/desktop/src-tauri"

# 装配 MSVC 构建环境（来自 vcvars64 导出）
while IFS= read -r line; do
  case "$line" in
    [A-Za-z_]*=*)
      key="${line%%=*}"
      case "$key" in *\(*|*\)*|*\ *) continue ;; esac
      val="${line#*=}"
      export "$key=$val"
      ;;
  esac
done < vcenv.txt
export CARGO_TARGET_DIR='C:\Users\MR\imgannot-target'
export PATH="/c/Users/MR/.workbuddy/binaries/node/versions/22.22.2:$PATH"

# === 方案A：下载并解压 WebView2 固定运行时（避免依赖系统 WebView2 自动更新 -> 消除 BITS 弹窗）===
WV_VER="1.0.2739.0"
WV_DIR="webview2"
WV_DLL="$WV_DIR/Microsoft.Web.WebView2.Core.dll"
if [ ! -f "$WV_DLL" ]; then
  echo "=== 下载 WebView2 固定运行时 $WV_VER ==="
  WV_CAB="/tmp/mswebview2_${WV_VER}.cab"
  WV_URL="https://msedgedownloadstorage.blob.core.windows.net/webview/${WV_VER}/x64/Microsoft.Web.WebView2.FixedVersionRuntime.${WV_VER}.x64.cab"
  curl -L -o "$WV_CAB" "$WV_URL" || { echo "下载失败，请手动下载 $WV_URL 并解压到 $WV_DIR"; exit 1; }
  echo "=== 解压 cab -> $WV_DIR ==="
  mkdir -p "$WV_DIR"
  WV_CAB_WIN=$(cygpath -w "$WV_CAB")
  WV_DIR_WIN=$(cygpath -w "$WV_DIR")
  powershell -NoProfile -Command "expand.exe -F:* '$WV_CAB_WIN' '$WV_DIR_WIN'" || { echo "解压失败，请手动用 expand.exe 解压 $WV_CAB 到 $WV_DIR"; exit 1; }
  rm -f "$WV_CAB"
  echo "WebView2 固定运行时已就绪: $WV_DIR"
else
  echo "WebView2 固定运行时已存在，跳过下载"
fi

# === 方案C：代码签名会在 tauri build 内通过 signCommand 调用 scripts/sign.ps1 ===
# 提供证书后，运行本脚本前请先设置环境变量：
#   export CODESIGN_PFX=/path/to/cert.pfx
#   export CODESIGN_PWD=证书密码
# 未设置时 sign.ps1 会自动跳过，构建仍可完成（产物为未签名）。

echo "=== tauri build (A+C: fixed WebView2 + codesign hook) ==="
npx --yes @tauri-apps/cli@latest build --target x86_64-pc-windows-msvc > build7.log 2>&1
echo "BUILD_DONE exit=$?"
