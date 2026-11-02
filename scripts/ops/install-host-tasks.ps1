<#
.SYNOPSIS
  Installs (or re-installs) the host-side Windows scheduled tasks for AI Quant Lab: the nightly database backup and
  the morning check. Safe to re-run: it overwrites the copies and re-registers the tasks.

.DESCRIPTION
  Written 2026-10-31. The scripts are copied to <OpsDir>\bin so the tasks do not depend on a git checkout being on any
  particular branch or commit. Re-run this after changing either script in the repository.

  Tasks are registered for the current user, interactive, without elevation (like AIQuantLab-PostMarketPipeline):
    AIQuantLab-DatabaseBackup  daily at BackupTime (default 17:45 IST, after the 16:05 end-of-day pipeline).
                               "Nightly" in the loose sense: the laptop sleeps overnight (Modern Standby, about 48% of
                               the time), so the run is placed at the end of the working day, and StartWhenAvailable
                               makes a missed run happen as soon as the machine is awake again. WakeToRun is requested too.
    AIQuantLab-MorningCheck    weekdays from CheckStart (default 08:50), repeating every 10 minutes for 50 minutes, so a
                               missing Fyers login is flagged before the 09:15 open and repeated until it is fixed.
    AIQuantLab-MorningLevels   weekdays at LevelsStart (default 08:58) and ten minutes later: shows the daily levels sheet
                               the scheduler builds at 08:55 (docs/2026-11-02-daily-levels-sheet-and-reaction-protocol.md).
#>
param(
  [string]$OpsDir = (Join-Path $env:USERPROFILE 'ai-quant-lab-ops'),
  [string]$BackupTime = '17:45',
  [string]$CheckStart = '08:50',
  [string]$LevelsStart = '08:58',
  [string]$OffsiteDir = ''
)

$ErrorActionPreference = 'Stop'
$bin = Join-Path $OpsDir 'bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'backup-database.ps1'), (Join-Path $PSScriptRoot 'morning-check.ps1'), (Join-Path $PSScriptRoot 'morning-levels.ps1') -Destination $bin -Force
Write-Host "scripts installed to $bin"

$user = "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$common = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden'

# 1. the backup
$offsiteArgument = if ($OffsiteDir) { " -OffsiteDir `"$OffsiteDir`"" } else { '' }
$backupAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "$common -File `"$bin\backup-database.ps1`"$offsiteArgument"
$backupTrigger = New-ScheduledTaskTrigger -Daily -At $BackupTime
$backupSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName 'AIQuantLab-DatabaseBackup' -Action $backupAction -Trigger $backupTrigger -Settings $backupSettings `
  -Principal $principal -Force -Description 'Verified pg_dump of the AI Quant Lab database (see docs/2026-10-31-database-backup.md).' | Out-Null
Write-Host "registered AIQuantLab-DatabaseBackup, daily at $BackupTime"

# 2. the morning check
$checkAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "$common -File `"$bin\morning-check.ps1`""
$checkTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At $CheckStart
$repetition = (New-ScheduledTaskTrigger -Once -At $CheckStart -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Minutes 50)).Repetition
$checkTrigger.Repetition = $repetition
$checkSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName 'AIQuantLab-MorningCheck' -Action $checkAction -Trigger $checkTrigger -Settings $checkSettings `
  -Principal $principal -Force -Description 'Notifies when the Fyers login, the backup, the disk or a container needs attention.' | Out-Null
Write-Host "registered AIQuantLab-MorningCheck, weekdays from $CheckStart every 10 minutes for 50 minutes"

# 3. the morning levels message: the scheduler builds the sheet at 08:55 (retry 09:05); this shows it at LevelsStart and once more ten
# minutes later, and is silent on weekends, NSE holidays and once it has shown the day's message.
$levelsAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "$common -File `"$bin\morning-levels.ps1`""
$levelsTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At $LevelsStart
$levelsTrigger.Repetition = (New-ScheduledTaskTrigger -Once -At $LevelsStart -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Minutes 15)).Repetition
$levelsSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
Register-ScheduledTask -TaskName 'AIQuantLab-MorningLevels' -Action $levelsAction -Trigger $levelsTrigger -Settings $levelsSettings `
  -Principal $principal -Force -Description 'Shows the daily levels sheet for NIFTY 50 and BANK NIFTY before the open.' | Out-Null
Write-Host "registered AIQuantLab-MorningLevels, weekdays at $LevelsStart and ten minutes later"

Get-ScheduledTask -TaskName 'AIQuantLab-*' | ForEach-Object {
  $i = Get-ScheduledTaskInfo -TaskName $_.TaskName
  Write-Host ('{0,-28} state={1,-8} next run={2}' -f $_.TaskName, $_.State, $i.NextRunTime)
}
