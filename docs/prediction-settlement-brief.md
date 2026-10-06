# Next Session — Prediction Settlement (and why the model competition is on hold)

Paste this whole file as your prompt. It is self-contained and assumes no memory of the
2026-07-31 session that produced it.

---

## 0. READ THIS FIRST — verify before you trust

Two consecutive briefs in this project have gone stale and cost real time by being
believed. **Verify these numbers before acting on anything below**, and treat any
mismatch as "this brief is older than the tree", not "the tree is broken".

```bash
cd apps/api && npx tsc --noEmit && npx vitest run
```
Expect a clean typecheck and **285 passed / 48 files**.

```bash
py -3.12 -m unittest discover -s apps/ml -p "test_*.py"
```
Expect **`Ran 155 ... OK`** — zero failures. (LightGBM used to fail here with
`WinError 4551`; that machine policy no longer blocks it. Any ML failure is new.)

```bash
cd apps/web && npx tsc --noEmit     # expect clean
npm run db:migrate                  # expect all skipped, nothing applied
git log --oneline -3                # expect 5443c52, 5863627, 6974791
```

**Git state, verified 2026-07-31:**
- On branch **`feature/champion-challenger`**, at `5443c52`, **no upstream set**.
- `feature/FIIDII-giftnifty` is at the same commit and **is pushed** —
  `origin/feature/FIIDII-giftnifty == 5443c52`. Nothing is waiting to be pushed.
- Migrations **001–024**, all applied to the local DB. **The next migration is 025.**
  Two plans in a row have proposed a number that was already taken; check `ls` first.

---

## 1. The task: make predictions scorable

`model_predictions` is **write-only**. Nothing ever records whether a prediction was
right, so the system has never measured its own live accuracy — every claim about model
quality comes from a training-time holdout.

Build the settlement layer, and only that:

1. **Migration 025** — add `settled_at`, `realized_label`, `was_correct` to
   `model_predictions`. `realized_label` must use the same alphabet as `prediction`
   (BULLISH/BEARISH/NEUTRAL) and be nullable until settled.
2. **A settlement job** (TypeScript, run from the scheduler after the EOD data fetch).
   For each unsettled prediction whose outcome horizon has now closed: compute the
   realised forward return from candles, derive `realized_label`, set `was_correct` and
   `settled_at`.
3. **Reuse the trainer's labelling rule.** The neutral band and horizon must come from
   the same logic `apps/ml` uses to build training labels, not a reimplementation. If
   live scoring and training disagree about what "BULLISH" means, every number the
   settlement produces is uninterpretable. This is the single most important detail in
   the task.

**Then stop and look at the data** before building anything on top of it. The point of
settlement is to find out whether a directional edge exists at all. See §3.

### Three blockers to clear first

- **All 110 existing `model_predictions` rows are fabricated.** Every one carries the
  removed seed path's hardcoded `coefficient: 0.421` / `linearScore: 0.856`. Verify with:
  ```sql
  SELECT count(*) FROM model_predictions
  WHERE feature_contributions::text LIKE '%0.421%' OR explanation::text LIKE '%0.856%';
  ```
  Expect 110 of 110. **Purge them in migration 025.** Settling them would build the
  first accuracy figures the project has ever had entirely out of invented data.
- **Nothing writes predictions on a schedule.** `run-eod-pipeline.ts` has no predict
  step; those 110 rows came from ad-hoc runs. Settlement has no input until the EOD
  pipeline calls `ml:predict`. Add it.
- **`predict.py` refuses in-sample predictions.** It needs a model whose
  `data_cutoff_at` is after the snapshot time *and* an `--as-of` past a candle that
  closed later still. Working example is in `docs/next-session-brief.md` §6.

---

## 2. Do NOT build the champion–challenger competition yet

A full daily competition plan was reviewed on 2026-07-31 and **put on hold**. It is
good engineering; the problem is that its promotion gate cannot resolve the difference
it exists to arbitrate. Do not re-propose it without new evidence.

