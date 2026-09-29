# IV-compression / volatility-expansion check — 2026-09-29

## What was pitched

Yesterday's status-report pitch proposed a third "better strategy": identify low
implied-volatility (IV) compression right before a breakout, and use it as an entry
trigger for option buying at 1:3-1:5 R:R. This document records what was actually
checked and the real result, before anything gets built on it.

## What already existed (not new)

This project already has a validated, non-directional **volatility-expansion**
classifier (`ai_quant_lab_ml/volatility_expansion.py`): CONTRACTION/STABLE/EXPANSION
over a forward high-low range vs. a trailing one, trained purely from price (no
options data), running the full train -> shadow -> settle -> compete lifecycle
(see `[[volatility-path-is-the-live-track]]`). It clears the leakage audit and a
0.40 macro-F1 promotion floor on some instrument/timeframe combinations
(`[[volatility-expansion-has-signal]]`). It is **not connected to any option-buying
entry logic** -- it is a standalone forecast, not wired to trading.

Separately, this codebase already computes real implied volatility and an IV
percentile, but only as a **pre-trade ceiling check** (Factor 5 of the options
entry checklist, `market-data/domain/iv-percentile.ts` +
`chain-greeks.ts` + `packages/pricing`): it screens OUT buying when IV percentile
is *high* (>= 85 by default), the opposite direction from "IV compression predicts
a breakout." No production code anywhere uses low IV percentile as a predictive
entry trigger.

So the genuinely new claim in the pitch was narrow: **does a causal, as-of
IV-percentile-compression feature add any predictive signal for a subsequent
range expansion, beyond what the existing price-only model already captures?**

## Does real IV data exist?

`option_chain_snapshots` (migration `037-option-chain-snapshots.ts`) stores
raw bid/ask/last_price/underlying_value per contract, **not** implied volatility --
IV has to be solved via Black-Scholes inversion, same as the live TS pre-trade
checklist does. Real data exists: NIFTY50, BANKNIFTY, SBIN, RELIANCE, 2026-08-04
through 2026-09-29, 39 distinct trading days, ~57k-67k rows per instrument
(NIFTY50/BANKNIFTY have the deepest coverage; SBIN/RELIANCE lack matching 15m
candle history over the same window).

## What was measured

New script: `apps/ml/iv_compression_signal_check.py`, the same "Step 1 gap
analysis" pattern as `oi_pcr_signal_check.py` -- build the real
volatility-expansion labels the normal way, replace each example's feature vector
with a **minimal, standalone** 3-column IV feature set, and run the existing
leakage-audit machinery (`run_leakage_audit`, `VOLATILITY_ALPHABET`,
`persistence_dominated=True`, matching the reasoning already established for
this target). No model version, prediction, paper trade, or order was created.

Since no raw IV is stored, ATM IV is solved per snapshot from the nearest strike
to the observed underlying value, at the nearest un-expired expiry, averaging
call/put IV when both solve. This is a from-scratch Python port of
`packages/pricing/src/index.ts`'s Newton-Raphson/bisection solver (same bounds,
same minimum-extrinsic-value floor), deliberately skipping the put-call-parity
forward correction `chain-greeks.ts` applies live -- appropriate for a cheap
first-pass screen, not for a number a trade decision would read.

Features (all as-of, `observed_at <= candle.close_time`, snapshot age <= 60min):

- `iv.percentile` -- rank of the latest known IV against **calendar days strictly
  before** the candle's own day (one representative value per day, requiring
  >= 20 trailing distinct days, same threshold as the live `iv-percentile.ts`).
- `iv.level` -- the raw solved ATM IV.
- `iv.change_vs_prior_day_bps` -- change vs. the prior day's representative IV.

Run on NIFTY50 and BANKNIFTY, 15m timeframe, horizon_bars=5, expansion_band=0.25
(the only timeframe/instrument pair with matching option-chain and candle
history over the full window):

| Instrument | Usable examples | Base macro-F1 | LABEL_SHUFFLE | FEATURE_LAG | ERA_HOLDOUT | Verdict |
|---|---|---|---|---|---|---|
| NIFTY50 | 321 | 0.1905 (below 0.3333 random baseline) | PASS | skipped (no skill to audit) | skipped | PASS, but no skill |
| BANKNIFTY | 341 | 0.4054 (clears the 0.40 volatility promotion floor) | PASS | PASS (0.041 degradation) | **FAILED** (later era: 0.329, at/below random baseline) | INVESTIGATE |

## Honest result: NO_EDGE

Neither instrument supports the pitch. NIFTY50's model has no skill at all --
below the three-class random baseline, so the leakage checks that need a skilled
model to interpret were correctly skipped. BANKNIFTY looked real in-window
(clears the same 0.40 macro-F1 floor the existing volatility model uses for
promotion) but **fails exactly the check designed to catch this failure mode**:
scored on a later, disjoint era, it collapses to the random baseline. That is
the same "looked good in one window, vanished in the next" pattern this project
has hit repeatedly (`[[daily-gate-terminal-fold-noise]]`,
`[[ofi-labelendat-bug-first-real-result]]`, `[[tier-sweep-no-durable-edge]]`).
With only 39 distinct option-chain trading days available and one of two
instruments failing outright, there is no basis to call this a replicated
result.

**Verdict: NO_EDGE.** The IV-percentile-compression feature does not add
usable, leakage-audit-surviving signal for the volatility-expansion target on
the data available today. This does not rule out a real effect on more history
(option-chain data is forward-accumulating and cannot be backfilled, per
`iv-percentile.ts`'s own docstring) -- but there is no honest basis today to
build an option-buying entry trigger, a new strategy class, or any live wiring
on top of it.

## What was (and was not) built

Only the gap-analysis script (`apps/ml/iv_compression_signal_check.py`) and its
unit tests (`apps/ml/tests/test_iv_compression_signal_check.py`, covering the
IV solver's round-trip correctness and the as-of/no-lookahead guarantees of the
percentile feature). Per instruction #4, no new strategy class, no feature-schema
change, and nothing was wired live -- the signal did not clear the bar for that.
