# AnyRouter 本地探测 host（Chrome Native Messaging）
#
# 为什么存在：浏览器 fetch() 改不了 User-Agent 等被禁头，落不到 anyrouter 的「活通道」，
# 导致主站明明能用却回 429。本 host 用 curl.exe 发与真实 Claude Code 完全一致的请求
# （带 user-agent: claude-cli/...），真成功才判可用——根治这种假 429。
#
# 协议：与扩展通过 stdin/stdout 交换「4 字节小端长度前缀 + UTF-8 JSON」各一帧。
# 输入：{ headers, body, path, urlSuffix, timeoutMs, targets:[{key,name,baseUrl}] }
# 输出：{ ok:true, probeVia:"native", targets:[{key,name,baseUrl,success,latencyMs,errorMessage}] }
#       host 自身不可用（如缺 curl）→ { ok:false, error } 让扩展回退到浏览器 fetch。
#
# 纪律：只向 stdout 写「一帧响应」；不 Write-Host / 不打印 API Key；异常也回一帧 ok:false。

function Read-Exactly {
  param([System.IO.Stream]$Stream, [int]$Count)
  $buf = New-Object byte[] $Count
  $off = 0
  while ($off -lt $Count) {
    $n = $Stream.Read($buf, $off, $Count - $off)
    if ($n -le 0) { return $null }
    $off += $n
  }
  return ,$buf
}

function Write-Message {
  param([System.IO.Stream]$Stream, [string]$Json)
  $bytes = [Text.Encoding]::UTF8.GetBytes($Json)
  $Stream.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
  $Stream.Write($bytes, 0, $bytes.Length)
  $Stream.Flush()
}

$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()
# curl 的响应体是 UTF-8；PowerShell 默认按系统 GBK 解码原生命令输出会乱码，显式设为 UTF-8。
# 仅影响 PS 对 curl 文本输出的解码，不影响我们对 $stdout 的原始字节写入。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

