<#
.SYNOPSIS
  根据 help-sale.config.yaml 配置,停止监听 server.port 的老服务进程树,并后台重启 npm run dev。

.DESCRIPTION
  - 从 help-sale.config.yaml 读取 server.port / server.host / logging.dir
  - 定位监听该端口的进程;仅当其为 node/tsx 且命令行包含本项目仓库时才停止(防止误杀)
  - 递归停止该进程及其全部子进程(tsx watch 进程树)
  - 隐藏窗口后台启动 npm run dev;stdout/err 追加写入 <logging.dir>/service.log,启动器 PID 记录到 service.pid
  - 默认轮询 GET /api/v1/health 直到 200(超时 60 秒)

.PARAMETER Port
  覆盖配置文件中的监听端口
.PARAMETER NoWait
  启动后跳过健康检查等待
.PARAMETER DryRun
  只打印将要执行的操作(停止哪些 PID / 启动什么命令),不真正执行

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\restart-service.ps1
#>
param(
    [int]$Port = 0,
    [switch]$NoWait,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $repoRoot 'help-sale.config.yaml'
$apiRoot = Join-Path $repoRoot 'apps\api'

function Read-Config {
    if (-not (Test-Path $configPath)) { throw "配置文件不存在: $configPath" }
    Push-Location $repoRoot
    try {
        $json = & node -e "const fs=require('fs');const y=require('yaml');console.log(JSON.stringify(y.parse(fs.readFileSync(process.argv[1],'utf8'))))" $configPath
        if ($LASTEXITCODE -ne 0) { throw '无法解析 help-sale.config.yaml(yaml 依赖缺失?)' }
        return $json | ConvertFrom-Json
    } finally {
        Pop-Location
    }
}
$cfg = Read-Config
$port = if ($Port -gt 0) { $Port } else { [int]$cfg.server.port }
$hostBind = [string]$cfg.server.host
$rawLogDir = [string]$cfg.logging.dir
if ([string]::IsNullOrWhiteSpace($rawLogDir)) { $rawLogDir = 'apps/api/log' }
$logDir = if ([IO.Path]::IsPathRooted($rawLogDir)) { $rawLogDir } else { Join-Path $repoRoot $rawLogDir }
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

Write-Host "==> 目标服务: ${hostBind}:$port (配置: $configPath)"
Write-Host "==> 日志目录: $logDir"

$script:killPids = [System.Collections.Generic.List[int]]::new()
function Add-KillTree([int]$ParentPid) {
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentPid" -ErrorAction SilentlyContinue
    foreach ($child in $children) {
        $script:killPids.Add([int]$child.ProcessId)
        Add-KillTree ([int]$child.ProcessId)
    }
}

# ── 1) 停止老服务 ──
$listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
$ownerPids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
if ($ownerPids.Count -eq 0) {
    Write-Host "端口 $port 当前无监听进程,跳过停止"
} else {
    foreach ($owner in $ownerPids) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue
        if (-not $proc) { continue }
        $cmd = [string]$proc.CommandLine
        $isOurs = ($proc.Name -like 'node*' -or $cmd -match 'tsx') -and $cmd -match 'proj_help_sale'
        if (-not $isOurs) {
            Write-Warning ("端口 $port 的进程不是本项目服务,跳过: PID=$owner Name={0} Cmd={1}" -f $proc.Name, $cmd.Substring(0, [Math]::Min(140, $cmd.Length)))
            continue
        }
        $script:killPids.Clear()
        $script:killPids.Add([int]$owner)
        Add-KillTree ([int]$owner)
        Write-Host "停止服务进程树: 根PID=$owner -> $($script:killPids -join ',')"
        if (-not $DryRun) {
            foreach ($kill in ($script:killPids | Sort-Object -Descending)) {
                Stop-Process -Id $kill -Force -ErrorAction SilentlyContinue
            }
            Start-Sleep -Seconds 1
        }
    }
}

# ── 2) 启动新服务 ──
$outLog = Join-Path $logDir 'service.log'
$pidFile = Join-Path $logDir 'service.pid'
$cmdLine = "cd /d $apiRoot && npm run dev >> $outLog 2>&1"
if ($DryRun) {
    Write-Host "==> [DryRun] 将执行: cmd /d /c $cmdLine (隐藏窗口后台启动)"
    Write-Host "==> [DryRun] PID 记录: $pidFile"
    exit 0
}
$p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/c', $cmdLine) -WindowStyle Hidden -PassThru
$p.Id | Out-File -FilePath $pidFile -Encoding utf8
Write-Host "已启动新服务: 启动器 PID=$($p.Id) (记录于 $pidFile)"

# ── 3) 等待健康检查 ──
if ($NoWait) { Write-Host '==> 完成(NoWait,跳过健康检查)'; exit 0 }
$healthUrl = "http://127.0.0.1:$port/api/v1/health"
$ok = $false
for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $r = Invoke-WebRequest -Uri $healthUrl -TimeoutSec 2 -UseBasicParsing
        if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch {
        # 服务尚未就绪,继续等待
    }
}
if ($ok) {
    Write-Host "服务已就绪: $healthUrl -> 200 (约 $([math]::Round(($i + 0.5) / 2, 1)) 秒)"
    exit 0
}
Write-Warning "等待 $port 健康检查超时(60s),请查看 $outLog"
exit 1