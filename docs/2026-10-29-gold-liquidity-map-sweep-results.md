# Gold liquidity map sweep: results (FAIL, no edge from this form)

Run once on 2026-10-29. Nothing was re-tuned. Frozen by `2026-10-29-gold-liquidity-map-sweep-preregistration.md` (commit `9fb605d2`) and run with `research-scripts/2026-10-29-gold-liquidity-map-sweep.py` (commit `44d20f1c`, pushed before the first run).

## Verdict

**FAIL.** The floor was met (668 trades on 578 days), and every result condition failed.

| Pre-registered condition | Result |
|---|---|
| Gross mean > 0 | no: -1.27 bps |
| 95% day-clustered interval excludes zero | no: [-3.52, +0.99] |
| Placebo share < 0.05 | no: 0.825 (82.5% of 600 time-shifts did at least as well) |
| Mean after the $0.60 per ounce cost > 0 | no: -4.26 bps (cost averages about 2.99 bps) |
| Floor of 300 trades on 150 days | met |
| Replication window gross mean > 0 | no: -2.42 bps, interval [-11.89, +5.87], 134 trades on 114 days |

Recorded as "no edge from this form of the liquidity map", as the document's failure handling requires.

## What the checks add (none can rescue a failure)

- **Named levels are not special.** The trailing 6-hour extreme control gave -0.77 bps, interval [-2.00, +0.45], on 2,306 trades.
- **Following the sweep does not work either.** The same events traded the other way give +1.27 bps gross, interval [-0.99, +3.47], and -1.72 bps after cost.
- **Stacking levels cannot be told apart.** Stack 2 and above had 23 trades, -4.19 bps, interval [-15.92, +6.03]; the difference from stack 1 is -3.02 bps, interval [-16.02, +7.37]. With 23 trades this says nothing either way.
- **Level types:** Asian 436 trades -1.58 bps; previous day 165 trades +1.40; previous week 44 trades -6.67; mixed 23 trades -4.19. No interval excludes zero.
- **No stable sign.** Years alternate between positive and negative gross (2020 -4.22, 2021 +1.39, 2022 -3.73, 2023 +0.17, 2024 +1.34, 2025 -5.15, 2026 -0.94), and every net figure is negative. Every sensitivity setting (penetration 2 and 5 bps, hold 6 and 24 bars, long and short, hour blocks, US summer and winter) is net negative.

## Reading

