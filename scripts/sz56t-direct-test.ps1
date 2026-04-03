# 华磊/sz56t 轨迹直连探活（与线上相同：POST、Content-Length: 0、selectTrack.htm?documentCode=）
# 依赖：Windows 自带的 curl.exe（非 PowerShell 的 curl 别名）。
#
# 用法：
#   .\scripts\sz56t-direct-test.ps1 -ApiBase "http://hx.hailei2018.com:8082" -DocumentCode "单号"
# 或环境变量：
#   $env:SZ56T_API_BASE = "http://..."
#   $env:SZ56T_DOCUMENT_CODE = "单号"
#   .\scripts\sz56t-direct-test.ps1
# 或已复制 sz56t-test.json（同 Node 版）时可直接：
#   .\scripts\sz56t-direct-test.ps1
#
# 一行 curl（自行替换 URL 与单号）：
#   curl.exe -sS -X POST -H "Content-Length: 0" -H "Accept: */*" "http://hx.hailei2018.com:8082/selectTrack.htm?documentCode=单号"

param(
    [string] $ApiBase = $env:SZ56T_API_BASE,
    [string] $DocumentCode = $env:SZ56T_DOCUMENT_CODE
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$cfgPath = Join-Path $repoRoot 'sz56t-test.json'

if ((-not $ApiBase -or -not $DocumentCode) -and (Test-Path -LiteralPath $cfgPath)) {
    try {
        $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not $ApiBase) { $ApiBase = [string]$cfg.apiBase }
        if (-not $DocumentCode) { $DocumentCode = [string]$cfg.documentCode }
    } catch {
        Write-Host "读取 sz56t-test.json 失败: $_" -ForegroundColor Red
        exit 1
    }
}

$ApiBase = "$ApiBase".Trim().TrimEnd('/')
$DocumentCode = "$DocumentCode".Trim()

if (-not $ApiBase -or -not $DocumentCode) {
    Write-Host @'
缺少 ApiBase 或 DocumentCode。
  • 参数：.\scripts\sz56t-direct-test.ps1 -ApiBase "http://host:port" -DocumentCode "单号"
  • 或 $env:SZ56T_API_BASE / $env:SZ56T_DOCUMENT_CODE
  • 或复制 sz56t-test.example.json 为 sz56t-test.json 并填写
'@ -ForegroundColor Yellow
    exit 1
}

$enc = [System.Uri]::EscapeDataString($DocumentCode)
$url = "$ApiBase/selectTrack.htm?documentCode=$enc"

$curl = Get-Command -Name curl.exe -CommandType Application -ErrorAction SilentlyContinue
if (-not $curl) {
    Write-Host '未找到 curl.exe（请使用 Windows 10 及以上，或安装 Git/curl 并加入 PATH）。' -ForegroundColor Red
    exit 1
}

Write-Host "POST $url" -ForegroundColor Cyan
Write-Host "(empty body, Content-Length: 0)`n" -ForegroundColor DarkGray

# -w 打印 HTTP 状态码；-D - 把响应头打到 stderr，正文 stdout 便于只管道 JSON
$outputFile = [System.IO.Path]::GetTempFileName()
try {
    # 响应体写入文件，状态码由 -w 打印到 stdout（与 curl 文档一致）
    $codeStr = & curl.exe -sS -o $outputFile -w '%{http_code}' `
        -X POST `
        -H 'Content-Length: 0' `
        -H 'Accept: */*' `
        $url 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "curl 退出码 $LASTEXITCODE ：$codeStr"
    }
} catch {
    Remove-Item -LiteralPath $outputFile -Force -ErrorAction SilentlyContinue
    Write-Host "curl 执行失败: $_" -ForegroundColor Red
    exit 1
}

$body = Get-Content -LiteralPath $outputFile -Raw -Encoding UTF8
Remove-Item -LiteralPath $outputFile -Force -ErrorAction SilentlyContinue

$code = 0
try {
    $code = [int][string]$codeStr
} catch {
    $code = -1
}

Write-Host "HTTP $code" -ForegroundColor $(if ($code -ge 200 -and $code -lt 300) { 'Green' } else { 'Red' })

try {
    $obj = $body | ConvertFrom-Json
    $obj | ConvertTo-Json -Depth 20
} catch {
    Write-Host "正文（非 JSON 或解析失败），前 2000 字符：" -ForegroundColor Yellow
    if ($body.Length -gt 2000) {
        Write-Host $body.Substring(0, 2000)
    } else {
        Write-Host $body
    }
}

if ($code -lt 200 -or $code -ge 300) { exit 1 }
