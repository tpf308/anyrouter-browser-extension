# AnyRouter 本地健康检查（独立工具，不依赖浏览器/扩展）
# 双击同目录 check.bat 运行：用与真实 Claude Code 完全一致的请求探两条线路，
# 输出 绿(正常)/红(异常) + 真实原因。判定口径与扩展一致：2xx 且响应体无 error = 正常。
#
# 取 key 顺序：-ApiKey 参数 > probe-config.json 里的 apiKey 字段 > 运行时输入。
# 代理沿用 probe-config.json（主站走 socks、大陆直连默认直连）。
param([string]$ApiKey)

$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$here = $PSScriptRoot
$cfgPath = Join-Path $here "probe-config.json"
$proxyMain = "socks5h://127.0.0.1:7897"; $proxyCn = ""
if (Test-Path $cfgPath) {
  try {
    $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -ne $cfg.proxyMain) { $proxyMain = [string]$cfg.proxyMain }
    if ($null -ne $cfg.proxyCn)   { $proxyCn   = [string]$cfg.proxyCn }
    if (-not $ApiKey -and ($cfg.PSObject.Properties.Name -contains "apiKey") -and $cfg.apiKey) { $ApiKey = [string]$cfg.apiKey }
  } catch { }
}
if (-not $ApiKey) { $ApiKey = Read-Host "粘贴 API Key (sk-...)" }
$ApiKey = $ApiKey.Trim()
if (-not $ApiKey) { Write-Host "未提供 API Key。" -ForegroundColor Yellow; exit 1 }
if ($null -eq (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
  Write-Host "未找到 curl.exe（Windows 10/11 自带）。" -ForegroundColor Red; exit 1
}

# 与 usage.js buildProbeBody / buildProbeNativeSpec 完全一致；写临时文件避免命令行引号问题
$sys1 = "x-anthropic-billing-header: cc_version=2.1.183; cc_entrypoint=cli;"
$sys2 = "You are Claude Code, Anthropic" + [char]39 + "s official CLI for Claude."
$userId = @{ device_id = ([guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")); account_uuid = ""; session_id = [guid]::NewGuid().ToString() } | ConvertTo-Json -Compress
$body = [ordered]@{
  model = "claude-opus-4-8"; max_tokens = 16; stream = $true
  system = @(@{ type = "text"; text = $sys1 }, @{ type = "text"; text = $sys2 })
  metadata = @{ user_id = $userId }
  messages = @(@{ role = "user"; content = "hi" })
} | ConvertTo-Json -Depth 8 -Compress
$bodyFile = Join-Path $env:TEMP "anyrouter_check_body.json"
[System.IO.File]::WriteAllText($bodyFile, $body, (New-Object System.Text.UTF8Encoding($false)))

$headerArgs = @(
  "-H", "x-api-key: $ApiKey", "-H", "content-type: application/json",
  "-H", "anthropic-version: 2023-06-01", "-H", "anthropic-beta: context-1m-2025-08-07",
  "-H", "user-agent: claude-cli/2.1.183 (external, cli)", "-H", "x-app: cli"
)
$targets = @(
  @{ name = "主站 anyrouter.top"; baseUrl = "https://anyrouter.top";                     proxy = $proxyMain },
  @{ name = "大陆直连 fcapp.run"; baseUrl = "https://a-ocnfniawgw.cn-shanghai.fcapp.run"; proxy = $proxyCn }
)

$tail = if ($ApiKey.Length -ge 4) { $ApiKey.Substring($ApiKey.Length - 4) } else { "" }
Write-Host ""
Write-Host ("AnyRouter 本地健康检查   key=...{0}   {1}" -f $tail, (Get-Date -Format "HH:mm:ss")) -ForegroundColor Cyan
Write-Host ""

$anyOk = $false
foreach ($t in $targets) {
  $url = $t.baseUrl + "/v1/messages?beta=true"
  $a = @("-s", "--connect-timeout", "8", "--max-time", "40", "-X", "POST")
  if ($t.proxy -and $t.proxy.Trim() -ne "") { $a += @("--proxy", $t.proxy) }
  $a += $headerArgs + @("--data-binary", "@$bodyFile", "-w", "`n<<<%{http_code}>>>", $url)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $out = (& curl.exe @a 2>$null | Out-String)
  $sw.Stop(); $ms = [int]$sw.Elapsed.TotalMilliseconds
  $code = 0
  $m = [regex]::Match($out, "<<<(\d+)>>>"); if ($m.Success) { $code = [int]$m.Groups[1].Value }
  $bodyTxt = ($out -replace "<<<\d+>>>", "").Trim()
  $ok = ($code -ge 200 -and $code -lt 300 -and $bodyTxt -notmatch '"type"\s*:\s*"error"' -and $bodyTxt -notmatch '"error"\s*:\s*\{')
  if ($ok) {
    $anyOk = $true
    Write-Host ("  ● {0}   正常   ({1} ms, HTTP {2})" -f $t.name, $ms, $code) -ForegroundColor Green
  } else {
    $reason = if ($code -eq 0) { "无响应（连接失败/超时，检查代理是否开启）" } else {
      $mm = [regex]::Match($bodyTxt, '"message"\s*:\s*"([^"]*)"')
      $d = if ($mm.Success) { $mm.Groups[1].Value } else { ($bodyTxt -replace '\s+', ' ').Trim() }
      if ($d.Length -gt 80) { $d = $d.Substring(0, 80) }
      "HTTP {0}：{1}" -f $code, $d
    }
    Write-Host ("  ● {0}   异常   {1}" -f $t.name, $reason) -ForegroundColor Red
  }
}
try { Remove-Item $bodyFile -ErrorAction SilentlyContinue } catch { }
Write-Host ""
if ($anyOk) { Write-Host "结论：可用（至少一条线路正常）。" -ForegroundColor Green }
else { Write-Host "结论：不可用（两条都失败——可能这个 key 无可用渠道，或代理未开）。" -ForegroundColor Red }
