# 代码签名脚本（方案 C）
# 由 tauri.conf.json 的 bundle.windows.signCommand 调用：
#   powershell -ExecutionPolicy Bypass -File scripts/sign.ps1 $file
# Tauri 会把待签名文件路径替换到 $file。
#
# 使用前请确保已设置环境变量：
#   CODESIGN_PFX  = 代码签名证书(.pfx)的完整路径
#   CODESIGN_PWD  = 证书密码
# 未配置时本脚本仅输出警告并正常退出（不影响构建，产物为未签名状态）。

param(
  [Parameter(Position = 0, Mandatory = $true)]
  [string]$FilePath
)

$pfx = $env:CODESIGN_PFX
$pwd = $env:CODESIGN_PWD

if (-not $pfx -or -not (Test-Path $pfx)) {
  Write-Warning "CODESIGN_PFX 未配置或文件不存在，跳过代码签名。如需签名，请设置环境变量 CODESIGN_PFX（证书路径）与 CODESIGN_PWD（密码）。"
  exit 0
}

# 定位 signtool.exe（MSVC / Windows SDK 通常已在 PATH；否则兜底搜索）
$signtool = (Get-Command signtool.exe -ErrorAction SilentlyContinue).Source
if (-not $signtool) {
  $candidates = @(
    "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe",
    "C:\Program Files\Windows Kits\10\bin\*\x64\signtool.exe"
  )
  foreach ($pat in $candidates) {
    $hit = Resolve-Path $pat -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { $signtool = $hit.Path; break }
  }
}

if (-not $signtool) {
  Write-Warning "signtool.exe 未找到（请确认已安装 Windows SDK / MSVC 构建工具），跳过签名。"
  exit 0
}

& "$signtool" sign /f "$pfx" /p "$pwd" /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 "$FilePath"
if ($LASTEXITCODE -ne 0) {
  Write-Error "代码签名失败，signtool exit=$LASTEXITCODE"
  exit $LASTEXITCODE
}
Write-Host "已签名: $FilePath"
