<#
重启后端服务(开发模式:tsx 直跑 backend/server.ts,改代码自动重载)。

用法:
  powershell -ExecutionPolicy Bypass -File scripts\restart-service.ps1
  ... -Port 3199              # 覆盖健康检查端口(服务端口仍取自配置文件)
  ... -ConfigPath <path>      # 用指定配置文件(等价于设置 CONFIG_PATH)
  ... -NoWait                 # 只启动,不等待健康检查

端口/主机/日志目录都从 help-sale.config.yaml 读(CONFIG_PATH 可覆盖配置路径),
脚本不硬编码任何运行参数。
#>
param(
	[int]$Port = 0,
	[string]$ConfigPath = "",
	[switch]$NoWait
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot          # 仓库根 = scripts/ 的上一级
$entry = Join-Path $repoRoot 'backend\server.ts'

function Read-Config([string]$path) {
	$cfg = @{ server = @{}; logging = @{} }
	$section = ""
	foreach ($line in Get-Content $path) {
		if ($line -match '^\s*#' -or $line -match '^\s*$') { continue }
		if ($line -match '^([A-Za-z_]+):') { $section = $Matches[1]; continue }
		if ($line -match '^\s+([A-Za-z_]+):\s*(.+?)\s*$') {
			$key = $Matches[1]; $value = $Matches[2].Trim('"').Trim("'")
			if ($section -eq 'server' -or $section -eq 'logging') { $cfg[$section][$key] = $value }
		}
	}
	return $cfg
}

$configFile = if ($ConfigPath) { $ConfigPath } elseif ($env:CONFIG_PATH) { $env:CONFIG_PATH } else { Join-Path $repoRoot 'help-sale.config.yaml' }
if (-not (Test-Path $configFile)) { throw "找不到配置文件:$configFile" }
if ($ConfigPath) { $env:CONFIG_PATH = $ConfigPath }

$cfg = Read-Config $configFile
$port = if ($Port -gt 0) { $Port } elseif ($cfg.server.port) { [int]$cfg.server.port } else { throw "配置文件里没有 server.port" }
$hostBind = if ($cfg.server.host) { [string]$cfg.server.host } else { "127.0.0.1" }
$rawLogDir = if ($cfg.logging.dir) { [string]$cfg.logging.dir } else { "log" }
$logDir = if ([IO.Path]::IsPathRooted($rawLogDir)) { $rawLogDir } else { Join-Path $repoRoot $rawLogDir }
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$outLog = Join-Path $logDir 'service.log'
$errLog = Join-Path $logDir 'service.err.log'
$pidFile = Join-Path $logDir 'service.pid'

function Stop-ProcessTree([int]$ProcessId) {
	$children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue
	foreach ($c in $children) { Stop-ProcessTree ([int]$c.ProcessId) }
	Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

# ── 1) 停掉老服务(先按 pid 文件,再按端口占用兜底) ──
if (Test-Path $pidFile) {
	$oldPid = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
	if ($oldPid -and ($oldPid -as [int])) {
		Write-Host "==> 停止旧服务(PID $oldPid)"
		Stop-ProcessTree ([int]$oldPid)
	}
	Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}
$listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
foreach ($ownerPid in @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
	if ($ownerPid -and $ownerPid -ne 0) {
		Write-Host "==> 端口 $port 仍被占用,停止 PID $ownerPid"
		Stop-ProcessTree ([int]$ownerPid)
	}
}
Start-Sleep -Milliseconds 500

# ── 2) 启动新服务:node + 仓库自带的 tsx 直跑 TS 入口 ──
$tsx = Join-Path $repoRoot 'node_modules\tsx\dist\cli.mjs'
if (-not (Test-Path $tsx)) { throw "缺少 tsx:$tsx(先执行 npm install --ignore-scripts)" }
if (-not (Test-Path $entry)) { throw "缺少服务入口:$entry" }
$cmdLine = "cd /d `"$repoRoot`" && node `"$tsx`" `"$entry`" >> `"$outLog`" 2>> `"$errLog`""
Write-Host "==> 启动服务:$hostBind`:$port(日志 $outLog)"
$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/c', $cmdLine) -WindowStyle Hidden -PassThru
$proc.Id | Out-File -FilePath $pidFile -Encoding utf8
Write-Host "    launcher PID=$($proc.Id)(记录在 $pidFile)"

if ($NoWait) { Write-Host '==> Done(NoWait,已跳过健康检查)'; exit 0 }

# ── 3) 等待健康检查 ──
$healthUrl = "http://127.0.0.1:$port/api/v1/health"
$maxAttempts = 120
$ok = $false
for ($i = 1; $i -le $maxAttempts; $i++) {
	try {
		$r = Invoke-WebRequest -Uri $healthUrl -TimeoutSec 2 -UseBasicParsing
		if ($r.StatusCode -eq 200) { Write-Host "健康检查通过(第 $i 次尝试,约 $([math]::Round($i * 0.5, 1))s)"; $ok = $true; break }
	} catch {
		Write-Verbose "第 $i 次尝试失败:$($_.Exception.Message)"
	}
	if ($i -lt $maxAttempts) { Start-Sleep -Milliseconds 500 }
}
if (-not $ok) { throw "服务在 $maxAttempts 次尝试后仍未就绪:$healthUrl(见 $outLog / $errLog)" }

Write-Host "==> 服务就绪:$healthUrl"
