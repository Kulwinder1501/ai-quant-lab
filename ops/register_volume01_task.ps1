# Register VOLUME-01 Weekly Task in Windows Task Scheduler
# Run once as Administrator: .\ops\register_volume01_task.ps1

$TASK_NAME = "VOLUME-01-WeeklyReEvaluation"
$SCRIPT_PATH = (Resolve-Path "$PSScriptRoot\volume01_weekly_run.ps1").Path
$REPO_ROOT = Split-Path -Parent $PSScriptRoot

# Run every Monday at 09:15 IST (03:45 UTC)
$TRIGGER = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At "09:15AM"

$ACTION = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-ExecutionPolicy Bypass -NonInteractive -File `"$SCRIPT_PATH`"" `
    -WorkingDirectory $REPO_ROOT

$SETTINGS = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

$PRINCIPAL = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive

# Remove existing task if present
if (Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false
    Write-Host "Removed existing task: $TASK_NAME"
}

Register-ScheduledTask `
    -TaskName $TASK_NAME `
    -Trigger $TRIGGER `
    -Action $ACTION `
    -Settings $SETTINGS `
    -Principal $PRINCIPAL `
    -Description "VOLUME-01 pre-registration re-evaluation. Runs weekly to accumulate OOS sessions and re-check H1 monotonicity and H2 deferral threshold."

Write-Host ""
Write-Host "Task '$TASK_NAME' registered successfully."
Write-Host "Schedule : Every Monday at 09:15 AM"
Write-Host "Script   : $SCRIPT_PATH"
Write-Host ""
Write-Host "To run immediately: Start-ScheduledTask -TaskName '$TASK_NAME'"
Write-Host "To view logs      : ls $REPO_ROOT\logs\volume01\"
