<#
.SYNOPSIS
  Re-detects pattern evidence (candlestick-v2 / price-action-v3) from scratch for NSE symbol/timeframe pairs.

.DESCRIPTION
  *** NOT RUN. Delivered with the pattern-recognition audit fixes; run it deliberately, once the
  *** code containing migration 133 has been deployed and the migration has been applied. ***

  Why this exists
    The candlestick / price-action / chart-pattern rules changed (see
    docs/2026-10-10-pattern-recognition-v2-redetection.md). Stored candlestick-v1 rows are marked
    superseded by migration 133 but not deleted, and consumers now read only candlestick-v2 and
    price-action-v3. Until this script (or an equivalent run) has been executed, there is no v2
    evidence, so patterns correctly carry no weight.

  What it does
    For every SYMBOL x TIMEFRAME pair it runs, from the repo root:

        npm run analysis:detect-patterns -- --instrument <SYMBOL> --timeframe <TF>

    WITHOUT --from, so the whole completed history is detected and every bar is re-evaluated.
    Each pair is written under candlestick-v2 / price-action-v3 (new rows next to the old ones;
    the upsert key includes the algorithm version, so v1 rows are neither touched nor removed) and
    stamps candle_feature_coverage for the new versions.

  Safety
    - Dry run by default: prints the commands and exits. Pass -Execute to run them.
    - Never deletes anything and never touches v1 rows.
    - Run it with the scheduler's pattern-detection job paused, or accept that both write the same
      v2 rows (the upsert is idempotent, so the worst case is duplicated work).
    - The CLI resolves NSE instruments only. Other exchanges are not covered (see the doc).
    - Do NOT pass --threshold-mode: the default picks ATR units on intraday and percent on daily,
      which is what price-action-v3 means. --threshold-mode atr writes a different version label
      (price-action-v3-atr) and is for research comparisons only.

  Choosing the pairs
    Run this READ-ONLY query (for example through the scheduler container's python and
    DATABASE_URL, as other audits do) to list the pairs that have candlestick-v1 rows, then pass
    them with -Pairs "SYMBOL:TF,SYMBOL:TF,...":

        SELECT i.symbol, c.timeframe, count(*) AS v1_rows
          FROM pattern_detections d
          JOIN pattern_definitions pd ON pd.id = d.pattern_definition_id
          JOIN candles c              ON c.id  = d.candle_id
          JOIN instruments i          ON i.id  = c.instrument_id
         WHERE pd.algorithm_version = 'candlestick-v1'
           AND i.exchange = 'NSE'
         GROUP BY i.symbol, c.timeframe
         ORDER BY i.symbol, c.timeframe;

.PARAMETER Pairs
  Comma-separated SYMBOL:TIMEFRAME pairs, e.g. "NIFTY50:5m,NIFTY50:1d,RELIANCE:5m".

.PARAMETER Execute
  Actually run the commands. Without it the script only prints them.

.EXAMPLE
  # Dry run: shows exactly what would be executed.
  .\scripts\redetect-candlestick-v2.ps1 -Pairs "NIFTY50:5m,NIFTY50:1d"

.EXAMPLE
  # Real run, deliberately.
  .\scripts\redetect-candlestick-v2.ps1 -Pairs "NIFTY50:5m,NIFTY50:1d" -Execute
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Pairs,

  [switch]$Execute
)

$ErrorActionPreference = "Stop"
$supportedTimeframes = @("1m", "3m", "5m", "10m", "15m", "30m", "60m", "1d")

$repoRoot = Split-Path -Parent $PSScriptRoot
$parsed = @()
foreach ($entry in ($Pairs -split ",")) {
  $trimmed = $entry.Trim()
  if ($trimmed -eq "") { continue }
  $parts = $trimmed -split ":"
  if ($parts.Count -ne 2 -or $parts[0].Trim() -eq "" -or $parts[1].Trim() -eq "") {
    throw "Invalid pair '$trimmed'. Use SYMBOL:TIMEFRAME, e.g. NIFTY50:5m."
  }
  $symbol = $parts[0].Trim().ToUpperInvariant()
  $timeframe = $parts[1].Trim()
  if ($symbol -notmatch "^[A-Z0-9&_-]+$") { throw "Invalid symbol '$symbol'." }
  if ($supportedTimeframes -notcontains $timeframe) {
    throw "Unsupported timeframe '$timeframe'. Use: $($supportedTimeframes -join ', ')."
  }
  $parsed += [pscustomobject]@{ Symbol = $symbol; Timeframe = $timeframe }
}
if ($parsed.Count -eq 0) { throw "No SYMBOL:TIMEFRAME pairs supplied." }

Push-Location $repoRoot
try {
  foreach ($pair in $parsed) {
    $command = "npm run analysis:detect-patterns -- --instrument $($pair.Symbol) --timeframe $($pair.Timeframe)"
    if (-not $Execute) {
      Write-Host "[dry run] $command"
      continue
    }
    Write-Host "[run] $command"
    & npm run analysis:detect-patterns -- --instrument $pair.Symbol --timeframe $pair.Timeframe
    if ($LASTEXITCODE -ne 0) { throw "Detection failed for $($pair.Symbol) $($pair.Timeframe) (exit $LASTEXITCODE)." }
  }
  if (-not $Execute) {
    Write-Host "Dry run only. Re-run with -Execute to detect candlestick-v2 / price-action-v3 for the pairs above."
  }
} finally {
  Pop-Location
}
