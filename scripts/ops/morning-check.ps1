<#
.SYNOPSIS
  Host-side health check that raises a Windows notification when something needs a human, and is silent otherwise.

.DESCRIPTION
  Written 2026-10-31 after an audit found that nothing told the operator about three things that cost data:
    - the Fyers token dies at 16:31 IST every day and needs a manual login before the 09:15 open; on 2026-10-28 the
      login came at 12:15 and the first three hours of depth and tick data were lost (18 failed auth checks, no alert);
    - the database had no backup, so a stale or failing backup would have gone unnoticed;
    - the whole stack can be found stopped, or the disk nearly full, with no one the wiser.

  Checks (each adds a line to the alert, nothing is shown when all pass):
    1. Docker is reachable and every ai-quant-lab-* container is running and not unhealthy.
    2. The latest database backup (written by backup-database.ps1) succeeded and is no older than BackupMaxAgeHours.
    3. The system drive has at least MinimumFreeGB free.
    4. On a weekday that is not an NSE holiday (read from the nse_holidays table the system itself uses), between
       08:40 and 15:00 IST: the Fyers access token is valid for at least another 30 minutes.

  It is meant to run as a Windows scheduled task on weekday mornings, repeating every 10 minutes through the pre-open
  window, so a missing login is repeated until it is fixed. It changes nothing; it only reads and notifies.
  Everything is also appended to <OpsDir>\morning-check.log and summarised in <OpsDir>\last-morning-check.json.

.PARAMETER Test
  Sends one test notification and exits, to confirm notifications reach the desktop.
#>
param(
  [switch]$Test,
  [string]$Container = 'ai-quant-lab-db-v2',
  [string]$OpsDir = (Join-Path $env:USERPROFILE 'ai-quant-lab-ops'),
  [int]$BackupMaxAgeHours = 36,
  [int]$MinimumFreeGB = 20
)

$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $OpsDir | Out-Null
$logFile = Join-Path $OpsDir 'morning-check.log'
$summaryFile = Join-Path $OpsDir 'last-morning-check.json'

function Write-Log([string]$message) {
  Add-Content -Path $logFile -Value ('{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $message)
}

function Show-Toast([string]$title, [string]$body) {
  try {
    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
    $safeTitle = [System.Security.SecurityElement]::Escape($title)
    $safeBody = [System.Security.SecurityElement]::Escape($body)
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$safeTitle</text><text>$safeBody</text></binding></visual></toast>")
    $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
    $notifierId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($notifierId).Show($toast)
    return $true
  } catch {
    Write-Log "notification could not be shown: $($_.Exception.Message)"
    return $false
  }
}

# A toast can be dropped silently (Do Not Disturb / Focus Assist, or notifications switched off for the sender) with no
# error, which is not good enough for "log in to Fyers before the open". A message box is always shown on the desktop
# and stays on top; it closes itself after TimeoutSeconds so a run never hangs, and the next run (10 minutes later)
# shows it again if the problem is still there.
function Show-Popup([string]$title, [string]$body, [int]$timeoutSeconds = 120) {
  try {
    $shell = New-Object -ComObject WScript.Shell
    # 48 = exclamation icon, 4096 = system modal (topmost)
    [void]$shell.Popup($body, $timeoutSeconds, $title, 48 + 4096)
    return $true
  } catch {
    Write-Log "message box could not be shown: $($_.Exception.Message)"
    return $false
  }
}

if ($Test) {
  $toast = Show-Toast 'AI Quant Lab' 'Test notification: the morning check can reach your desktop.'
  Write-Host "test toast shown: $toast"
  Write-Host 'showing the message box (closes by itself after 60 seconds)...'
  [void](Show-Popup 'AI Quant Lab' 'Test: the morning check can reach your desktop. You can close this.' 60)
  exit 0
}

# Read one value from the database through the container, so no password is ever on the host.
function Query([string]$sql) {
  # the SQL goes in on standard input: Windows PowerShell does not escape quotes nested in a native argument
  $out = $sql | docker exec -i $Container sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -At' 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  return ($out | Out-String).Trim()
}

$problems = New-Object System.Collections.Generic.List[string]
$now = Get-Date

# 1. Docker and the containers
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  $problems.Add('Docker is not running, so nothing is collecting data.')
} else {
  $names = docker ps -a --filter 'name=ai-quant-lab-' --format '{{.Names}}|{{.Status}}' 2>$null
  foreach ($line in $names) {
    $parts = $line -split '\|', 2
    if ($parts[1] -notmatch '^Up' -or $parts[1] -match 'unhealthy') {
      $problems.Add(('{0} is not healthy: {1}' -f ($parts[0] -replace '^ai-quant-lab-', ''), $parts[1]))
    }
  }
  if (-not $names) { $problems.Add('No ai-quant-lab containers were found.') }
}

# 2. the latest backup
$backupStatus = Join-Path $OpsDir 'last-backup.json'
if (-not (Test-Path $backupStatus)) {
  $problems.Add('No database backup has ever completed (no status file).')
} else {
  try {
    $b = Get-Content $backupStatus -Raw | ConvertFrom-Json
    $ageHours = ($now - [datetime]$b.finishedAt).TotalHours
    if ($b.status -ne 'OK') { $problems.Add("The last database backup FAILED: $($b.detail)") }
    elseif ($ageHours -gt $BackupMaxAgeHours) { $problems.Add(('The last good database backup is {0:N0} hours old.' -f $ageHours)) }
  } catch { $problems.Add("The backup status file could not be read: $($_.Exception.Message)") }
}

# 3. disk
$free = [math]::Round((Get-PSDrive -Name 'C').Free / 1GB, 1)
if ($free -lt $MinimumFreeGB) { $problems.Add("Only $free GB free on C: (the database lives on it).") }

# 4. Fyers login, only when a login is actually needed: a weekday, not an NSE holiday, in the pre-open to mid-session window
$fyersNote = 'not checked'
$minutes = $now.Hour * 60 + $now.Minute
if ($now.DayOfWeek -ne 'Saturday' -and $now.DayOfWeek -ne 'Sunday' -and $minutes -ge (8 * 60 + 40) -and $minutes -le (15 * 60)) {
  $holiday = Query 'select count(*) from nse_holidays where holiday_date = current_date'
  if ($holiday -eq '0') {
    $valid = Query "select access_token_expires_at > now() + interval '30 minutes' from provider_credentials where provider = 'fyers-api-v3'"
    if ($valid -eq 't') { $fyersNote = 'token valid' }
    elseif ($valid -eq 'f') {
      $fyersNote = 'TOKEN INVALID'
      $deadline = if ($minutes -lt (9 * 60 + 15)) { 'The market opens at 09:15.' } else { 'The market is already open and data is being lost.' }
      $problems.Add("Fyers login needed: the access token has expired. $deadline")
    } else { $fyersNote = 'could not read the token' }
  } else { $fyersNote = 'NSE holiday' }
}

$summary = [pscustomobject]@{
  checkedAt = $now.ToString('o'); problems = @($problems); fyers = $fyersNote; diskFreeGB = $free
}
$summary | ConvertTo-Json | Set-Content -Path $summaryFile -Encoding UTF8

if ($problems.Count -eq 0) {
  Write-Log "ok (fyers: $fyersNote, disk free: $free GB)"
  exit 0
}
$body = ($problems -join ' | ')
Write-Log "ALERT: $body"
$title = if ($problems.Count -eq 1) { 'AI Quant Lab: needs attention' } else { "AI Quant Lab: $($problems.Count) problems" }
[void](Show-Toast $title $body)
[void](Show-Popup $title $body)
exit 2
