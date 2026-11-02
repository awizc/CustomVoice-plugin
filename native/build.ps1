param([string]$Dotnet = 'dotnet', [switch]$SkipCapabilityCheck)
$ErrorActionPreference = 'Stop'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$project = Join-Path $PSScriptRoot 'CustomVoice.Capture.csproj'
$outputDirectory = Join-Path $PSScriptRoot 'publish'
& node (Join-Path $PSScriptRoot 'sync-renderer.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Native renderer bundle sync failed' }
& $Dotnet restore $project -r win-x64 -p:SelfContained=true --source 'https://api.nuget.org/v3/index.json' --verbosity quiet
if ($LASTEXITCODE -ne 0) { throw 'Native capture restore failed' }
& $Dotnet publish $project -c Release --no-restore --self-contained true -o $outputDirectory --verbosity quiet
if ($LASTEXITCODE -ne 0) { throw 'Native capture build failed' }
foreach ($file in @('capture.js', 'host-main.cjs', 'host-preload.cjs', 'audio-main.cjs', 'github-main.cjs', 'Install.cmd', 'README.txt')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $outputDirectory
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'THIRD-PARTY-NOTICES.txt') -Destination $outputDirectory
$licenseDirectory = Join-Path $outputDirectory 'licenses'
New-Item -ItemType Directory -Path $licenseDirectory -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'licenses') -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $licenseDirectory -Force }
$assets = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'obj/project.assets.json') -Raw | ConvertFrom-Json
$runtimeConfig = Get-Content -LiteralPath (Join-Path $outputDirectory 'CustomVoice.Capture.runtimeconfig.json') -Raw | ConvertFrom-Json
$runtime = $runtimeConfig.runtimeOptions.includedFrameworks | Where-Object { $_.name -eq 'Microsoft.NETCore.App' } | Select-Object -First 1
if (-not $runtime) { throw 'Self-contained runtime package metadata is missing' }
$runtimePackage = 'microsoft.netcore.app.runtime.win-x64/' + $runtime.version
$packageRoot = $assets.packageFolders.PSObject.Properties.Name | Where-Object { Test-Path -LiteralPath (Join-Path $_ $runtimePackage) } | Select-Object -First 1
if (-not $packageRoot) { throw 'Runtime package could not be located' }
$runtimeDirectory = Join-Path $packageRoot $runtimePackage
foreach ($license in @('LICENSE.TXT', 'THIRD-PARTY-NOTICES.TXT')) {
    Copy-Item -LiteralPath (Join-Path $runtimeDirectory $license) -Destination (Join-Path $licenseDirectory ('dotnet-runtime-' + $license)) -Force
}
if (-not $SkipCapabilityCheck) {
    & (Join-Path $outputDirectory 'CustomVoice.Capture.exe') --check
    if ($LASTEXITCODE -ne 0) { throw 'Native capture capability check failed' }
}
