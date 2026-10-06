# hybrid-liquidity-confluence-v1: Pillar Fixes and Random-Subsample Validation

> **Document Type:** Defect Fix + Validation Report
> **Date:** September 28, 2026
> **Status:** Both sides disabled (`executableSides: []`) pending further validation
> **Scope:** `hybrid-liquidity-confluence-v1`, shipped 2026-09-28 in commit `8bc349f`, reviewed and fixed the same day.

---

## 1. What this strategy claimed at ship time

`hybrid-liquidity-confluence-strategy.ts` combines three "pillars" into a single gate before proposing a LONG/SHORT trade:

1. **Pillar A** -- a structural liquidity level (PDH/PDL, swing high/low, session high/low) is proximate, and L2 depth is imbalanced in the rejection direction (`DI_decay` past a threshold).
2. **Pillar B** -- raw order-flow imbalance (`raw_di`) confirms the same direction.
3. **Pillar C** -- an option-chain open-interest wall (put/call ratio) confirms the same direction.

Independent review the same day it shipped found two real defects, both fixed here.

## 2. Defect 1: Pillar A's threshold disagreed with itself

The TS code gated at `diTilde > 0.10`. The class docstring, and the standalone benchmark script (`apps/ml/run_hybrid_confluence_backtest.py`), both said `0.15`. Shipped code and its own documentation disagreed about what the strategy does.

### Sensitivity sweep (Pillar A alone, over all 172,667 level-contact events since 2026-08-01)

| Threshold | n | Win rate | Profit factor | Net R | Binomial p (vs 33.93% unfiltered baseline) |
|---|---|---|---|---|---|
| 0.10 | 14,678 | 38.36% | 0.93 | -603 | 1.64e-29 |
| 0.125 | 13,480 | 36.20% | 0.85 | -1,280 | 1.49e-08 |
| 0.15 | 12,290 | 33.65% | 0.76 | -1,950 | 0.7417 |

Reproduce with `python apps/ml/run_hybrid_confluence_backtest.py --sensitivity-sweep`.

**Finding:** performance is monotonically *worse* as the threshold tightens. 0.15 -- the value the docstring and backtest script claimed -- performs *below* the unfiltered baseline win rate (33.65% vs 33.93%) and is statistically indistinguishable from it (p=0.74). 0.10 -- the value actually shipped in code -- is the best of the three and clears significance by 28 orders of magnitude on its own (uncorrected) test.

**Resolution:** the code was right; the docstring and the backtest script's default were wrong. Both now say 0.10, with this sweep cited as the reason.

## 3. Defect 2: Pillar C was a stub that always passed

Pillar C read `priceActionEvents[].details.oiSupport` / `.oiResistance`. Nothing anywhere in the codebase ever set those fields on a price-action event -- the gate's own default (`let oiWallConfirmed = true`) was therefore the only value it could ever take. Pillar C never rejected a single proposal since the strategy shipped.

The docstring also claimed a "volatility regime" check inside Pillar C. No IV-percentile logic was ever wired to this strategy, and the reasoning string repeated the same false claim ("Option Chain Open Interest wall & volatility regime confirmed"). That claim is removed, not implemented as a stub.

### What exists, and what was wired

The codebase already has real machinery for both option-chain concepts:

- `putCallRatios()` (`apps/api/src/modules/market-data/domain/option-chain.ts`) computes OI- and volume-based PCR from a live chain quote.
- `summariseIvPercentile()` (`apps/api/src/modules/market-data/domain/iv-percentile.ts`) ranks a current IV reading against >= 20 distinct trading days of history.
- `oi_pcr_signal_check.py` already ran a leakage-audited gap analysis on whole-chain PCR + OI-change as a *direction* feature and found it **below random** (macro-F1 0.19-0.20, n=541/542 -- see project memory `gap-analysis-oi-pcr-no-edge`). That is the same underlying data source this pillar now reads, on a different task (a confirmation gate rather than a standalone direction model), so it does not by itself prove or disprove this pillar -- but it sets a real prior of skepticism, not novelty.

**PCR wall (Pillar C): wired for real.** `option_chain_snapshots` (228,326 rows, NIFTY50/BANKNIFTY from 2026-08-04 onward) supports a genuine as-of join: `PostgresStrategyMarketContextRepository.resolveOptionChainSignal` (new) resolves the nearest snapshot at or before the candle's close time, aggregates whole-chain call/put OI over the nearest un-expired expiry (same definition `oi_pcr_signal_check.py` uses), and computes `pcr = putOI / callOI`. A 60-minute staleness ceiling matches that script's own `MAXIMUM_SNAPSHOT_AGE_MINUTES`. The result is a new optional `StrategyMarketContext.optionChainSignal.pcr: number | null` field. The strategy now gates on it directly: `pcr >= 1.2` for a LONG confirmation, `pcr <= 0.8` for SHORT, and **`pcr === null` (no snapshot yet, or the nearest one stale) is treated as unconfirmed, never as a default pass.**

