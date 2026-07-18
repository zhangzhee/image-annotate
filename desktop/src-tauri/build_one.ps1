param(
  [Parameter(Mandatory=$true)][string]$variant
)
$ErrorActionPreference = 'Continue'
$root = "C:\Users\MR\Desktop\图片标注app"
Set-Location "$root\desktop\src-tauri"
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
$bundleDir = "C:\Users\MR\imgannot-target\x86_64-pc-windows-msvc\release\bundle\nsis"
$dest = "$root\desktop\release"
$logName = "build_$variant.log"
function Remove-WebViewInstallMode($text) {
  return $text -replace '(?s)\s*"webviewInstallMode":\s*\{[^}]*\},?', ''
}
if ($variant -eq 'online') {
  Set-Content $conf (Remove-WebViewInstallMode $origConf)
} else {
  Set-Content $conf $origConf
}
Write-Output ("CONFIG_SET_FOR=" + $variant)
npx --yes "@tauri-apps/cli@latest" build --target x86_64-pc-windows-msvc *> $logName
Write-Output ("BUILD_EXIT=" + $LASTEXITCODE)
$exe = Get-ChildItem $bundleDir -Filter "*.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($exe) {
  $name = if ($variant -eq 'online') { "图片标注_0.9.0_x64_在线WebView2_setup.exe" } else { "图片标注_0.9.0_x64_内置WebView2_setup.exe" }
  Copy-Item $exe.FullName (Join-Path $dest $name) -Force
  Write-Output ("COPIED=" + $name + " size=" + $exe.Length)
} else {
  Write-Output "EXE_MISSING"
}
Set-Content $conf $origConf
Write-Output "CONFIG_RESTORED"
Write-Output ("DONE_" + $variant)