try {
  # ── 读入一帧请求 ──
  $lenBytes = Read-Exactly $stdin 4
  if ($null -eq $lenBytes) { exit 0 }
  $len = [BitConverter]::ToInt32($lenBytes, 0)
  if ($len -le 0 -or $len -gt 1048576) { exit 0 }
  $msgBytes = Read-Exactly $stdin $len
  if ($null -eq $msgBytes) { exit 0 }
  $req = [Text.Encoding]::UTF8.GetString($msgBytes) | ConvertFrom-Json

  # curl 不可用 → host 无法工作，回 ok:false 让扩展回退 fetch（而非误报红）
  if ($null -eq (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
    Write-Message $stdout (@{ ok = $false; error = "curl.exe 不可用" } | ConvertTo-Json -Compress)
    exit 0
  }

  # ── 代理映射（机器相关，放 host 旁 probe-config.json；主站走 socks、大陆直连默认直连）──
  $proxyMain = "socks5h://127.0.0.1:7897"
  $proxyCn = ""
  $cfgPath = Join-Path $PSScriptRoot "probe-config.json"
  if (Test-Path $cfgPath) {
    try {
      $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($null -ne $cfg.proxyMain) { $proxyMain = [string]$cfg.proxyMain }
      if ($null -ne $cfg.proxyCn)   { $proxyCn   = [string]$cfg.proxyCn }
    } catch { }
  }

  $timeoutSec = 15
  if ($req.timeoutMs) { $timeoutSec = [int][Math]::Ceiling(([double]$req.timeoutMs) / 1000.0) }
  if ($timeoutSec -lt 3) { $timeoutSec = 3 }

  # 公共 header 参数（含 fetch 改不了的 user-agent / x-app）
  $headerArgs = @()
  foreach ($p in $req.headers.PSObject.Properties) {
    $headerArgs += "-H"
    $headerArgs += ("{0}: {1}" -f $p.Name, [string]$p.Value)
  }

  # 请求体改为写临时文件、用 --data-binary "@file" 让 curl 读原始字节：
  # 把含双引号/空格的 JSON 直接当 curl 命令行参数时，PS 5.1 不会正确转义内部双引号，
  # 服务端会收到残缺 JSON（HTTP 400：invalid character 'm'…）。写文件彻底绕开命令行引号问题。
  $bodyFile = [System.IO.Path]::Combine([string]$env:TEMP, ("anyrouter_probe_body_{0}.json" -f $PID))
  [System.IO.File]::WriteAllText($bodyFile, [string]$req.body, (New-Object System.Text.UTF8Encoding($false)))

  $results = @()
  foreach ($t in $req.targets) {
    $key = [string]$t.key
    $proxy = if ($key -eq "main" -or $key.EndsWith("-main")) { $proxyMain } else { $proxyCn }
    $url = [string]$t.baseUrl + [string]$req.path + [string]$req.urlSuffix

    # -w 末尾追加「换行 + 状态码 + 制表符 + curl 错误信息」，无需读 stderr 即可判定
    $curlArgs = @("-s", "--connect-timeout", "8", "--max-time", "$timeoutSec", "-X", "POST")
    $curlArgs += $headerArgs
    $curlArgs += @("--data-binary", "@$bodyFile")
    if ($proxy -and $proxy.Trim() -ne "") { $curlArgs += @("--proxy", $proxy) }
    $curlArgs += @("-w", '\n%{http_code}\t%{errormsg}')
    $curlArgs += $url

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $raw = & curl.exe @curlArgs 2>$null
    $sw.Stop()
    $latencyMs = [int]$sw.Elapsed.TotalMilliseconds
    $rawStr = if ($null -eq $raw) { "" } else { ($raw -join "`n") }

    # 拆出末行（curl 已把 \n \t 转成真换行/制表符）：状态码 + 错误信息；其余为响应体
    $code = 0
    $curlErr = ""
    $body = $rawStr
    $lastNl = $rawStr.LastIndexOf("`n")
    $statusLine = if ($lastNl -ge 0) { $rawStr.Substring($lastNl + 1) } else { $rawStr }
    if ($lastNl -ge 0) { $body = $rawStr.Substring(0, $lastNl) } else { $body = "" }
    $parts = $statusLine -split "`t", 2
    [void][int]::TryParse(($parts[0].Trim()), [ref]$code)
    if ($parts.Count -gt 1) { $curlErr = $parts[1].Trim() }

    # 判定（镜像扩展内 probeModel）：响应体 error 优先 → 非 2xx → 无响应；2xx 且无 error = 可用
    $success = $false
    $errMsg = ""
    if ($code -eq 0) {
      $errMsg = if ($curlErr) { "无响应：$curlErr" } else { "无响应（连接失败或超时）" }
    } elseif ($body -match 'high\s*demand') {
      $snippet = ($body -replace '\s+', ' ').Trim()
      $mm = [regex]::Match($snippet, "currently experiencing high\s*demand[^.]*\.", "IgnoreCase")
      if ($mm.Success) { $snippet = $mm.Value }
      if ($snippet.Length -gt 120) { $snippet = $snippet.Substring(0, 120) }
      $errMsg = "HTTP ${code}：$snippet"
    } elseif ($body -match '"type"\s*:\s*"error"' -or $body -match '"error"\s*:\s*\{') {
      $mm = [regex]::Match($body, '"message"\s*:\s*"([^"]*)"')
      $detail = if ($mm.Success) { $mm.Groups[1].Value } else { "上游返回 error" }
      $errMsg = "HTTP ${code}：$detail"
    } elseif ($code -lt 200 -or $code -ge 300) {
      $snippet = ($body -replace '\s+', ' ').Trim()
      if ($snippet.Length -gt 120) { $snippet = $snippet.Substring(0, 120) }
      $errMsg = "HTTP $code" + $(if ($snippet) { "：$snippet" } else { "" })
    } else {
      $success = $true
    }

    $results += [ordered]@{
      key = [string]$t.key
      name = [string]$t.name
      baseUrl = [string]$t.baseUrl
      success = $success
      latencyMs = $latencyMs
      errorMessage = $errMsg
    }
  }

  try { Remove-Item $bodyFile -ErrorAction SilentlyContinue } catch { }

  $resp = [ordered]@{ ok = $true; probeVia = "native"; targets = @($results) }
  Write-Message $stdout ($resp | ConvertTo-Json -Depth 6 -Compress)
  exit 0
} catch {
  try {
    Write-Message $stdout (@{ ok = $false; error = ("host 异常：" + $_.Exception.Message) } | ConvertTo-Json -Compress)
  } catch { }
  exit 0
}
