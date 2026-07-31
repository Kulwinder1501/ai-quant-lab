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
Expect **`Ran 155 ... OK`** — zero failures. Re-verified 2026-07-31. Through
2026-07-30 this suite ended `FAILED (errors=5)`, all 5 being
`tests/test_gradient_boosting.py` LightGBM cases hitting
`OSError: [WinError 4551] An Application Control policy has blocked this file`;
**that machine policy no longer blocks the DLL** (`import lightgbm` → 4.7.0, all
20 gradient-boosting cases pass). Any ML error at all is now new and yours.

```bash
cd apps/api && npx tsc --noEmit && npx vitest run
```
Expect a clean typecheck and **139 passed / 32 files**. Verified 2026-07-31.

```bash
git status --short               # 2026-07-31: two uncommitted files, see §3.1
git log --oneline -3             # expect d032da8, 948b895 docs, 425b7fb docs
```

---

## 1. Where things stand

Branch `feature/FIIDII-giftnifty`. All of the work described below **is committed
and pushed** — `origin/feature/FIIDII-giftnifty` is at `d032da8`, level with HEAD.
(`82883e7` code, `425b7fb`/`948b895` this brief, `d032da8` later UI/docker work.)

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

### 3.1 DONE — committed and pushed; two files left dirty
The session's work is in `82883e7`, this brief in `425b7fb`/`948b895`, later
UI/docker work in `d032da8`. All pushed; opening a PR is the only git action left.

Uncommitted as of 2026-07-31 (verified, not stray edits — a real fix):
`apps/web/Dockerfile` + `docker-compose.v2.yml` turn `NEXT_PUBLIC_API_URL` into a
**build arg**. Next.js inlines `NEXT_PUBLIC_*` at build time, so setting it only in
compose's `environment:` was too late and every v2 image shipped pointing at the v1
API port. Needs an image rebuild to take effect, then a commit.

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

### 3.3 DONE — PRODUCTION cleaned; candidates deliberately left
The two throwaway volatility models were archived on 07-30, and on **2026-07-31 the
two orphaned pre-v5 models were archived too** (§4.2 decided). PRODUCTION is now a
single row:

```
v4  volatility-expansion-logistic--…--volatility-expansion-v1--band0.25        <- the keeper
```

Archived, not deleted — reverting is `UPDATE model_versions SET stage='PRODUCTION'`
on `42b726d9-0bb7-4f9d-a489-11af123e6b15` (v1, `ml-feature-v1`) and
`3c0e6ab9-48a4-4485-ba68-89d658724865` (v3, `ml-feature-scalp-v1`). Both were
confirmed orphaned by reading their stored `feature_schema`, not by assuming it.

**56 CANDIDATE rows were left in place on purpose.** `prune.py` can only express
"older than N days", so removing the ~14 created on 2026-07-30 would also delete the
pre-existing 07-28/07-29 history, which was not mine to delete. The default
`npm run ml:prune` (7 days) will clear them naturally. Both FK guards are in place,
so it correctly skips any candidate referenced by a prediction or promotion.

### 3.4 Brief items never started
- ~~**B7 intraday indicator + pattern backfill**~~ — **DONE** for NIFTY50 and
  BANKNIFTY on 1d and 15m. Re-run after ingesting new candles.
- ~~**B6 backtest `momentum-scalp` v2**~~ — **DONE 2026-07-31, negative result.**
  It loses on 1d *frictionless*: NIFTY50 97 trades / 53.6% win rate / PF 0.73,
  BANKNIFTY 86 trades / 41.9% / PF 0.48 (trend-breakout baseline: 7 trades, 0 wins,
  PF 0.00). Cause is not gaps and not `rewardRiskMultiple` — see §3.4b. Intraday is
  still untested because of 3.2b.
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

### 3.4b Why momentum-scalp loses, and the false lead inside it
Under a 1:1 stop/target a 53.6% win rate should pay. It doesn't: the average stop
loss is ~2× the average target win (NIFTY50 -121.4 vs +60.2). **That is not gap
slippage** — only 3 of 45 stop exits were `OPEN_GAP_STOP`, the rest filled intrabar
at the exact stop price. It is that `quantity` is fixed while stops are
ATR-proportional, so risk per trade varies hugely (R spanned 0.8–196 points) and the
large-R trades are the losers. Bucketed by R, NIFTY50 win rate falls monotonically
**77% → 64% → 41% → 41%**.

