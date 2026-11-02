<#
.SYNOPSIS
  Host-side morning message with today's daily levels for NIFTY 50 and BANK NIFTY.

.DESCRIPTION
  The scheduler builds the pre-open levels sheet at 08:55 IST on trading days and stores it in daily_level_sheets
  (docs/2026-11-02-daily-levels-sheet-and-reaction-protocol.md). This script reads today's sheet through the database
  container, like morning-check.ps1, and shows it as a toast and as a message box that stays on top and closes itself.

  The message is context, not a signal, and says so. It also carries one line of the study's verdict, worded from the stored
  interval: today that line says the levels did not bounce more often than random lines.

  It is quiet on weekends and NSE holidays. It shows the message once per day (a flag file in OpsDir), so the second
  scheduled run only acts if the first found no sheet. If there is still no sheet at the second run, it says so, because a
  missing sheet means the 08:55 job failed and the page is empty.

  Nothing is changed in the database; it only reads.

.PARAMETER Test
  Shows the latest stored sheet (any date) marked as a test, ignoring the weekday check and the once-a-day flag.

.PARAMETER PrintOnly
  Prints the message instead of showing it, and writes no flag file. For checking the wording.

.PARAMETER SheetFile
  Reads the sheets from a file of JSON lines (one object per index: underlying, sheet, history) instead of the database.
  For testing the formatting only.
#>
param(
  [switch]$Test,
  [switch]$PrintOnly,
  [string]$SheetFile = '',
  [string]$Container = 'ai-quant-lab-db-v2',
  [string]$OpsDir = (Join-Path $env:USERPROFILE 'ai-quant-lab-ops'),
  [int]$PopupSeconds = 900
)

$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $OpsDir | Out-Null
$logFile = Join-Path $OpsDir 'morning-levels.log'

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

# A toast can be dropped silently (Do Not Disturb), so the message also goes in a box that is always shown, stays on top and closes
# itself after PopupSeconds. 64 = information icon, 4096 = system modal (topmost).
function Show-Popup([string]$title, [string]$body, [int]$timeoutSeconds) {
  try {
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.Popup($body, $timeoutSeconds, $title, 64 + 4096)
    return $true
  } catch {
    Write-Log "message box could not be shown: $($_.Exception.Message)"
    return $false
  }
}

# Read from the database through the container, so no password is ever on the host. The SQL goes in on standard input.
function Query([string]$sql) {
  $out = $sql | docker exec -i $Container sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -At' 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  return ($out | Out-String).Trim()
}

function Format-Number([double]$value) { return $value.ToString('N0', [System.Globalization.CultureInfo]::GetCultureInfo('en-IN')) }

# One zone as `23,500-23,519 (2)` (the number is how many kinds of source agree) or `23,752`.
function Format-Zone($zone) {
  $text = if ([math]::Round($zone.low) -eq [math]::Round($zone.high)) { Format-Number $zone.low } else { '{0}-{1}' -f (Format-Number $zone.low), (Format-Number $zone.high) }
  if ($zone.confluence -gt 1) { $text += " ($($zone.confluence))" }
  return $text
}

function Format-Index([string]$label, $sheet) {
  $zones = @($sheet.zones)
  $above = @($zones | Where-Object { $_.position -eq 'ABOVE' } | Sort-Object { $_.centre } | Select-Object -First 3)
  $below = @($zones | Where-Object { $_.position -eq 'BELOW' } | Sort-Object { $_.centre } -Descending | Select-Object -First 3)
  $at = @($zones | Where-Object { $_.position -eq 'AT' })
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add(('{0}   previous close {1:N2} ({2})' -f $label, [double]$sheet.referencePrice, $sheet.referenceDate))
  if ($above.Count -gt 0) { $lines.Add('  Above: ' + (($above | ForEach-Object { Format-Zone $_ }) -join '  |  ')) }
  if ($at.Count -gt 0) { $lines.Add('  At the close: ' + (($at | ForEach-Object { Format-Zone $_ }) -join '  |  ')) }
  if ($below.Count -gt 0) { $lines.Add('  Below: ' + (($below | ForEach-Object { Format-Zone $_ }) -join '  |  ')) }
  $walls = @($zones | ForEach-Object { $_.levels } | Where-Object { $_.family -eq 'OI_WALL' })
  if ($walls.Count -gt 0) {
    $call = $walls | Where-Object { $_.key -eq 'call-oi-wall' } | Select-Object -First 1
    $put = $walls | Where-Object { $_.key -eq 'put-oi-wall' } | Select-Object -First 1
    $parts = @()
    if ($call) { $parts += ('call ' + (Format-Number $call.price)) }
    if ($put) { $parts += ('put ' + (Format-Number $put.price)) }
    $lines.Add(('  Option OI walls (expiry {0}): {1}' -f $sheet.oi.expiry, ($parts -join '  |  ')))
  }
  return ($lines -join "`n")
}

