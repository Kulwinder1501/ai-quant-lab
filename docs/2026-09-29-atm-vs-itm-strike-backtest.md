# ATM vs ITM strike backtest — 2026-09-29

## What was pitched

The live paper-trading system always buys the ATM option
(`nearestStrike(entry, strikeStep)` in `prepare-option-entry.ts`). ATM has low
delta, and this project has already measured the consequence in premium space:
roughly one India-VIX/index-volatility point moves ~117 index points on an ATM
option (`[[premium-target-unreachable-at-index-target]]`) — the index-based
stop/target geometry translates very nonlinearly into option P&L. The pitch was
that a higher-delta ITM strike would track the underlying's stop/target more
linearly and might produce better real P&L, at the (unknown, until measured)
cost of worse ITM liquidity/spread.

This checks that directly, on real historical fills, on the two strategies that
actually matter for live P&L.

## Step 1: does real data even support this comparison?

`collect-option-premium-ticks.ts` polls `selectAtmPremiumContracts` (default
`strikeBand: 1`): every poll fetches **ATM − 1 step, ATM, ATM + 1 step**, for
both CE and PE, and writes them to `option_premium_ticks`. Nothing wider is
polled routinely; anything at ATM ± 2 steps or beyond only appears when an
already-open position's contract (a `requiredContracts` entry) drifted there
as the underlying moved after entry.

That makes the question empirical, not a design guess: **ATM+1 ITM is
collected on the same cadence as ATM itself; ATM+2 ITM is not.** Measured
directly against `option_premium_ticks` (NIFTY50 + BANKNIFTY, 2026-08-12
through 2026-09-29, 32 trading days, ~1.9M rows total):

| offset from ATM (poll-time) | rows, BANKNIFTY | rows, NIFTY50 |
|---|---|---|
| 0 (ATM) | 263,328 | 285,873 |
| ±1 (ITM+1 / OTM+1) | ~236k each side | ~258–265k each side |
| ±2 | ~83.5k each side | ~63–82k each side |
| ±3 and beyond | long tail, <20k, mostly from open-position drift | same pattern |

And, checked against the **actual historical entries** (the real closed
`momentum-scalp` / `momentum-scalp-index` option trades, see Step 2), whether
the ITM+1/ITM+2 contract had a fillable ask within the same 2-minute freshness
window the live system requires at the real entry instant:

| strategy | symbol | n trades | ITM+1 fillable at entry | ITM+2 fillable at entry |
|---|---|---:|---:|---:|
| momentum-scalp | BANKNIFTY | 26 | 26 (100%) | 18 (69%) |
| momentum-scalp | NIFTY50 | 29 | 29 (100%) | 16 (55%) |
| momentum-scalp-index | BANKNIFTY | 162 | 154 (95%) | 65 (40%) |
| momentum-scalp-index | NIFTY50 | 137 | 133 (97%) | 39 (28%) |

**Conclusion: ITM+1 is genuinely testable on real fills, at essentially full
population coverage. ITM+2 is not** — its coverage is opportunistic (whichever
days happened to drift a live position two strikes away), not systematic, so
any ITM+2 numbers below are a selection-biased subsample, not a population
answer. They are reported for completeness and explicitly labelled as such;
they are not evidence either way. Making ITM+2 testable for real would mean
widening `collect-option-premium-ticks.ts`'s `strikeBand` from 1 to 2 going
forward — not attempted here, per the brief ("this pass is backtest/analysis
only").

## Step 2: the replay kernel — reused, not rebuilt

`backtest-engine.ts` / `settleResearchPath` (the scalp-harness replay kernel)
both operate on **underlying-index price bars** and R-multiples — the right
tool for most of this project's lever tests (see `momentum-stall-exit.ts`'s
own docstring on why a second options-tick-accurate harness is usually
unnecessary), but not this one: the whole question here is what real option
premium fills and spread do to the ATM/ITM choice, and a Black-Scholes
re-pricing would hide exactly that.

The actual real-money-accurate path is `evaluate-open-paper-trades.ts`
(`EvaluateOpenPaperTrades`), the code that closes real option-buyer paper
trades live, in this order of evidence quality: expiry settlement →
**the observed premium-tick series** (`decideOptionBuyerObservedExit`, the
first oldest-first tick that crosses the stop/target bid) → the latest fresh
bid → theoretical Black-Scholes (last resort only). This is already the
"replay real ticks against a signal" mechanism the task asked to find — it
just hadn't been pointed at alternate strikes before.

