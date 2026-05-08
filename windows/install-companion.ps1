param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$Configuration = "Release",
  [switch]$SelfContained,
  [switch]$Start
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
  throw "The .NET SDK is required. Install .NET 8 SDK, then rerun this installer."
}

$project = Join-Path $RepoRoot "windows\OnlineCLI.Companion\OnlineCLI.Companion.csproj"
$publishDir = Join-Path $RepoRoot ".online-cli\companion"
$runtimeArgs = @()

if ($SelfContained) {
  $runtimeArgs = @("-r", "win-x64", "--self-contained", "true", "-p:PublishSingleFile=true")
}

Write-Host "Publishing Online CLI Companion..." -ForegroundColor Cyan
dotnet publish $project -c $Configuration -o $publishDir @runtimeArgs

$exe = Join-Path $publishDir "OnlineCLI.Companion.exe"
if (-not (Test-Path $exe)) {
  throw "Published companion executable was not found: $exe"
}

Write-Host "Published: $exe" -ForegroundColor Green
Write-Host "Start it once, then use the tray panel to enable Run on startup and scan the pairing QR code." -ForegroundColor Green

if ($Start) {
  Start-Process -FilePath $exe -WorkingDirectory $RepoRoot
}
