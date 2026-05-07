param(
  [int]$Port = 3777,
  [string]$Path = "/cmd"
)

$ErrorActionPreference = "Stop"

function Require-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found in PATH."
  }
}

Require-Command tailscale

if (-not $Path.StartsWith("/")) {
  $Path = "/$Path"
}

$target = "http://127.0.0.1:$Port"
Write-Host "Configuring Tailscale Serve: $Path -> $target" -ForegroundColor Cyan

tailscale serve --bg "--set-path=$Path" $target | Out-Null

Write-Host "Current Tailscale Serve status:" -ForegroundColor Cyan
tailscale serve status
