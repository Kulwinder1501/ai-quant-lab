<#
.SYNOPSIS
  Nightly backup of the AI Quant Lab database (db-v2): a verified pg_dump of everything that cannot be rebuilt.

.DESCRIPTION
  Written 2026-10-31 after an audit found the 34 GB database had NO backup: one copy, in a Docker volume inside
  docker_data.vhdx on a laptop. See docs/2026-10-31-database-backup.md for the design, the restore procedure and the limits.

  What it dumps ("core"): every table EXCEPT the data of five derived tables that can be recomputed from candles with
  the repo's own CLIs (indicator_snapshots, ict_state_snapshots, price_action_events, pattern_detections,
  candle_feature_coverage: 13.7 GB of the 34 GB). Their schemas are still dumped, so a restore recreates them empty.
  That keeps a dump to about 2.2 GB and about 3 minutes instead of 34 GB.

  Safeguards, in order: the database container must be running and healthy; the disk must have room (MinimumFreeGB);
  the dump is written inside the container, read back in full with pg_restore to prove the archive is intact, copied
  out under a .partial name, and its SHA-256 compared with the container's copy BEFORE it is given its final name.
  A failed run never deletes a good older backup. Rotation keeps the newest Daily dumps plus the newest Weekly dumps
  (the first dump of each ISO week), so a bad night cannot push out the last good copy.

  Credentials are never stored: the user and database name are read from the container's own environment.

  Status is written to <OpsDir>\last-backup.json for the morning check and the task's exit code (0 = success).

.PARAMETER BackupDir
  Where dumps go. Default: <profile>\ai-quant-lab-backups\db  (the same disk as the database: this protects against
  corruption, a deleted volume and a bad migration, NOT against losing the machine; see OffsiteDir).
.PARAMETER OffsiteDir
  Optional. If set (for example a OneDrive folder), the newest dump is copied there after a successful backup.
  Not set by default: it uploads a 2+ GB copy of the data to another service and needs the owner's decision.
#>
param(
  [string]$Container = 'ai-quant-lab-db-v2',
  [string]$BackupDir = (Join-Path $env:USERPROFILE 'ai-quant-lab-backups\db'),
  [string]$OpsDir = (Join-Path $env:USERPROFILE 'ai-quant-lab-ops'),
  [string]$OffsiteDir = '',
  [int]$KeepDaily = 4,
  [int]$KeepWeekly = 2,
  [int]$MinimumFreeGB = 15,
  [string[]]$DerivedTables = @('indicator_snapshots', 'ict_state_snapshots', 'price_action_events', 'pattern_detections', 'candle_feature_coverage')
)

$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $BackupDir, $OpsDir | Out-Null
$logFile = Join-Path $OpsDir 'backup.log'
$statusFile = Join-Path $OpsDir 'last-backup.json'
$started = Get-Date
$stamp = $started.ToString('yyyyMMdd-HHmm')
$name = "aiquantlab-core-$stamp.dump"
$inContainer = "/tmp/$name"
$partial = Join-Path $BackupDir "$name.partial"
$final = Join-Path $BackupDir $name

function Write-Log([string]$message) {
  $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $message
  Add-Content -Path $logFile -Value $line
  Write-Host $line
}

function Save-Status([string]$state, [string]$detail, [string]$file, [long]$bytes, [string]$sha) {
  [pscustomobject]@{
    status = $state; detail = $detail; file = $file; bytes = $bytes; sha256 = $sha
    startedAt = $started.ToString('o'); finishedAt = (Get-Date).ToString('o')
  } | ConvertTo-Json | Set-Content -Path $statusFile -Encoding UTF8
}

function Fail([string]$why) {
  Write-Log "FAILED: $why"
  Save-Status 'FAILED' $why '' 0 ''
  if (Test-Path $partial) { Remove-Item $partial -Force -ErrorAction SilentlyContinue }
  docker exec $Container rm -f $inContainer 2>$null | Out-Null
  exit 1
}

Write-Log "=== backup start ($name) ==="

