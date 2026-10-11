# Pattern recognition v2: what changed, how to re-detect, how to replay

Date: 2026-10-10. Scope: the audit fixes to `apps/api/src/modules/pattern-recognition` and its consumers.

**Status of the evidence: stored `candlestick-v1` rows are superseded; `candlestick-v2` /
`price-action-v3` rows do not exist until the re-detection below is run. The audit verdict stands:
pattern output has no demonstrated edge, so its weight stays zero until outcomes are re-measured on
v2 evidence.**

## Versions

| Layer | Written now | Superseded (never read by current consumers) |
| --- | --- | --- |
| Candlestick | `candlestick-v2` | `candlestick-v1` |
| Price action + chart patterns | `price-action-v3` (`price-action-v3-atr` for the explicit `--threshold-mode atr` research variant) | `price-action-v1`, `price-action-v2` |

Constants live in `domain/market-pattern.ts`. Migration 132 inserts the v2 `pattern_definitions`
rows and marks the v1 rows superseded (`superseded_at`, `superseded_by_version`); it deletes nothing.
`price_action_events` has no definitions table, so its superseded versions are recorded in code only.

## Rule changes behind the version bumps

- **Sessions.** Intraday series (< 1 day) are cut at the IST session date before every engine runs, so
  no pattern can use a previous session's bar. Daily is one series, unchanged.
- **No-trade bars.** A flat zero-volume bar (`high == low`, `volume == 0`) is suppressed everywhere. A
  zero-volume bar in a segment that otherwise reports volume is suppressed too. Feeds that never report
  volume (OANDA FX, DXY, INDIAVIX) are not silenced by this.
- **DOJI.** Range must exceed two ticks (instrument tick size, NSE default 0.05). `confidence` is a
  heuristic strength (`1 - bodyRatio`, always >= 0.9 for a doji), not a probability; rows say so in
  `details.confidenceKind`.
- **Prior trend.** Candlestick trend-dependent patterns use a 12-bar lookback on intraday
  (`intradayTrendLookback`) instead of 3; daily keeps 3.
- **Piercing Line / Dark Cloud Cover.** Must open beyond the prior low / high, as their descriptions
  always said.
- **Price action unit.** ATR units on intraday, percent on daily; each event records `thresholdMode`.
- **Chart patterns.** Breakouts must arrive within `breakoutWindowMultiplier` (3) x the pattern width
  of the last pivot, never spanning sessions; `wedgeMinTotalPivots` and `flagMinBars` are enforced; a
  flag channel excludes the pole-end pivot; head-and-shoulders is void after a new extreme beyond the
  head; a triangle that breaks the wrong way first is void.

## known_at (point-in-time)

`pattern_detections.known_at` and `price_action_events.known_at` (migration 133) hold the close time of
the candle the row is stored on: the earliest moment it could be known (last bar for multi-bar
patterns, confirmation bar for swings and chart patterns). A trigger fills it on insert and a second
keeps the earliest value on update, so upserts that re-detect a row never move it later. Existing rows
are backfilled with the same definition, which is optimistic for rows written long after their bar.

**Replay and backtest reads must filter on `known_at <= as_of`, not `detected_at`.** `detected_at` is a
most-recent-write field. The market-context and backtest repositories are outside this change and still
need that switch.

## Re-detecting v2 from scratch (not run)

Prerequisite: the build containing migration 133 is deployed and applied (the migration is registered by
the parent in `migrations/index.ts` as `candlestickV2PatternDefinitionsMigration`).

1. List the pairs that have v1 rows (read-only query is in the header of the script).
2. For each pair, from the repo root, with **no `--from`** so the whole history is evaluated:

   ```powershell
   npm run analysis:detect-patterns -- --instrument <SYMBOL> --timeframe <TF>
   ```

   or run `scripts/redetect-candlestick-v2.ps1 -Pairs "SYMBOL:TF,..." -Execute` (dry run without `-Execute`).

The CLI resolves NSE instruments only; pairs on other exchanges are not covered. Do not pass
`--threshold-mode` for the standard run. New rows sit next to the old ones (the upsert key includes the
algorithm version) and `candle_feature_coverage` is stamped for the v2 versions.

## Consumers that still name old versions

Strategy versions are frozen and registered, so their default version strings were deliberately not
changed: `momentum-scalp-pattern-strategy` still defaults to `candlestick-v1` / `price-action-v2`. Until a
new strategy version is registered with v2 names, it reads nothing from the new evidence. That is the
intended fail-closed behaviour, but it is a decision for the owner of those registrations.
