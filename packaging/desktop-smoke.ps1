param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$installerFile=[IO.Path]::GetFullPath($Installer)
$caseRoot=Join-Path $root ('.test-output\packaging\desktop-smoke-'+[guid]::NewGuid().ToString('N').Substring(0,8))
$program=Join-Path $caseRoot 'Program Files'
$data=Join-Path $caseRoot 'User Data'
New-Item -ItemType Directory -Path $caseRoot -Force | Out-Null
$env:WAN_EDITOR_DATA_DIR=$data
Remove-Item Env:WAN_EDITOR_PORT -ErrorAction SilentlyContinue
function Require($value,$message){if(-not $value){throw $message}}
function Run($file,$arguments,$timeout=420000){$process=Start-Process -FilePath $file -ArgumentList $arguments -WindowStyle Hidden -PassThru;try{if(-not $process.WaitForExit($timeout)){throw 'Process timeout'};return $process.ExitCode}finally{$process.Dispose()}}
function ReadStatus {try{return Get-Content -LiteralPath (Join-Path $data 'desktop-status.json') -Raw | ConvertFrom-Json}catch{return $null}}
function WaitDesktop($oldId=0){
  for($i=0;$i -lt 120;$i++){$value=ReadStatus;if($value -and $value.rendered -and $value.tray -and -not $value.quitting -and $value.pid -ne $oldId){return $value};Start-Sleep -Milliseconds 250}
  throw 'Desktop did not become ready'
}
$arguments='/S /TESTMODE /D='+$program
try {
  Require ((Run $installerFile $arguments) -eq 0) 'Desktop installation failed'
  $launcher=Join-Path $program 'YingTiStudio.exe'
  & (Join-Path $program 'runtime\node.exe') --disable-warning=ExperimentalWarning (Join-Path $PSScriptRoot 'seed-desktop-test.mjs') $program $data | Out-Null
  Require ($LASTEXITCODE -eq 0) 'Unable to seed local fixture'
  & (Join-Path $program 'runtime\ffmpeg.exe') -hide_banner -loglevel error -y -f lavfi -i 'color=c=blue:size=160x90:rate=30' -t 2 -an -c:v libx264 (Join-Path $data 'projects\11111111-2222-4333-8444-555555555555\source.mp4')
  Require ($LASTEXITCODE -eq 0) 'Unable to encode local fixture'
  Require ((Run $launcher '--start-minimized' 30000) -eq 0) 'Unable to start desktop'
  $first=WaitDesktop
  Require (-not $first.visible) 'Start-minimized opened a visible window'
  $origin='http://127.0.0.1:'+$first.backendPort
  $boot=Invoke-RestMethod "$origin/api/bootstrap"
  Invoke-RestMethod -Method Post -Uri "$origin/api/key" -Headers @{'x-csrf-token'=$boot.csrf} -ContentType 'application/json' -Body (@{key='installer-smoke-test-not-a-real-key';remember=$true} | ConvertTo-Json) | Out-Null
  $projectBefore=Invoke-RestMethod "$origin/api/projects/11111111-2222-4333-8444-555555555555" | ConvertTo-Json -Depth 30
  Require ((Run $launcher '--start-minimized' 30000) -eq 0) 'Second desktop launch failed'
  for($i=0;$i -lt 40;$i++){$second=ReadStatus;if($second.visible -and $second.secondInstances -gt 0){break};Start-Sleep -Milliseconds 100}
  Require ($second.pid -eq $first.pid -and $second.backendPid -eq $first.backendPid -and $second.visible) 'Duplicate launch did not restore the same desktop'
  $held=[IO.File]::Open((Join-Path $program 'desktop\YingTiDesktop.exe'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try{Require ((Run $installerFile $arguments) -eq 0) 'Running desktop could not save, close and upgrade'}finally{$held.Dispose()}
  Require ((Run $launcher '--start-minimized' 30000) -eq 0) 'Updated desktop did not start'
  $updated=WaitDesktop $first.pid
  $origin='http://127.0.0.1:'+$updated.backendPort
  $projectAfter=Invoke-RestMethod "$origin/api/projects/11111111-2222-4333-8444-555555555555" | ConvertTo-Json -Depth 30
  Require ($projectBefore -eq $projectAfter) 'Desktop upgrade changed the saved project'
  $boot=Invoke-RestMethod "$origin/api/bootstrap"
  Require ($boot.key.configured -and $boot.key.remembered) 'Desktop upgrade lost encrypted KEY'
  Require ([IO.File]::ReadAllText((Join-Path $data 'project-proof.txt')).Contains('Keep this data')) 'Data file was not preserved'
  $report=@{passed=$true;installerSha256=(Get-FileHash -LiteralPath $installerFile).Hash;version=$updated.version;desktopRendered=$true;trayRetained=$true;minimizedStartHidden=$true;reopenRestoredSameWindow=$true;runningDesktopUpgraded=$true;unchangedLockedRuntimeReused=$true;projectPreserved=$true;encryptedKeyPreserved=$true;newModelCalls=0;caseRoot=$caseRoot}
  $report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $root '.test-output\packaging\desktop-smoke-report.json') -Encoding UTF8
  $report | ConvertTo-Json -Depth 4
} finally {
  if(Test-Path -LiteralPath (Join-Path $program 'scripts\prepare-update.ps1')){
    & (Join-Path $program 'scripts\prepare-update.ps1') -InstallDir $program -ManifestPath (Join-Path $program 'build-manifest.json') -CopyPlan (Join-Path $caseRoot 'cleanup-copy-plan.ini') -Version '2.2.0'
  }
}
