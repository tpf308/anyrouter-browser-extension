# AnyRouter 本地探测 host —— 卸载（只删注册表项，保留文件）
# 卸载后扩展会自动回退到浏览器 fetch 探测，扩展仍可正常使用。
#
# 用法：powershell -ExecutionPolicy Bypass -File uninstall.ps1

$ErrorActionPreference = "Stop"

$HostName = "com.anyrouter.probe"
$roots = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
)

$removed = 0
foreach ($key in $roots) {
  if (Test-Path $key) {
    Remove-Item -LiteralPath $key -Force -Recurse
    Write-Host "✓ 已移除 $key"
    $removed++
  }
}
if ($removed -eq 0) { Write-Host "未发现注册项（可能未安装）。" }

Write-Host ""
Write-Host "已卸载本地探测 host。扩展将自动回退到浏览器 fetch 探测。" -ForegroundColor Green
Write-Host "（host.ps1 / host.bat / 清单 / probe-config.json 文件已保留，可随时重新 install.ps1。）"