Measured against `train.py`'s own noise calibration (`train.py:62-73`, which states
SE(macro-F1) ≈ 0.10 at n=24 and that a 0.38 pass and 0.34 fail at that size *"are the
same measurement"*):

| the plan's rule | what it actually is |
|---|---|
| "SECONDARY wins 5 of last 7 days" | a coin flip clears it **22.7%** of the time |
| evaluated daily, overlapping windows | **~54%** chance of a spurious promotion per month |
| `+0.02` rolling macro-F1 margin | **0.46 SE** of the difference it tests (SE = 0.044 at 250 settled) |
| margin needed to be a 2-SE filter | **0.088** |
| measured gap, best directional model vs trivial | **0.059** |

The last two rows are the whole objection: **a statistically meaningful margin is larger
than the entire edge available to detect.** No tuning of the streak length or margin
fixes that — it is a sample-size problem, and the fix is more instruments and timeframes,
not a shorter window.

Its entry gate has the same flaw. `macro-F1 ≥ 0.38` admits, from the real candidates:

```
macroF1   n    dirPreds  dirHit
0.5152    19       17    0.588   <-- clears 0.38
0.4023    24        8    0.250   <-- clears 0.38
```

That second row is the exact case `train.py:62` documents as a false pass. The pool would
fill with small-sample flukes, then rank them on ~25 predictions/day.

**Parts of the plan that were right, and worth keeping when it does get built:** putting
`role` in a separate `model_competition_state` table rather than on `model_versions` (it
avoids breaking the one-PRODUCTION-per-key constraint and the Python promote
transaction); reusing the trainer's neutral-band rule for settlement; a ≥60 settled
minimum mirroring `MINIMUM_VALIDATION_ROWS`; and leaving a demoted champion in the pool.

---

## 3. What settlement is actually for

Read this before deciding what to build after the job runs.

**Direction prediction has been measured dead three independent ways.** Every one loses
to the trivial always-predict-the-majority-class strategy — which is the comparison that
matters, not the 0.333 random baseline:

| approach | result |
|---|---|
| fixed-horizon h5, logistic | macro-F1 0.2374, dirHit 0.303 vs **trivial 0.366** |
| triple-barrier (several geometries) | higher macro-F1 is a class-balance artifact; trivial crushes it on dirHit |
| k-NN / RAG retrieval over real context | loses to trivial on accuracy; **label-shuffle control scores the same** |

**The one signal that works is volatility expansion** — macro-F1 ~0.44 vs trivial ~0.17,
holding across all 4 walk-forward folds, collapsing under label shuffle. It is
non-directional: a position-sizing and regime-gating signal, consumed by the risk engine
(`evaluateRisk`), never a reason to pick a side.

So the honest expectation for settlement: **it will probably confirm that live
directional accuracy does not beat trivial.** That is a useful result and the reason to
build it — it replaces a training-time holdout score with live evidence, and it is the
measurement that would detect an edge *if one appeared*. Build it to learn the answer,
not to enable a tournament.

After 4–6 weeks of settled predictions, compare live accuracy against the trivial
baseline **on accuracy as well as macro-F1**. macro-F1 rises mechanically as classes
become less degenerate; that alone made triple-barrier look like an improvement when it
was not.

---

## 4. Invariants — do not break these

- **The two label alphabets must stay disjoint.** `DIRECTIONAL_ALPHABET`
  (BEARISH/NEUTRAL/BULLISH) and `VOLATILITY_ALPHABET` (CONTRACTION/STABLE/EXPANSION).
  Directional predictions live in `model_predictions`; non-directional ones in
  `auxiliary_model_predictions`. A volatility label reaching `model_predictions` would be
  read as a trade direction by the strategy engine, the agent, the scanner, and the
  dashboard. `realized_label` must be constrained to the directional alphabet.
- **`ml-feature-v5` / `ml-feature-scalp-v2` are immutable ordered column contracts.**
  Adding or removing a column requires a new version string.
