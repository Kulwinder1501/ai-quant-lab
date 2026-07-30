# Next Session Brief — AI Quant Lab

Paste this whole file as your prompt. It is self-contained and assumes no memory of
the 2026-07-30 session that produced it.

---

## 0. READ THIS FIRST — verify before you trust

The brief that started the *previous* session was stale, and acting on it wasted
real time: it described `ml-feature-v4` when the tree was already at v5, listed two
test failures as open when they had been fixed, and quoted test counts that were
three sessions out of date.

**So do not trust the numbers below. Verify them first**, and treat any mismatch as
"this brief is older than the tree", not "the tree is broken":

```bash
py -3.12 -m unittest discover -s apps/ml -p "test_*.py"
```
Expect **`Ran 155`, `FAILED (errors=5)`**. All 5 errors are
`tests/test_gradient_boosting.py` LightGBM cases failing with
`OSError: [WinError 4551] An Application Control policy has blocked this file` —
**environmental, not regressions** (the native DLL is blocked by Windows
Application Control). sklearn/logistic, xgboost, numpy, pandas all work.

```bash
cd apps/api && npx tsc --noEmit && npx vitest run
```
Expect a clean typecheck and **139 passed / 32 files**. Any *sixth* ML error or any
API failure is new and yours.

```bash
git status --short               # expect a clean tree (docker-compose.v2.yml may be untracked)
git log --oneline -3             # expect 425b7fb docs, 82883e7 the session's work, 8ac8e02
```

---

## 1. Where things stand

Branch `feature/FIIDII-giftnifty`. All of the work described below **is committed**
(`82883e7` for the code, `425b7fb` for this brief) and **not pushed**.

Current contract versions — **these are immutable ordered column contracts; adding
or removing any column requires a new version string**:

- Feature schemas: **`ml-feature-v5`** (swing), **`ml-feature-scalp-v2`** (1m/3m/5m)
- Label schemes: `fixed-horizon-v1`, `triple-barrier-v1`, `volatility-expansion-v1`
- Label alphabets: `DIRECTIONAL_ALPHABET` (BEARISH/NEUTRAL/BULLISH) and
  `VOLATILITY_ALPHABET` (CONTRACTION/STABLE/EXPANSION). **They are disjoint by
  design and a test enforces it.**
- Migrations through **`011-auxiliary-model-predictions`**, all applied to the local
  DB.

### The headline empirical results — read before proposing model work

Measured 2026-07-30 on the live DB (NIFTY50 1d, 879 bars, ~173-row holdout).

**Direction prediction is a dead end — both schemes.** The decisive test is not
macro-F1 against the 0.3333 random baseline, it is **beating the trivial
always-predict-the-majority-class strategy**:

| config | macro-F1 | dirHit | trivial dirHit |
|---|---|---|---|
| fixed-horizon h5, logistic | 0.2374 | 0.303 | 0.366 |
| triple-barrier h5 u1 l1, logistic | 0.3402 | 0.389 | 0.390 |
| triple-barrier h10 u1.5, logistic | 0.3631 | 0.468 | **0.676** |
| triple-barrier h20 u2.0, logistic | 0.3046 | 0.558 | **0.763** |

Triple-barrier's higher macro-F1 is a **class-balance artifact**, not skill.
Asymmetric barriers look best on macro-F1 precisely because a near stop is hit far
more often than a far target, which skews labels ~68% BEARISH — and there the
trivial predictor crushes the model. Corroborated by `ERA_HOLDOUT: FAILED` on the
best config. **Do not retry direction by tuning hyperparameters or barrier
geometry.**

**Volatility expansion works.** Same window, same holdout:

| config | model (logistic) | trivial |
|---|---|---|
| NIFTY50 1d, K=10, band .25 | macro-F1 **0.4433** / acc 0.448 | 0.1745 / 0.355 |
| BANKNIFTY 1d, K=10, band .25 | **0.4301** / 0.427 | 0.1508 / 0.292 |
| NIFTY50 15m, K=5, band .25 | **0.4254** / 0.515 | 0.2177 / 0.485 |

