$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
& node --version
& ffmpeg -version | Select-Object -First 1
& ffprobe -version | Select-Object -First 1
& npm.cmd run check
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& npm.cmd test
exit $LASTEXITCODE