**Do not read that as a tradable low-volatility filter.** Split by time, the low-R
win rate decays 87.0% → 56.5% (NIFTY50) and 68.4% → 36.8% (BANKNIFTY — below its own
high-R bucket in the second half).

**The root cause, isolated by equalising risk and re-running** (`--position-sizing
CONSTANT_RISK_FRACTION`, see §3.4c). Equal risk does *not* rescue it — profit factor
stays 0.68 / 0.46 — which rules sizing out as the cause. What survives is that the
mean per-unit gain on TARGET exits is only **0.58R (NIFTY50) / 0.65R (BANKNIFTY)
against a nominal 1:1 geometry**. The strategy sets stop and target from the source
candle's *close* but fills at the *next candle's open*, and a momentum bar tends to
continue overnight, so the fill lands nearer the target and further from the stop.
Every trade opens with degraded geometry; 56% accuracy at 0.58:1 is −0.12R/trade,
matching the engine's −0.145R.

The only repair with a real mechanism behind it is to re-derive stop and target from
the **fill** price rather than the signal bar's close — a strategy-version bump, not
a parameter tweak. Tuning `rewardRiskMultiple` would repeat the triple-barrier
mistake in §1.

`backtest:run` now takes `--strategy <key>`; it was hard-wired to trend-breakout, so
momentum-scalp had never been measurable. Both strategies now resolve through one
`strategy-registry.ts` shared with idea generation.

### 3.4c Backtest execution model — two additions
Both default to the previous behaviour, so recorded runs stay reproducible.

- `--position-sizing CONSTANT_RISK_FRACTION --risk-fraction 0.005` solves for the
  quantity that risks the same capital on every trade. Default is `FIXED_QUANTITY`,
  which risks capital in proportion to stop width and therefore lets the most
  volatile bars dominate any result. **Use constant risk for anything you intend to
  believe.**
- `--margin-fraction 0.2` funds a position on margin. The two settings are
  *coupled*, and this is the trap: the capital check was cash-secured, but risking
  1% behind a stop 0.3% away implies ~3× notional, so a cash-secured account rejects
  nearly every risk-sized signal. Measured: 97 of 118 NIFTY50 signals skipped as
  `skippedSignalsInsufficientCapital`, which reads as "no signal" when it is really
  "no funding". At 0.2 only 4 are skipped. Index futures margin at ~0.15–0.20, so
  that is the realistic setting; `1` (cash) is the default.
- New metric `skippedSignalsUnsizable` counts signals whose stop was so wide the risk
  budget bought under one unit — kept distinct from the capital and gap counters so
  the three failure modes can never be confused. Metrics are jsonb; no migration.

### 3.6 DONE — pseudo-embeddings removed, and RAG measured before building it
A proposed 11-phase `@xenova/transformers` semantic-memory migration was assessed on
2026-07-31. **The fabrication it identified was removed; the pipeline it proposed was
measured first and is not worth building.**

**Removed** (migration `012-remove-pseudo-embeddings`). `generatePseudoEmbedding` was
`Math.sin(hash + i) * Math.cos(hash * i)` over a string hash — no semantic structure,
so cosine distance ranked nothing. It fed three things:

1. The agent took the 2 nearest reflections **with no similarity threshold** and moved
   confidence ±15 per hit while printing *"MEMORY RECALL: Found highly similar past
   losing setup"* to the dashboard. With noise as the metric and 2 rows in the table,
   the same rows came back every time — a constant bias on every decision, presented
   as recall.
2. `seed-market-data.ts` invented an RSI (`Math.floor(40 + Math.random() * 30)`) and
   stored a hash of a string describing it as the "embedding" for 504 rows.
3. It k-NN'd those vectors into a BULLISH/BEARISH call written to **`model_predictions`**
   with hardcoded coefficients (0.421, 0.315) and `linearScore: 0.856`, attributed to
   whichever model was in PRODUCTION — indistinguishable from real inference on the
   dashboard, and one archived model away from writing a directional label against the
   volatility model (the exact confusion §5 and migration 011 exist to prevent).

Journal reflections now save with a NULL embedding ("not embedded" is true; a fake
vector was not). The 504 context rows were deleted since the vector was their only
payload. `findSimilarLessons` was removed rather than left looking functional.