Believable because: **every one of 4 walk-forward folds beats trivial by 2–3×** in
all three configs; **label shuffle collapses it** (.443→.308, .430→.303,
.425→.240); it beats trivial on **both** macro-F1 and accuracy at band=0.25.

**Two caveats that must not be dropped when describing this:**
1. The signal is **volatility clustering and essentially nothing else** — a
   range/ATR/wick/VIX-only subset scores as well or better than the full schema
   (NIFTY50 1d: volOnly 0.4500 vs full 0.4433). Indicator, pattern, price-action,
   and institutional-flow columns add ~nothing here.
2. **Prefer logistic.** hist-gbdt's shuffle test is much less clean (shuffled
   0.37–0.40), so its margin over noise is thin.

It is a **position-sizing / regime-gating** signal, not a directional edge.

### Measured facts to reuse rather than re-derive

- Neutral share at ±50bps, horizon 5: **1m 99.2%, 15m 87.8%, 1d 19.9%**.
- `^NSEI` 1m volume is **zero on 1871/1871 bars**. Any volume feature is inert
  against that source.
- Median |overnight gap| **71.4bps** vs 1m 5-bar p99 move **20.8bps**.
- Yahoo history caps: 1m ≈7 days, 5m/15m ≈60 days, 1d ≈400+ bars.

---

## 2. What was done on 2026-07-30 (do not redo)

- **Phase 22 audit + fixes.** The institutional-flow ML features were declared but
  populated by *nothing* — constant NaN on both training and inference paths. Now
  loaded point-in-time (a bar may only read a print published before its close, from
  a strictly earlier session). The unbacked `gift_nifty_implied_gap_bps` column was
  removed. The agent now reads the latest *published* flow instead of `date = today`
  (which returned zero rows for the entire trading day).
- **Indicator/pattern backfill run** for NIFTY50 + BANKNIFTY on 1d and 15m, so
  EMA-9 now has real `ta-v1` snapshots (see 3.2).
- **`run-backtest` fabrication removed.** It fell back to a `Math.random()` synthetic
  series when a strategy produced no trades, and reported those metrics as real.
- **Scalp LONG/SHORT.** The seed hard-coded a `'LONG'` placeholder; that is fixed.
  The real blocker was that **EMA-9 was missing from `defaultIndicatorDefinitions`**,
  so `resolveIndicators` always failed and momentum-scalp could produce *nothing* on
  real data. EMA-9 is now registered *and backfilled* (see 3.2 and the 3.2b blocker).
  `analysis:generate-trade-ideas` gained an opt-in `--lookback N` historical scan.
- **B1 triple-barrier**: fully built (label core, DB forward-path loader, builder,
  train.py wiring) and measured → negative result above. The machinery is reusable
  and is what B2 reuses.
- **B2 volatility expansion**: measured first, then made promotable — label
  alphabet generalisation, `auxiliary_model_predictions` table, train.py wiring,
  serving. Trains, audits, promotes, and **serves** end-to-end.
