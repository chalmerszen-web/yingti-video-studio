param([string]$NsisPath, [string]$NodePath, [string]$FfmpegPath, [string]$LocalMaterialRuntime, [switch]$Rebuild, [switch]$QuickTest, [switch]$FastCompression, [ValidatePattern('^[a-z0-9-]{0,32}$')][string]$StageTag='', [ValidateSet('Developer','User')][string]$Edition='Developer')
$ErrorActionPreference='Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectDir
if (-not $NodePath) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
& $NodePath (Join-Path $projectDir 'packaging/check-edition-versions.mjs')
if($LASTEXITCODE -ne 0){throw 'Visible version validation failed before packaging.'}
$package = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json
$version = $package.version
$appId='YingTiStudio'; $appTitle='映替视频工作台'
if($Edition -eq 'User') {
    $userEdition=Get-Content -LiteralPath 'packaging/user-edition.json' -Encoding UTF8 -Raw | ConvertFrom-Json
    if($userEdition.productId -ne 'YingTiStudioUser' -or $userEdition.functionalBaseline -ne $package.version){throw 'User edition requires its declared development baseline.'}
    $version=$userEdition.version; $appId=$userEdition.productId; $appTitle=$userEdition.title
}
function Convert-EditionText([string]$Content) {
    if($Edition -eq 'User') { return $Content.Replace('YingTiStudio','YingTiStudioUser').Replace('映替视频工作台','映替视频工作台（用户版）').Replace('映替 · 视频工作台 ','映替 · 视频工作台（用户版） ').Replace(($package.version+'.0'),($version+'.0')).Replace(("Version='"+$package.version+"'"),("Version='"+$version+"'")) }
    return $Content
}
$buildRoot = Join-Path $projectDir '.test-output\packaging'
$toolsRoot = Join-Path $projectDir '.test-output\package-tools'
$stageName="stage-$version"+$(if($StageTag){'-'+$StageTag}else{''})
if($Edition -eq 'User'){$stageName='user-'+$stageName}
$payload = [IO.Path]::GetFullPath((Join-Path $buildRoot $stageName))
$outputDir = Join-Path $projectDir 'dist'
New-Item -ItemType Directory -Path $buildRoot,$outputDir -Force | Out-Null
if (Test-Path -LiteralPath $payload) {
    if (-not $Rebuild) { throw 'Build stage already exists. Pass -Rebuild to replace only that generated stage.' }
    if (-not $payload.StartsWith([IO.Path]::GetFullPath($buildRoot) + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $payload) -ne $stageName) { throw 'Unsafe stage path' }
    Remove-Item -LiteralPath $payload -Recurse -Force
}
if (-not $NsisPath) { $NsisPath = Join-Path $toolsRoot 'nsis-3.13\makensis.exe' }
if (-not $NodePath) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
if (-not $FfmpegPath) { $FfmpegPath = (Get-Command ffmpeg -ErrorAction Stop).Source }
$ffprobePath = Join-Path (Split-Path -Parent $FfmpegPath) 'ffprobe.exe'
$ffmpegRoot = Split-Path -Parent (Split-Path -Parent $FfmpegPath)
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$electronRoot=Join-Path $toolsRoot 'electron-44.6.0'
$electronZip=Join-Path $toolsRoot 'electron-v44.6.0-win32-x64.zip'
if (-not $LocalMaterialRuntime) { $LocalMaterialRuntime = Join-Path $toolsRoot 'local-material-cpu-release/runtime' }
foreach($file in @($NsisPath,$NodePath,$FfmpegPath,$ffprobePath,$csc,(Join-Path $toolsRoot 'node-LICENSE.txt'),(Join-Path $toolsRoot 'node-SHASUMS256.txt'),(Join-Path $toolsRoot 'ffmpeg-d32b387f2b.tar.gz'),$electronZip,(Join-Path $electronRoot 'electron.exe'))) {
    if(-not(Test-Path -LiteralPath $file)){throw "Required build input missing: $file"}
}
$nodeVersion = (& $NodePath --version).Trim()
$nodeSha = (Get-FileHash -LiteralPath $NodePath -Algorithm SHA256).Hash.ToLowerInvariant()
$expected = (Get-Content -LiteralPath (Join-Path $toolsRoot 'node-SHASUMS256.txt') | Where-Object { $_ -match 'win-x64/node.exe$' }).Split(' ')[0]
if($nodeVersion -ne 'v24.12.0' -or $nodeSha -ne $expected){throw 'Node executable does not match the verified v24.12.0 x64 release.'}
$ffVersion = (& $FfmpegPath -version | Select-Object -First 1)
if ($ffVersion -notmatch '^ffmpeg version 9\.0-full_build-www.gyan.dev') { throw 'FFmpeg version changed; update the matching source archive and build notices first.' }
$electronSha=(Get-FileHash -LiteralPath $electronZip -Algorithm SHA256).Hash.ToLowerInvariant()
if($electronSha -ne '04d6071f8deca081044e1398f96f65e4c1550ffdb3f882504cd78528d821d422'){throw 'Electron archive does not match the verified official release.'}
if(-not(Test-Path -LiteralPath (Join-Path $LocalMaterialRuntime 'runtime-manifest.json'))){throw 'Prepare the pinned offline material runtime before building either edition.'}

