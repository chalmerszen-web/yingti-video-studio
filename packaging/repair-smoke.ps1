param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$installerFile=[IO.Path]::GetFullPath($Installer)
$caseRoot=Join-Path $root ('.test-output\packaging\repair-smoke-'+[guid]::NewGuid().ToString('N').Substring(0,8))
$env:LOCALAPPDATA=Join-Path $caseRoot 'Local App Data'
$env:WAN_EDITOR_DATA_DIR=Join-Path $caseRoot 'User Data'
$program=Join-Path $env:LOCALAPPDATA 'Programs\YingTiStudio'
$runtime=Join-Path $program 'runtime\node.exe'
New-Item -ItemType Directory -Path (Split-Path -Parent $runtime),$env:WAN_EDITOR_DATA_DIR -Force | Out-Null
Copy-Item -LiteralPath (Get-Command node).Source -Destination $runtime
[IO.File]::WriteAllText((Join-Path $env:WAN_EDITOR_DATA_DIR 'preserve.txt'),'keep my existing project data')
function Require($value,$message){if(-not $value){throw $message}}
function Run($file,$arguments,$timeout=420000){$process=Start-Process -FilePath $file -ArgumentList $arguments -WindowStyle Hidden -PassThru;try{if(-not $process.WaitForExit($timeout)){throw 'Process timeout'};return $process.ExitCode}finally{$process.Dispose()}}
Require (-not(Test-Path -LiteralPath (Join-Path $program 'installed-product.id'))) 'Residual fixture unexpectedly has a marker'
$lock=[IO.File]::Open($runtime,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try{Require ((Run $installerFile ('/S /TESTMODE /D='+$program)) -eq 0) 'Markerless runtime repair failed'}finally{$lock.Dispose()}
$manifest=Get-Content -LiteralPath (Join-Path $program 'build-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach($file in $manifest.files){Require ((Get-FileHash -LiteralPath (Join-Path $program $file.path)).Hash -eq $file.sha256) ('Repair payload mismatch: '+$file.path)}
Require ([IO.File]::ReadAllText((Join-Path $env:WAN_EDITOR_DATA_DIR 'preserve.txt')) -eq 'keep my existing project data') 'Repair changed user data'
$empty=Join-Path $caseRoot 'Existing Empty Folder'
New-Item -ItemType Directory -Path $empty -Force | Out-Null
Require ((Run $installerFile ('/S /TESTMODE /D='+$empty)) -eq 0) 'Existing empty folder installation failed'
Require (Test-Path -LiteralPath (Join-Path $empty 'YingTiStudio.exe')) 'Empty-folder installation missing launcher'
$unknown=Join-Path $caseRoot 'Unrelated Folder'
New-Item -ItemType Directory -Path $unknown -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $unknown 'notes.txt'),'do not change')
Require ((Run $installerFile ('/S /TESTMODE /D='+$unknown)) -ne 0) 'Unrelated folder was accepted'
Require ([IO.File]::ReadAllText((Join-Path $unknown 'notes.txt')) -eq 'do not change') 'Unrelated file changed'
Require (-not(Test-Path -LiteralPath (Join-Path $unknown 'YingTiStudio.exe'))) 'Program entered unrelated directory'
$report=@{passed=$true;version=$manifest.version;installerSha256=(Get-FileHash -LiteralPath $installerFile).Hash;markerlessLockedRuntimeRepaired=$true;payloadFilesVerified=$manifest.files.Count;dataPreserved=$true;existingEmptyFolderAccepted=$true;unrelatedFolderBlocked=$true;caseRoot=$caseRoot;newModelCalls=0}
$report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $root '.test-output\packaging\repair-smoke-report.json') -Encoding UTF8
$report | ConvertTo-Json -Depth 4