The upper end of the primary interval, about +1 bps gross, is below the assumed cost (about 3 bps averaged over the window, about 1.3 bps in 2025 and 2026 because gold's price more than doubled). So an edge worth trading from fading these sweeps at a one-hour horizon is ruled out for this definition of the levels, the sweep and the hold.

The replication window is too small to say anything about the recent, cheaper-cost years: its interval runs from -11.89 to +5.87 bps.

## Limits

- The cost is an assumption: the stored candles have no bid or ask and the repository has no gold cost model.
- Not tested: sweeps after 15:30 UTC (the New York afternoon), equal highs and lows, order-book liquidity, stop and target exits, NIFTY and BANKNIFTY.
- Diagnostics: 24 Asian sessions were built from fewer than 60 of 72 bars, and 2 daily and 1 weekly level from thin sessions. These are too few to matter.
- Day-clustering reduces but does not remove dependence between trades. Intervals on small groups (stack, level type, replication) are unreliable.
- A statistical test of the market, not a trading recommendation.

## Provenance

- Data: `XAU_USD` 5m, OANDA, completed bars from 2020-01-01 23:00 UTC to 2026-10-28 23:55 UTC, 477,312 rows, exported with the query in the script header. CSV sha256 `ed8520c0ae1d1fe2da930c6fdb58df6b3ee62251482153f97b32cb303c3fc9df`.
- Script: blob in commit `44d20f1c`, sha256 `d8b6b0bc9ae26381718466e57b1cfe05516ac1a36b1cd5e18a1f2ea717e57325`. Run as `python -I <script> xau_5m.csv`, seed 20261029.
- Before the run the script passed its own self-test (unit checks, an independent bar-by-bar cross-check of the level and sweep logic, and a synthetic end-to-end run). The self-test touches no market data.

## Full output

```
bars 477312  first 2020-01-01T23:00:00.000000000  last 2026-10-28T23:55:00.000000000
  diagnostic: asian sessions built from fewer than 60 of 72 bars: 24
  diagnostic: daily levels built from a thin session/week: 2
  diagnostic: weekly levels built from a thin session/week: 1

== Stage 1: counts (no returns are read) ==
  levels built: A 3524, D 3524, W 712
  sweep events (any time): 1101;  in window with consecutive bars: 832
  primary trades 668 on 578 days;  replication trades 134 on 114 days
  primary trades by type: {'A': 436, 'D': 165, 'W': 44, 'mixed': 23}  by stack: {1: 645, 2: 23}
  primary trades by year: {2020: 122, 2021: 122, 2022: 110, 2023: 124, 2024: 114, 2025: 76}
  floor (300 trades on 150 days): MET

== Stage 2: primary test (2020-01-01 .. 2025-10-31) ==
  all events                         n=  668 days= 578  gross   -1.27 bps [ -3.52, +0.99]  net   -4.26  net@2x   -7.26  ($-0.28/oz, cost 2.99 bps)
  placebo: observed mean -1.27 bps; share of 600 shifts at or above it = 0.8250
  break-even cost: $-0.28 per ounce = -1.27 bps  (assumed cost $0.60, about 2.99 bps on average)
  replication 2025-11..2026-10       n=  134 days= 114  gross   -2.42 bps [-11.89, +5.87]  net   -3.76  net@2x   -5.10  ($-1.30/oz, cost 1.34 bps)

== Pass conditions ==
  [ ] gross mean > 0
  [ ] 95% interval excludes zero
  [ ] placebo share < 0.05
  [ ] mean after $0.60 cost > 0
  [x] floor met
  [ ] replication gross mean > 0
  VERDICT: FAIL   (a pass justifies only a stop/target pre-registration and a forward paper test)

== Checks that cannot rescue a failure (primary window) ==
  control: trailing 6h extremes      n= 2306 days=1235  gross   -0.77 bps [ -2.00, +0.45]  net   -3.64  net@2x   -6.51  ($-0.18/oz, cost 2.87 bps)
  stack 1                            n=  645 days= 559  gross   -1.17 bps [ -3.47, +1.17]  net   -4.16  net@2x   -7.15  ($-0.26/oz, cost 2.99 bps)
  stack >= 2                         n=   23 days=  23  gross   -4.19 bps [-15.92, +6.03]  net   -7.29  net@2x  -10.39  ($-0.94/oz, cost 3.10 bps)
  stack >= 2 minus stack 1             -3.02 bps  [-16.02, +7.37]
  type A only                        n=  436 days= 411  gross   -1.58 bps [ -4.18, +0.90]  net   -4.57  net@2x   -7.56  ($-0.29/oz, cost 2.99 bps)
  type D only                        n=  165 days= 164  gross   +1.40 bps [ -3.90, +6.51]  net   -1.56  net@2x   -4.52  ($+0.12/oz, cost 2.96 bps)
  type W only                        n=   44 days=  44  gross   -6.67 bps [-17.64, +4.36]  net   -9.76  net@2x  -12.84  ($-1.41/oz, cost 3.08 bps)
  type mixed (stack >= 2)            n=   23 days=  23  gross   -4.19 bps [-16.18, +5.74]  net   -7.29  net@2x  -10.39  ($-0.94/oz, cost 3.10 bps)
  continuation (same events, reversed) n=  668 days= 578  gross   +1.27 bps [ -0.99, +3.47]  net   -1.72  net@2x   -4.71  ($+0.28/oz, cost 2.99 bps)
  -- halves and years
  2020-2022                          n=  354 days= 303  gross   -2.13 bps [ -5.30, +1.03]  net   -5.49  net@2x   -8.86  ($-0.36/oz, cost 3.36 bps)
  2023-2025-10                       n=  314 days= 275  gross   -0.30 bps [ -3.49, +3.02]  net   -2.88  net@2x   -5.46  ($-0.19/oz, cost 2.58 bps)
  year 2020                          n=  122 days=  99  gross   -4.22 bps [-10.51, +1.91]  net   -7.63  net@2x  -11.04  ($-0.74/oz, cost 3.41 bps)
  year 2021                          n=  122 days= 111  gross   +1.39 bps [ -3.30, +5.96]  net   -1.95  net@2x   -5.29  ($+0.26/oz, cost 3.34 bps)
  year 2022                          n=  110 days=  93  gross   -3.73 bps [ -8.74, +1.25]  net   -7.06  net@2x  -10.39  ($-0.64/oz, cost 3.33 bps)
  year 2023                          n=  124 days= 107  gross   +0.17 bps [ -4.81, +4.95]  net   -2.92  net@2x   -6.02  ($+0.04/oz, cost 3.09 bps)
  year 2024                          n=  114 days=  99  gross   +1.34 bps [ -4.08, +6.69]  net   -1.17  net@2x   -3.68  ($+0.34/oz, cost 2.51 bps)
  year 2025                          n=   94 days=  86  gross   -5.15 bps [-11.76, +1.38]  net   -6.91  net@2x   -8.66  ($-2.11/oz, cost 1.75 bps)
  year 2026                          n=  116 days=  97  gross   -0.94 bps [-12.28, +8.79]  net   -2.27  net@2x   -3.60  ($-0.69/oz, cost 1.33 bps)
  -- sensitivity
  min penetration 2 bps              n=  822 days= 680  gross   -0.87 bps [ -2.91, +1.04]  net   -3.87  net@2x   -6.86  ($-0.20/oz, cost 3.00 bps)
  min penetration 5 bps              n=  438 days= 402  gross   -0.80 bps [ -3.70, +2.12]  net   -3.83  net@2x   -6.85  ($-0.29/oz, cost 3.02 bps)
  hold 6 bars                        n=  678 days= 579  gross   -0.64 bps [ -2.36, +1.06]  net   -3.64  net@2x   -6.64  ($-0.17/oz, cost 3.00 bps)
  hold 24 bars                       n=  648 days= 577  gross   -2.26 bps [ -5.58, +1.12]  net   -5.26  net@2x   -8.25  ($-0.44/oz, cost 2.99 bps)
  short only                         n=  313 days= 302  gross   -3.07 bps [ -6.36, +0.27]  net   -6.03  net@2x   -8.99  ($-0.64/oz, cost 2.96 bps)
  long only                          n=  355 days= 328  gross   +0.31 bps [ -2.94, +3.53]  net   -2.71  net@2x   -5.73  ($+0.03/oz, cost 3.02 bps)
  03:30-07:00 UTC                    n=  154 days= 151  gross   -3.24 bps [ -6.60, +0.20]  net   -6.18  net@2x   -9.12  ($-0.73/oz, cost 2.94 bps)
  07:00-12:00 UTC                    n=  241 days= 232  gross   -0.87 bps [ -4.16, +2.37]  net   -3.87  net@2x   -6.86  ($-0.08/oz, cost 2.99 bps)
  12:00-15:30 UTC                    n=  273 days= 262  gross   -0.51 bps [ -4.77, +3.61]  net   -3.54  net@2x   -6.56  ($-0.21/oz, cost 3.02 bps)
  US summer time                     n=  482 days= 417  gross   -0.60 bps [ -3.31, +2.05]  net   -3.56  net@2x   -6.51  ($-0.20/oz, cost 2.95 bps)
  US winter time                     n=  186 days= 161  gross   -3.00 bps [ -7.60, +1.38]  net   -6.10  net@2x   -9.20  ($-0.50/oz, cost 3.10 bps)
```
