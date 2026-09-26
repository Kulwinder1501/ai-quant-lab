# AutoBot-Scalp1m relative-volume confirmation — falsification program v1

**Registered 2026-09-16, before any measurement of a volume filter.** Nothing below may be revised
after a result is seen. If the design turns out to be wrong, this document gets a dated amendment
saying so and the run is discarded, not re-scored.

## Why this exists

This is the last untested entry-side lever from the original four-hypothesis list for
`momentum-scalp`/1m on `AutoBot-Scalp1m`. The other three are closed: pattern gating made it worse
([[patterns-make-scalping-worse]]), time-of-day gating separates nothing
([[scalp1m-time-of-day-gate-no-edge]]), and the fourth (HTF exit conditioning) is exploratory
infrastructure, not a quick test. Chop filters on price-derived features have already failed five
times over ([[chop-filter-candidates-refuted]], [[scalp-signal-inversion-does-not-replicate]],
[[stall-rule-on-1m-is-a-time-stop]]) — every one of those reads the price series differently. RVOL
is mechanistically different: it reads *participation*, not price shape, which is the actual reason
to expect it might separate something the other five could not.

**Expected outcome, given that prior, is still NO_EDGE** — five failures on the same signal family
is a strong base rate against a sixth working. Registering before measuring is what keeps a
positive-looking number honest either way.

**Data check, done before registering the configs below:** NIFTY50 and BANKNIFTY 1m candles carry
real, non-constant volume (3,621 of 4,477 bars nonzero since 2026-09-01; mean ~437k BANKNIFTY,
~608k NIFTY50) — the "no intraday volume" constraint in [[scalp-blocked-by-missing-volume]] is
stale for this instrument/timeframe as of today. This is index-level constituent-aggregate volume,
not real order flow ([[index-volume-is-constituent-aggregate]]) — a real, tradeable signal if
present, but not the same thing as institutional order-book participation.

## What gets built

`RelativeVolumeFilteredStrategy` in `entry-filters.ts`, same decorator pattern as the existing
filters: admits a bar only when its own volume is at least `multiple` times the mean of the prior
`lookback` bars, keyed per instrument+timeframe series. The baseline is built from bars strictly
before the signal bar — the signal bar's own volume never enters its own denominator, which would
mechanically inflate the ratio on exactly the bars a real breakout would want admitted. Fail-closed
below `lookback` bars of history, matching `EmaStrengthFilteredStrategy`. Wired into `run-backtest.ts`
as `--entry-filter rvol-<config>`, default-off; nothing here touches the live bot.

## Configs, fixed now, before measurement

Three, chosen to bound sensitivity without becoming a search:

- **Config 1 — RVOL-1.5x20 (the originally proposed configuration).** 1.5x the trailing 20-bar mean
  volume.
- **Config 2 — RVOL-2.0x20.** Stricter multiple, same lookback — in case 1.5x is too weak a bar to
  separate real participation from noise.
- **Config 3 — RVOL-1.5x10.** Same multiple, shorter lookback — in case a 20-bar (20-minute) window
  is too slow-moving to be a locally relevant baseline at 1m.

No other multiple/lookback pair may be added or substituted after seeing a result.

## Unit of analysis

**The trade.** R is defined on the option's own premium risk, the same convention as
[[scalp1m-time-of-day-gate-no-edge]]: `R = realized_pnl / (|entry_price - stop_loss| x quantity)`
for the live cross-check; the backtest reports expectancy per trade in the underlying's own points,
same as the time-of-day program, for direct comparability to it. Standard errors are clustered by
session (IST calendar date), pooled across both instruments on the same day.

## Decision rule

A config passes only by clearing **all four** gates, mirroring
[[scalp1m-time-of-day-gate-no-edge]] and the ICT falsification program:

- **Gate 1 — sign replication.** Mean expectancy inside the RVOL-admitted population is positive on
  **both** NIFTY50 and BANKNIFTY independently.
- **Gate 2 — noise floor.** Session-clustered t > 2.0 on the admitted population, Bonferroni-corrected
  for 3 configurations.
- **Gate 3 — paired delta, done on the control's own trades.** Split the control (unfiltered)
  backtest population by whether each trade's own signal-bar volume would have cleared the
  threshold, same bars, no separate run. The admitted-population mean must exceed the rejected
  population's mean by more than either standard error.
