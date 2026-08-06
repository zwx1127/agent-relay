param(
  [string]$Command = ""
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$ManageScript = Join-Path $RootDir "src\gateway\manage.ts"

function Show-Usage {
  [Console]::Out.WriteLine("usage: gateway.ps1 <setup|start|stop|status|remove>")
}

if ($Command -eq "help" -or $Command -eq "-h" -or $Command -eq "--help") {
  Show-Usage
  exit 0
}

if (@("setup", "start", "stop", "status", "remove") -notcontains $Command) {
  Show-Usage
  exit 1
}

$bunPath = [Environment]::GetEnvironmentVariable("AGENT_RELAY_BUN_PATH")
if ([string]::IsNullOrWhiteSpace($bunPath) -or -not (Test-Path -LiteralPath $bunPath)) {
  $bunCommand = Get-Command bun -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $bunCommand) {
    [Console]::Error.WriteLine("bun is not available on PATH")
    exit 1
  }
  $bunPath = $bunCommand.Source
}

Push-Location $RootDir
try {
  & $bunPath $ManageScript $Command
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
