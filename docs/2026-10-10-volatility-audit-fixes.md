# 2026-10-10 volatility audit fixes: what changed, and what still has to be run by hand

Nothing in this change touched stored data. Every statement below that mutates data is a
command for a person to run deliberately; none was run.

## 1. Straddle gate: two clocks (HIGH)

`volatility-straddle.ts` priced the implied move on a **calendar** horizon while the gate compares it
with a **trading-time** forecast. A 75-minute horizon was 75/525,600 of a year instead of
75/94,500 (375 min x 252 sessions), understating the implied move by sqrt(525600/94500) = 2.36x
and making the gate 2.36x too easy to pass (NIFTY 23,400 at 13% IV: 36.3 points vs 85.7).

The two clocks are now distinct branded types, `TradingYears` and `CalendarYears`, and the
proposer takes both (`tradingHorizonYears`, `calendarHorizonYears`):

| Quantity | Clock |
|---|---|
| Implied move `spot * IV * sqrt(t)` | trading (`minutes * bars / (375 * 252)`; a daily bar is 1/252) |
| Theta decay, time to expiry, tenor ratio | calendar |

Refusal messages print trading minutes. The tenor-ratio comment says what it is: nominal, and it
overstates the penalty when the horizon crosses the close.

## 2. Frozen holiday bars poison ATR (HIGH)

A bar with `high == low && volume == 0` is a frozen-feed print, not a trade. The conjunction
matters: an index legitimately has volume 0. `isFlatBar` (`market-data/domain/flat-bar.ts`) is the single
definition, and a missing volume is never treated as zero.

- `technical-indicator-engine.ts`: ATR, Bollinger Bands and Supertrend run on live bars only, and
  no snapshot is written where more than 50% of the raw trailing window is flat.
- `atrSeries` and `IctAtrTracker` (the only other own-ATR computations in the API) skip flat bars.
- First bar of a session: its true range uses the prior close. That is intentional and kept.

**Known cost.** Dropping a legitimately flat 1m index bar biases ATR up by roughly the flat share
(about 2% for NIFTY50 1m, see counts below). The 50% window guard stops a collapse; it does not remove
this small upward bias. Accepted: the opposite error (ATR near zero on a holiday) is worse.

### Stored snapshots written before this change

The recompute **only upserts**. Snapshots that sit on a flat candle keep their stale values unless
deleted, because the engine now writes nothing for them.

**Step 1 -- list the affected snapshots (read-only).** Run through psql, or pipe it into the
scheduler container's Python as the other read-only checks do.

```sql
-- READ ONLY. Affected indicator snapshots: ATR / Bollinger / Supertrend rows on a frozen candle.
SELECT i.symbol,
       c.timeframe,
       d.indicator_code,
       c.close_time AT TIME ZONE 'Asia/Kolkata' AS close_time_ist,
       s.id AS snapshot_id
FROM indicator_snapshots s
JOIN candles c               ON c.id = s.candle_id
JOIN instruments i           ON i.id = c.instrument_id
JOIN indicator_definitions d ON d.id = s.indicator_definition_id
WHERE d.indicator_code IN ('ATR', 'BOLLINGER_BANDS', 'SUPERTREND')
  AND c.high = c.low
  AND c.volume = 0
ORDER BY i.symbol, c.timeframe, d.indicator_code, c.close_time;

-- Counts per instrument / timeframe / indicator:
-- same query, replace the select list with  i.symbol, c.timeframe, d.indicator_code, count(*)
-- and add  GROUP BY 1, 2, 3  (drop the ORDER BY close_time).
```

Counts seen on 2026-10-10 (rows per indicator): BANKBEES 5m 3,736 (to 2025-10-21), BANKBEES 1m
1,055 (to 2026-08-14), NIFTY50 1m 929 (from 2026-08-05), BANKNIFTY 1m 920 (from 2026-08-07); BANKNIFTY 5m 113, 15m 23, 30m 12 and
60m 6 on the earlier tally. Not every flat bar is a holiday: 1m index bars can be genuinely flat, which
is why Step 2 is optional and should be reviewed against Step 1 before running.

**Step 2 -- optional cleanup (DO NOT run automatically; review Step 1 first).**

```sql
-- DESTRUCTIVE. Wrap in a transaction, check the row count, then COMMIT or ROLLBACK.
BEGIN;
DELETE FROM indicator_snapshots s
USING candles c, indicator_definitions d
WHERE c.id = s.candle_id
  AND d.id = s.indicator_definition_id
  AND d.indicator_code IN ('ATR', 'BOLLINGER_BANDS', 'SUPERTREND')
  AND c.high = c.low
  AND c.volume = 0;
-- inspect the reported row count, then:  COMMIT;   (or ROLLBACK;)
```

**Step 3 -- recompute.** `--from` is the only bound (there is no `--to`): the whole series is
computed and `--from` limits what is written. It must reach back to the oldest snapshot you want
corrected.

```
npm run analysis:calculate-indicators -- --instrument NIFTY50  --timeframe 5m  --from 2026-08-01
npm run analysis:calculate-indicators -- --instrument NIFTY50  --timeframe 15m --from 2026-06-01
npm run analysis:calculate-indicators -- --instrument BANKNIFTY --timeframe 5m  --from 2026-08-01
npm run analysis:calculate-indicators -- --instrument BANKNIFTY --timeframe 15m --from 2026-06-01
```

