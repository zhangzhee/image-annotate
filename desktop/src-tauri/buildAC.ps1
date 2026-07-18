# buildAC.ps1 - download fixed WebView2 runtime + tauri build (plan A+C)
# All English content to avoid UTF-8-BOM codepage issues when sourced by powershell -File.

Get-Content ".\vcenv.txt" | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process") }
}
$env:CARGO_TARGET_DIR = "C:\Users\MR\imgannot-target"
$env:PATH = "C:\Users\MR\.workbuddy\binaries\node\versions\22.22.2;" + $env:PATH
Remove-Item Env:\CARGO_BUILD_TARGET -ErrorAction SilentlyContinue

$WV_VER = "1.0.2739.0"
$WV_DIR = "webview2"
$WV_DLL = Join-Path $WV_DIR "Microsoft.Web.WebView2.Core.dll"
if (-not (Test-Path $WV_DLL)) {
  $WV_URL = "https://msedgedownloadstorage.blob.core.windows.net/webview/$WV_VER/x64/Microsoft.Web.WebView2.FixedVersionRuntime.$WV_VER.x64.cab"
  $WV_CAB = Join-Path $env:TEMP ("mswebview2_" + $WV_VER + ".cab")
  Write-Output ("=== download WebView2 " + $WV_VER + " ===")
  # Download: on any failure, stop immediately with a clear error (do NOT continue to build).
  try {
    Invoke-WebRequest -Uri $WV_URL -OutFile $WV_CAB -TimeoutSec 600 -ErrorAction Stop
  } catch {
    Write-Output ("ERROR: WebView2 download failed: " + $_.Exception.Message)
    Write-Output ("HINT: proxy/CDN blocked, or version " + $WV_VER + " not found (404). Fix network or set a valid `$WV_VER (e.g. 1.0.2592.61), then rerun.")
    Write-Output "ABORT_NO_WEBVIEW2"
    exit 1
  }
  if (-not (Test-Path $WV_CAB) -or ((Get-Item $WV_CAB).Length -lt 1048576)) {
    Write-Output "ERROR: downloaded CAB missing or too small (<1MB), treated as failure."
    if (Test-Path $WV_CAB) { Remove-Item $WV_CAB -Force }
    Write-Output "ABORT_NO_WEBVIEW2"
    exit 1
  }
  Write-Output "=== expand cab ==="
  New-Item -ItemType Directory -Force -Path $WV_DIR | Out-Null
  $dst = Resolve-Path $WV_DIR
  expand.exe -F:* $WV_CAB $dst.Path | Out-Null
  Remove-Item $WV_CAB -Force
  # Verify the runtime actually extracted; only then report ready.
  $WV_DLL_CHECK = Get-ChildItem -Path $WV_DIR -Recurse -Filter "Microsoft.Web.WebView2.Core.dll" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $WV_DLL_CHECK) {
    Write-Output "ERROR: expand finished but Microsoft.Web.WebView2.Core.dll not found in webview2/. Runtime NOT ready."
    Write-Output "ABORT_NO_WEBVIEW2"
    exit 1
  }
  Write-Output ("webview2 runtime ready -> " + $WV_DLL_CHECK.FullName)
} else {
  Write-Output "webview2 exists, skip download"
}

Write-Output "=== tauri build (A+C: fixed WebView2 + codesign hook) ==="
npx --yes "@tauri-apps/cli@latest" build --target x86_64-pc-windows-msvc *> buildAC.log
Write-Output ("BUILD_DONE exit=" + $LASTEXITCODE)
