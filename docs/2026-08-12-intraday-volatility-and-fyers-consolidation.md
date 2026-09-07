# 2026-08-12 — Intraday volatility models (30m/60m) and the Yahoo→Fyers question

**Written 2026-08-12.** Every figure below was measured on that date against the v2
database (port 5433, ~1.74M candles) with the command that produced it given, so it can be
re-run rather than trusted. Nothing here was committed; the "Branch state" section lists the
uncommitted changes.

The headline: **30m and 60m directional prediction is dead, 60m volatility-expansion has real
statistical skill but no tradable edge, and 30m volatility is dead.** One production bug was
fixed along the way (15m training window). The cost-aware gate is what caught the 60m model —
every statistical guard passed; only the economics failed.

---

## 0. What was asked

A sequence of questions about extending the EOD training pipeline to new intraday timeframes:

1. "Can we train on 30m and 60m data too — can it create any edge?"
2. Then a concrete plan: fix 30m collection/indicators/patterns/SMC; correct the stale 15m
   58-day window; train 30m/60m **volatility-expansion** as shadow models (30m h5, 60m h2/h3);
   keep 30m/60m **directional** research-only; require purged WF/CPCV + shuffle checks +
   300–500 settled predictions; promote only on cost-aware option P&L or incremental value.
3. Execute steps 1–3 (window fix, train, shuffle audit), then step 4 (backfill), then step 5
   (the promotion gate).
4. Finally: "Can we use Fyers for every kind of data and remove Yahoo?"

---

## 1. Data foundation for 30m/60m (already mostly present)

The 30m/60m candles were **already collected and already Fyers-sourced** — no collection
needed:

| symbol | tf | bars | range | provenance |
|---|---|---|---|---|
| NIFTY50 | 30m | 14,749 | 2022-01 → 2026-08 | fyers-api-v3 |
| NIFTY50 | 60m | 7,945 | 2022-01 → 2026-08 | fyers-api-v3 |
| BANKNIFTY | 30m | 14,746 | 2022-01 → 2026-08 | fyers-api-v3 |
| BANKNIFTY | 60m | 7,943 | 2022-01 → 2026-08 | fyers-api-v3 |

What was missing was the **derived feature layer**. Materialized it and cleared the readiness
gate:

```bash
# indicators (ta-v1) and patterns/price-action for both instruments, both timeframes
npm run analysis:calculate-indicators -- --instrument NIFTY50 --timeframe 30m   # ×4 combos
npm run analysis:detect-patterns    -- --instrument NIFTY50 --timeframe 30m     # ×4 combos
```

