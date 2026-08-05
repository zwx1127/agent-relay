param(
  [string]$Command = ""
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$ScriptPath = $PSCommandPath
if (-not $ScriptPath) {
  $ScriptPath = $MyInvocation.MyCommand.Path
}

$RootDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$DataDir = Join-Path $RootDir ".data"
$LogDir = Join-Path $RootDir "logs"
$PidFile = Join-Path $DataDir "agent-relay.pid"
$LogFile = Join-Path $LogDir "agent-relay.log"
$ErrorLogFile = Join-Path $LogDir "agent-relay.err.log"
$MainScript = Join-Path $RootDir "src\main.ts"

function Write-Line {
  param([string]$Message)
  [Console]::Out.WriteLine($Message)
}

function Write-ErrorLine {
  param([string]$Message)
  [Console]::Error.WriteLine($Message)
}

function Test-PathEnvironmentName {
  param([string]$Name)
  return [string]::Equals($Name, "Path", [StringComparison]::OrdinalIgnoreCase)
}

function Join-PathEnvironmentValues {
  param([string[]]$Values)

  $seen = New-Object "System.Collections.Generic.HashSet[string]" ([StringComparer]::OrdinalIgnoreCase)
  $entries = New-Object "System.Collections.Generic.List[string]"

  foreach ($value in $Values) {
    if ([string]::IsNullOrWhiteSpace($value)) {
      continue
    }

    foreach ($entry in ($value -split ";")) {
      if ([string]::IsNullOrWhiteSpace($entry)) {
        continue
      }

      $normalized = [Environment]::ExpandEnvironmentVariables($entry.Trim())
      if ($seen.Add($normalized)) {
        $entries.Add($normalized)
      }
    }
  }

  return [string]::Join(";", $entries)
}

function Import-WindowsEnvironment {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    return
  }

  $machineVars = [Environment]::GetEnvironmentVariables("Machine")
  $userVars = [Environment]::GetEnvironmentVariables("User")
  $processVars = [Environment]::GetEnvironmentVariables("Process")
  $processNames = New-Object "System.Collections.Generic.HashSet[string]" ([StringComparer]::OrdinalIgnoreCase)
  $registryVars = New-Object "System.Collections.Hashtable" ([StringComparer]::OrdinalIgnoreCase)

  foreach ($name in $processVars.Keys) {
    [void]$processNames.Add([string]$name)
  }

  foreach ($scopeVars in @($machineVars, $userVars)) {
    foreach ($name in $scopeVars.Keys) {
      $envName = [string]$name
      if (Test-PathEnvironmentName $envName) {
        continue
      }

      $registryVars[$envName] = [string]$scopeVars[$name]
    }
  }

  foreach ($name in $registryVars.Keys) {
    $envName = [string]$name
    if (-not $processNames.Contains($envName) -or [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($envName, "Process"))) {
      [Environment]::SetEnvironmentVariable($envName, [string]$registryVars[$name], "Process")
    }
  }

  $pathValue = Join-PathEnvironmentValues @(
    [Environment]::GetEnvironmentVariable("Path", "Process"),
    [Environment]::GetEnvironmentVariable("PATH", "Process"),
    [Environment]::GetEnvironmentVariable("Path", "Machine"),
    [Environment]::GetEnvironmentVariable("Path", "User")
  )

  if (-not [string]::IsNullOrEmpty($pathValue)) {
    [Environment]::SetEnvironmentVariable("Path", $pathValue, "Process")
    $env:Path = $pathValue
  }
}

Import-WindowsEnvironment

function Get-EnvSeconds {
  param(
    [string]$Name,
    [double]$DefaultValue
  )

  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $DefaultValue
  }

  [double]$parsed = 0
  $ok = [double]::TryParse(
    $value,
    [System.Globalization.NumberStyles]::Float,
    [System.Globalization.CultureInfo]::InvariantCulture,
    [ref]$parsed
  )
  if (-not $ok -or $parsed -lt 0) {
    Write-ErrorLine "invalid ${Name}: $value"
    exit 1
  }

  return $parsed
}

$StopTimeoutSeconds = Get-EnvSeconds "AGENT_RELAY_STOP_TIMEOUT_SECONDS" 20
$StopPollIntervalSeconds = Get-EnvSeconds "AGENT_RELAY_STOP_POLL_INTERVAL_SECONDS" 1
$StartCheckDelaySeconds = Get-EnvSeconds "AGENT_RELAY_START_CHECK_DELAY_SECONDS" 1
$RestartWorkerDelaySeconds = Get-EnvSeconds "AGENT_RELAY_RESTART_WORKER_DELAY_SECONDS" 1

