# Checks for Node 24+, then hands over to the cross-platform installer.
$ErrorActionPreference = 'Stop'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error 'Node.js 24 or newer is required. Install it from https://nodejs.org and re-run.'
  exit 1
}
$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 24) {
  Write-Error "Node.js $major found; 24 or newer is required. Install it from https://nodejs.org and re-run."
  exit 1
}
& node (Join-Path $PSScriptRoot 'setup.ts') @args
exit $LASTEXITCODE
