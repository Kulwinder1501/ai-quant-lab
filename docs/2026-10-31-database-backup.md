# 2026-10-31 database backup, morning check, and what they do not cover

## Why

An audit on 2026-10-31 found that the 34 GB database (`ai-quant-lab-db-v2`, port 5433, the system of record) had **no
backup at all**: one copy, in a Docker volume inside `docker_data.vhdx` on a laptop. The same audit found nothing alerted
when the Fyers login was missing (2026-10-28: first login at 12:15, three hours of depth and tick data lost), when a backup
was stale, when the disk was nearly full, or when the whole stack was stopped. This change adds a verified nightly dump and
a host-side morning check. Both are PowerShell scripts under `scripts/ops/`, run by Windows scheduled tasks. Nothing in the
application or the compose file changed.

## What runs

| Task | When | What |
|---|---|---|
| `AIQuantLab-DatabaseBackup` | daily 17:45 IST | `scripts/ops/backup-database.ps1` |
| `AIQuantLab-MorningCheck` | weekdays 08:50, repeating every 10 min for 50 min | `scripts/ops/morning-check.ps1` |

Both are registered for the current user, interactive, **without elevation** (the same way as
`AIQuantLab-PostMarketPipeline`) by `scripts/ops/install-host-tasks.ps1`, which copies the two scripts to
`%USERPROFILE%\ai-quant-lab-ops\bin` so the tasks do not depend on which branch the repository is on. Re-run the installer
after changing either script. Run it from any PowerShell:

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\install-host-tasks.ps1
```

**Why 17:45 and not "at night".** The laptop enters Modern Standby most nights (about 48% of the last ten days), and the
Docker VM freezes with it, so a 02:00 run would not run. 17:45 is after the 16:05 end-of-day pipeline and while the machine
is in use. The task has `StartWhenAvailable` (a missed run happens as soon as the machine is awake) and `WakeToRun`.

### The backup (`backup-database.ps1`)

- Dumps everything except the **data** of five derived tables (schemas are still dumped): `indicator_snapshots`,
  `ict_state_snapshots`, `price_action_events`, `pattern_detections`, `candle_feature_coverage`. They are 13.7 GB of the
  34 GB and are recomputed from candles. A dump is about 2.1 GB and takes 5 to 10 minutes end to end (the two runs on 2026-10-31
  took 5 and 10 minutes; the second overlapped other work).
- The dump is written **inside the db container** with `pg_dump -Fc -Z 6`; the database user and name come from the
  container's own environment, so no credential is stored anywhere.
- Before a file counts as a backup: the container must be running and healthy, the disk must have at least 15 GB free,
  `pg_restore -f /dev/null` must read the whole archive back, the file is copied out under a `.partial` name, and its
  SHA-256 must equal the one computed inside the container. Only then is it renamed. A failed run never deletes a good
  older backup.
- Writes `<name>.dump`, `<name>.dump.sha256` and `<name>.dump.tables.txt` (row estimates for every table with data, to check
  a restore against).
- Rotation keeps the newest 4 dumps plus the first dump of each of the 2 newest ISO weeks (about 6 dumps, 13 GB).
- Status goes to `%USERPROFILE%\ai-quant-lab-ops\last-backup.json` and `backup.log`; the exit code is 0 on success, 1 on failure.
- Location: `%USERPROFILE%\ai-quant-lab-backups\db`.

### The morning check (`morning-check.ps1`)

Silent when everything is fine; otherwise it shows a Windows toast **and** a topmost message box listing what is wrong
(the box closes itself after 2 minutes and is shown again 10 minutes later if the problem remains). The box exists because the
toast alone was silently dropped on the operator's machine on 2026-10-31 (no error; most likely Do Not Disturb or Focus
Assist), while the box was seen. It changes nothing else.

1. Docker reachable and every `ai-quant-lab-*` container running and not unhealthy.
2. The last backup succeeded and finished within 36 hours.
3. At least 20 GB free on C:.
4. On a weekday that is not an NSE holiday (read from the system's own `nse_holidays` table), between 08:40 and 15:00 IST:
   the Fyers access token (`provider_credentials.access_token_expires_at`) is valid for at least another 30 minutes.
   This is the "log in to Fyers" alert. It repeats every 10 minutes until the login is done or 09:40 passes.

`morning-check.ps1 -Test` sends one test toast and one test message box. A summary of the last run is in `last-morning-check.json`.

## What is NOT in the backup, and how to get it back

The five derived tables restore **empty** (schema only). Rebuild them from candles:

- `indicator_snapshots`: `npm run analysis:calculate-indicators -- --instrument <X> --timeframe <T>` over the full history
  (the scheduled gold path passes `--warmup-bars 5000` to bound its work; a rebuild over the full history should not).
- `price_action_events`, `pattern_detections`, `candle_feature_coverage`: `npm run analysis:detect-patterns` (price-action-v4
  and candlestick-v2 are the current versions; v2/v3 rows were deleted on 2026-10-31 and are *not* regenerable, see
  `superseded-price-action-rows-deleted-2026-10-31` in the memory notes and the CSV exports in
  `%USERPROFILE%\ai-quant-lab-backups`).
- `ict_state_snapshots`: a cache written on demand by the strategy-market-context and backtest data repositories; it refills
  as they run.

Also **not** in the dump: model artifacts (`./models` in the main checkout, files not database rows), `.env`, and the repository.
The repository is on GitHub; `./models` and `.env` are not backed up by this change.

## Restoring

Into a scratch database first, to check, then into the real one only if needed. All commands run inside the container, which
has `pg_restore` and the credentials in its environment:

```
docker cp "%USERPROFILE%\ai-quant-lab-backups\db\<name>.dump" ai-quant-lab-db-v2:/tmp/restore.dump
docker exec ai-quant-lab-db-v2 sh -c 'createdb -U $POSTGRES_USER scratch_restore'
docker exec ai-quant-lab-db-v2 sh -c 'pg_restore -U $POSTGRES_USER -d scratch_restore --no-owner -j 2 /tmp/restore.dump'
```

Verify the file first against its `.sha256`. To replace the live database, stop `api-v2`, `scheduler-v2`, the research scheduler
and the collectors, restore into a fresh database, check counts against `<name>.dump.tables.txt`, then rename. Then rebuild the
derived tables above.

## Restore test (2026-10-31)

The newest dump (`aiquantlab-core-20261031-1233.dump`, 2.06 GB, written by the scheduled task itself) was restored in full
into a scratch database inside the db container with `pg_restore --no-owner -j 2`, then the scratch database was dropped.
The live database was not touched.

- `pg_restore` exited 0 and printed nothing (no errors, no warnings). It took about 7 minutes (12:51 to 12:58); the restored
  database was 16 GB.
- Exact `count(*)` of all 75 tables, live against restored: **67 identical**, including `candles` (27,371,536),
  `oanda_bid_ask_candles` (2,410,962), `option_premium_ticks` (4,785,158) and `depth_frames` (1,991,084).
- The 8 that differ: the five derived tables restored **empty by design** (`indicator_snapshots` 21,099,202 live,
  `candle_feature_coverage` 2,625,249, `pattern_detections` 2,537,323, `price_action_events` 1,155,286,
  `ict_state_snapshots` 315,437), and three tables still being written to, where live was ahead by what arrived in the
  15 minutes between the dump and the comparison (`scheduled_job_runs` +52, `market_data_ingestions` +29, `market_news` +13).
- Indexes (230), constraints (509), sequences (2) and the migration table (143 rows) are identical live and restored.

What this does **not** show: that the application runs against a restored database (it was not pointed at one), and how long
the derived tables take to recompute.

## Limits, stated plainly

- **Same disk, same machine.** The dump protects against corruption, a dropped volume, a bad migration and a mistaken
  `DELETE`. It does **not** protect against losing or wiping the laptop. `backup-database.ps1 -OffsiteDir <folder>` copies the
  newest dump to another folder (for example a OneDrive folder) after a successful backup. It is **not set**: it would upload
  a 2 GB copy of the market and paper-trading data to a consumer cloud account, which is the owner's decision, and the quota
  should be checked first. To enable it, re-run the installer with `-OffsiteDir`.
- The backup runs only while the machine is awake. A skipped day shows up in the morning check after 36 hours.
- The derived tables are not backed up, so a restore is followed by a recompute (hours, not minutes, for the full history).
- A dump taken while the stack runs is a consistent snapshot of that moment (`pg_dump` uses one transaction), so rows written
  after it began are not in it.
