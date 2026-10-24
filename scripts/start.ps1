param([switch]$NoBrowser, [switch]$CheckRunning)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectDir
$expectedVersion = (Get-Content -LiteralPath (Join-Path $projectDir 'package.json') -Raw | ConvertFrom-Json).version
if ($expectedVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Application version metadata is invalid. Please reinstall the application.' }
$installed = Test-Path -LiteralPath (Join-Path $projectDir 'installed-product.id')
$dataDir = if ($env:WAN_EDITOR_DATA_DIR) { $env:WAN_EDITOR_DATA_DIR } elseif ($installed) { Join-Path $env:LOCALAPPDATA 'YingTiStudio\data' } else { Join-Path $projectDir 'data' }
$dataDir = [System.IO.Path]::GetFullPath($dataDir)
$hashInput = $dataDir.TrimEnd('\','/').ToLowerInvariant()
$hasher = [System.Security.Cryptography.SHA256]::Create()
try { $instance = ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($hashInput)))).Replace('-','').ToLowerInvariant().Substring(0,24) } finally { $hasher.Dispose() }

function Get-LocalHealth([int]$Candidate) {
    try { return Invoke-RestMethod -Uri "http://127.0.0.1:$Candidate/api/health" -TimeoutSec 2 } catch { return $null }
}
function Save-Address([int]$Port, $Health, [int]$ProcessId) {
    $record = @{ app='wan-replace-studio'; port=$Port; instanceId=$instance; version=$Health.version; pid=$ProcessId }
    [IO.File]::WriteAllText((Join-Path $dataDir 'runtime.json'), ($record | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}

$launchMutex = [Threading.Mutex]::new($false, "Local\YingTiStudio-Launch-$instance")
$held = $false
try {
    try { $held = $launchMutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { throw 'Another launch is still running. Please try again shortly.' }
    $ports = @()
    if ($env:WAN_EDITOR_PORT) {
        $specified = 0
        if (-not [int]::TryParse($env:WAN_EDITOR_PORT,[ref]$specified) -or $specified -lt 1024 -or $specified -gt 65535) { throw 'Invalid WAN_EDITOR_PORT.' }
        $ports += $specified
    } else {
        $addressFile = Join-Path $dataDir 'runtime.json'
        if (Test-Path -LiteralPath $addressFile) {
            try { $saved = Get-Content -LiteralPath $addressFile -Raw | ConvertFrom-Json; if ($saved.instanceId -eq $instance -and $saved.port -ge 1024 -and $saved.port -le 65535) { $ports += [int]$saved.port } } catch {}
        }
        $ports += 3210..3229
        $ports = @($ports | Select-Object -Unique)
    }
    $listening = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object { $_.Port })
    $freePort = $null
    foreach ($candidate in $ports) {
        if ($listening -contains $candidate) {
            $health = Get-LocalHealth $candidate
            if ($health -and $health.app -eq 'wan-replace-studio' -and $health.instanceId -eq $instance) {
                if ($CheckRunning) { exit 10 }
                if ($health.version -ne $expectedVersion) { throw "This workspace is still running version $($health.version). Exit that application before starting version $expectedVersion." }
                $processId = 0
                try { $processId = [int](Get-Content -LiteralPath (Join-Path $dataDir 'server.pid')) } catch {}
                Save-Address $candidate $health $processId
                if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$candidate" }
                Write-Output "Running: http://127.0.0.1:$candidate"
                exit 0
            }
        } elseif ($null -eq $freePort) { $freePort = $candidate }
    }
    if ($CheckRunning) { exit 0 }
    # Never create a second writer against data belonging to an older server.
    $pidFile = Join-Path $dataDir 'server.pid'
    if (Test-Path -LiteralPath $pidFile) {
        $oldPid = 0
        if ([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(),[ref]$oldPid)) {
            $oldProcess = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
            $pidWritten = (Get-Item -LiteralPath $pidFile).LastWriteTime
            if ($oldProcess -and $oldProcess.ProcessName -eq 'node' -and $oldProcess.StartTime -le $pidWritten.AddSeconds(1)) { throw 'This data directory may still be open in another server. Exit that workspace before starting again.' }
        }
    }
    if ($null -eq $freePort) { throw 'No available local port. Exit an unused workspace and try again.' }
    $port = [int]$freePort
    $bundledNode = Join-Path $projectDir 'runtime\node.exe'
    $nodePath = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node -ErrorAction Stop).Source }
    $major = [int]((& $nodePath --version).TrimStart('v').Split('.')[0])
    if ($major -lt 24) { throw 'Node.js 24 or newer is required.' }
    if (-not (Test-Path -LiteralPath (Join-Path $projectDir 'node_modules\express'))) {
        if ($installed) { throw 'Application files are missing. Please run the installer again.' }
        & npm.cmd ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    }
    foreach ($tool in @('ffmpeg', 'ffprobe')) {
        $localTool = Join-Path $projectDir "runtime\$tool.exe"
        if (-not (Test-Path -LiteralPath $localTool) -and -not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is required. Please reinstall the application." }
    }
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    $env:WAN_EDITOR_DATA_DIR = $dataDir
    $env:WAN_EDITOR_PORT = [string]$port
    $appProcess = Start-Process -FilePath $nodePath -ArgumentList @('--disable-warning=ExperimentalWarning','src/main.js') -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDir 'server.log') -RedirectStandardError (Join-Path $dataDir 'server-error.log') -PassThru
    $appProcess.Id | Set-Content -LiteralPath $pidFile -Encoding ascii
    $healthy = $false
    for ($attempt = 0; $attempt -lt 80; $attempt++) {
        Start-Sleep -Milliseconds 250
        $health = Get-LocalHealth $port
        if ($health -and $health.app -eq 'wan-replace-studio' -and $health.instanceId -eq $instance -and $health.version -eq $expectedVersion) { $healthy = $true; break }
        if ($appProcess.HasExited) { break }
    }
    if (-not $healthy) { throw "Unable to start. See $dataDir\server-error.log" }
    Save-Address $port $health $appProcess.Id
    if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$port" }
    Write-Output "Started: http://127.0.0.1:$port"
} catch {
    if (-not $CheckRunning) {
        try {
            New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
            [IO.File]::WriteAllText((Join-Path $dataDir 'launcher-error.log'),($_ | Out-String),[Text.UTF8Encoding]::new($false))
        } catch {}
    }
    throw
} finally {
    if ($held) { $launchMutex.ReleaseMutex() }
    $launchMutex.Dispose()
}