**IV percentile: not wired, honestly dropped from Pillar C's claims.** `summariseIvPercentile` needs >= 20 distinct calendar days of a single daily IV reading; nothing in this repository currently derives "the" ATM IV per day and feeds it into a strategy-context resolver the way PCR was wired above, and building that pipeline (choosing an ATM-window IV definition, resolving it once per day, threading it through `StrategyMarketContext`) is a separate piece of work this fix did not attempt. The docstring and reasoning text no longer claim it.

## 4. The critical test: is the filter better than randomly dropping trades?

Filtering 172,667 raw events down to a few thousand mechanically shrinks total loss when the underlying population is a net loser -- that alone is not evidence of a quality edge. The only way to tell the two apart is to compare the filtered population against same-size *random* subsamples of the same raw population.

### Method

- Raw population: all 172,667 level-contact events (2026-08-01 onward), each scored win/loss by rejection-vs-breach exactly as the standalone baseline always has been (`+1.5R` win, `-1.0R` loss).
- Full-pillar population: Pillar A (threshold 0.10) AND Pillar B (`|raw_di| >= 0.05`, same direction) AND Pillar C (PCR wall, real, `pcr` must be measured).
- Null distribution: 1,000 independent random subsamples, without replacement, each exactly the size of the full-pillar population, drawn from the raw 172,667.
- Comparison: the full-pillar population's actual net R / win rate / profit factor against each null distribution's mean, spread, percentile rank, and one-sided p-value (share of null draws that are >= the actual value).

Reproduce with `python apps/ml/run_hybrid_confluence_backtest.py --pillar-a-threshold 0.10 --resamples 1000 --seed 42`.

### An interim finding on Pillar B

Pillar B (`|raw_di| >= 0.05`) turns out to be **tautological with Pillar A in this feature construction**, not an independent filter. `di_decay = raw_di * decay_factor` with `0 < decay_factor <= 1`, so `|raw_di| >= |di_decay|` always. Any event clearing Pillar A's 0.10 threshold on `di_decay` already clears Pillar B's looser 0.05 threshold on the same underlying `raw_di` -- Pillar B removes zero additional events beyond Pillar A alone, in this data. This is reported as a real finding about the feature design, not silently dropped.

### Results

