$ErrorActionPreference = 'Continue'
$root = "C:\Users\MR\Desktop\图片标注app"
Set-Location "$root\desktop\src-tauri"

# 加载 MSVC 编译环境（来自 vcenv.txt）
Get-Content .\vcenv.txt | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') {
    [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
  }
}
$env:CARGO_TARGET_DIR = "C:\Users\MR\imgannot-target"
$nodeDir = "C:\Users\MR\.workbuddy\binaries\node\versions\22.22.2"
$env:PATH = "$nodeDir;" + $env:PATH
Remove-Item Env:\CARGO_BUILD_TARGET -ErrorAction SilentlyContinue

$conf = "tauri.conf.json"
$origConf = Get-Content $conf -Raw
$bundleDir = "..\..\imgannot-target\x86_64-pc-windows-msvc\release\bundle\nsis"
$dest = "$root\desktop\release"

function Remove-WebViewInstallMode($text) {
  return $text -replace '(?s)\s*"webviewInstallMode":\s*\{[^}]*\},?', ''
}
function Get-BuiltExe {
  return Get-ChildItem $bundleDir -Filter "*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

# ===== Build 1: 内置 WebView2 版（当前配置含 webviewInstallMode）=====
Write-Output "=== BUILD 1: 内置 WebView2 版 ==="
npx --yes "@tauri-apps/cli@latest" build --target x86_64-pc-windows-msvc *> build_embed.log
Write-Output "EMBEDDED_BUILD_EXIT=$LASTEXITCODE"
$exe1 = Get-BuiltExe
if ($exe1) {
  $embedName = "图片标注_0.9.0_x64_内置WebView2_setup.exe"
  Copy-Item $exe1.FullName (Join-Path $dest $embedName) -Force
  Write-Output ("EMBEDDED_EXE_COPIED=" + $embedName + " size=" + $exe1.Length)
} else {
  Write-Output "EMBEDDED_EXE_MISSING"
}

# ===== Build 2: 在线 WebView2 版（移除 webviewInstallMode）=====
Write-Output "=== BUILD 2: 在线 WebView2 版 ==="
$online = Remove-WebViewInstallMode $origConf
Set-Content $conf $online
npx --yes "@tauri-apps/cli@latest" build --target x86_64-pc-windows-msvc *> build_online.log
Write-Output "ONLINE_BUILD_EXIT=$LASTEXITCODE"
$exe2 = Get-BuiltExe
if ($exe2) {
  $onlineName = "图片标注_0.9.0_x64_在线WebView2_setup.exe"
  Copy-Item $exe2.FullName (Join-Path $dest $onlineName) -Force
  Write-Output ("ONLINE_EXE_COPIED=" + $onlineName + " size=" + $exe2.Length)
} else {
  Write-Output "ONLINE_EXE_MISSING"
}

# ===== 恢复配置（保持仓库默认为内置版）=====
Set-Content $conf $origConf
Write-Output "CONFIG_RESTORED=1"
Write-Output "ALL_DONE"
