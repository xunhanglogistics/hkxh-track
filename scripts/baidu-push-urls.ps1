# 百度主动推送（无需安装 Node.js）
# 用法（先设置变量，与接口页一致）：
#   $env:BAIDU_PUSH_SITE="https://hkxhlogistics.com"
#   $env:BAIDU_PUSH_TOKEN="你的token"
#   .\scripts\baidu-push-urls.ps1

$ErrorActionPreference = 'Stop'

function Normalize-BaiduSite([string]$raw) {
    if ([string]::IsNullOrWhiteSpace($raw)) { return '' }
    $s = $raw.Trim().TrimEnd('/')
    if ($s -match '^(?i)https?://') {
        try { return ([System.Uri]$s).Host } catch {
            return (($s -replace '^(?i)https?://', '') -split '/')[0]
        }
    }
    return $s
}

$site = Normalize-BaiduSite $env:BAIDU_PUSH_SITE
$token = $env:BAIDU_PUSH_TOKEN

$urlsToPush = @(
    'https://hkxhlogistics.com/'
    # 'https://hkxhlogistics.com/services.html'
)

if (-not $site -or -not $token) {
    Write-Host '请先设置环境变量 BAIDU_PUSH_SITE 与 BAIDU_PUSH_TOKEN。' -ForegroundColor Red
    exit 1
}

$body = ($urlsToPush | Where-Object { $_ }) -join "`n"
$qSite = [System.Uri]::EscapeDataString($site)
$qToken = [System.Uri]::EscapeDataString($token)
$uri = "http://data.zz.baidu.com/urls?site=$qSite&token=$qToken"

try {
    $result = Invoke-RestMethod -Uri $uri -Method Post -Body $body -ContentType 'text/plain; charset=utf-8'
    $result | ConvertTo-Json
}
catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    if ($_.ErrorDetails.Message) {
        Write-Host $_.ErrorDetails.Message
    }
    exit 1
}
