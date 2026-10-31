# Windows PowerShell 5.1+ entry point for WTAgent's scoped self-release.
# Never installs globally, publishes, or pushes upstream.
[CmdletBinding()]
param(
    [string[]] $UpgradeFile = @(),
    [string] $ReleaseDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptPath = $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($scriptPath)) {
    throw "Cannot resolve the self-release script location."
}

$repositoryRoot = [System.IO.Path]::GetFullPath(
    (Join-Path (Split-Path -Parent $scriptPath) "..")
)
$nodeScript = Join-Path $repositoryRoot "scripts\self-release.js"

if (-not (Test-Path -LiteralPath $nodeScript -PathType Leaf)) {
    throw "Missing release implementation: $nodeScript"
}
if ((Split-Path -Leaf $repositoryRoot) -ne "wtagent-selfdev") {
    throw "Refusing release outside the wtagent-selfdev development repository."
}

$nodeExecutable = Get-Command node -ErrorAction Stop
$arguments = @($nodeScript)
foreach ($file in $UpgradeFile) {
    if ([string]::IsNullOrWhiteSpace($file)) {
        throw "An upgrade file path must not be empty."
    }
    $arguments += @("--file", $file)
}
if (-not [string]::IsNullOrWhiteSpace($ReleaseDir)) {
    $arguments += @("--release-dir", $ReleaseDir)
}

Push-Location -LiteralPath $repositoryRoot
try {
    Write-Host "WTAgent development release: $repositoryRoot"
    & $nodeExecutable.Source @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Self-release failed with exit code $LASTEXITCODE. No globally installed WTAgent was changed."
    }
    Write-Host "Release completed. Restart from the development source to load the newly released capabilities."
} finally {
    Pop-Location
}