function Show-Usage {
  $name = Split-Path -Leaf $ScriptPath
  Write-Line "usage: $name <start|stop|restart|status|clean-data|clean|gateway-start|gateway-stop|gateway-status|gateway-install|gateway-uninstall|clients-enable|clients-disable|desktop-enable|desktop-disable>"
}

function Test-ExperimentalSeamlessWorkEnabled {
  $value = [Environment]::GetEnvironmentVariable("EXPERIMENTAL_SEAMLESS_WORK_ENABLED")
  if ([string]::IsNullOrWhiteSpace($value)) {
    $envFile = Join-Path $RootDir ".env"
    if (Test-Path -LiteralPath $envFile) {
      $line = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*EXPERIMENTAL_SEAMLESS_WORK_ENABLED\s*=' } | Select-Object -Last 1
      if ($line) { $value = ($line -split '=', 2)[1].Trim().Trim('"').Trim("'") }
    }
  }
  return @("1", "true", "yes", "on") -contains ([string]$value).Trim().ToLowerInvariant()
}

function Start-SleepSeconds {
  param([double]$Seconds)
  if ($Seconds -le 0) {
    return
  }

  $milliseconds = [Math]::Max(1, [int][Math]::Ceiling($Seconds * 1000))
  Start-Sleep -Milliseconds $milliseconds
}

function Ensure-Bun {
  $configuredBunPath = [Environment]::GetEnvironmentVariable("AGENT_RELAY_BUN_PATH")
  if (-not [string]::IsNullOrWhiteSpace($configuredBunPath) -and (Test-Path -LiteralPath $configuredBunPath)) {
    return $configuredBunPath
  }

  $commandInfo = Get-Command bun -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $commandInfo) {
    Write-ErrorLine "bun is not available on PATH"
    exit 1
  }

  return $commandInfo.Source
}

function Normalize-ProcessPathEnvironment {
  Import-WindowsEnvironment
}

function Test-PidIsAlive {
  param([int]$ProcessId)
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  return $null -ne $process
}

function Test-PidMatchesRelay {
  param([int]$ProcessId)
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  return $null -ne $process -and $process.ProcessName -eq "bun"
}

function Get-CurrentRelayPid {
  if (Test-Path -LiteralPath $PidFile) {
    $rawPid = (Get-Content -LiteralPath $PidFile -Raw).Trim()
    [int]$parsedPid = 0
    if (-not [int]::TryParse($rawPid, [ref]$parsedPid) -or $parsedPid -le 0) {
      Write-ErrorLine "invalid PID file: $PidFile"
      return [pscustomobject]@{ Status = 2; Pid = $null }
    }

    if (-not (Test-PidIsAlive $parsedPid)) {
      Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    } elseif (-not (Test-PidMatchesRelay $parsedPid)) {
      Write-ErrorLine "PID $parsedPid is running but does not look like this relay process; refusing to manage it"
      return [pscustomobject]@{ Status = 2; Pid = $null }
    } else {
      return [pscustomobject]@{ Status = 0; Pid = $parsedPid }
    }
  }

  return [pscustomobject]@{ Status = 1; Pid = $null }
}

function Quote-CmdArgument {
  param([string]$Value)
  return '"' + $Value + '"'
}

function Join-NativeArguments {
  param([string[]]$Arguments)
  return (($Arguments | ForEach-Object { Quote-CmdArgument $_ }) -join " ")
}

function Start-NativeProcess {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$WorkingDirectory
  )

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $FilePath
  $startInfo.Arguments = Join-NativeArguments $Arguments
  $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.UseShellExecute = $true
  $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden

  $process = [System.Diagnostics.Process]::Start($startInfo)
  if (-not $process) {
    throw "failed to start process: $FilePath"
  }

  return $process
}

function Write-LogTail {
  foreach ($path in @($LogFile, $ErrorLogFile)) {
    if (-not (Test-Path -LiteralPath $path)) {
      continue
    }

    try {
      Write-ErrorLine "tail: $path"
      Get-Content -LiteralPath $path -Tail 20 -ErrorAction Stop | ForEach-Object {
        Write-ErrorLine ([string]$_)
      }
    } catch {
      continue
    }
  }
}

