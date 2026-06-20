# AnyRouter 本地探测 host —— 一键安装（幂等，可重复运行）
#
# 作用：把本地 host 注册给 Chrome/Edge，使扩展能调它做「真实 CC 请求」探活。
# 安装顺序很重要：先在 chrome://extensions 重新加载扩展（加 key 后扩展 ID 已固定为下方 EXT_ID），
# 再运行本脚本。否则 allowed_origins 对不上、host 会拒连。
#
# 用法：右键「使用 PowerShell 运行」，或在本目录执行  powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = "Stop"

$HostName = "com.anyrouter.probe"
# 扩展 ID 由 manifest.json 的 "key" 派生而来，固定值（各机一致）
$ExtId = "hchkecljdlipiohlmjoeifpdeoigbkim"

$here = $PSScriptRoot
$hostBat = Join-Path $here "host.bat"
$manifestPath = Join-Path $here "$HostName.json"
$cfgPath = Join-Path $here "probe-config.json"

if (-not (Test-Path $hostBat)) { throw "未找到 host.bat：$hostBat" }

# ── 1. 生成 native host 清单（path 用绝对路径；UTF-8 无 BOM，避免 Chrome 解析异常）──
$manifest = [ordered]@{
  name            = $HostName
  description     = "AnyRouter opus probe native host"
  path            = $hostBat
  type            = "stdio"
  allowed_origins = @("chrome-extension://$ExtId/")
}
$json = $manifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "✓ 已写清单 $manifestPath"

# ── 2. 注册到 Chrome / Edge（默认值 = 清单绝对路径）──
$roots = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
)
foreach ($key in $roots) {
  New-Item -Path $key -Force | Out-Null
  Set-Item -LiteralPath $key -Value $manifestPath
  Write-Host "✓ 已注册 $key"
}

# ── 3. 默认代理配置（仅在缺失时创建；主站走 Clash socks、大陆直连默认直连，可自行修改）──
if (-not (Test-Path $cfgPath)) {
  $cfg = [ordered]@{ proxyMain = "socks5h://127.0.0.1:7897"; proxyCn = "" }
  $cfgJson = $cfg | ConvertTo-Json
  [System.IO.File]::WriteAllText($cfgPath, $cfgJson, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "✓ 已生成默认 probe-config.json（如代理端口不同请修改 proxyMain）"
} else {
  Write-Host "· 已存在 probe-config.json，保留不动"
}

Write-Host ""
Write-Host "安装完成。请确认顺序：" -ForegroundColor Green
Write-Host "  1) 在 chrome://extensions 重新加载本扩展（扩展 ID 应为 $ExtId）"
Write-Host "  2) 点扩展弹窗的刷新按钮 ⟳ —— 弹窗底部应显示「本地探测 ✓」"
Write-Host ""
Write-Host "卸载：运行同目录 uninstall.ps1（仅删注册表项，文件保留）。"