- **`FEATURE_LAG` leakage check fixed.** Its premise ("if staling features doesn't
  hurt, they encode the future") is invalid for a persistence-dominated target.
  Callers pass `persistence_dominated=True` and it returns **`INCONCLUSIVE`** —
  never upgraded to PASS. `LABEL_SHUFFLE` still blocks; tests enforce both.

---

## 3. What is left

### 3.1 DONE — committed
The session's work is in `82883e7`, this brief in `425b7fb`. Neither is pushed, so
pushing (or opening a PR) is the only remaining git action.

### 3.2 DONE — EMA-9 backfilled, and momentum-scalp proven to work
Indicators and patterns were recomputed for NIFTY50 + BANKNIFTY on 1d and 15m.
EMA-9 now has real `ta-v1` snapshots, and the scan produces **both directions**:

```
NIFTY50 1d, --lookback 800:
  trend-breakout : 5 ideas   (3 LONG, 2 SHORT)
  momentum-scalp : 110 ideas (73 LONG, 37 SHORT)
```

So the strategy logic is sound and is *not* long-biased. **But see 3.2b — it still
cannot run intraday.**

### 3.2b BLOCKER — momentum-scalp cannot fire on any intraday timeframe
Root-caused on 2026-07-30. The chain:

1. `momentum-scalp` requires VWAP (`resolveIndicators` returns null without it).
2. VWAP is volume-weighted and the engine only emits a value when
   `cumulativeVolume > 0`.
3. **Yahoo provides no volume for index intraday bars.** Measured:
   `NIFTY50 15m: 0 of 1075 bars have volume`, `BANKNIFTY 15m: 0 of 1075`. Daily bars
   do have volume (873/881), which is why 1d works.
4. Therefore VWAP snapshots exist only on 1d (`{'1d': 873}`, nothing on 15m), and a
   15m scan reports `RULES_NOT_MET` for every candle — permanently.

This makes **B5 (a volume-bearing intraday source) a hard prerequisite for the whole
scalping track**, not the optional enhancement the previous brief implied. Until a
source with real intraday volume exists (NIFTY futures, NIFTYBEES ETF, or
constituent-summed volume), no amount of strategy tuning will produce an intraday
scalp idea. Do not spend time debugging `momentum-scalp` before fixing the feed.

### 3.3 PARTLY DONE — PRODUCTION cleaned; candidates deliberately left
The two throwaway volatility models were archived. PRODUCTION is now:

```
v1  market-direction-logistic--NIFTY50--1d--h5--neutral-50bps--ml-feature-v1   <- orphaned by v5 (see 4.2)
v3  scalp-momentum-v1                                                          <- orphaned by v5 (see 4.2)
v4  volatility-expansion-logistic--…--volatility-expansion-v1--band0.25        <- the keeper
```

**56 CANDIDATE rows were left in place on purpose.** `prune.py` can only express
"older than N days", so removing the ~14 created on 2026-07-30 would also delete the
pre-existing 07-28/07-29 history, which was not mine to delete. The default
`npm run ml:prune` (7 days) will clear them naturally. Both FK guards are in place,
so it correctly skips any candidate referenced by a prediction or promotion.

### 3.4 Brief items never started
- ~~**B7 intraday indicator + pattern backfill**~~ — **DONE** for NIFTY50 and
  BANKNIFTY on 1d and 15m. Re-run after ingesting new candles.
- **B6 backtest `momentum-scalp` v2** — the rules are now *proven to fire* (110
  ideas on 1d, 73 LONG / 37 SHORT), but have never been run through
  `backtest:run` to get P&L. Still the cheapest remaining source of signal and
  independent of the ML track. Note it can only be backtested on 1d until 3.2b is
  fixed.
- **B3 time-of-day / session-position features** (data-justified: 1m median bar
  range is 5.4bps at 09:15 IST vs ~2.3bps midday). Needs a new scalp schema version.
- **B4 relative-strength features** (NIFTY-vs-BANKNIFTY spread in bps + rate of
  change). No cross-instrument column exists today.
- **B5 a volume-bearing intraday source — PROMOTED TO PREREQUISITE.** See 3.2b:
  this now gates the entire intraday scalping track, not just volume features.
  Options: NIFTY futures, NIFTYBEES ETF, or constituent-summed volume.
- **B8 daily 1m persistence job** (Yahoo's 7-day 1m cap means 1m history can only
  accumulate by appending). Low priority.
- **A6 10m/15m schema decision** — `SCALP_TIMEFRAMES` is `("1m","3m","5m")`, so 15m
  uses the swing schema including three daily-gap columns that are degenerate
  inside a session. Extend the scalp set, or add a third intraday schema. **This is
  a design call, not a mechanical fix.**

### 3.5 Deliberately skipped
**Phase 4 — a consumer for `auxiliary_model_predictions`.** Nothing reads that
table, so the promoted volatility model is currently inert plumbing. Wiring it into
position sizing or regime gating is where its value actually lands.

---

## 4. Decisions needed from the user

1. **`rewardRiskMultiple` is still 1.0** in `momentum-scalp`. At a ~0.5 ATR stop on
   1m this is likely negative-expectancy after spread, slippage, and brokerage. Left
   alone deliberately — it is a trading-economics decision. State the friction
   assumption and the geometry can be set.
2. **Archive the orphaned pre-v5 PRODUCTION models?**
   `market-direction-logistic--…--ml-feature-v1` (v1) and `scalp-momentum-v1` (v3)
   are orphaned by the v5 bump and will be rejected at inference.
3. **Is the volatility model worth a consumer** (3.5), given its signal is
   persistence-dominated?

---

## 5. Invariants — do not break these

- **`ml-feature-v5` / `ml-feature-scalp-v2` are immutable ordered column
  contracts.** Adding or removing any column requires a new version string. This is
  what corrupted v3.
- **The two label alphabets must stay disjoint.** A volatility label reaching
  `model_predictions` would be read as a trade direction by the strategy engine, the
  autonomous agent, the market scanner, and the predictions dashboard. Non-directional
  predictions go to `auxiliary_model_predictions`; `predict.py` routes on the label
  scheme read **from the artifact**, not from a flag.
- **Everything alphabet-aware defaults to `DIRECTIONAL_ALPHABET`**, so the directional
  path is byte-identical. Regression check: training NIFTY50 1d logistic must still
  produce key `market-direction-logistic--NIFTY50--1d--h5--neutral-50bps--ml-feature-v5`
  with `macroF1=0.2374`, `dirHit=0.3030`.
- **`persistence_dominated=True` is only for non-directional targets.** For a
  directional target, low lag degradation really is a leakage smell and must FAIL.
- The `LEAD` forward-label window stays **partitioned by IST trading date for
  intraday only**. Partitioning daily bars would null every label.
- `reference_data._fixed_schema` is a **whitelist**. Do not relax it.
- `1d` neutral threshold stays **50bps** to preserve the existing promotion lineage.
- A `strategy_versions` configuration is immutable — changing `momentum-scalp`'s
  config requires bumping `momentumScalpStrategyVersion`.
- **A model key carries only the parameters that shape its own scheme's target.**
  A volatility key must not contain a neutral band or barrier multiples.

---

## 6. Local environment traps (each looks like a code bug and is not)

- **LightGBM is unusable on this machine** (`WinError 4551`, Application Control).
  5 permanent test errors. Use xgboost for boosted comparisons.
- **Postgres is live** at `postgresql://localhost:5432/ai_quant_lab`. `DATABASE_URL`
  is in `.env`, `apps/api/.env`, `apps/ml/.env` but is **not exported**, so scripts
  must `load_dotenv`. Do not assume there is no database — check first.
- Running ML scripts by path needs `PYTHONPATH` set to `apps/ml`.
- **`data_cutoff_at` silently gates indicator snapshots.** ATR snapshots were
  calculated `2026-07-30 12:40Z`; a cutoff earlier than that yields evidence with
  **zero ATR**, which makes triple-barrier and volatility skip every candle and
  produce zero examples. Looks like a loader bug; it is a cutoff choice.
- **`predict.py` refuses in-sample predictions.** It needs a model whose
  `data_cutoff_at` is after the snapshot time *and* an `--as-of` past a candle that
  closed later still. Working example:
  ```bash
  py -3.12 apps/ml/train.py --instrument NIFTY50 --timeframe 1d --from 2023-01-01 \
    --to 2026-07-25 --data-cutoff-at 2026-07-30T13:00:00Z --algorithm logistic \
    --label-scheme volatility-expansion-v1 --horizon-bars 10 --expansion-band 0.4 --promote
  py -3.12 apps/ml/predict.py --instrument NIFTY50 --timeframe 1d \
    --model-key "volatility-expansion-logistic--NIFTY50--1d--h10--ml-feature-v5--volatility-expansion-v1--band0.4" \
    --as-of 2026-07-31T06:00:00Z
  ```

---

## 7. Method note that mattered more than any single fix

Two habits produced every real result here, and both are cheap:

1. **Always compare a model against the trivial majority-class predictor**, not just
   the random baseline. macro-F1 rises mechanically when classes become less
   degenerate; that alone made triple-barrier look like an improvement when it was
   not.
2. **Measure before building infrastructure.** B1 had its full pipeline built and
   *then* was shown to have no edge. B2 inverted that — a throwaway harness first,
   plumbing only once signal appeared — and cost a fraction as much.
