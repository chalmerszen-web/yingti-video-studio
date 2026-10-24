param([Parameter(Mandatory=$true)][string]$Installer,[string]$PreviousInstaller,[ValidateSet('Developer','User')][string]$Edition='Developer')
$ErrorActionPreference='Stop'
$MaterialCase=$env:YINGTI_MATERIAL_CASE -eq '1'
$appId=if($Edition -eq 'User'){'YingTiStudioUser'}else{'YingTiStudio'}
$root = Split-Path -Parent $PSScriptRoot
$installerFile=[IO.Path]::GetFullPath($Installer)
$initialInstaller=if($PreviousInstaller){[IO.Path]::GetFullPath($PreviousInstaller)}else{$installerFile}
$caseRoot=Join-Path $root ('.test-output\packaging\install-smoke-'+[guid]::NewGuid().ToString('N').Substring(0,8))
$installRoot=Join-Path $caseRoot 'Program Files'
$testData=Join-Path $caseRoot 'User Data'
New-Item -ItemType Directory -Path $caseRoot -Force | Out-Null
$foreign=$null; $origin=$null; $identity=$null
$nodePath=(Get-Command node -ErrorAction Stop).Source
$initialRegistry = Get-ItemProperty ('HKCU:\Software\'+$appId) -ErrorAction SilentlyContinue
function Require($Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Run-Hidden([string]$File,[string]$Arguments,[int]$Timeout=120000){
    $process=Start-Process -FilePath $File -ArgumentList $Arguments -WindowStyle Hidden -PassThru
    if(-not $process.WaitForExit($Timeout)){throw "Process timed out: $File"}
    return $process.ExitCode
}
function Stop-TestService {
    if(-not $origin){return}
    try {
        $health=Invoke-RestMethod "$origin/api/health" -TimeoutSec 2
        if($health.instanceId -ne $identity){return}
        $boot=Invoke-RestMethod "$origin/api/bootstrap" -TimeoutSec 2
        Invoke-RestMethod -Method Post -Uri "$origin/api/shutdown" -Headers @{'x-csrf-token'=$boot.csrf} | Out-Null
        for($i=0;$i -lt 100;$i++){
            Start-Sleep -Milliseconds 100
            try{$still=Invoke-RestMethod "$origin/api/health" -TimeoutSec 1}catch{return}
        }
        throw 'Isolated service did not stop.'
    } catch { if($_.Exception.Message -eq 'Isolated service did not stop.'){throw} }
}
try {
    $ports=@([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object {$_.Port})
    if($ports -notcontains 3210){
        $foreign=Start-Process -FilePath $nodePath -ArgumentList @('"'+(Join-Path $root 'test\package-port-fixture.mjs')+'"') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $caseRoot 'foreign.log') -RedirectStandardError (Join-Path $caseRoot 'foreign-error.log')
        for($i=0;$i -lt 30;$i++){try{Invoke-RestMethod 'http://127.0.0.1:3210/api/health' -TimeoutSec 1 | Out-Null;break}catch{Start-Sleep -Milliseconds 100}}
    }
    $env:WAN_EDITOR_DATA_DIR=$testData
    Remove-Item Env:WAN_EDITOR_PORT -ErrorAction SilentlyContinue
    # The installed app must work without a system Node, npm or FFmpeg on PATH.
    $env:PATH="$env:WINDIR\System32;$env:WINDIR;$env:WINDIR\System32\WindowsPowerShell\v1.0"
    $unrelatedDir=Join-Path $caseRoot 'Existing User Folder'
    New-Item -ItemType Directory -Path $unrelatedDir -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $unrelatedDir 'personal.txt'),'do not overwrite')
    Require ((Run-Hidden $installerFile ('/S /TESTMODE /D='+$unrelatedDir)) -ne 0) 'Installer accepted an unrelated nonempty folder.'
    Require (-not(Test-Path -LiteralPath (Join-Path $unrelatedDir ($appId+'.exe')))) 'Installer wrote to the protected folder.'
    Require ([IO.File]::ReadAllText((Join-Path $unrelatedDir 'personal.txt')) -eq 'do not overwrite') 'Installer changed unrelated data.'
    $arguments='/S /TESTMODE /D='+$installRoot
    Require ((Run-Hidden $initialInstaller $arguments) -eq 0) 'Fresh installation failed.'
    $manifest=Get-Content -LiteralPath (Join-Path $installRoot 'build-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach($file in $manifest.files){
        $installedFile=Join-Path $installRoot $file.path
        Require (Test-Path -LiteralPath $installedFile) ('Missing payload file: '+$file.path)
        Require ((Get-FileHash -LiteralPath $installedFile -Algorithm SHA256).Hash -eq $file.sha256) ('Payload hash mismatch: '+$file.path)
    }
    Require (-not(Test-Path -LiteralPath (Join-Path $installRoot 'data'))) 'User data must not be bundled.'
    $launcher=Join-Path $installRoot ($appId+'.exe')
    Require ((Run-Hidden $launcher '--no-browser' 30000) -eq 0) 'First launcher call did not finish.'
    $address=Get-Content -LiteralPath (Join-Path $testData 'runtime.json') -Raw | ConvertFrom-Json
    $origin='http://127.0.0.1:'+$address.port; $identity=$address.instanceId
    Require ($address.port -ne 3210) 'Launcher reused a foreign workspace port.'
    $health=Invoke-RestMethod "$origin/api/health"
    Require ($health.version -eq $manifest.version -and $health.ffmpeg -and $health.ffprobe) 'Bundled service/tools not ready.'
    $boot=Invoke-RestMethod "$origin/api/bootstrap"
    Require (-not $boot.key.configured) 'Package must not contain a KEY.'
    Require ($boot.features.fundingPreflight -eq $false) 'Deferred balance preflight was enabled.'
    Require ($boot.features.localMaterialRepair -eq $true) 'Bundled local material worker was not enabled.'
    & (Join-Path $installRoot 'runtime\local-material\python.exe') -I -B -X utf8 (Join-Path $PSScriptRoot 'local-runtime-smoke.py')
    Require ($LASTEXITCODE -eq 0) 'Bundled CPU models did not run with restricted PATH.'
    $projects=Invoke-RestMethod "$origin/api/projects"; $jobs=Invoke-RestMethod "$origin/api/jobs"
    Require ($projects.Count -eq 0 -and $jobs.Count -eq 0) 'Package must start with no user projects or jobs.'
    if($MaterialCase) {
        $materialReport=Join-Path $root ('.test-output\material-release\installed-'+$Edition.ToLowerInvariant()+'-material.json')
        & (Join-Path $installRoot 'runtime\node.exe') (Join-Path $root '.test-output\material-release\installed-material-case.mjs') $installRoot $testData $origin $materialReport
        Require ($LASTEXITCODE -eq 0) 'Installed full material processing failed.'
        $materialCheck=Get-Content -LiteralPath $materialReport -Raw -Encoding UTF8 | ConvertFrom-Json
        Require ($materialCheck.passed -and $materialCheck.allFramesEqualAcceptedR14 -and $materialCheck.confirmedState -eq 'confirmed') 'Installed frame equality/confirmation failed.'
    }
    foreach($url in @('/','/studio.js','/readability.css','/full-dialogue-ui.js','/local-material-ui.js','/local-material.css','/local-material-view.js','/output-recovery.js','/output-recovery.css')){
        Require ((Invoke-WebRequest -UseBasicParsing -Uri ($origin+$url)).StatusCode -eq 200) ('UI asset not served: '+$url)
    }
    $installedPage=(Invoke-WebRequest -UseBasicParsing -Uri ($origin+'/')).Content
    $versionLabel=if($Edition -eq 'User'){'用户版 · '+$manifest.version}else{'v'+$manifest.version}
    Require ($installedPage.Contains($versionLabel)) 'Visible UI version differs from installed metadata.'
    Require ($installedPage -notmatch '(?i)omni-plus') 'An obsolete Omni model is shown in the installed page.'
    $installedProvider=Get-Content -LiteralPath (Join-Path $installRoot 'src/provider.js') -Raw
    Require ($installedProvider.Contains("ANALYSIS_MODEL = 'Omni-Analysis'")) 'Installed analysis model was not migrated.'
    $installedEngine=Get-Content -LiteralPath (Join-Path $installRoot 'src/engine.js') -Raw
    Require ($installedEngine.Contains('GENERATION_WAIT_MS = 3600 * 1000')) 'Installed generation timeout differs from 3600 seconds.'
    try { Invoke-RestMethod "$origin/api/funding" | Out-Null; throw 'Deferred funding endpoint unexpectedly succeeded.' } catch {
        $expectedFundingStatus=if($Edition -eq 'User'){403}else{409}
        Require ([int]$_.Exception.Response.StatusCode -eq $expectedFundingStatus) 'Deferred funding endpoint did not reject without querying the provider.'
    }
    Require ((Run-Hidden $launcher '--no-browser' 30000) -eq 0) 'Repeated launch failed.'
    $repeated=Get-Content -LiteralPath (Join-Path $testData 'runtime.json') -Raw | ConvertFrom-Json
    Require ($repeated.pid -eq $address.pid -and $repeated.port -eq $address.port) 'Repeated launch created another service.'
    Require ((Run-Hidden $launcher '--check-running' 30000) -eq 10) 'Running detection failed.'
    $fakeKeyBody=@{key='installer-smoke-test-not-a-real-key';remember=$true} | ConvertTo-Json
    Invoke-RestMethod -Method Post -Uri "$origin/api/key" -Headers @{'x-csrf-token'=$boot.csrf} -ContentType 'application/json' -Body $fakeKeyBody | Out-Null
    Require (Test-Path -LiteralPath (Join-Path $testData 'credential.dpapi')) 'Local encrypted credential test failed.'
    $previousVersion=$health.version
    $runtimeReadLock=[IO.File]::Open((Join-Path $installRoot 'runtime\node.exe'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{Require ((Run-Hidden $installerFile $arguments 420000) -eq 0) 'Automatic running-version upgrade failed.'}finally{$runtimeReadLock.Dispose()}
    Require ((Run-Hidden $launcher '--no-browser' 30000) -eq 0) 'Launcher failed after automatic upgrade.'
    $address=Get-Content -LiteralPath (Join-Path $testData 'runtime.json') -Raw | ConvertFrom-Json
    $origin='http://127.0.0.1:'+$address.port;$identity=$address.instanceId
    $manifest=Get-Content -LiteralPath (Join-Path $installRoot 'build-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach($file in $manifest.files){Require ((Get-FileHash -LiteralPath (Join-Path $installRoot $file.path)).Hash -eq $file.sha256) ('Upgraded payload mismatch: '+$file.path)}
    $boot=Invoke-RestMethod "$origin/api/bootstrap"
    Require ($boot.key.configured -and $boot.key.remembered) 'Automatic update lost saved credential.'
    $video=Join-Path $testData 'codec-fixture.mp4'
    & (Join-Path $installRoot 'runtime\ffmpeg.exe') -hide_banner -loglevel error -y -f lavfi -i 'color=c=blue:size=160x90:rate=30' -f lavfi -i 'sine=frequency=440:sample_rate=48000' -t 2 -c:v libx264 -pix_fmt yuv420p -c:a aac $video
    Require ($LASTEXITCODE -eq 0) 'Bundled H.264/AAC encode failed.'
    $media=& (Join-Path $installRoot 'runtime\ffprobe.exe') -v error -show_streams -show_format -of json $video | ConvertFrom-Json
    Require (@($media.streams | Where-Object codec_name -eq h264).Count -eq 1) 'H.264 stream missing.'
    Require (@($media.streams | Where-Object codec_name -eq aac).Count -eq 1) 'AAC stream missing.'
    Stop-TestService
    $desktopReadLock=[IO.File]::Open((Join-Path $installRoot 'desktop\YingTiDesktop.exe'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{Require ((Run-Hidden $installerFile $arguments) -eq 0) 'Unchanged desktop runtime should not be overwritten.'}finally{$desktopReadLock.Dispose()}
    Require ((Run-Hidden $launcher '--no-browser' 30000) -eq 0) 'Upgraded launcher failed.'
    $boot=Invoke-RestMethod "$origin/api/bootstrap"
    Require ($boot.key.configured -and $boot.key.remembered) 'Upgrade did not preserve encrypted test data.'
    [IO.File]::WriteAllText((Join-Path $testData 'keep-on-uninstall.txt'),'retain test data')
    [IO.File]::WriteAllText((Join-Path $installRoot 'user-added-note.txt'),'retain unrecognized file')
    Require ((Run-Hidden (Join-Path $installRoot 'Uninstall.exe') '/S') -eq 0) 'Uninstaller failed.'
    for($i=0;$i -lt 100 -and (Test-Path -LiteralPath $launcher);$i++){Start-Sleep -Milliseconds 100}
    Require (-not(Test-Path -LiteralPath $launcher)) 'Installed executable remained after uninstall.'
    Require (Test-Path -LiteralPath (Join-Path $testData 'keep-on-uninstall.txt')) 'Uninstall removed user data.'
    Require (Test-Path -LiteralPath (Join-Path $testData 'credential.dpapi')) 'Uninstall removed user credentials.'
    Require (Test-Path -LiteralPath (Join-Path $installRoot 'user-added-note.txt')) 'Uninstall removed an unrecognized user file.'
    $afterRegistry=Get-ItemProperty ('HKCU:\Software\'+$appId) -ErrorAction SilentlyContinue
    Require ($initialRegistry.InstallDir -eq $afterRegistry.InstallDir) 'Test install changed the real installation registration.'
    $report=@{passed=$true;version=$manifest.version;previousVersion=$previousVersion;installer=$installerFile;installerSha256=(Get-FileHash -LiteralPath $installerFile).Hash;payloadFilesVerified=$manifest.files.Count;port=$address.port;restrictedPath=$true;unrelatedDirectoryBlocked=$true;freshKeyEmpty=$true;freshProjectsEmpty=$true;duplicateLaunchReused=$true;runningUpgradeAutomatic=$true;upgradePreservedData=$true;uninstallPreservedData=$true;uninstallPreservedUnknownFile=$true;bundledCodecs='H.264/AAC';newModelCalls=0;caseRoot=$caseRoot}
    $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root ('.test-output\packaging\'+$Edition.ToLowerInvariant()+'-smoke-report.json')) -Encoding UTF8
    $report | ConvertTo-Json -Depth 5
} finally {
    Stop-TestService
    if($foreign -and -not $foreign.HasExited){Stop-Process -Id $foreign.Id -ErrorAction SilentlyContinue}
}