# The verdict line, worded from the stored interval of the "all levels" comparison; it never says more than the interval allows.
function Format-History($summary, [int]$sessions) {
  if ($null -eq $summary -or $null -eq $summary.lower -or $null -eq $summary.upper) { return 'History: not enough data to compare these levels with random lines.' }
  $verdict = if ($summary.lower -gt 0) { 'bounced MORE often than random lines' } elseif ($summary.upper -lt 0) { 'bounced LESS often than random lines' } else { 'did not bounce more or less often than random lines' }
  return "History ($sessions sessions since 2023): these levels $verdict."
}

# ---- which sheets ----
$sheets = @()   # objects with .label, .sheet, .history, .sessions
if ($SheetFile -ne '') {
  foreach ($line in (Get-Content -LiteralPath $SheetFile)) {
    if (-not $line.StartsWith('{')) { continue }
    $row = $line | ConvertFrom-Json
    $label = if ($row.underlying -eq 'BANKNIFTY') { 'BANK NIFTY' } else { 'NIFTY 50' }
    $sheets += [pscustomobject]@{ label = $label; sheet = $row.sheet; summary = ($row.summaries | Select-Object -First 1); sessions = $row.sessionsUsed; date = $row.sheet.sessionDate }
  }
  $today = ($sheets | Select-Object -First 1).date
} else {
  $ist = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId((Get-Date), 'India Standard Time')
  $today = $ist.ToString('yyyy-MM-dd')
  if (-not $Test) {
    if ($ist.DayOfWeek -eq 'Saturday' -or $ist.DayOfWeek -eq 'Sunday') { exit 0 }
    $holiday = Query "SELECT name FROM nse_holidays WHERE holiday_date = '$today'"
    if ($holiday) { Write-Log "NSE holiday ($holiday): no levels message"; exit 0 }
    $flag = Join-Path $OpsDir "levels-shown-$today.flag"
    if ((Test-Path $flag) -and -not $PrintOnly) { exit 0 }
  }
  foreach ($pair in @(@('NIFTY50', 'NIFTY 50'), @('BANKNIFTY', 'BANK NIFTY'))) {
    $where = if ($Test) { '' } else { "AND session_date = '$today'" }
    $json = Query "SELECT payload::text FROM daily_level_sheets WHERE underlying_symbol = '$($pair[0])' $where ORDER BY session_date DESC, version DESC LIMIT 1"
    if (-not $json) { continue }
    $study = Query "SELECT payload::text FROM daily_level_study_results WHERE underlying_symbol = '$($pair[0])' ORDER BY computed_at DESC LIMIT 1"
    $studyObject = if ($study) { $study | ConvertFrom-Json } else { $null }
    $sheet = $json | ConvertFrom-Json
    $sheets += [pscustomobject]@{
      label = $pair[1]; sheet = $sheet
      summary = if ($studyObject) { $studyObject.summaries | Select-Object -First 1 } else { $null }
      sessions = if ($studyObject) { $studyObject.sessionsUsed } else { 0 }
      date = $sheet.sessionDate
    }
  }
}

$firstFlag = if ($today) { Join-Path $OpsDir "levels-shown-$today.flag" } else { $null }

if ($sheets.Count -eq 0) {
  $text = "No daily levels sheet was found for $today.`nThe 08:55 scheduler job (DAILY_LEVELS) probably failed. Check scheduled_job_runs, then run:`n  npm run data:daily-levels -- --force"
  Write-Log "no sheet for $today"
  if ($PrintOnly) { Write-Output $text; exit 1 }
  [void](Show-Toast 'Daily levels missing' "No sheet for $today. The 08:55 job probably failed.")
  [void](Show-Popup 'AI Quant Lab: daily levels missing' $text 300)
  exit 1
}

$title = if ($Test) { "Daily levels (TEST, sheet for $today)" } else { "Daily levels for $today" }
$body = New-Object System.Collections.Generic.List[string]
$body.Add('Context, not a signal: levels traders commonly watch, computed from stored data before the open.')
$body.Add('')
foreach ($entry in $sheets) { $body.Add((Format-Index $entry.label $entry.sheet)); $body.Add('') }
$body.Add((Format-History ($sheets | Select-Object -First 1).summary ([int]($sheets | Select-Object -First 1).sessions)))
$body.Add('(2) = two kinds of source agree. The full sheet, with every line, is on the Daily Levels page.')
$text = $body -join "`n"

$summaryLine = ($sheets | ForEach-Object { '{0} close {1}' -f $_.label, (Format-Number ([double]$_.sheet.referencePrice)) }) -join ' | '
Add-Content -Path (Join-Path $OpsDir "levels-$today.txt") -Value ($title + "`n" + $text + "`n") -ErrorAction SilentlyContinue
Write-Log "levels message for ${today}: $summaryLine"

if ($PrintOnly) { Write-Output $title; Write-Output $text; exit 0 }

[void](Show-Toast $title $summaryLine)
[void](Show-Popup "AI Quant Lab: $title" $text $PopupSeconds)
if (-not $Test -and $firstFlag) { Set-Content -Path $firstFlag -Value (Get-Date -Format o) }