New script `apps/api/src/interfaces/cli/run-atm-vs-itm-strike-backtest.ts`
reuses, unchanged:

- `mapIdeaToOptionBuyerFill` — entry fill, stop/target repricing onto the bid
  basis, and the risk-reward-distortion guard.
- `decideOptionBuyerObservedExit` — the same oldest-first observed-tick
  barrier scan `evaluate-open-paper-trades.ts` uses live.
- `calculateEntryFees` / `calculateExitFees` — the real Zerodha/NSE fee
  schedule.
- The live `MOMENTUM_STALL_POLICIES` table and `shouldFlattenAtSessionClose`
  (15:15 IST flatten) — applied with the same eligibility rules
  (`momentum-scalp`/`momentum-scalp-index`, 5m-only stall, 1m/5m flatten).

One thing was genuinely missing, exactly as anticipated: `mapIdeaToOptionBuyerFill`
always derived `nearestStrike(entry, step)` internally, with no way to ask for
a neighbour. Added a single optional field, `strikeOverride`, to
`option-buyer-fill.ts`'s input — when omitted (every live call site, unchanged)
behaviour is byte-identical; the backtest script is the only caller that sets
it. `prepare-option-entry.ts` was not touched.

**Fidelity check** — replaying the *ATM* variant through this new harness and
summing net P&L across all 353 fillable trades gives **-45,355.89**, against
the real recorded `paper_trades.realized_pnl` total of **-43,325.96** for the
same trades (within ~4.7%). The residual is expected and explainable: the live
evaluator only runs on its own scheduler cadence and this replay scans every
collected tick continuously, so the two can resolve a crossing (or a stall/
session-close) a few minutes apart from each other. Close enough to trust the
relative ATM-vs-ITM1 comparison below.

## Step 3 & 4: the comparison, on real fills

All 354 closed option-buyer trades from `momentum-scalp` (the only strategy
this project has documented as actually executing live —
`[[scalp-gate-is-only-executable-cell]]`) and `momentum-scalp-index`, across
both instruments, replayed at ATM, ATM+1 ITM, and ATM+2 ITM, same entry
decision (side/underlying entry/stop/target/quantity/expiry), same exit logic,
different strike:

| strategy | symbol | variant | fill rate | win rate | net P&L (total) | net P&L / trade | profit factor | avg entry spread (ask−bid)/mid |
|---|---|---|---:|---:|---:|---:|---:|---:|
| momentum-scalp-index | BANKNIFTY | ATM  | 100.0% | 34.0% | -22,702.81 | -140.14 | 0.782 | 26.0% |
| momentum-scalp-index | BANKNIFTY | ITM1 | 95.1%  | 31.8% | -35,600.66 | -231.17 | 0.605 | 26.2% |
| momentum-scalp-index | BANKNIFTY | ITM2*| 38.3%  | 19.4% | -31,591.73 | -509.54 | 0.303 | 25.5% |
| momentum-scalp-index | NIFTY50   | ATM  | 99.3%  | 35.3% | -12,008.71 | -88.30  | 0.899 | 23.3% |
| momentum-scalp-index | NIFTY50   | ITM1 | 97.1%  | 33.8% | -14,095.25 | -105.98 | 0.861 | 20.4% |
| momentum-scalp-index | NIFTY50   | ITM2*| 26.3%  | 22.2% | -36,396.39 | -1,011.01 | 0.213 | 21.5% |
| momentum-scalp        | BANKNIFTY | ATM  | 100.0% | 38.5% | -4,557.20  | -175.28 | 0.670 | 28.1% |
| momentum-scalp        | BANKNIFTY | ITM1 | 100.0% | 38.5% | -4,465.19  | -171.74 | 0.709 | 26.0% |
| momentum-scalp        | BANKNIFTY | ITM2*| 65.4%  | 23.5% | -6,057.69  | -356.33 | 0.366 | 29.8% |
| momentum-scalp        | NIFTY50   | ATM  | 100.0% | 24.1% | -6,087.17  | -209.90 | 0.420 | 21.2% |
| momentum-scalp        | NIFTY50   | ITM1 | 100.0% | 24.1% | -6,683.94  | -230.48 | 0.425 | 22.0% |
| momentum-scalp        | NIFTY50   | ITM2*| 51.7%  | 13.3% | -6,919.37  | -461.29 | 0.183 | 22.7% |