# 1. the database must be up and healthy
$health = (docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' $Container) 2>$null
if ($LASTEXITCODE -ne 0 -or $health -notmatch '^running healthy') { Fail "database container is not running and healthy (state: '$health')" }

# 2. room on the disk, counting what is already there
$drive = Get-PSDrive -Name ((Split-Path $BackupDir -Qualifier).TrimEnd(':'))
$freeGB = [math]::Round($drive.Free / 1GB, 1)
if ($freeGB -lt $MinimumFreeGB) { Fail "only $freeGB GB free on $($drive.Name):, the minimum is $MinimumFreeGB GB; free space or lower KeepDaily before the next run" }
Write-Log "disk free: $freeGB GB"

# 3. dump inside the container (custom format, so pg_restore can verify and restore selectively)
$excludes = ($DerivedTables | ForEach-Object { "--exclude-table-data=$_" }) -join ' '
$dumpCommand = "pg_dump -U `$POSTGRES_USER -d `$POSTGRES_DB -Fc -Z 6 $excludes -f $inContainer"
Write-Log 'dumping...'
docker exec $Container sh -c $dumpCommand
if ($LASTEXITCODE -ne 0) { Fail "pg_dump exited with $LASTEXITCODE" }

# 4. prove the archive is intact: read all of it back (decompresses and parses every data block)
Write-Log 'verifying archive integrity inside the container...'
docker exec $Container sh -c "pg_restore -f /dev/null $inContainer"
if ($LASTEXITCODE -ne 0) { Fail "pg_restore could not read the dump back (exit $LASTEXITCODE): the archive is not intact" }
$entries = (docker exec $Container sh -c "pg_restore -l $inContainer | grep -c 'TABLE DATA'") 2>$null
$sourceSha = ((docker exec $Container sh -c "sha256sum $inContainer | cut -d' ' -f1") 2>$null).Trim()
if (-not $sourceSha) { Fail 'could not hash the dump inside the container' }

# 5. copy out under a .partial name and compare the hash before it counts as a backup
Write-Log 'copying out...'
docker cp "${Container}:$inContainer" $partial
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $partial)) { Fail 'docker cp failed' }
docker exec $Container rm -f $inContainer | Out-Null
$hostSha = (Get-FileHash -Algorithm SHA256 -Path $partial).Hash.ToLower()
if ($hostSha -ne $sourceSha) { Fail "checksum differs after copying (container $sourceSha, host $hostSha)" }
Rename-Item -Path $partial -NewName $name
$bytes = (Get-Item $final).Length
"$hostSha *$name" | Set-Content -Path "$final.sha256" -Encoding ASCII

# 6. a manifest of what was in the database at dump time, so a restore can be checked against it
# (the SQL goes in on standard input: Windows PowerShell does not escape quotes nested in a native argument)
$manifest = 'select relname, n_live_tup from pg_stat_user_tables where n_live_tup > 0 order by relname' | docker exec -i $Container sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -At' 2>$null
if (-not $manifest) { Write-Log 'WARNING: could not write the table manifest; the backup itself is intact' }
$manifest | Set-Content -Path "$final.tables.txt" -Encoding UTF8
Write-Log ("backup ok: {0}, {1:N2} GB, sha256 {2}, {3} tables with data" -f $name, ($bytes / 1GB), $hostSha.Substring(0, 12), $entries)

# 7. rotation: newest $KeepDaily, plus the first dump of each of the newest $KeepWeekly ISO weeks
$all = Get-ChildItem -Path $BackupDir -Filter 'aiquantlab-core-*.dump' | Sort-Object Name -Descending
$keep = New-Object System.Collections.Generic.HashSet[string]
$all | Select-Object -First $KeepDaily | ForEach-Object { [void]$keep.Add($_.Name) }
$weeks = @{}
foreach ($f in ($all | Sort-Object Name)) {
  $d = [datetime]::ParseExact($f.Name.Substring(15, 8), 'yyyyMMdd', $null)
  $cal = [System.Globalization.CultureInfo]::InvariantCulture.Calendar
  $week = '{0}-{1:00}' -f $d.Year, $cal.GetWeekOfYear($d, [System.Globalization.CalendarWeekRule]::FirstFourDayWeek, [DayOfWeek]::Monday)
  if (-not $weeks.ContainsKey($week)) { $weeks[$week] = $f.Name }
}
$weeks.Keys | Sort-Object -Descending | Select-Object -First $KeepWeekly | ForEach-Object { [void]$keep.Add($weeks[$_]) }
foreach ($f in $all) {
  if (-not $keep.Contains($f.Name)) {
    Remove-Item $f.FullName, "$($f.FullName).sha256", "$($f.FullName).tables.txt" -Force -ErrorAction SilentlyContinue
    Write-Log "rotated out $($f.Name)"
  }
}

# 8. optional off-machine copy (only when the owner has chosen a destination)
if ($OffsiteDir) {
  try {
    New-Item -ItemType Directory -Force -Path $OffsiteDir | Out-Null
    Get-ChildItem -Path $OffsiteDir -Filter 'aiquantlab-core-*.dump' -ErrorAction SilentlyContinue | Remove-Item -Force
    Copy-Item $final $OffsiteDir -Force
    Copy-Item "$final.sha256" $OffsiteDir -Force
    Write-Log "offsite copy written to $OffsiteDir"
  } catch { Write-Log "offsite copy FAILED (the local backup is fine): $($_.Exception.Message)" }
}

Save-Status 'OK' "$entries tables with data" $name $bytes $hostSha
Write-Log '=== backup done ==='
exit 0
