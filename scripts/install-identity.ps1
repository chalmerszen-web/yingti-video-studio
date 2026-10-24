# Shared by the directory wizard and update preparation. No writes or processes.
function Get-YingTiFileHash([string]$Path) {
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $sha=[Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose();$stream.Dispose() }
}

function Get-YingTiRegisteredDir {
    $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\YingTiStudio')
    if($key){try{return [string]$key.GetValue('InstallDir','')}finally{$key.Dispose()}}
    return ''
}

function Get-YingTiInstallState([string]$InstallDir,[string]$ManifestPath,[switch]$IgnoreRegistration) {
    try {
        $directory=[IO.Path]::GetFullPath($InstallDir).TrimEnd('\','/')
        if([IO.File]::Exists($directory)){return 'Invalid'}
        if(-not [IO.Directory]::Exists($directory)){return 'New'}
        if(([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint) -ne 0){return 'Invalid'}
        $children=@([IO.Directory]::GetFileSystemEntries($directory))
        if($children.Count -eq 0){return 'Empty'}
        $marker=Join-Path $directory 'installed-product.id'
        if([IO.File]::Exists($marker)){
            if([IO.File]::ReadAllText($marker).Trim() -eq 'YingTiStudio.LocalTest.x64'){return 'Installed'}
            return 'Invalid'
        }
        # Markerless recovery is restricted to this product's registered or
        # dedicated default directory, with additional evidence of our payload.
        $known=@([IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\YingTiStudio')).TrimEnd('\','/'))
        if(-not $IgnoreRegistration){$registered=Get-YingTiRegisteredDir;if($registered){$known+=[IO.Path]::GetFullPath($registered).TrimEnd('\','/')}}
        if($known -notcontains $directory){return 'Invalid'}
        $oldManifest=Join-Path $directory 'build-manifest.json'
        $oldPackage=Join-Path $directory 'package.json'
        if([IO.File]::Exists($oldManifest) -and [IO.File]::Exists($oldPackage)){
            $product=[IO.File]::ReadAllText($oldManifest) | ConvertFrom-Json
            $package=[IO.File]::ReadAllText($oldPackage) | ConvertFrom-Json
            if($product.product -eq 'YingTiStudio' -and $package.name -eq 'wan-replace-studio'){return 'Repair'}
        }
        if(-not $ManifestPath){return 'Invalid'}
        $manifest=[IO.File]::ReadAllText($ManifestPath) | ConvertFrom-Json
        if($manifest.product -ne 'YingTiStudio'){return 'Invalid'}
        # Interrupted older installs may leave just a locked runtime executable.
        # Permit only known binary paths whose bytes match the new trusted build.
        $allowed=@('YingTiStudio.exe','desktop/YingTiDesktop.exe','runtime/node.exe','runtime/ffmpeg.exe','runtime/ffprobe.exe')
        $pending=[Collections.Generic.Queue[string]]::new();$pending.Enqueue($directory);$fileCount=0
        while($pending.Count -gt 0){
            foreach($entry in [IO.Directory]::GetFileSystemEntries($pending.Dequeue())){
                $attributes=[IO.File]::GetAttributes($entry)
                if(($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){return 'Invalid'}
                $relative=$entry.Substring($directory.Length+1).Replace('\','/')
                if(($attributes -band [IO.FileAttributes]::Directory) -ne 0){
                    if(@('runtime','desktop') -notcontains $relative){return 'Invalid'}
                    $pending.Enqueue($entry);continue
                }
                if($allowed -notcontains $relative){return 'Invalid'}
                $expected=$manifest.files | Where-Object path -eq $relative | Select-Object -First 1
                if(-not $expected -or $expected.sha256 -notmatch '^[a-f0-9]{64}$' -or (Get-YingTiFileHash $entry) -ne $expected.sha256){return 'Invalid'}
                $fileCount++
            }
        }
        if($fileCount -gt 0){return 'Repair'}
        return 'Invalid'
    } catch { return 'Invalid' }
}
