param([Parameter(Mandatory=$true)][string]$InstallDir,[string]$Version='2.2.9',[ValidateSet('Update','Uninstall')][string]$Operation='Update',[string]$ManifestPath,[string]$CopyPlan,[switch]$IgnoreRegistration)
$ErrorActionPreference='Stop'
$InstallDir=[IO.Path]::GetFullPath($InstallDir).TrimEnd('\','/')
$dataDir=if($env:WAN_EDITOR_DATA_DIR){[IO.Path]::GetFullPath($env:WAN_EDITOR_DATA_DIR)}else{Join-Path $env:LOCALAPPDATA 'YingTiStudio\data'}
$desktopPath=Join-Path $InstallDir 'desktop\YingTiDesktop.exe'
try {
    . (Join-Path $PSScriptRoot 'install-identity.ps1')
    $state=Get-YingTiInstallState -InstallDir $InstallDir -ManifestPath $ManifestPath -IgnoreRegistration:$IgnoreRegistration
    if($state -eq 'Invalid' -or ($Operation -eq 'Uninstall' -and $state -ne 'Installed')){throw 'Installation identity does not match.'}
    $control=$null
    try{$control=Get-Content -LiteralPath (Join-Path $dataDir 'desktop-control.json') -Raw | ConvertFrom-Json}catch{}
    $desktop=$null
    if($control -and $control.app -eq 'yingti-desktop'){
        $candidate=Get-Process -Id $control.pid -ErrorAction SilentlyContinue
        if($candidate -and $candidate.Path -eq $desktopPath){$desktop=$candidate}elseif($candidate){$candidate.Dispose()}
    }
    if($desktop){
        $requestId=[guid]::NewGuid().ToString('N')
        $request=@{token=$control.token;requestId=$requestId;reason=$Operation}
        [IO.File]::WriteAllText((Join-Path $dataDir 'desktop-quit-request.json'),($request | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
        $clock=[Diagnostics.Stopwatch]::StartNew()
        while(-not $desktop.HasExited){
            if($clock.Elapsed.TotalSeconds -gt 320){throw 'Desktop did not finish saving. No application files were replaced.'}
            try{
                $status=Get-Content -LiteralPath (Join-Path $dataDir 'desktop-status.json') -Raw | ConvertFrom-Json
                if($status.lastRequestId -eq $requestId -and $status.lastError){throw ('Desktop save failed: '+$status.lastError)}
            }catch{if($_.Exception.Message.StartsWith('Desktop save failed:')){throw}}
            $desktop.WaitForExit(500) | Out-Null
        }
        $desktop.Dispose()
    } else {
        $stillRunning=Get-CimInstance Win32_Process -Filter "Name='YingTiDesktop.exe'" -ErrorAction SilentlyContinue | Where-Object ExecutablePath -eq $desktopPath
        if($stillRunning){throw 'The desktop is still starting. Please retry the installer shortly.'}
    }
    & (Join-Path $PSScriptRoot 'stop-backend.ps1') -InstallDir $InstallDir
    if($LASTEXITCODE -and $LASTEXITCODE -ne 0){throw 'Unable to close background service.'}
    # Wait for the renderer and GPU children to release runtime files; never kill
    # another app or interrupt an unacknowledged cloud submission.
    $clock=[Diagnostics.Stopwatch]::StartNew()
    do {
        $children=Get-CimInstance Win32_Process -Filter "Name='YingTiDesktop.exe'" -ErrorAction SilentlyContinue | Where-Object ExecutablePath -eq $desktopPath
        if(-not $children){break}
        if($clock.Elapsed.TotalSeconds -gt 20){throw 'Desktop child processes are still closing. Retry the update shortly.'}
        Start-Sleep -Milliseconds 250
    } while($true)
    $newManifest=$null;$keep=@('[keep]')
    if($ManifestPath){$newManifest=Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json}
    # Do not rewrite byte-identical runtimes; overlays can retain read handles
    # even after the old application exits. Changed files still require access.
    foreach($relative in @('YingTiStudio.exe','desktop\YingTiDesktop.exe','runtime\node.exe','runtime\ffmpeg.exe','runtime\ffprobe.exe')){
        $executable=Join-Path $InstallDir $relative
        if(-not(Test-Path -LiteralPath $executable)){continue}
        $entry=$newManifest.files | Where-Object path -eq $relative.Replace('\','/') | Select-Object -First 1
        if($Operation -eq 'Update' -and $CopyPlan -and $entry.sha256 -match '^[a-f0-9]{64}$' -and (Get-YingTiFileHash $executable) -eq $entry.sha256){$keep+=($relative+'=1');continue}
        $clock=[Diagnostics.Stopwatch]::StartNew()
        do {
            try{$stream=[IO.File]::Open($executable,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);$stream.Dispose();break}
            catch{if($clock.Elapsed.TotalSeconds -gt 20){throw ('Program file is still held by another application: '+$relative+'. No application files were replaced.')} ; Start-Sleep -Milliseconds 250}
        }while($true)
    }
    if($CopyPlan){[IO.File]::WriteAllLines($CopyPlan,$keep,[Text.Encoding]::ASCII)}
    if($Operation -eq 'Update' -and (Test-Path -LiteralPath (Join-Path $dataDir 'queue.sqlite'))){
        $backup=Join-Path $dataDir ('backups\before-'+$Version+'-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff'))
        New-Item -ItemType Directory -Path $backup -Force | Out-Null
        foreach($name in @('queue.sqlite','queue.sqlite-wal','queue.sqlite-shm')){
            $source=Join-Path $dataDir $name
            if(Test-Path -LiteralPath $source){Copy-Item -LiteralPath $source -Destination (Join-Path $backup $name)}
        }
    }
    Write-Output 'Old application closed safely; user data retained.'
    exit 0
} catch {
    try{New-Item -ItemType Directory -Path $dataDir -Force | Out-Null;[IO.File]::WriteAllText((Join-Path $dataDir 'update-error.log'),($_ | Out-String),[Text.UTF8Encoding]::new($false))}catch{}
    Write-Error 'Unable to finish automatic update preparation. User data is unchanged; see update-error.log.'
    exit 1
}
