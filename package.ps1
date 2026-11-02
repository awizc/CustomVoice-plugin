param([string]$Dotnet = 'dotnet', [switch]$ReuseNativeBuild, [switch]$SkipCapabilityCheck)
$ErrorActionPreference = 'Stop'
if ($ReuseNativeBuild) {
    # For JS-only releases: reuse the self-contained executable and runtime.
    # This path performs packaging only; no capability or test executable runs.
    & node (Join-Path $PSScriptRoot 'native/sync-renderer.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Native renderer bundle sync failed' }
    foreach ($file in @('capture.js', 'host-main.cjs', 'host-preload.cjs', 'audio-main.cjs', 'github-main.cjs', 'Install.cmd', 'README.txt')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('native/' + $file)) -Destination (Join-Path $PSScriptRoot 'native/publish')
    }
} else {
    & (Join-Path $PSScriptRoot 'native/build.ps1') -Dotnet $Dotnet -SkipCapabilityCheck:$SkipCapabilityCheck
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
[IO.File]::WriteAllText((Join-Path $nativeTarget 'native-version.json'), (ConvertTo-Json @{ version = $nativeVersion }), [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath $sourcePlugin -Destination $stage
Copy-Item -LiteralPath (Join-Path $published 'Install.cmd') -Destination $stage
[IO.File]::WriteAllText((Join-Path $stage 'INSTALL.txt'), "압축을 전부 풀고 Discord를 완전히 종료한 뒤 Install.cmd를 더블클릭하세요.`r`nNode.js와 .NET을 따로 설치할 필요가 없습니다.`r`n썸네일은 송출자와 시청자 모두 1.1.0 이상이 필요합니다. 업데이트 후 Discord를 완전히 재시작하세요.`r`nnative 1.1.6부터 공개 저장소 자동 업데이트에는 GitHub 토큰이 필요하지 않습니다. 비공개 저장소는 각자의 접근 권한과 토큰이 필요합니다.`r`n이전 native에서 토큰 없이 사용했다면 이 전체 ZIP을 한 번 설치하세요.`r`n", [Text.UTF8Encoding]::new($true))
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
