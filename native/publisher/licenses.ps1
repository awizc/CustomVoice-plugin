param([string]$Go = 'go', [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    $directories = @(& $Go list -deps -f '{{if .Module}}{{.Module.Dir}}{{end}}' . | Where-Object { $_ } | Sort-Object -Unique)
    if ($LASTEXITCODE -ne 0) { throw 'Publisher dependency inventory failed' }
    $runtimeRoot = & $Go env GOROOT
    $directories += $runtimeRoot
    $notices = [Text.StringBuilder]::new()
    [void]$notices.AppendLine('CustomVoice.Publisher: Go runtime and linked module licenses')
    foreach ($directory in $directories) {
        if ([IO.Path]::GetFullPath($directory) -eq [IO.Path]::GetFullPath($PSScriptRoot)) { continue }
        $licenses = @(Get-ChildItem -LiteralPath $directory -File | Where-Object { $_.Name -match '^(LICENSE|COPYING|NOTICE|PATENTS)(\..*)?$' })
        if (!$licenses.Count) { throw ('Missing dependency license: ' + $directory) }
        [void]$notices.AppendLine("`n" + [IO.Path]::GetFileName($directory))
        foreach ($license in $licenses) { [void]$notices.AppendLine([IO.File]::ReadAllText($license.FullName)) }
    }
    [IO.File]::WriteAllText($Destination, $notices.ToString(), [Text.UTF8Encoding]::new($false))
} finally { Pop-Location }