function Start-Relay {
  $bunPath = Ensure-Bun
  New-Item -ItemType Directory -Force -Path $DataDir, $LogDir | Out-Null
  Normalize-ProcessPathEnvironment

  $current = Get-CurrentRelayPid
  if ($current.Status -eq 0) {
    Write-Line "agent-relay is already running (pid $($current.Pid))"
    return
  }
  if ($current.Status -ne 1) {
    exit 1
  }

  $relayProcess = Start-Process `
    -FilePath $bunPath `
    -ArgumentList @($MainScript) `
    -WorkingDirectory $RootDir `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError $ErrorLogFile `
    -WindowStyle Hidden `
    -PassThru

  $relayPid = [int]$relayProcess.Id
  Set-Content -LiteralPath $PidFile -Value ([string]$relayPid) -Encoding ASCII
  Start-SleepSeconds $StartCheckDelaySeconds

  if (-not (Test-PidIsAlive $relayPid)) {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    Write-ErrorLine "agent-relay failed to start; see $LogFile and $ErrorLogFile"
    Write-LogTail
    exit 1
  }

  Write-Line "agent-relay started (pid $relayPid)"
  Write-Line "log: $LogFile"
}

function Stop-Relay {
  $current = Get-CurrentRelayPid
  if ($current.Status -eq 1) {
    Write-Line "agent-relay is not running"
    return
  }
  if ($current.Status -ne 0) {
    exit 1
  }

  $relayPid = [int]$current.Pid
  Write-Line "stopping agent-relay (pid $relayPid)"
  Stop-Process -Id $relayPid -ErrorAction SilentlyContinue

  $deadline = (Get-Date).AddMilliseconds([Math]::Ceiling($StopTimeoutSeconds * 1000))
  while (Test-PidIsAlive $relayPid) {
    if ((Get-Date) -ge $deadline) {
      Write-ErrorLine "agent-relay did not stop after ${StopTimeoutSeconds}s; forcing termination"
      Stop-Process -Id $relayPid -Force -ErrorAction SilentlyContinue
      break
    }
    Start-SleepSeconds $StopPollIntervalSeconds
  }

  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  Write-Line "agent-relay stopped"
}