- **Gate 4 — population-shrink ambiguity.** A config that raises mean expectancy while cutting trade
  count by more than half is reported as ambiguous, not a pass — the same rule that already applies
  to the chop filters and the ICT killzone arm.

## Pre-committed threats to validity

- Index volume is a constituent aggregate, not real order flow — a pass here would be a real,
  tradeable finding, but should not be read as confirming an "institutional participation" causal
  story; it would need its own follow-up to say more than "volume-weighted entries do better here."
- Same same-bar settlement ambiguity as [[scalp1m-time-of-day-gate-no-edge]]'s Amendment 1 applies:
  the raw backtest win rate will likely be far lower than the live account's, for the same
  `CONSERVATIVE_STOP_FIRST` / tight-ATR-geometry reason, not a new defect. Read this program's
  numbers against each other, not against the live account's scale.
- RVOL and volatility are correlated; a volume spike often coincides with a volatility spike, so a
  positive result here could be re-discovering the same ATR/EMA-strength story under a different
  name rather than a genuinely new mechanism. Not disentangled by this program.

## Stopping condition

If no config clears all four gates, the verdict is recorded as **NO_VIABLE_VOLUME_FILTER** and
`momentum-scalp` keeps taking every signal on `AutoBot-Scalp1m` regardless of volume, unchanged.
`RelativeVolumeFilteredStrategy` stays in the tree, default-off, with the measurement attached.

## Results

Executed 2026-09-16, same day as registration. Backtest: `momentum-scalp@6`, 1m, both instruments,
2026-08-01..09-15, quantity 1, ₹20/order, 2bps slippage, `initial-capital` 1,000,000. 19 new unit
tests, `tsc --noEmit` clean, full suite 2709/2767 passed (58 pre-existing skips).

| config | NIFTY50 trades | NIFTY50 wins | NIFTY50 expectancy | BANKNIFTY trades | BANKNIFTY wins | BANKNIFTY expectancy |
|---|--:|--:|--:|--:|--:|--:|
| control (none) | 279 | 0 | -49.03 | 313 | 5 | -62.67 |
| 1 — RVOL 1.5x/20 | 85 | 0 | -49.47 | 107 | 1 | -65.49 |
| 2 — RVOL 2.0x/20 | 36 | 0 | -50.13 | 61 | 1 | -67.30 |
| 3 — RVOL 1.5x/10 | 84 | 0 | -48.51 | 108 | 2 | -63.73 |

Every config on every instrument stays deeply negative, none comes close to zero let alone positive,
and — notably — expectancy does not improve under any config; on BANKNIFTY it gets measurably worse
(-62.67 -> -65.49/-67.30/-63.73) while the population shrinks by 65-80%. NIFTY50 stays flat within
noise. Requiring a volume-confirmed breakout does not admit a better-quality subset of trades; it
mostly just admits fewer of the same population, at the same or worse expectancy.

### Verdict

**NO_VIABLE_VOLUME_FILTER.**

- Gate 1 (sign replication) — failed by every config on both instruments. Never positive.
- Gate 4 (population-shrink ambiguity) — this is the gate that actually resolves it: population
  drops 61-87% under every config while expectancy does not rise (BANKNIFTY: falls further). A
  filter that shrinks the population without ever improving it fails outright rather than landing
  in the "ambiguous" bucket that gate exists for.
- Gates 2 and 3 were not reached — there is no positive or improved cell for them to test the
  significance or the pairing of.

This closes the last of the four originally proposed hypotheses. `momentum-scalp` keeps taking
every RVOL level on `AutoBot-Scalp1m`, unchanged. `RelativeVolumeFilteredStrategy` stays in the
tree, default-off, with this measurement attached. Combined with
[[scalp1m-time-of-day-gate-no-edge]], every tested lever — pattern, chop, inversion, holding time,
time-of-day, and now volume confirmation — has failed to separate this signal's winners from its
losers. The exit-geometry program (`PATH_STUDY_V2`) remains the one structurally different avenue
still open, already running, currently at 12-14 of the 20 sessions its own G1 gate requires before
target geometry becomes eligible for any change.