- **A model key carries only the parameters that shape its own scheme's target.**
- **Point-in-time or it is leakage.** Settlement reads candles that closed *after* the
  prediction; that is correct and is the whole point. But nothing that *produces* a
  prediction may read past its `evidence_cutoff_at`. The existing guards to copy:
  `PostgresRiskStateRepository.findVolatilityRegime` (`evidence_cutoff_at <= asOf`) and
  `PostgresIndiaVixImpliedVolatilitySource` (`close_time <= asOf`, settled only).
- **`persistence_dominated=True` is only for non-directional targets.** For a directional
  target, low feature-lag degradation really is a leakage smell and must FAIL.
- A `strategy_versions` configuration is immutable — changing `momentum-scalp`'s config
  requires bumping `momentumScalpStrategyVersion`.

---

## 5. Environment traps (each looks like a code bug and is not)

- **Postgres is live** at `postgresql://localhost:5432/ai_quant_lab`. `DATABASE_URL` is in
  `.env`, `apps/api/.env`, `apps/ml/.env` but is **not exported**, so scripts must
  `load_dotenv`. Do not conclude there is no database — check.
- Running ML scripts by path needs `PYTHONPATH=apps/ml`.
- **`data_cutoff_at` silently gates indicator snapshots.** A cutoff earlier than the
  snapshot run yields evidence with zero ATR, which makes label builders skip every
  candle and produce zero examples. Looks like a loader bug; it is a cutoff choice.
- **The seeds fetch real Yahoo data.** `candles.source` is the provider (`yahoo`);
  `source_metadata.ingestedBy = 'seed'` records that a seed run wrote the row. Seeds
  cannot overwrite settled candles — `upsertSeedCandle` applies the same
  `is_complete = FALSE` guard as the real repository.
- **A "whole number in [40,70)" RSI is no longer a fabrication signature.** It was, before
  the random-RSI seeds were fixed; now ~1% of genuine values land there by coincidence
  (31 of 3748 at last count). Do not read that query's output as a regression.

---

## 6. Two facts still unconfirmed, recorded as such

Both are in the database as `ASSUMED`, and `resolveWeeklyExpiryWeekday` refuses to derive
an expiry from an unconfirmed weekday, so nothing can silently act on them:

| instrument | `weekly_expiry_weekday` | `weekly_expiry_source` |
|---|---|---|
| NIFTY50 | 4 (Thursday) | ASSUMED |
| BANKNIFTY | 3 (Wednesday) | ASSUMED |

BANKNIFTY's value additionally asserts that it *has* a weekly series, which is the fact
actually in doubt. Nothing reads either value today, so no fix is needed until someone
wants a "next weekly expiry" convenience feature. To promote one:

```sql
UPDATE instruments SET weekly_expiry_weekday = 4, weekly_expiry_source = 'CONFIRMED'
WHERE symbol = 'NIFTY50';
```

Separately, **BANKNIFTY's lot size is 30 on a best reading, not confirmed.**
`assessContractSize` flags any lot whose implied notional leaves the ₹15–20 lakh band, so
a stale value surfaces on its own. It is a data correction, not a code change.

---

## 7. Method notes that produced every real result here

1. **Always compare against the trivial majority-class predictor**, not the random
   baseline. macro-F1 rises mechanically when classes become less degenerate.
2. **Measure before building infrastructure.** The triple-barrier track had its full
   pipeline built and *then* was shown to have no edge; the volatility track measured
   first with a throwaway harness and cost a fraction as much.
3. **Run a new diagnostic against real data immediately.** The first output is where its
   blind spots show — the trade-review tagging had a gap that only appeared on the first
   real run, and a "worthless option" test case took three attempts because the strike
   snapping kept the contract at the money.
4. **A plausible number is indistinguishable from a correct one.** Most of this project's
   worst bugs were not crashes: hash-noise embeddings driving a constant ±15% confidence
   bias, a random RSI stored as a measurement, fabricated SHAP rows attributed to a real
   model, a `Math.random()` backtest series. When a value cannot be verified, record that
   it cannot — `ASSUMED`, `NULL`, `REGIME_UNAVAILABLE`, `NO_HOLDING_PERIOD_DATA` — rather
   than letting a guess wear the shape of a fact.