The 60m/15m series then showed DEGRADED only because of a handful of **stale provisional bars**
(today's live bars the collector left unfinalised while the stack was down). Purged them with
the same rule as migration 035 (`is_complete = FALSE AND close_time < now() - 1 hour`), scoped
to the four series. After that, all of 15m/30m/60m/1d for both instruments audit **READY**.

```bash
npm run data:audit    # confirm READY
```

**Note:** 30m/60m index bars carry `zeroVol=76%` — the pre-2026 index volume gap
(`fyers-index-volume-break`). Harmless here: the volume feature degrades to NaN (not a fake
constant) and the boosted models route NaN natively; volatility-expansion is range-driven.

---

## 2. The 15m training-window bug (fixed — the one production improvement)

`run-eod-pipeline.ts` trained 15m on `sixtyDaysAgo` (58 days) with a comment claiming "15m is
Yahoo-owned and Yahoo serves ~60 days". **That comment is stale** — 15m moved to Fyers on
2026-08-05, and NIFTY50 15m now holds **22,265 bars back to 2023-01**. The pipeline was
discarding 3.5 years and training on 6 weeks (which is why those models scored 0.29 macro-F1).

Fixed: `--from "2023-01-01"`, folds raised from 2 → 5 (the row count now supports it), comment
corrected. Removed the now-dead `sixtyDaysAgo` constant. Typechecks clean.

---

## 3. Directional 30m/60m — dead (as expected)

Not pursued past a screen: the EOD pipeline already records that direction's failure is the
*target*, not the sample (pooling gave the directional target 20× data for +0.0004 macro-F1).
The 60m leakage audit confirmed it directly — the directional model scored **0.317 macro-F1,
below the 0.333 random baseline → NO_SKILL**. Kept directional research-only, as planned.

---

## 4. Volatility-expansion 30m/60m — the real finding

Trained as shadow candidates (no `--promote`) with 5-fold WF + CPCV-6. Judged on the
`cpcv-accuracy-discriminator` rule — **both** accuracy and macro-F1 vs trivial, not macro-F1
alone.

```bash
npm run ml:train:xgboost -- --instrument NIFTY50 --timeframe 60m \
  --label-scheme volatility-expansion-v1 --horizon-bars 2 \
  --from 2022-01-01 --to <now> --folds 5 --cpcv-groups 6
```

| model | CPCV macro-F1 vs trivial | CPCV **accuracy** vs trivial | EXPANSION f1 | verdict |
|---|---|---|---|---|
| NIFTY50 60m **h2** (xgb) | +0.196 (100%) | **+0.031 (won 93%)** | 0.42 | signal |
| NIFTY50 60m **h2** (lgbm) | +0.207 (100%) | **+0.032 (won 93%)** | — | algo-robust |
| BANKNIFTY 60m **h2** (xgb) | +0.170 (100%) | **+0.018 (won 87%)** | 0.39 | replicates (marginal) |
| NIFTY50 **30m** h5 | +0.077 (100%) | **−0.003 (won 40%)** | 0.00 | **dead** |
| NIFTY50 60m **h3** | +0.072 (100%) | **−0.012 (won 7%)** | 0.14 | **dead** |
| BANKNIFTY 60m **h3** | +0.069 (100%) | −0.012 (won 7%) | 0.00 | **dead** |

**Two non-obvious results:**
- **Bar resolution beats sample size.** 30m/h5 has *more* rows (9,060 vs 5,666) yet is dead;
  60m denoises the intraday microstructure enough for the target to become learnable.
- **The horizon is sharp.** h2 (~120 min) works; h3 (~180 min) is dead on both instruments and
  both algos. The signal is specific to the 2-bar window, which is reassuring (a spurious edge
  wouldn't be so cleanly horizon-shaped) but means the model must be pinned at h2.

---

## 5. Leakage audit — feature pipeline is clean (audit.py extended)

`audit.py` previously had no `--label-scheme`, so it could only audit the directional label.
**Added `--label-scheme` / `--expansion-band`** (backward-compatible; passes the correct
`VOLATILITY_ALPHABET`). Then on NIFTY 60m/h2 (base macro-F1 0.42, real skill to trace):

```bash
npm run ml:audit -- --instrument NIFTY50 --timeframe 60m --algorithm xgboost \
  --label-scheme volatility-expansion-v1 --horizon-bars 2 --from 2022-01-01 --to <now>
```

- **LABEL_SHUFFLE PASS** — shuffled target scored 0.259, *below* 0.333 random. Signal destroyed
  by shuffling → no leakage.
- **FEATURE_LAG PASS** — stale features cost 0.044 → the current bar carries the signal. (The
  `leakage-audit-feature-lag-caveat` false-positive concern for persistent targets did not bite.)
- **ERA_HOLDOUT PASS** — a much later era scored 0.432, within 0.012 of in-window → survives out
  of sample in a different time era.

---

## 6. Walk-forward backfill (step 4) — deployment-forward simulation

The live shadow pool **cannot be backfilled by design** —
`require_prediction_after_pool_enrollment` enforces that a candidate's track starts at
enrollment. Faking `enrolled_at` would be exactly the fabrication those guards prevent, so
instead I built a research backtest (writes nothing to the DB):

```bash
node scripts/run-python.mjs apps/ml/backfill_volatility_shadow.py \
  --instrument NIFTY50 --timeframe 60m --horizon-bars 2 --from 2022-01-01 --to <now> --folds 10
```

Rolling-origin, train-on-past-only, 10 forward windows, ~1,130 out-of-sample settled
predictions per instrument (exceeds the 300–500 target):

| | accuracy > trivial | macro-F1 > trivial | pooled acc | pooled macro-F1 | EXPANSION f1 |
|---|---|---|---|---|---|
| NIFTY50 60m/h2 | **10/10** | 10/10 | 0.537 | 0.437 | 0.35 |
| BANKNIFTY 60m/h2 | **7/10** | 10/10 | 0.515 | 0.384 | 0.21 |

NIFTY is strong and stable across every forward window; BANKNIFTY is real-but-thin (lost 2 of
10 windows on accuracy, one by −0.089). The deployable statistical claim is NIFTY50 specifically.

---

## 7. Cost-aware straddle gate (step 5) — the decisive verdict: **do not promote**

A volatility call only has value if it monetizes through a tradable instrument. Buyer-only book:
EXPANSION → buy an ATM straddle; else stay flat. Built `apps/ml/volatility_gate.py` — same
walk-forward, but each OOS bar also prices an intraday straddle (weekly tenor for NIFTY,
mark-to-market exit after h2, India VIX as the IV, true-elapsed-time decay), gated by the
model's prediction. Reuses `straddle_economics.black_scholes_straddle`; writes nothing to the DB.

```bash
node scripts/run-python.mjs apps/ml/volatility_gate.py \
  --instrument NIFTY50 --timeframe 60m --horizon-bars 2 --from 2022-01-01 --to <now> \
  --folds 10 --days-to-expiry 7 --iv-scale 1.0
```

Result (1,124 OOS entries):
- Model EXPANSION precision **0.47 vs 0.24 base rate** — genuinely selective.
- **But gross P&L ≈ 0.5 bps of spot per straddle**, negative past ~5 bps fees, and model-gating
  (0.55 bps) does not even beat always-entering (0.75 bps).

**Statistical skill, no tradable edge.** Two structural reasons, neither fixable:
1. A 2-bar (~2 h) hold is too short to move any tradable option — the shortest NSE tenor is
   weekly, and h3 is dead so you cannot hold longer on a valid signal.
2. The range-expansion *label* is not the straddle *payoff* — a straddle pays on any large
   directional move; the label is the forward/trailing range ratio. Optimizing one does not
   optimize the other.

This repeats the `straddle-breakeven-precision` and `tier-sweep-no-durable-edge` lesson: skill ≠
edge, and the cost-aware gate is the only guard that caught it. **The 30m and 60m volatility
models are not promoted, not enrolled, not wired into the pipeline.**

---

## 8. Yahoo → Fyers consolidation (analysis only, nothing changed)

Question: can Fyers source everything and remove Yahoo? **Technically yes** — Fyers resolves
`INDIAVIX` (`NSE:INDIAVIX-INDEX`), has a batch live-quote endpoint (`FyersLiveMarketDataProvider.
fetchQuotes`) that can replace the driver-tape's Yahoo quotes, and paginates historical candles
back years. Recommendation:

- **Consolidate onto Fyers as the primary/authoritative feed** — it's the actual broker feed,
  it ends cross-provider seams, and it drops the fragile unofficial `yahoo-finance2` scraper.
- **Do not delete Yahoo — demote it to a fallback.** Fyers is a single point of failure with a
  daily OAuth refresh that has already refused once (`fyers-refresh-api-disabled`). Redundancy is
  worth more than deleting ~200 lines.
- **Costs to plan for:** re-sourcing rewrites daily closes (Fyers `NIFTY50-INDEX` ≠ Yahoo
  `^NSEI`), so it invalidates and requires retraining the 1d model stack; and **verify Fyers
  India VIX history depth ≥ 2023-01 first** — the one thing that could block, currently unverified.

---

## 9. Branch state (all uncommitted, on `feature/enhancements`)

1. `apps/api/src/interfaces/cli/run-eod-pipeline.ts` — 15m window fix (production improvement).
2. `apps/ml/audit.py` — `--label-scheme` / `--expansion-band` passthrough (backward-compatible).
3. `apps/ml/backfill_volatility_shadow.py` — new research harness (rolling walk-forward).
4. `apps/ml/volatility_gate.py` — new research harness (cost-aware straddle gate).

The 15m fix is the one change that stands on its own regardless of the volatility outcome. The
two harnesses are reusable and the gate is exactly what should run before any future model
promotion.