Of the 14,678 events that pass Pillar A (threshold 0.10), 218 have no measurable PCR (excluded, not defaulted to a pass -- see Section 3) and Pillar B removes zero more (Section 3's tautology finding). Pillar C's wall requirement is the one doing almost all of the further cutting: of the remaining 14,460, **1,122 (7.8%) pass all three pillars.**

| Population | n | Win rate | Profit factor | Net R |
|---|---|---|---|---|
| Standalone baseline (all contact events) | 172,667 | 33.93% | 0.77 | -26,217 |
| Pillar A only (threshold 0.10) | 14,678 | 38.36% | 0.93 | -603 |
| **Full pillar (A + B + C)** | **1,122** | **73.98%** | **4.26** | **+953** |

**Random-subsample null (1,000 draws, each size-matched to 1,122, without replacement, seed 42):**

| Metric | Null mean | Null sd | Actual (full pillar) | Percentile rank | p-value |
|---|---|---|---|---|---|
| Net R | -170.09 | 38.69 | +953.00 | 100.0 | 0.0000 |
| Win rate | 33.94% | 1.38 | 73.98% | 100.0 | 0.0000 |
| Profit factor | 0.77 | 0.05 | 4.26 | 100.0 | 0.0000 |

The actual result sits roughly **29 standard deviations** above the null distribution's mean net R (`(953 - (-170.09)) / 38.69 ≈ 29`). None of 1,000 random size-matched draws came close. This is not the "trading less mechanically shrinks a loss" pattern the earlier v1.0.0 result (n=12,290, -1,950R, p=0.74 vs the *unfiltered* baseline) could not rule out -- against the correct null (same-size random subsamples, not the full unfiltered population), the filtered population is decisively different in kind, not just in size.

**Per-instrument replication**, run separately to check this is not a single-symbol artifact (a real risk in this project -- see `htf-confluence-below-noise-floor` and the ICT strategy's sign-flipping cells in `strategy-registry.ts`):

| Symbol | n | Win rate | Profit factor | Net R | Level types |
|---|---|---|---|---|---|
| BANKNIFTY | 658 | 74.77% | 4.45 | +572 | PDH 120, SWING_HIGH 314, ITH 112, PDL 112 |
| NIFTY50 | 464 | 72.84% | 4.02 | +381 | PDH 360, SWING_HIGH 100, ITH 4 |

Both instruments land within ~2pp win rate and ~0.4 PF of each other -- this is a real replication, not one instrument carrying the average. One asymmetry worth flagging plainly: **NIFTY50's 464 events are 100% up-level (SHORT-side) rejections** -- no PDL/SWING_LOW/ITL/SESSION_LOW event passed all three pillars for NIFTY50 in this window, so the LONG side of this strategy is untested on NIFTY50 here. BANKNIFTY has both sides (546 up-level SHORT, 112 PDL LONG).

### Important caveats before reading this as "the strategy works"

1. **No transaction costs, spread, or slippage.** Every trade is a fixed +1.5R win / -1.0R loss on a rejection/breach outcome -- the same idealization the original v1.0.0 backtest used, not a fill-level simulation. This project has previously found strategies that look profitable on a frictionless R-multiple and lose money once spread/slippage/fees are included (`paper-trade-loss-is-mostly-fees`: 54.5% of a -76.5R live record was friction; `ict-entry-model-power-bound`'s "-16.79/trade" widening once real costs were added). This number has not been through that filter.
2. **In-sample, not out-of-sample.** This is the same 2026-08-01-onward window the threshold defect and the Pillar C stub were both found in. None of it is a holdout the fixes were validated against after the fact.
3. **PCR data is sparse and slow-moving.** Only 1,070 (NIFTY50) and 905 (BANKNIFTY) whole-chain PCR observations exist over the whole window (~8 weeks) -- the collector polls roughly every 7-8 minutes during market hours, and PCR itself moves slowly within a session. Many of the 1,122 passing events likely share the same or a highly correlated PCR reading from the same or an adjacent snapshot, which means the effective number of *independent* PCR readings behind this result is smaller than 1,122 event-level rows. The event-level rejection/breach outcomes are still individually valid (same methodology the original baseline always used), but the filtering variable is coarser than the headline n suggests.
4. **Directly adjacent, previously-negative research exists for two of the three pillars** (Pillar A's underlying DI signal: ORDERBOOK-01, independently falsified CASE E the same day this strategy shipped; Pillar B's OFI: closed on a sign-flipped replication window). Pillar C's PCR-as-direction-feature was separately found below random for next-bar direction (`gap-analysis-oi-pcr-no-edge`, macro-F1 0.19-0.20). None of those findings falsifies *this* conjunctive, rejection-outcome hypothesis directly -- it is a different question (does the combination confirm a level rejection, not does PCR alone predict the next bar) -- but it sets a real prior of skepticism this single in-sample result does not, on its own, overcome.

### Verdict: **EDGE CONFIRMED against the random-subsample null, in-sample -- NOT validated for live execution**

The narrow question this section was built to answer -- is the confluence logic doing something beyond "trade less to shrink a loss" -- has a clear, non-marginal, cross-instrument-replicated answer: **yes.** That is the headline finding and it is not being buried or spun as a loss.

It is also not, by itself, a green light. Per Section 5, `executableSides: []` is added regardless of this result, and the caveats above (no cost model, in-sample only, sparse/autocorrelated PCR, adjacent falsified priors) are exactly the gap between "beats a random-filtering null" and "ready to trade." The next step, if this is pursued further, is a cost-aware, out-of-sample re-measurement on data outside 2026-08-01..09-28 -- not a relaxation of the gate on the strength of this document.

## 5. What shipped as a result

- Pillar A threshold: kept at 0.10 in code; docstring, reasoning text and `run_hybrid_confluence_backtest.py`'s default now agree.
- Pillar C: real as-of PCR join wired into `StrategyMarketContext.optionChainSignal` and the strategy's gate; the false "volatility regime" claim removed.
- `executableSides: []` added to the `hybrid-liquidity-confluence-v1` registry entry in `strategy-registry.ts`, matching the `momentum-scalp-pattern-v2` convention -- both sides disabled, registered so idea generation and this record survive. This applies **regardless of the verdict above**: a single backtest run over data adjacent to where these defects were found is not grounds to go live under this project's own discipline (train -> shadow -> settle -> compete, OOS validation, walk-forward), whichever way the random-subsample comparison came out.
- Unit tests added/updated: `hybrid-liquidity-confluence-strategy.test.ts` (PCR pass/reject/unmeasured cases), `postgres-strategy-market-context-repository.test.ts` (live-DB `optionChainSignal` resolution, absence, staleness), `strategy-registry.test.ts` (the disable is asserted, not just present).

## 6. What would need to happen before this could go live

Per this project's own standard, and independent of this document's verdict: shadow-run the fixed strategy, settle its predictions against real fills, and re-measure out-of-sample before ever removing the `executableSides: []` gate. An IV-percentile pipeline would need to be built from scratch if Pillar C's "volatility regime" half is ever revisited rather than dropped.
