# PowerShell Script: Setup Post-Market Pipeline Task Scheduler
#
# Registers a Windows Scheduled Task named "AIQuantLab-PostMarketPipeline"
# to run every weekday (Mon-Fri) at 15:30 IST (after NSE market close).

$ErrorActionPreference = "Stop"

$TaskName = "AIQuantLab-PostMarketPipeline"
$ProjectDir = (Get-Item -Path "$PSScriptRoot\..").FullName
$ScriptPath = Join-Path $ProjectDir "scripts\run_post_market_pipeline.py"

# Find python path
$PythonPath = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $PythonPath) {
    $PythonPath = (Get-Command py -ErrorAction SilentlyContinue).Source
}

if (-not $PythonPath) {
    Write-Error "Python executable not found in PATH. Please install Python 3.12+."
    exit 1
}

Write-Host "Project Directory: $ProjectDir"
Write-Host "Script Path: $ScriptPath"
Write-Host "Python Path: $PythonPath"

# Define Trigger: Daily at 15:30 (3:30 PM) IST
$Trigger = New-ScheduledTaskTrigger -Daily -At "15:30"

# Define Action: Execute Python script in working directory
$Action = New-ScheduledTaskAction `
    -Execute $PythonPath `
    -Argument "`"$ScriptPath`"" `
    -WorkingDirectory $ProjectDir

# Settings: Allow on demand, run whether user is logged on or not if configured
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 5)

# Register Scheduled Task (overwrite if exists)
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
    -TaskName $TaskName `
    -Trigger $Trigger `
    -Action $Action `
    -Settings $Settings `
    -Description "Automated post-market pipeline for AI Quant Lab candidate generation, labeling, and ORDERBOOK-01 OOS evaluation."

Write-Host "Successfully registered Task Scheduler job: $TaskName"
Write-Host "Schedule: Daily at 15:30 IST"