**Measured, then declined.** A market-context document here is a template of numbers,
so a sentence encoder is a lossy re-encoding of those numbers and k-NN on the numbers
themselves is an **upper bound** on what embedded RAG could do. Tested on real
`ta-v1` snapshots, point-in-time (a neighbour's label must resolve before the query
bar), h5, ±50bps, 173-row holdout:

| | best k-NN | trivial | label-shuffle |
|---|---|---|---|
| NIFTY50 | 0.3070 / acc **0.3410** | 0.1780 / **0.3642** | **0.3359** |
| BANKNIFTY | 0.3419 / acc **0.3584** | 0.1920 / **0.4046** | 0.3237 |

Two refutations, the second decisive: k-NN **loses to trivial on accuracy** at every
k (5/15/25/50) and both metrics; and the **label-shuffle control matches or beats the
real labels**, so the macro-F1 gain is purely the spread-the-classes artifact from §1.
Better embeddings cannot rescue this — the upper bound was tested.

Not measured: retrieval over journal *prose*, which is genuinely semantic. Blocked
for a simpler reason — 4 reflection rows, and their text is templated boilerplate
("tighten Stop Loss from 1.5% to 1.0%") rather than observation. No corpus.

### 3.6b Seed fabrication removed, and the RSI read that never worked
Cleaned up in the same pass. The seed no longer invents indicator or pattern values:

- `Math.floor(40 + Math.random() * 30)` written as an RSI into `indicator_snapshots`
  is now a **real simple-average RSI(14)** computed from the same closes the seeds
  already use for SMA, Bollinger, EMA, and VWAP (`simpleRsi` in
  `market-data/domain/simple-rsi.ts`, unit-tested, shared by both seeds). It stays
  under algorithm version `v1`, deliberately distinct from the production pipeline's
  `ta-v1`, which uses Wilder smoothing — two algorithms must not share a version.
  **`seed-scalp-data.ts` was the real source**: it wrote a random RSI per 1m candle,
  which was every one of the 3742 fabricated rows in the database. `seed-market-data.ts`
  caps at 100 rows per timeframe, so fixing only it would have left the bulk in place.
- The seeded `BULLISH_ENGULFING` detection is gone. It fired whenever a candle merely
  closed up, with `confidence = 0.85 + random() * 0.1` and a description of "Test
  Pattern on Real Data". A bullish engulfing is a two-candle relationship, so the
  detection was wrong independently of its invented confidence. Real detections come
  from `npm run analysis:detect-patterns`.

**And the bug found while checking whether that fake RSI mattered:** it did not,
because **the agent could not read RSI at all.** It read `values["rsi"]`, but RSI
snapshots store `value`, so `rsiVal` was a hardcoded **50** on every run — none of the
`52–68` / `>70` / `<35` branches could ever fire, while the emitted thought still
claimed the setup was "aligned across RSI, Bollinger Bands, and News Sentiment". Now
reads the right key, so **the agent's confidence numbers will differ from every
previous run** — for the first time they include RSI.

The agent also matched indicators on code alone, taking whichever algorithm version
sorted first, so a seeded snapshot could stand in for a production one. It now pins
`PRODUCTION_INDICATOR_VERSION = "ta-v1"`, the same version the strategies pin through
their configuration.

**Verified by running it** (`npm run data:seed:core-instruments`, which runs all three
seeds):

- RSI `v1` went from **3742/3742 carrying the random signature** (a whole number in
  [40,70)) to a real 9.75–98.40 spread.
