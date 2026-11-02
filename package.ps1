param([string]$Dotnet = 'dotnet', [switch]$ReuseNativeBuild, [switch]$SkipCapabilityCheck)
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
Copy-Item -LiteralPath (Join-Path $published 'game-hook') -Destination $nativeTarget -Recurse
[IO.File]::WriteAllText((Join-Path $nativeTarget 'native-version.json'), (ConvertTo-Json @{ version = $nativeVersion }), [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath $sourcePlugin -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'SERVER-VIEWERS.md') -Destination $stage
Copy-Item -LiteralPath (Join-Path $published 'Install.cmd') -Destination $stage
[IO.File]::WriteAllText((Join-Path $stage 'INSTALL.txt'), "압축을 전부 풀고 Discord를 완전히 종료한 뒤 Install.cmd를 더블클릭하세요.`r`nNode.js와 .NET을 따로 설치할 필요가 없습니다.`r`n시청자도 인원수와 닉네임 목록을 보려면 방송자와 본인 모두 1.1.11 이상이어야 합니다. 업데이트 후 Discord를 완전히 재시작하세요.`r`n1.1.8~1.1.10 사용자의 시청 알림도 집계에는 포함합니다. 목록은 방송 화면에만 표시됩니다.`r`n서버 권한이 차단되면 SERVER-VIEWERS.md의 수정이 필요합니다. 이 ZIP만으로 서버 차단이 해제되지는 않습니다.`r`n방송 닉네임을 클릭하면 미리보기가 고정되며 아래 방송 보기 버튼으로 시청할 수 있습니다.`r`n공개 GitHub에서 플러그인과 native를 자동 다운로드합니다. 업데이트 토큰 설정은 필요하지 않습니다.`r`n플러그인은 통화 종료 후, native는 Discord 완전 종료 후 적용합니다. 이전 버전에서 업데이트가 멈췄다면 이 전체 ZIP을 한 번 설치하세요.`r`n", [Text.UTF8Encoding]::new($true))
[IO.File]::AppendAllText((Join-Path $stage 'INSTALL.txt'), "알탭 중 게임 캡처: 송출자는 이 전체 ZIP의 플러그인 1.1.21과 native 1.1.14를 함께 설치해 주세요. 공유 시작 후 게임을 한 번 활성화하면 전체화면 감지 시 게임 캡처가 연결되고, 이후 알탭해도 게임의 렌더링 화면을 계속 받습니다. OBS 앱을 따로 설치하거나 실행할 필요는 없습니다. 시청 영상 자동 복구는 시청자 플러그인 1.1.15 이상이 필요합니다. 게임 후크가 차단되거나 게임이 렌더링을 멈춘 경우는 계속 움직이는 영상을 보장하지 않습니다. 실제 osu! 알탭과 두 PC 송수신 검증은 수행하지 않았습니다.`r`n", [Text.UTF8Encoding]::new($true))
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
