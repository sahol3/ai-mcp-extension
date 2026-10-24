<#
.SYNOPSIS
  Install the AI Studio MCP Bridge: dependencies, the daemon as a logon task, and the MCP
  server registration for Claude Code.

.DESCRIPTION
  Idempotent. Re-run it after pulling changes; it replaces what it installed before.

  The daemon runs from a .cmd launcher rather than being invoked directly by the scheduled
  task. Two reasons, both learned the hard way on this machine:

    - `wscript //B run_hidden.vbs "<cmd>"` silently no-ops when <cmd> contains inner quotes,
      because VBS has no \" escape. The task still reports success and nothing runs.
    - A console-less parent that spawns console apps pops a visible window per child.

  A .cmd file whose own path contains no quotes avoids both, and the check that it worked is
  always the side effect — a line appearing in daemon.log — never the task's exit code.

.PARAMETER SkipTask
  Do not create the logon scheduled task.

.PARAMETER SkipMcp
  Do not register the MCP server with Claude Code.
#>
param(
  [switch]$SkipTask,
  [switch]$SkipMcp
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Home2 = Join-Path $env:USERPROFILE '.ai-mcp'
$TaskName = 'AiStudioMcpBridge'

Write-Host "AI Studio MCP Bridge — install" -ForegroundColor Cyan
Write-Host "  repo: $Root"
Write-Host "  data: $Home2`n"

# ---------------------------------------------------------------- dependencies

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "node is not on PATH. Install Node.js 20 or newer first."
}
$nodeVersion = (node --version)
Write-Host "node $nodeVersion"

Write-Host "Installing server dependencies..."
Push-Location $Root
try { npm --prefix server install --no-audit --no-fund | Out-Null } finally { Pop-Location }

New-Item -ItemType Directory -Force $Home2 | Out-Null

# --------------------------------------------------------------- icons

Write-Host "Generating extension icons..."
Push-Location $Root
try { node scripts/make-icons.mjs | Out-Null } finally { Pop-Location }

# ------------------------------------------------------------- daemon launcher

# The launcher lives under the data directory, whose path contains no spaces or quotes.
$Launcher = Join-Path $Home2 'daemon.cmd'
$DaemonJs = Join-Path $Root 'server\src\daemon.js'
$launcherBody = "@echo off`r`nnode `"$DaemonJs`"`r`n"
# PowerShell 5.1's -Encoding UTF8 writes a BOM, and a BOM in a .cmd is a syntax error on the
# first line. WriteAllText with an explicit no-BOM encoding is the only reliable form.
[System.IO.File]::WriteAllText($Launcher, $launcherBody, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Wrote $Launcher"

# --------------------------------------------------------------- scheduled task

if (-not $SkipTask) {
  Write-Host "Registering logon task '$TaskName'..."
  try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop } catch {}

  $action    = New-ScheduledTaskAction -Execute $Launcher
  $trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                 -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
                 -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Description 'AI Studio MCP Bridge daemon' | Out-Null

  # Prove the side effect, never the exit code: a duplicate daemon exits with EADDRINUSE,
  # which is a success for our purposes and a failure by exit code.
  $logPath = Join-Path $Home2 'daemon.log'
  $before = if (Test-Path $logPath) { (Get-Item $logPath).Length } else { 0 }
  Start-ScheduledTask -TaskName $TaskName
  $deadline = (Get-Date).AddSeconds(20)
  $started = $false
  while ((Get-Date) -lt $deadline -and -not $started) {
    Start-Sleep -Milliseconds 700
    if (Test-Path $logPath) {
      $tail = Get-Content $logPath -Tail 6 -ErrorAction SilentlyContinue
      if ($tail -match 'daemon listening' -or $tail -match 'already in use') { $started = $true }
    }
  }
  if ($started) { Write-Host "  daemon is up (see $logPath)" -ForegroundColor Green }
  else { Write-Warning "  no daemon.log activity within 20s — check $logPath" }
}

# ----------------------------------------------------------------- mcp server

if (-not $SkipMcp) {
  $indexJs = Join-Path $Root 'server\src\index.js'
  if (Get-Command claude -ErrorAction SilentlyContinue) {
    Write-Host "Registering the MCP server with Claude Code..."
    try { claude mcp remove ai-studio --scope user 2>$null | Out-Null } catch {}
    claude mcp add ai-studio --scope user -- node $indexJs
    Write-Host "  registered as 'ai-studio'" -ForegroundColor Green
  } else {
    Write-Host "claude CLI not found — register the server yourself:" -ForegroundColor Yellow
    Write-Host "  claude mcp add ai-studio --scope user -- node `"$indexJs`""
  }
}

# --------------------------------------------------------------------- summary

Write-Host "`nNext:" -ForegroundColor Cyan
Write-Host "  1. node `"$Root\scripts\launch-browser.mjs`""
Write-Host "     ...then sign in to Gemini, Google Flow and ChatGPT in that window, once."
Write-Host "  2. node `"$Root\scripts\verify-live.mjs`""
Write-Host "  3. In your agent: run ai_status`n"
Write-Host "  Chrome 137+ ignores --load-extension. To use your own Chrome, load"
Write-Host "  $Root\extension by hand from chrome://extensions with Developer mode on."
