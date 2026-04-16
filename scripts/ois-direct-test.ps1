# 越航 OIS 轨迹直连测试（调用 scripts/ois-direct-test.js，需已安装 Node.js）
#
# 用法：
#   .\scripts\ois-direct-test.ps1 1Z0E319J0437330473 zh
#   .\scripts\ois-direct-test.ps1 1Z0E319J0437330473 en
# 需配置 ois-test.json（从 ois-test.example.json 复制）或设置 OIS_* 环境变量
#
# 若提示找不到 node：请安装 Node.js LTS https://nodejs.org/zh-cn/ 安装时勾选 Add to PATH，关闭并重开 PowerShell。

param(
    [Parameter(Position = 0, Mandatory = $false)]
    [string] $TrackingNumber,
    [Parameter(Position = 1)]
    [string] $Lang = 'zh'
)

$ErrorActionPreference = 'Stop'

function Find-NodeExe {
    $g = Get-Command -Name 'node.exe' -CommandType Application -ErrorAction SilentlyContinue
    if ($g) { return $g.Source }
    foreach ($p in @(
            (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
            (Join-Path $env:LOCALAPPDATA 'Programs\node\node.exe')
        )) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    return $null
}

$node = Find-NodeExe
if (-not $node) {
    Write-Host @'
未找到 node.exe。npm / node 未安装或未加入 PATH。

请任选其一：
  1) 安装 Node.js LTS：https://nodejs.org/zh-cn/  （安装时勾选 “Add to PATH”）
  2) 安装后关闭并重新打开 PowerShell，再执行本脚本
  3) 若已安装 Node，可将安装目录（如 C:\Program Files\nodejs\n）加入系统环境变量 PATH

验证：在 PowerShell 中执行  node -v  应显示版本号。
'@ -ForegroundColor Yellow
    exit 1
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$scriptJs = Join-Path $repoRoot 'scripts\ois-direct-test.js'
if (-not (Test-Path -LiteralPath $scriptJs)) {
    Write-Host "未找到: $scriptJs" -ForegroundColor Red
    exit 1
}

if (-not $TrackingNumber) {
    Write-Host @'
用法: .\scripts\ois-direct-test.ps1 <运单号> [zh|en]

示例: .\scripts\ois-direct-test.ps1 1Z0E319J0437330473 zh
'@ -ForegroundColor Cyan
    exit 1
}

Write-Host "使用 Node: $node" -ForegroundColor DarkGray
& $node $scriptJs $TrackingNumber $Lang
exit $LASTEXITCODE