- Re-running the seeds only rewrites candles inside their current fetch window, so 379
  fabricated rows survived on older 1m candles that no future run would revisit.
  Migration **`013-purge-fabricated-rsi`** deletes them by that signature; **0 remain**.
  It is scoped to RSI (the seeds' other `v1` indicators were always real) and leaves
  all 38,284 `ta-v1` snapshots untouched.
- No `pattern_detections`, `model_predictions`, or `market_context_embeddings` rows were
  created (2585 / 110 / 0, all unchanged) — confirming the removed fabrications stay
  removed across a seed run.
- Candles were not corrupted: NIFTY50 1d 2026-07-30 is byte-identical after the run and
  still `source: yahoo`. Counts only grew as new bars were fetched (1m 3742→4064).

**Do not treat the fabrication signature as a live detector.** "A whole number in
[40,70)" identified the old `Math.random()` RSI, but a genuine RSI stored to two
decimals lands on an integer roughly 1% of the time — after the fix, **31 of 3748 rows
match the signature and every sampled one recomputes exactly**, verified against an
independent reimplementation. So a future run of that query reporting "31 fabricated"
is a false positive, not a regression. Migration 013 was therefore a one-time cleanup,
not a reusable check; on a fresh database it runs before any seeding and deletes
nothing.

### 3.6c `candles.source` now records the provider, not the script
`source` is provider provenance — the ingestion paths set it from `provider.id`, which
is where `'yahoo'` comes from. Both seeds fetch from Yahoo through `yahoo-finance2`
exactly like the real collector, but hardcoded `source = 'seed'`, so **4374 rows of
genuine Yahoo data had the column that exists to identify real market data naming the
script that wrote it instead.** "Which candles are real?" was unanswerable from it.

Fixed without losing the distinction: `source` is the provider, and the ingestion path
moved to `source_metadata` (`{"ingestedBy":"seed"}`), which is what that column is for.
Migration `014-correct-seed-candle-provenance` relabels the existing rows, merging
metadata rather than replacing it, and touches no price, volume, or timestamp.

`YAHOO_PROVIDER_ID` now lives in `market-data/domain/candle-provenance.ts` and the
Yahoo provider reads it from there, so the string has one definition rather than three.

### 3.6d The seeds no longer rewrite settled history
The more serious find. `PostgresCandleRepository.upsert` — the path all real ingestion
goes through — restricts its `ON CONFLICT ... DO UPDATE` with
**`WHERE candles.is_complete = FALSE`**, so a completed candle is immutable. Both seeds
ran their own raw upsert with **no such guard** while inserting `is_complete = TRUE`, so
a seed run could silently rewrite settled bars. The backtests and ML feature builders
read those exact rows, so results could move underneath them. That the 2026-07-30 candle
came back byte-identical on the earlier run was luck — both paths fetch from Yahoo — not
protection.

Both seeds now share `upsertSeedCandle`, which applies the same guard. Because the guard
makes the conflicting update return no row, the id is read back with a follow-up SELECT
rather than assumed from `RETURNING` — the previous inline version would have thrown on
`rows[0].id`. It also unifies the two seeds' update lists, which disagreed (the market
seed refreshed `open`, the scalp seed did not).

**Proven, not assumed.** A settled NIFTY50 1d candle was deliberately tampered to
`open=24000.00 close=24010.00`, the full seed was run, and the tampered values were still
there afterwards — the seed did not touch it. The sentinel was then restored to its real
values (23971.25 / 24041.15 / 23954.60 / 23985.35). Seeding still works normally: 9002
candles, all `source='yahoo'`, 4462 seed / 4540 collector, 0 incomplete.

Verified after a second seed run: **all 8964 candles are `source='yahoo'`**, split by
ingestion path into 4540 collector and 4424 seed. The seeds' `ON CONFLICT` clauses do
not update the provenance columns, so re-running cannot undo the relabel.

### 3.5 Deliberately skipped
**Phase 4 — a consumer for `auxiliary_model_predictions`.** Nothing reads that
table, so the promoted volatility model is currently inert plumbing. Wiring it into
position sizing or regime gating is where its value actually lands.

---

## 4. Decisions needed from the user

1. ~~**`rewardRiskMultiple` is still 1.0**~~ — **superseded by §3.4b.** It was framed
   as a friction question; the measurement says friction is not what is killing this
   strategy, since it loses at zero cost. Setting the geometry is no longer the
   decision that matters.
2. ~~**Archive the orphaned pre-v5 PRODUCTION models?**~~ — **done 2026-07-31**, see
   §3.3.
3. **Is the volatility model worth a consumer** (3.5), given its signal is
   persistence-dominated? **Still open, and now the highest-value open question** —
   with momentum-scalp dead on 1d and direction dead entirely, volatility expansion
   is the only measured signal in the repo, and nothing reads it.

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

- ~~**LightGBM is unusable on this machine**~~ — **resolved 2026-07-31.** The
  Application Control block (`WinError 4551`) is gone; lightgbm 4.7.0 imports and
  all 20 gradient-boosting tests pass. xgboost is no longer the only boosted option.
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
