param([string]$Dotnet = 'dotnet', [string]$Go = 'go', [switch]$ReuseNativeBuild, [switch]$SkipCapabilityCheck)
$ErrorActionPreference = 'Stop'
if ($ReuseNativeBuild) {
    # For JS-only releases: reuse the self-contained executable and runtime.
    # This path performs packaging only; no capability or test executable runs.
    & node (Join-Path $PSScriptRoot 'native/sync-renderer.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Native renderer bundle sync failed' }
    foreach ($file in @('capture.js', 'host-main.cjs', 'host-preload.cjs', 'audio-main.cjs', 'github-main.cjs', 'window-sources-main.cjs', 'Install.cmd', 'README.txt')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('native/' + $file)) -Destination (Join-Path $PSScriptRoot 'native/publish')
    }
} else {
    & (Join-Path $PSScriptRoot 'native/build.ps1') -Dotnet $Dotnet -Go $Go -SkipCapabilityCheck:$SkipCapabilityCheck
    if ($LASTEXITCODE -ne 0) { throw 'Native build failed' }
}
$sourcePlugin = Join-Path $PSScriptRoot 'CustomVoice.plugin.js'
$version = [regex]::Match([IO.File]::ReadAllText($sourcePlugin), '@version\s+(\d+\.\d+\.\d+)').Groups[1].Value
if (-not $version) { throw 'Plugin version is missing' }
$nativeVersion = [regex]::Match([IO.File]::ReadAllText($sourcePlugin), '@nativeVersion\s+(\d+\.\d+\.\d+)').Groups[1].Value
if (-not $nativeVersion) { throw 'Native version is missing' }
$dist = Join-Path $PSScriptRoot 'dist'
$stage = Join-Path $dist ('CustomVoice-' + $version + '-windows-x64-' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss'))
$nativeTarget = Join-Path $stage 'CustomVoice.native'
New-Item -ItemType Directory -Path $nativeTarget -Force | Out-Null
$published = Join-Path $PSScriptRoot 'native/publish'
$builtStamp = Join-Path $published 'native-version.json'
if (-not (Test-Path -LiteralPath $builtStamp)) { throw 'Native build metadata is missing. Build without -ReuseNativeBuild.' }
$builtNativeVersion = ([IO.File]::ReadAllText($builtStamp) | ConvertFrom-Json).version
if ($builtNativeVersion -ne $nativeVersion) { throw 'Native build version differs from @nativeVersion. Build the matching native version before packaging.' }
Get-ChildItem -LiteralPath $published -File | Where-Object { $_.Extension -ne '.pdb' -and $_.Name -notin @('install-host.cjs','manifest.json') } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $nativeTarget
}
Copy-Item -LiteralPath (Join-Path $published 'licenses') -Destination $nativeTarget -Recurse
Copy-Item -LiteralPath (Join-Path $published 'game-hook') -Destination $nativeTarget -Recurse
[IO.File]::WriteAllText((Join-Path $nativeTarget 'native-version.json'), (ConvertTo-Json @{ version = $nativeVersion }), [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath $sourcePlugin -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'SERVER-VIEWERS.md') -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'SERVER-NATIVE-SCREEN.md') -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'server') -Destination $stage -Recurse
Copy-Item -LiteralPath (Join-Path $published 'Install.cmd') -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'INSTALL.txt') -Destination $stage
$manifest = @(Get-ChildItem -LiteralPath $nativeTarget -Recurse -File | Sort-Object FullName | ForEach-Object {
    @{ name = $_.FullName.Substring($nativeTarget.Length + 1).Replace('\','/'); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
})
[IO.File]::WriteAllText((Join-Path $nativeTarget 'manifest.json'), (ConvertTo-Json -InputObject $manifest -Depth 5), [Text.UTF8Encoding]::new($false))
$zip = Join-Path $dist ('CustomVoice-' + $version + '-windows-x64.zip')
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $zip) {
    $previous = $zip + '.previous-' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss')
    Move-Item -LiteralPath $zip -Destination $previous
}
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
$nativeMetadata = Join-Path $dist 'CustomVoice-native.json'
[IO.File]::WriteAllText($nativeMetadata, (ConvertTo-Json @{ schema = 1; nativeVersion = $nativeVersion; packageVersion = $version; file = [IO.Path]::GetFileName($zip); sha256 = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() }), [Text.UTF8Encoding]::new($false))
[pscustomobject]@{ Zip = $zip; Directory = $stage; NativeMetadata = $nativeMetadata; SizeMiB = [Math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 1) } | ConvertTo-Json
