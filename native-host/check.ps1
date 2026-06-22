# AnyRouter 本地健康检查（独立工具，不依赖浏览器/扩展）
# 双击同目录 check.bat 运行：同时检测 Claude 与 GPT 5.5 的主站/大陆直连入口。
# 判定口径与扩展一致：2xx 且响应体无 error/high-demand 文案 = 正常。
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

function New-ClaudeProbeBody {
  $sys1 = "x-anthropic-billing-header: cc_version=2.1.183; cc_entrypoint=cli;"
  $sys2 = "You are Claude Code, Anthropic" + [char]39 + "s official CLI for Claude."
  $userId = @{ device_id = ([guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")); account_uuid = ""; session_id = [guid]::NewGuid().ToString() } | ConvertTo-Json -Compress
  [ordered]@{
    model = "claude-opus-4-8"; max_tokens = 16; stream = $true
    system = @(@{ type = "text"; text = $sys1 }, @{ type = "text"; text = $sys2 })
    metadata = @{ user_id = $userId }
    messages = @(@{ role = "user"; content = "hi" })
  } | ConvertTo-Json -Depth 8 -Compress
}

function New-GptProbeBody {
  [ordered]@{
    model = "gpt-5.5"
    input = @(@{
      type = "message"
      role = "user"
      content = @(@{ type = "input_text"; text = "Reply OK only." })
    })
    store = $false
    stream = $true
    include = @("reasoning.encrypted_content")
    prompt_cache_key = [guid]::NewGuid().ToString()
  } | ConvertTo-Json -Depth 8 -Compress
}

function Get-ProbeReason {
  param([int]$Code, [string]$BodyText, [string]$CurlError)
  if ($Code -eq 0) {
    if ($CurlError) { return "无响应：$CurlError" }
    return "无响应（连接失败/超时，检查代理是否开启）"
  }

  $compact = ($BodyText -replace "\s+", " ").Trim()
  $highDemand = [regex]::Match($compact, "currently experiencing high\s*demand[^.]*\.", "IgnoreCase")
  if ($highDemand.Success) { return "HTTP ${Code}: " + $highDemand.Value }

  try {
    $json = $BodyText | ConvertFrom-Json
    if (($json.error -is [string]) -and $json.error) { return "HTTP ${Code}: " + $json.error }
    if ($json.error.message) { return "HTTP ${Code}: " + $json.error.message }
    if ($json.message) { return "HTTP ${Code}: " + $json.message }
  } catch { }

  $dq = [string][char]34
  $compactNoSpaces = $compact -replace "\s+", ""
  if ($compactNoSpaces.Contains($dq + "type" + $dq + ":" + $dq + "error" + $dq) -or
      $compactNoSpaces.Contains($dq + "error" + $dq + ":{")) {
    return "HTTP ${Code}: 上游返回 error"
  }

  if ($compact.Length -gt 80) { $compact = $compact.Substring(0, 80) }
  if ($compact) { return "HTTP ${Code}: $compact" }
  return "HTTP $Code"
}

function Invoke-ProbeTarget {
  param($Target)

  $bodyFile = Join-Path $env:TEMP ("anyrouter_check_{0}_{1}.json" -f $PID, $Target.key)
  [System.IO.File]::WriteAllText($bodyFile, [string]$Target.body, (New-Object System.Text.UTF8Encoding($false)))

  $a = @("-s", "--connect-timeout", "8", "--max-time", "40", "-X", "POST")
  if ($Target.proxy -and $Target.proxy.Trim() -ne "") { $a += @("--proxy", $Target.proxy) }
  $a += $Target.headers + @("--data-binary", "@$bodyFile", "-w", "`n<<<%{http_code}`t%{errormsg}>>>", $Target.url)

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $out = (& curl.exe @a 2>$null | Out-String)
  $sw.Stop()
  try { Remove-Item $bodyFile -ErrorAction SilentlyContinue } catch { }

  $code = 0
  $curlErr = ""
  $m = [regex]::Match($out, "<<<(\d+)\t([^>]*)>>>")
  if ($m.Success) {
    $code = [int]$m.Groups[1].Value
    $curlErr = $m.Groups[2].Value.Trim()
  }
  $bodyTxt = ($out -replace "<<<\d+\t[^>]*>>>", "").Trim()
  $dq = [string][char]34
  $compactNoSpaces = ($bodyTxt -replace "\s+", "")
  $ok = (
    $code -ge 200 -and $code -lt 300 -and
    -not $compactNoSpaces.Contains($dq + "type" + $dq + ":" + $dq + "error" + $dq) -and
    -not $compactNoSpaces.Contains($dq + "error" + $dq + ":{") -and
    $bodyTxt -notmatch "high\s*demand"
  )

  [ordered]@{
    ok = $ok
    code = $code
    latencyMs = [int]$sw.Elapsed.TotalMilliseconds
    reason = if ($ok) { "" } else { Get-ProbeReason -Code $code -BodyText $bodyTxt -CurlError $curlErr }
  }
}

$claudeBody = New-ClaudeProbeBody
$gptBody = New-GptProbeBody
$claudeHeaders = @(
  "-H", "x-api-key: $ApiKey", "-H", "content-type: application/json",
  "-H", "anthropic-version: 2023-06-01", "-H", "anthropic-beta: context-1m-2025-08-07",
  "-H", "user-agent: claude-cli/2.1.183 (external, cli)", "-H", "x-app: cli"
)
$gptHeaders = @(
  "-H", "Authorization: Bearer $ApiKey", "-H", "content-type: application/json",
  "-H", "accept: application/json", "-H", "user-agent: codex-cli/0.141.0"
)

$targets = @(
  @{ group = "Claude"; key = "claude-main"; name = "Claude 主站 anyrouter.top"; url = "https://anyrouter.top/v1/messages?beta=true"; proxy = $proxyMain; headers = $claudeHeaders; body = $claudeBody },
  @{ group = "Claude"; key = "claude-cn";   name = "Claude 大陆直连 fcapp.run"; url = "https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1/messages?beta=true"; proxy = $proxyCn; headers = $claudeHeaders; body = $claudeBody },
  @{ group = "GPT 5.5"; key = "gpt-main"; name = "GPT 5.5 主站 anyrouter.top"; url = "https://anyrouter.top/v1/responses"; proxy = $proxyMain; headers = $gptHeaders; body = $gptBody },
  @{ group = "GPT 5.5"; key = "gpt-cn";   name = "GPT 5.5 大陆直连 fcapp.run"; url = "https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1/responses"; proxy = $proxyCn; headers = $gptHeaders; body = $gptBody }
)

$tail = if ($ApiKey.Length -ge 4) { $ApiKey.Substring($ApiKey.Length - 4) } else { "" }
Write-Host ""
Write-Host ("AnyRouter 本地健康检查   key=...{0}   {1}" -f $tail, (Get-Date -Format "HH:mm:ss")) -ForegroundColor Cyan

$groupOk = @{}
$currentGroup = ""
foreach ($t in $targets) {
  if ($currentGroup -ne $t.group) {
    $currentGroup = $t.group
    Write-Host ""
    Write-Host ("{0}" -f $currentGroup) -ForegroundColor Cyan
  }
  $r = Invoke-ProbeTarget -Target $t
  if ($r.ok) {
    $groupOk[$t.group] = $true
    Write-Host ("  ● {0}   正常   ({1} ms, HTTP {2})" -f $t.name, $r.latencyMs, $r.code) -ForegroundColor Green
  } else {
    if (-not $groupOk.ContainsKey($t.group)) { $groupOk[$t.group] = $false }
    Write-Host ("  ● {0}   异常   {1}" -f $t.name, $r.reason) -ForegroundColor Red
  }
}

$allOk = $true
foreach ($g in @("Claude", "GPT 5.5")) {
  if (-not $groupOk.ContainsKey($g) -or $groupOk[$g] -ne $true) { $allOk = $false }
}

Write-Host ""
if ($allOk) {
  Write-Host "结论：可用（Claude 与 GPT 5.5 均至少一条入口正常）。" -ForegroundColor Green
} else {
  Write-Host "结论：不可用或部分不可用（至少一个模型组两条入口都失败）。" -ForegroundColor Red
}