New-Item -ItemType Directory -Path $payload,(Join-Path $payload 'runtime'),(Join-Path $payload 'scripts'),(Join-Path $payload 'licenses'),(Join-Path $payload 'third-party-sources') -Force | Out-Null
# Explicit allowlist: no data, credentials, recordings, receipts, .git, or test projects.
foreach($folder in @('src','public')){Copy-Item -LiteralPath (Join-Path $projectDir $folder) -Destination $payload -Recurse}
foreach($file in @('package.json','package-lock.json','README.md')){Copy-Item -LiteralPath (Join-Path $projectDir $file) -Destination $payload}
& $NodePath (Join-Path $projectDir 'packaging/copy-local-runtime.mjs') $LocalMaterialRuntime $payload
if($LASTEXITCODE -ne 0){throw 'Offline material runtime verification failed.'}
if($Edition -eq 'User') {
    & $NodePath (Join-Path $projectDir 'packaging/prepare-user-payload.mjs') $payload $version
    if($LASTEXITCODE -ne 0){throw 'Unable to prepare user package metadata.'}
    $serverPath=Join-Path $payload 'src/server.js'
    $serverText=[IO.File]::ReadAllText($serverPath)
    $serverVersionAnchor="version: '"+$package.version+"'"
    foreach($anchor in @($serverVersionAnchor,"res.sendFile('studio.html'","res.sendFile('index.html'")) {
        if(-not $serverText.Contains($anchor)){throw ('User edition server transform anchor not found: '+$anchor)}
    }
    $serverText=$serverText.Replace($serverVersionAnchor,("version: '"+$version+"'")).Replace("res.sendFile('studio.html'","res.sendFile('user.html'").Replace("res.sendFile('index.html'","res.sendFile('user-quick.html'")
    [IO.File]::WriteAllText($serverPath,$serverText,[Text.UTF8Encoding]::new($false))
}
foreach($script in @('start.ps1','stop-backend.ps1','prepare-update.ps1','install-identity.ps1','inspect-install.ps1')){Copy-Item -LiteralPath (Join-Path $projectDir ('scripts\'+$script)) -Destination (Join-Path $payload ('scripts\'+$script))}
if($Edition -eq 'User'){foreach($script in Get-ChildItem -LiteralPath (Join-Path $payload 'scripts') -Filter '*.ps1'){[IO.File]::WriteAllText($script.FullName,(Convert-EditionText ([IO.File]::ReadAllText($script.FullName))),[Text.UTF8Encoding]::new($true))}}
Copy-Item -LiteralPath $electronRoot -Destination (Join-Path $payload 'desktop') -Recurse
Rename-Item -LiteralPath (Join-Path $payload 'desktop\electron.exe') -NewName 'YingTiDesktop.exe'
$defaultApp=Join-Path $payload 'desktop\resources\default_app.asar'
if(Test-Path -LiteralPath $defaultApp){Remove-Item -LiteralPath $defaultApp -Force}
$desktopApp=Join-Path $payload 'desktop\resources\app'
New-Item -ItemType Directory -Path $desktopApp -Force | Out-Null
foreach($file in Get-ChildItem -LiteralPath (Join-Path $projectDir 'desktop') -Filter '*.cjs' -File){[IO.File]::WriteAllText((Join-Path $desktopApp $file.Name),(Convert-EditionText ([IO.File]::ReadAllText($file.FullName))),[Text.UTF8Encoding]::new($false))}
if($Edition -eq 'User') {
    $corePath=Join-Path $desktopApp 'core.cjs'; $coreText=[IO.File]::ReadAllText($corePath)
    $routeScript=Get-Content -LiteralPath (Join-Path $projectDir 'packaging/user-route.cjs.txt') -Encoding UTF8 -Raw
    $routeStart=$coreText.IndexOf('function savedRoute(value)'); $routeEnd=$coreText.IndexOf('function externalURL(value)',$routeStart)
    if($routeStart -lt 0 -or $routeEnd -lt 0){throw 'Desktop route function not found'}
    [IO.File]::WriteAllText($corePath,($coreText.Substring(0,$routeStart)+$routeScript+"`n"+$coreText.Substring($routeEnd)),[Text.UTF8Encoding]::new($false))
    # Customer page navigation includes full page loads (home/quick tool) as
    # well as wizard history updates. Persist both so reopen restores the UI.
    $desktopMainPath=Join-Path $desktopApp 'main.cjs'; $desktopMainText=[IO.File]::ReadAllText($desktopMainPath)
    $routeEventAnchor="mainWindow.webContents.on('did-navigate-in-page',"
    if(-not $desktopMainText.Contains($routeEventAnchor)){throw 'Desktop page navigation hook not found'}
    $desktopMainText=$desktopMainText.Replace($routeEventAnchor,"for(const routeEvent of ['did-navigate','did-navigate-in-page']) mainWindow.webContents.on(routeEvent,")
    [IO.File]::WriteAllText($desktopMainPath,$desktopMainText,[Text.UTF8Encoding]::new($false))
}
$desktopPackage=@{name=$(if($Edition -eq 'User'){'yingti-desktop-user'}else{'yingti-desktop'});productName=$appTitle;version=$version;main='main.cjs';private=$true}
[IO.File]::WriteAllText((Join-Path $desktopApp 'package.json'),($desktopPackage | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $projectDir 'packaging\安装说明.txt') -Destination $payload
if($Edition -eq 'User') { Copy-Item -LiteralPath (Join-Path $projectDir 'packaging\用户版安装说明.txt') -Destination (Join-Path $payload '安装说明.txt') -Force; [IO.File]::WriteAllText((Join-Path $payload 'README.md'),([IO.File]::ReadAllText((Join-Path $projectDir 'packaging\用户版安装说明.txt'))),[Text.UTF8Encoding]::new($false)) }
Copy-Item -LiteralPath $NodePath -Destination (Join-Path $payload 'runtime\node.exe')
Copy-Item -LiteralPath $FfmpegPath -Destination (Join-Path $payload 'runtime\ffmpeg.exe')
Copy-Item -LiteralPath $ffprobePath -Destination (Join-Path $payload 'runtime\ffprobe.exe')
Copy-Item -LiteralPath (Join-Path $toolsRoot 'node-LICENSE.txt') -Destination (Join-Path $payload 'licenses\Node-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $ffmpegRoot 'LICENSE') -Destination (Join-Path $payload 'licenses\FFmpeg-GPLv3.txt')
Copy-Item -LiteralPath (Join-Path $ffmpegRoot 'README.txt') -Destination (Join-Path $payload 'licenses\FFmpeg-build.txt')
Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $NsisPath) 'COPYING') -Destination (Join-Path $payload 'licenses\NSIS-COPYING.txt')
Copy-Item -LiteralPath (Join-Path $toolsRoot 'ffmpeg-d32b387f2b.tar.gz') -Destination (Join-Path $payload 'third-party-sources\ffmpeg-d32b387f2b.tar.gz')
[IO.File]::WriteAllText((Join-Path $payload 'installed-product.id'),($appId+'.LocalTest.x64'),[Text.Encoding]::ASCII)
$oldLocation = Get-Location
try {
    Set-Location -LiteralPath $payload
    & npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund
    if($LASTEXITCODE -ne 0){throw 'Production dependency installation failed.'}
} finally { Set-Location -LiteralPath $oldLocation }
& (Join-Path $projectDir 'packaging\create-icon.ps1') -Output (Join-Path $payload ($appId+'.ico'))
$launcherSource=Join-Path $buildRoot ($appId+'-'+$version+'-Launcher.cs')
$launcherManifest=Join-Path $buildRoot ($appId+'-'+$version+'-launcher.manifest')
[IO.File]::WriteAllText($launcherSource,(Convert-EditionText ([IO.File]::ReadAllText((Join-Path $projectDir 'packaging\Launcher.cs')))),[Text.UTF8Encoding]::new($true))
[IO.File]::WriteAllText($launcherManifest,(Convert-EditionText ([IO.File]::ReadAllText((Join-Path $projectDir 'packaging\launcher.manifest')))),[Text.UTF8Encoding]::new($false))
& $csc /nologo /target:winexe /platform:x64 /optimize+ '/reference:System.Windows.Forms.dll' ('/win32icon:'+(Join-Path $payload ($appId+'.ico'))) ('/win32manifest:'+$launcherManifest) ('/out:'+(Join-Path $payload ($appId+'.exe'))) $launcherSource
if($LASTEXITCODE -ne 0){throw 'Launcher compilation failed.'}

$notices = @(
    'YingTi Studio - bundled component notices',
    '',
    'Node.js 24.12.0: https://nodejs.org/ - licenses in Node-LICENSE.txt.',
    'Node executable verified against https://nodejs.org/dist/v24.12.0/SHASUMS256.txt',
    'FFmpeg / FFprobe 9.0 GPLv3 build: https://www.gyan.dev/ffmpeg/builds/',
    'Unmodified standalone executables, invoked as child processes. See FFmpeg-GPLv3.txt and FFmpeg-build.txt.',
    'Matching FFmpeg main source commit: https://github.com/FFmpeg/FFmpeg/commit/d32b387f2b',
    'The corresponding main source archive is included in third-party-sources. External library build information is in FFmpeg-build.txt.',
    'NSIS installer: https://nsis.sourceforge.io/ - terms in NSIS-COPYING.txt.',
    'Electron 44.6.0: https://github.com/electron/electron/releases/tag/v44.6.0 - terms preserved in desktop/LICENSE and desktop/LICENSES.chromium.html.',
    'Local CPU material repair: CPython 3.13.16, MediaPipe, NumPy and OpenCV; pinned archive/wheel/model provenance in runtime/local-material/runtime-manifest.json.',
    'CPython license: runtime/local-material/LICENSE.txt. MediaPipe model terms: runtime/local-material/licenses/MEDIAPIPE_LICENSE.txt.',
    'Python wheel licenses and notices remain in runtime/local-material/Lib/site-packages and its dist-info license directories.',
    'The local worker performs offline inference. It does not download models, use system Python or require CUDA.',
    '',
    'JavaScript package licenses are preserved in the respective node_modules package directories:',
    ''
)
$notices += & $NodePath (Join-Path $projectDir 'packaging\list-packages.mjs') (Join-Path $payload 'package-lock.json')
if($LASTEXITCODE -ne 0){throw 'Unable to collect dependency license metadata.'}
[IO.File]::WriteAllLines((Join-Path $payload 'licenses\THIRD-PARTY-NOTICES.txt'),$notices,[Text.UTF8Encoding]::new($false))
$files = @(Get-ChildItem -LiteralPath $payload -File -Recurse)
if(@($files | Where-Object { $_.Extension -in @('.dpapi','.sqlite','.mp4','.key') -or $_.Name -match '^\.env' }).Count){throw 'Private/runtime data unexpectedly entered the payload.'}
$manifest = @($files | ForEach-Object { @{path=$_.FullName.Substring($payload.Length+1).Replace('\','/');bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()} } | Sort-Object { $_.path })
$buildInfo = @{product=$appId;version=$version;edition=$Edition;platform='windows-x64';node=$nodeVersion;electron='44.6.0';ffmpeg=$ffVersion;localMaterialRuntime='local-material-cpu-v1-py31316';files=$manifest;containsUserData=$false;containsKey=$false}
[IO.File]::WriteAllText((Join-Path $payload 'build-manifest.json'),($buildInfo | ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))

$removeFile=Join-Path $buildRoot "remove-$appId-$version.nsh"
$removeLines=@('; Exact installed files only; user data is outside this directory.')
foreach($file in Get-ChildItem -LiteralPath $payload -File -Recurse){$relative=$file.FullName.Substring($payload.Length+1).Replace('$','$$');$removeLines += 'Delete "$INSTDIR\'+$relative+'"'}
foreach($folder in (Get-ChildItem -LiteralPath $payload -Directory -Recurse | Sort-Object { $_.FullName.Length } -Descending)){$relative=$folder.FullName.Substring($payload.Length+1).Replace('$','$$');$removeLines += 'RMDir "$INSTDIR\'+$relative+'"'}
[IO.File]::WriteAllLines($removeFile,$removeLines,[Text.UTF8Encoding]::new($true))
$installedKB=[int][Math]::Ceiling((Get-ChildItem -LiteralPath $payload -Recurse -File | Measure-Object Length -Sum).Sum/1024)
$outputFile=if($QuickTest){Join-Path $buildRoot "$appId-QuickTest-$version.exe"}else{Join-Path $outputDir "$appId-Setup-$version-win-x64.exe"}
$temporaryOutput=Join-Path $buildRoot ('compiling-'+[guid]::NewGuid().ToString('N')+'.exe')
$compilerOptions=@('/V2',"/DAPP_VERSION=$version","/DPAYLOAD=$payload","/DOUTPUT_FILE=$temporaryOutput","/DREMOVE_MANIFEST=$removeFile","/DINSTALLED_KB=$installedKB")
if($FastCompression){$compilerOptions+='/DFAST_COMPRESSION'}
if($QuickTest){$compilerOptions+='/DQUICK_TEST'}
$installerSource=Join-Path $buildRoot ($appId+'-'+$version+'-installer.nsi')
[IO.File]::WriteAllText($installerSource,(Convert-EditionText ([IO.File]::ReadAllText((Join-Path $projectDir 'packaging\installer.nsi')))),[Text.UTF8Encoding]::new($true))
& $NsisPath @compilerOptions $installerSource
if($LASTEXITCODE -ne 0){throw 'Installer compilation failed.'}
Move-Item -LiteralPath $temporaryOutput -Destination $outputFile -Force
$checksum=(Get-FileHash -LiteralPath $outputFile -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText(($outputFile+'.sha256'),($checksum+'  '+[IO.Path]::GetFileName($outputFile)+"`r`n"),[Text.Encoding]::ASCII)
Copy-Item -LiteralPath (Join-Path $payload '安装说明.txt') -Destination (Join-Path $outputDir $(if($Edition -eq 'User'){'用户版安装说明.txt'}else{'安装说明.txt'})) -Force
Write-Output (@{installer=$outputFile;bytes=(Get-Item -LiteralPath $outputFile).Length;sha256=$checksum;payload=$payload;files=$manifest.Count;containsUserData=$false} | ConvertTo-Json)