Repeat for any other instrument and timeframe that Step 1 lists. Use an earlier `--from` for the
BANKBEES rows (they start in 2019 / 2023).

**Gaps the audit also found, to be closed by the same recompute** (figures as reported by the
audit; the per-instrument split was not re-derived): 144 5m ATR snapshots that differ from a fresh
calculation (2026-08), 975 missing 15m snapshots (2026-06 and 2026-07) and 270 missing 5m
snapshots. A recompute from the dates above writes the missing ones; the differing ones are
overwritten because their candles are live.

## 3. IV percentile (MEDIUM)

`market-data/domain/iv-percentile-by-tenor.ts`: rank only within the same DTE bucket (DTE_1,
DTE_2_3, DTE_4_7, DTE_8_PLUS), exclude DTE < 1, solve both sides on the same put-call-parity forward
(`atm-implied-volatility.ts`), and return `null` plus a reason below 20 distinct days in the
bucket. `dailyAtmQuotes` no longer returns an expired chain for the session day.

## 4. IV-percentile ceiling is dead code (MEDIUM): wiring for the parent

`options-entry-validator.ts` rejects at `ivPercentile >= 85`, but no caller sets
`ivPercentile` on its `OptionsValidationContext`, so the check never ran. The only production caller
is `PrepareOptionEntry` (`paper-trading/application/prepare-option-entry.ts`, the
`validateOptionsEntry({...})` call near line 658). The value is now available:

- `GET /api/v1/option-chain` returns `data.ivPercentileForValidator` (0-100, or `null`).
- Or compute it in `PrepareOptionEntry` and pass `ivPercentile` next to `hasMacroEvent`:

```ts
const history = buildTenorIvHistory(await optionChainRepository.dailyAtmQuotes({ underlyingSymbol, days: 400 }));
const atm = atmImpliedVolatility({ observedAt: validationChain.observedAt, expiryDate, quotes: validationChain.quotes });
const result = summariseTenorMatchedIvPercentile({
  history,
  current: atm.measurable ? { impliedVolatility: atm.impliedVolatility, daysToExpiry: calendarDaysToExpiry(validationChain.observedAt, expiryDate) } : null,
});
validateOptionsEntry({ /* ... existing fields ... */, ivPercentile: ivPercentileForValidator(result) });
// null leaves the validator's "unchecked" path; it never silently passes as 0.
```

`PrepareOptionEntry` needs `dailyAtmQuotes` from the option-chain repository (it already receives the chain).

## 5. India VIX as straddle IV (MEDIUM)

`ChainFirstStraddleImpliedVolatilitySource` prefers the chain's own ATM IV at the contract's
expiry (snapshot at most 20 minutes old). Otherwise it falls back to India VIX and says so:
`impliedVolatilitySource: INDIA_VIX_30D_PRIOR_CLOSE` plus a tenor warning. VIX is a 30-day, prior-close
figure. Chain ATM minus prior VIX measured live: median -1.4 vol points, p10/p90 -3.0/+1.6. The offline
`volatility_gate.py` cannot use chain IV (no historical per-expiry chain), so its output now labels the
source and carries a `limitations` list.

## 6. Expansion label baseline (MEDIUM)

NIFTY 15m h=5 expansion/stable/contraction is 13/25/62% at bar 0 and 6/16/78% at bar 4, against about
30/34/37% from bar 5 on. Two changes: trailing windows are confined to one session for intraday
bars (`SessionScopedTrailingWindow`; the first `window - 1` bars of a session are skipped as "not
full"), and the "beats trivial" baseline can be time-of-day-stratified (training-only majority per
bar of day: `time_of_day_majority_predictions`, `computeTimeOfDayBaseline`).
`requireTimeOfDayBaseline` defaults to off until the repository supplies the baseline; a baseline
that is present is always enforced.

## 7. Promotion standard error (MEDIUM)

`cost_aware_promotion_verdict(..., gated_clusters=...)` uses the one-way cluster-robust SE by trading
day. Duplicating overlapping entries no longer shrinks it (tested), one day of evidence has no SE and
fails closed, and the verdict reports `standardErrorBasis`. `volatility_gate.py` passes IST session dates.

## 8-10. Smaller items

- `yang_zhang_vol.py`: NaN for warm-up and any window with an invalid OHLC row (not 0.0);
  annualisation is `trading_periods * bars_per_session`.
- `regime.ts`: classifies `close / mean(prior 19 closes) > 1.10`, excluding the current bar.
- `iv_compression_signal_check.py`: 20-minute snapshot ceiling (shared constant), 5% relative
  spread filter (near-ATM p99 is 2.6% for indices), and a `sampleLimits` block stating the 39-day
  sample. Its write-up (`2026-09-29-iv-compression-...md`) said 60 minutes; corrected.
- `expiry_day_signal_check.py`: trading sessions are counted against `nse_holidays` (weekdays-only,
  flagged as `WEEKDAYS_ONLY_APPROXIMATION`, if that table is unavailable). `is_expiry_week` was
  removed: with weekly expiries it is true for essentially every candle.
