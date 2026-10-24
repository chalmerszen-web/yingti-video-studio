param([Parameter(Mandatory=$true)][string]$InstallDir,[Parameter(Mandatory=$true)][string]$ManifestPath,[Parameter(Mandatory=$true)][string]$ResultPath,[switch]$IgnoreRegistration)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'install-identity.ps1')
$state=Get-YingTiInstallState -InstallDir $InstallDir -ManifestPath $ManifestPath -IgnoreRegistration:$IgnoreRegistration
[IO.File]::WriteAllText($ResultPath,("[install]`r`nstate="+$state+"`r`n"),[Text.Encoding]::Unicode)
if($state -eq 'Invalid'){exit 1}
exit 0
