$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'scripts\install-identity.ps1')
$caseRoot=Join-Path $root ('.test-output\packaging\identity-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $caseRoot -Force | Out-Null
$env:LOCALAPPDATA=Join-Path $caseRoot 'Local App Data'
$default=Join-Path $env:LOCALAPPDATA 'Programs\YingTiStudio'
$manifest=Join-Path $caseRoot 'manifest.json'
$script:registered=''
function Get-YingTiRegisteredDir {return $script:registered}
function Get-FileHash {throw 'Get-FileHash must not be needed by installer helpers.'}
$passed=@()
function Check([string]$Directory,[string]$Expected,[string]$Name){
    $actual=Get-YingTiInstallState -InstallDir $Directory -ManifestPath $manifest
    if($actual -ne $Expected){throw "$Name expected $Expected but got $actual"}
    $script:passed+=$Name
}
Check $default New 'missing directory'
New-Item -ItemType Directory -Path $default -Force | Out-Null
Check $default Empty 'existing empty directory'
[IO.File]::WriteAllText((Join-Path $default 'unknown.txt'),'user data')
Check $default Invalid 'unrelated nonempty directory'
[IO.File]::WriteAllText((Join-Path $default 'installed-product.id'),'wrong product')
Check $default Invalid 'invalid product marker'
[IO.File]::WriteAllText((Join-Path $default 'installed-product.id'),"YingTiStudio.LocalTest.x64`r`n")
Check $default Installed 'known marker with newline'
Remove-Item -LiteralPath (Join-Path $default 'installed-product.id'),(Join-Path $default 'unknown.txt')
New-Item -ItemType Directory -Path (Join-Path $default 'runtime') -Force | Out-Null
$binary=Join-Path $default 'runtime\node.exe'
[IO.File]::WriteAllText($binary,'fixture runtime bytes')
$build=@{product='YingTiStudio';files=@(@{path='runtime/node.exe';sha256=(Get-YingTiFileHash $binary)})}
[IO.File]::WriteAllText($manifest,($build | ConvertTo-Json -Depth 5))
$held=[IO.File]::Open($binary,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try{Check $default Repair 'markerless identical runtime with read lock'}finally{$held.Dispose()}
[IO.File]::WriteAllText($binary,'changed or unrelated runtime bytes')
Check $default Invalid 'unknown runtime bytes blocked'
[IO.File]::WriteAllText($binary,'fixture runtime bytes')
[IO.File]::WriteAllText((Join-Path $default 'notes.txt'),'keep this')
Check $default Invalid 'unknown files in residual directory blocked'
$custom=Join-Path $caseRoot 'Custom Installation'
New-Item -ItemType Directory -Path (Join-Path $custom 'runtime') -Force | Out-Null
Copy-Item -LiteralPath $binary -Destination (Join-Path $custom 'runtime\node.exe')
Check $custom Invalid 'runtime in unrelated directory blocked'
$script:registered=$custom
Check $custom Repair 'registered residual directory'
[IO.File]::WriteAllText((Join-Path $custom 'runtime\node.exe'),'older bytes')
[IO.File]::WriteAllText((Join-Path $custom 'build-manifest.json'),'{"product":"YingTiStudio"}')
[IO.File]::WriteAllText((Join-Path $custom 'package.json'),'{"name":"wan-replace-studio"}')
Check $custom Repair 'registered partial application metadata'
$plainFile=Join-Path $caseRoot 'file.txt';[IO.File]::WriteAllText($plainFile,'not a folder')
Check $plainFile Invalid 'ordinary file path blocked'
@{passed=$true;count=$passed.Count;checks=$passed;usesGetFileHash=$false;caseRoot=$caseRoot} | ConvertTo-Json -Depth 4
