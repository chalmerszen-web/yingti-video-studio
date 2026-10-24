param([string]$InstallDir, [int]$TimeoutSeconds=230)
$ErrorActionPreference='Stop'
if(-not $InstallDir){$InstallDir=Split-Path -Parent $PSScriptRoot}
$dataDir=if($env:WAN_EDITOR_DATA_DIR){[IO.Path]::GetFullPath($env:WAN_EDITOR_DATA_DIR)}else{Join-Path $env:LOCALAPPDATA 'YingTiStudio\data'}
$hash=[Security.Cryptography.SHA256]::Create()
try{$identity=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($dataDir.TrimEnd('\','/').ToLowerInvariant())))).Replace('-','').ToLowerInvariant().Substring(0,24)}finally{$hash.Dispose()}
$ports=@();$address=$null;$processes=@()
try{$address=Get-Content -LiteralPath (Join-Path $dataDir 'runtime.json') -Raw | ConvertFrom-Json;if($address.instanceId -eq $identity){$ports+=[int]$address.port}}catch{}
$ports+=3210..3229
$listening=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)
foreach($port in ($ports | Select-Object -Unique)){
    if($port -lt 1024 -or $port -gt 65535 -or -not($listening | Where-Object LocalPort -eq $port)){continue}
    $origin="http://127.0.0.1:$port"
    try{$health=Invoke-RestMethod "$origin/api/health" -TimeoutSec 2}catch{continue}
    if($health.app -ne 'wan-replace-studio' -or $health.instanceId -ne $identity){continue}
    foreach($connection in ($listening | Where-Object { $_.LocalPort -eq $port -and $_.LocalAddress -eq '127.0.0.1' })){
        $process=Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
        if($process){$processes+=$process}
    }
    $boot=Invoke-RestMethod "$origin/api/bootstrap" -TimeoutSec 3
    Invoke-RestMethod -Method Post -Uri "$origin/api/shutdown" -Headers @{'x-csrf-token'=$boot.csrf} -TimeoutSec 5 | Out-Null
}
# A graceful shutdown can close its HTTP listener while saving a paid task ID.
$pidFile=Join-Path $dataDir 'server.pid'
if(Test-Path -LiteralPath $pidFile){
    $serviceId=0
    if([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(),[ref]$serviceId)){
        $process=Get-Process -Id $serviceId -ErrorAction SilentlyContinue
        if($process -and $process.Path -eq (Join-Path $InstallDir 'runtime\node.exe') -and $process.StartTime -le (Get-Item -LiteralPath $pidFile).LastWriteTime.AddSeconds(1)){$processes+=$process}
    }
}
$clock=[Diagnostics.Stopwatch]::StartNew()
try {
    foreach($process in ($processes | Sort-Object Id -Unique)){
        while(-not $process.HasExited){
            if($clock.Elapsed.TotalSeconds -gt $TimeoutSeconds){throw 'The background service is still saving a task. No files were replaced.'}
            $process.WaitForExit(500) | Out-Null
        }
    }
} finally {
    foreach($process in $processes){$process.Dispose()}
}
