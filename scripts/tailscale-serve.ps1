param(
  [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'

function Require-Command {
  param([string]$Name)

  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "Required command '$Name' was not found in PATH."
  }
}

Require-Command tailscale

$statusJson = tailscale status --json 2>$null
if (-not $statusJson) {
  throw "Could not read Tailscale status. Is Tailscale installed and running?"
}

$status = $statusJson | ConvertFrom-Json
if (-not $status -or -not $status.Self) {
  throw "Tailscale status did not include node identity."
}

if ($status.BackendState -ne 'Running') {
  throw "Tailscale is not running (BackendState=$($status.BackendState)). Please connect first."
}

$dnsName = [string]$status.Self.DNSName
if ([string]::IsNullOrWhiteSpace($dnsName)) {
  throw "Could not determine tailnet DNS name for this node."
}

$dnsName = $dnsName.TrimEnd('.')

Write-Host "Configuring tailscale serve for http://127.0.0.1:$Port ..." -ForegroundColor Cyan

$serveConfigured = $false
try {
  tailscale serve --bg "http://127.0.0.1:$Port" | Out-Null
  $serveConfigured = $true
} catch {
  # Fallback syntax supported by some tailscale versions.
  tailscale serve --bg $Port | Out-Null
  $serveConfigured = $true
}

if (-not $serveConfigured) {
  throw "Failed to configure tailscale serve."
}

$tailnetUrl = "https://$dnsName"

Write-Host ""
Write-Host "Serve configured successfully." -ForegroundColor Green
Write-Host "Tailnet HTTPS URL: $tailnetUrl" -ForegroundColor Green
Write-Host ""
Write-Host "Current tailscale serve status:" -ForegroundColor Cyan

try {
  tailscale serve status
} catch {
  Write-Warning "Unable to read 'tailscale serve status' output: $($_.Exception.Message)"
}