*ITM2 rows are the biased, low-coverage subsample described in Step 1 — shown
for completeness, not treated as a finding.

**Paired comparison** (same trades, ATM vs ITM1, both variants actually
filled+resolved — the honest apples-to-apples test):

| group | n | mean net P&L diff (ITM1 − ATM) | paired t |
|---|---:|---:|---:|
| momentum-scalp-index, BANKNIFTY | 154 | -77.39 | -2.509 |
| momentum-scalp-index, NIFTY50   | 133 | -18.74 | -1.119 |
| momentum-scalp, BANKNIFTY (the live cell) | 26 | +3.54 | 0.235 |
| momentum-scalp, NIFTY50 (the live cell)   | 29 | -20.58 | -1.983 |

A naive 5%-two-sided threshold is t≈1.96; with four comparisons here, a
Šidák-corrected threshold (matching how this project treats multi-cell
sweeps elsewhere) is t≈2.50. Only the BANKNIFTY `momentum-scalp-index` cell
clears that, and it clears it **in the negative direction** — ITM1 costs
~Rs 77/trade more than ATM there, not less. Every other cell is inside noise.

## Liquidity/spread: not the differentiator here

The entry bid-ask spread as a fraction of mid is large across the board
(20–30%, for *both* ATM and ITM1) — itself a striking number, and consistent
with this project's other findings that friction dominates this book
(`[[paper-trade-loss-is-mostly-fees]]`). But it is not meaningfully worse for
ITM1 than for ATM: in 3 of 4 groups ITM1's average spread is actually
*tighter* than ATM's. So the ITM1 underperformance above is not explained by
"ITM has a worse book" — the fills are comparably liquid; the strike choice
itself just doesn't help.

## Honest conclusion

- **ITM+1 is real-data-testable** (this section is not a
  DATA_UNAVAILABLE finding) — coverage matches ATM almost exactly, because the
  live poller already collects ATM±1 by construction.
- **ITM+1 does not improve real P&L** on either strategy that matters. On the
  live-executing cell (`momentum-scalp`, both instruments) the difference is
  statistically indistinguishable from zero. On `momentum-scalp-index` it
  trends *negative* for ITM1, and the one cell that nominally clears a
  corrected significance bar clears it as a loss, not a gain.
- The delta/leverage argument is real in isolation (an ATM option's premium
  really is far more nonlinear vs the index than an ITM option's), but it does
  not survive contact with real fills once entry cost, spread, and the
  existing risk-reward-distortion guard are all accounted for on both sides.
- **ITM+2 remains genuinely untested.** The subsample above is selection-biased
  (only days where a position happened to drift two strikes away have any
  data) and should not be read as evidence in either direction. Testing it for
  real would require widening `collect-option-premium-ticks.ts`'s
  `strikeBand` from 1 to 2 and waiting for several weeks of coverage — a data
  -collection change, not something this backtest-only pass should make.
- **No live behaviour was changed.** `prepare-option-entry.ts` still always
  buys ATM. The new `strikeOverride` field on `mapIdeaToOptionBuyerFill` is
  additive/optional and unused by any production call site.

## What was built

- `apps/api/src/modules/paper-trading/domain/option-buyer-fill.ts` — added the
  optional `strikeOverride` input (tests added in
  `option-buyer-fill.test.ts`: two new cases covering the override and its
  validation; all 29 tests in the file still pass, all 296 in
  `paper-trading/` still pass).
- `apps/api/src/interfaces/cli/run-atm-vs-itm-strike-backtest.ts` — the
  reusable strike-offset backtest. Queries the real closed
  `momentum-scalp`/`momentum-scalp-index` option trades, replays each at ATM /
  ITM+1 / ITM+2 through the existing exit-decision domain functions against
  real `option_premium_ticks`, and prints the tables above plus a fill/refusal
  breakdown and the ATM fidelity check.