function Quote-PowerShellLiteral {
  param([string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

function Get-PowerShellExecutable {
  $currentProcess = Get-Process -Id $PID -ErrorAction SilentlyContinue
  if ($currentProcess -and $currentProcess.Path) {
    return $currentProcess.Path
  }

  $candidates = @(
    (Join-Path $PSHOME "powershell.exe"),
    (Join-Path $PSHOME "pwsh.exe"),
    "powershell.exe"
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -ErrorAction SilentlyContinue) {
      return $candidate
    }
  }

  return "powershell.exe"
}

function Add-NativeProcessParentType {
  if ("NativeProcessParent" -as [type]) {
    return
  }

  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class NativeProcessParent {
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_BASIC_INFORMATION {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr InheritedFromUniqueProcessId;
  }

  [DllImport("ntdll.dll")]
  public static extern int NtQueryInformationProcess(
    IntPtr ProcessHandle,
    int ProcessInformationClass,
    ref PROCESS_BASIC_INFORMATION ProcessInformation,
    int ProcessInformationLength,
    out int ReturnLength
  );
}
"@
}

function Get-ParentProcessId {
  param([int]$ProcessId)

  try {
    Add-NativeProcessParentType
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    $info = New-Object NativeProcessParent+PROCESS_BASIC_INFORMATION
    $length = 0
    $size = [Runtime.InteropServices.Marshal]::SizeOf([type][NativeProcessParent+PROCESS_BASIC_INFORMATION])
    $result = [NativeProcessParent]::NtQueryInformationProcess($process.Handle, 0, [ref]$info, $size, [ref]$length)
    if ($result -ne 0) {
      return $null
    }

    return [int]$info.InheritedFromUniqueProcessId.ToInt64()
  } catch {
    return $null
  }
}

function Test-PidIsAncestor {
  param([int]$TargetPid)

  [int]$processId = $PID
  while ($processId -gt 0) {
    if ($processId -eq $TargetPid) {
      return $true
    }

    $parentPid = Get-ParentProcessId $processId
    if (-not $parentPid -or $parentPid -eq $processId) {
      return $false
    }

    $processId = [int]$parentPid
  }

  return $false
}

function Start-DetachedProcess {
  param(
    [string]$FilePath,
    [string]$EncodedCommand
  )

  $cmdExe = [Environment]::GetEnvironmentVariable("ComSpec")
  if ([string]::IsNullOrWhiteSpace($cmdExe)) {
    $cmdExe = Join-Path $env:SystemRoot "System32\cmd.exe"
  }

  Normalize-ProcessPathEnvironment
  Start-Process `
    -FilePath $cmdExe `
    -ArgumentList @(
      "/d",
      "/c",
      "start",
      "`"agent-relay restart worker`"",
      "/min",
      (Quote-CmdArgument $FilePath),
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      $EncodedCommand
    ) `
    -WorkingDirectory $RootDir `
    -WindowStyle Hidden | Out-Null
}

function Schedule-Restart {
  param([int]$RelayPid)

  New-Item -ItemType Directory -Force -Path $DataDir, $LogDir | Out-Null

  $bunPathLiteral = Quote-PowerShellLiteral (Ensure-Bun)
  $scriptLiteral = Quote-PowerShellLiteral $ScriptPath
  $logDirLiteral = Quote-PowerShellLiteral $LogDir
  $logFileLiteral = Quote-PowerShellLiteral $LogFile
  $workerScript = "`$env:AGENT_RELAY_BUN_PATH = $bunPathLiteral; try { & $scriptLiteral __restart-worker } catch { New-Item -ItemType Directory -Force -Path $logDirLiteral | Out-Null; Add-Content -LiteralPath $logFileLiteral -Value ([string]`$_); exit 1 }"
  $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($workerScript))
  Start-DetachedProcess -FilePath (Get-PowerShellExecutable) -EncodedCommand $encodedCommand

  Write-Line "agent-relay restart scheduled (pid $RelayPid)"
  Write-Line "log: $LogFile"
}

function Invoke-RestartWorker {
  Start-SleepSeconds $RestartWorkerDelaySeconds
  Invoke-RestartSequence
}

function Invoke-RestartSequence {
  Stop-Relay
  if (-not (Test-ExperimentalSeamlessWorkEnabled)) {
    Clear-RelayData
  } else {
    Write-Line "experimental seamless work enabled; preserving Relay data and the independent Gateway"
  }
  Start-Relay
}

function Invoke-SeamlessCommand {
  param([string]$Subcommand)
  $bunPath = Ensure-Bun
  & $bunPath (Join-Path $RootDir "src\gateway\manage.ts") $Subcommand
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Restart-Relay {
  $current = Get-CurrentRelayPid
  if ($current.Status -eq 0) {
    Schedule-Restart ([int]$current.Pid)
    return
  }
  if ($current.Status -ne 1) {
    exit 1
  }

  Invoke-RestartSequence
}

function Show-RelayStatus {
  $current = Get-CurrentRelayPid
  if ($current.Status -eq 0) {
    Write-Line "agent-relay is running (pid $($current.Pid))"
    return
  }
  if ($current.Status -eq 1) {
    Write-Line "agent-relay is stopped"
    return
  }

  exit 1
}

function Clear-RelayData {
  $current = Get-CurrentRelayPid
  if ($current.Status -eq 0) {
    Write-ErrorLine "agent-relay is running (pid $($current.Pid)); stop it before cleaning data"
    exit 1
  }
  if ($current.Status -ne 1) {
    exit 1
  }

  Remove-Item -LiteralPath $DataDir, $LogDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Line "removed $DataDir and $LogDir"
}

switch ($Command) {
  "start" {
    Start-Relay
  }
  "stop" {
    Stop-Relay
  }
  "restart" {
    Restart-Relay
  }
  "__restart-worker" {
    Invoke-RestartWorker
  }
  "status" {
    Show-RelayStatus
  }
  "gateway-start" { Invoke-SeamlessCommand "start" }
  "gateway-stop" { Invoke-SeamlessCommand "stop" }
  "gateway-status" { Invoke-SeamlessCommand "status" }
  "gateway-install" { Invoke-SeamlessCommand "gateway-install" }
  "gateway-uninstall" { Invoke-SeamlessCommand "gateway-uninstall" }
  "desktop-enable" { Invoke-SeamlessCommand "desktop-enable" }
  "desktop-disable" { Invoke-SeamlessCommand "desktop-disable" }
  "clients-enable" { Invoke-SeamlessCommand "clients-enable" }
  "clients-disable" { Invoke-SeamlessCommand "clients-disable" }
  { $_ -eq "clean-data" -or $_ -eq "clean" } {
    Clear-RelayData
  }
  { $_ -eq "-h" -or $_ -eq "--help" -or $_ -eq "help" } {
    Show-Usage
  }
  default {
    Show-Usage
    exit 1
  }
}
