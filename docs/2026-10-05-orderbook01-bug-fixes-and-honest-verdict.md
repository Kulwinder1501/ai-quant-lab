# ORDERBOOK-01: Two Confirmed Bugs Fixed, Honest Re-Derived Verdict is CASE E (FALSIFIED)

> **Document Type:** Defect Fix + Re-Derived Verdict Report
> **Date:** October 5, 2026
> **Status:** `ORDERBOOK01_LIVE_GATE_ENABLED` stays OFF. No code change to that flag is part of this fix.
> **Scope:** `apps/ml/run_orderbook01_oos.py` (statistical methodology), `apps/api/src/modules/strategy-engine/domain/orderbook-directional-gate.ts` (Tier-2 sign convention).

---

## 0. Why this document exists

An independent audit of ORDERBOOK-01 found two confirmed bugs in the code that produced the
2026-10-01 re-derivation (commit `c7a5a8a`, `fix(ml,api): resolve orderbook DI attenuation bug and
enable ORDERBOOK01_LIVE_GATE_ENABLED`). That commit re-enabled the live gate on the strength of an
H1-M "PASS" at 96.8% accuracy — a number that is actually *below* the 97.3% trivial baseline for
that same population. The live gate was already reverted to OFF before this fix started (both in
the running deployment and in the main checkout's `.env`); that revert is not part of this change.
This document fixes the two underlying bugs properly and re-derives the verdict honestly, following
this project's standing rule: the result is reported as it comes out, not spun positive
(`docs/2026-09-28-hybrid-liquidity-confluence-v1-validation.md` §4 is the house example of this —
an in-sample pass being reported as a pass with its caveats intact; this document is the opposite
case, a fix that makes a previously-reported pass become a real fail, reported the same way).

## 1. Bug 1 — wrong statistical null hypothesis

### What was wrong

`evaluate_h1_r` / `evaluate_h1_m` in `apps/ml/run_orderbook01_oos.py` tested model accuracy with
`stats.binomtest(successes, n, 0.50, alternative="greater")` — a one-sided test against a 50/50
coin-flip null. The labels these hypotheses score are heavily class-imbalanced, not 50/50:
confirmed directly against the live DB (`ai-quant-lab-db-v2`, port 5433), PDL's 30-second-horizon
breach rate is **97.28%** (4,299/4,419), and the six Tier-1 level types individually sit at
84–97% base rates. Against a 0.5 null, a constant always-predict-the-majority-outcome classifier
*also* reports `p ≈ 0.0` — the test cannot distinguish a real edge from doing nothing. That is
exactly how the 2026-10-01 run's H1-M reported 96.8% accuracy as "PASS": it cleared the 0.78
absolute floor and p≈0 against 0.5, while silently sitting below the 97.28%-ish trivial baseline
for that population.

This project has an established convention for exactly this failure mode: `apps/ml/train.py`'s
`trivial_majority_metrics` (see its docstring) scores an always-predict-the-training-majority
baseline and compares every model against it, explicitly because "a model can post a higher
macro-F1 than a previous attempt purely because its classes are better balanced while still being
beaten by a constant predictor." ORDERBOOK-01's H1-R/H1-M tests had never been brought in line
with that convention.

### The fix (`apps/ml/run_orderbook01_oos.py`)

Two new helpers, used by both `evaluate_h1_r` and `evaluate_h1_m`:

- **`trivial_baseline_rate`** — computes the always-predict-the-majority-outcome baseline directly
  from the same evaluated population (mirrors `train.py`'s convention, applied here in-sample
  since there is no separate train/validation split in this OOS evaluator).
- **`mcnemar_one_sided_p`** — a one-sided **exact McNemar test** comparing the model's paired
  correctness against the trivial baseline's paired correctness on the *same* events.

**Why McNemar's test, not a one-sample binomial test against the baseline rate:** the model and
the trivial baseline are scored on the exact same events, so their correctness is correlated —
both tend to be right together whenever an event lands on the majority side, and that shared
correctness carries zero information about whether the model adds anything. A one-sample test
(whether against 0.5 or against the baseline rate treated as an independent null proportion)
cannot see that correlation, and can call a result "significant" purely because concordant-correct
pairs pile up for both sides — which is exactly how the old 50/50-null test let a below-baseline
PDL accuracy through as `p ≈ 0`. McNemar's test strips out the concordant pairs (where model and
baseline agree, right or wrong) and looks only at the discordant ones — cases where exactly one of
the two was correct — asking whether the model wins those more often than chance (`p = 0.5`). That
is precisely "does the model beat this specific majority-class baseline on this specific sample,"
which reduces to an exact binomial test on the discordant count (`binomtest(n10, n10+n01, 0.5,
alternative="greater")`), so no new dependency (e.g. `statsmodels`, not in `apps/ml/requirements.txt`
and not installed in this environment) was needed — `scipy.stats.binomtest`, already imported by
this script, is sufficient. Full reasoning is in the code comment above `mcnemar_one_sided_p`
(`apps/ml/run_orderbook01_oos.py`).

Applied to every hypothesis that previously used the 0.5 null: `evaluate_h1_r` (overall and all six
per-level checks) and `evaluate_h1_m`. `evaluate_h2` (the monotonicity/quartile-lift test) was left
unchanged — it was never testing raw accuracy against a null proportion; it tests whether DI
*magnitude* predicts correctness via a permutation test on Spearman correlation, which is a
different, already-appropriate question and not affected by this bug.

Both the absolute pre-registered accuracy floor (H1-R: 0.72, H1-M: 0.78) and the new
baseline-relative check (`acc_gt_trivial_baseline`, McNemar `p <= 0.01`) are now required for a
PASS — the absolute floor alone is exactly what let a below-baseline accuracy through before.

## 2. Bug 2 — Tier-2 sign mismatch between the Python validator and the deployed gate

### What was wrong

`apps/ml/run_orderbook01_oos.py`'s `match_events_to_depth` applies `di_tilde = -di` **uniformly**
to every matched event, Tier 1 and Tier 2 (PDL) alike — confirmed via `git log --follow -p`
on this script: the line `di_tilde = -di` has been unconditional since the function was introduced
(commit `cd02381`, 2026-09-26) and has never had a tier-conditional branch. The module docstring
states "DI_tilde = -DI" for both the Tier 1 and Tier 2 sections.

`apps/api/src/modules/strategy-engine/domain/orderbook-directional-gate.ts`
(`resolveConfluenceSignalFromDepth`), by contrast, had `const diTilde = isTier1 ? -rawDi : rawDi;`
— negating only for Tier 1 and leaving Tier 2 (PDL) on the raw, un-negated sign. This line was
introduced later (commit `8f9930a2`, 2026-09-28, `isTier1 ? -decayingDi : decayingDi`, then
retargeted to `rawDi` in `c7a5a8a`) with no commit message or code comment explaining the
asymmetry, and `git log --follow -p` on the whole file turns up no documented rationale at any
point in its history. This was a bug introduced when the TS gate was built, not a deliberate
divergence from the Python validator it is supposed to implement: the deployed gate applied the
**opposite** sign convention for PDL relative to what was actually backtested, independent of
whatever the OOS verdict says.

### The fix (`apps/api/.../orderbook-directional-gate.ts`)

```ts
// DI_tilde = -DI uniformly across BOTH tiers, matching the frozen OOS validator
// (apps/ml/run_orderbook01_oos.py: `di_tilde = -di` in match_events_to_depth, applied to
// Tier 1 and Tier 2/PDL alike)...
const diTilde = -rawDi;
```

The downstream direction-interpretation branches (`isTier1` controlling which structural
meaning — "rejection" vs. "sweep" — a positive `diTilde` implies) are unchanged; only the sign
computation is now uniform, matching the Python validator exactly.

### New test coverage

`orderbook-directional-gate.test.ts` had zero references to `isTier1`, `PDL`, `rawDi`, or
`diTilde` before this fix — `resolveConfluenceSignalFromDepth`, where the bug lived, had no test
coverage at all. Four new tests were added under
`describe("resolveConfluenceSignalFromDepth DI_tilde sign convention")`:

1. Tier 1 (`SESSION_HIGH`) with sell-dominant depth (`rawDi = -0.6`) negates to `diTilde = +0.6`
   and flags `BEARISH_REJECTION` / `BUY_PUT_OR_SHORT`.
2. Tier 2 (`PDL`) with the **same** sell-dominant depth now also negates to `diTilde = +0.6` and
   flags `BEARISH_SWEEP` / `BUY_PUT_OR_SHORT` — this is the regression test that would have caught
   the original bug: before the fix, Tier 2 used the raw, un-negated DI, so `diTilde` would have
   stayed `-0.6`, failed the `diTilde > 0` check entirely, and silently reported `NO_ACTION`/`NONE`
   instead of a sweep signal.
3. Tier 1 and Tier 2 given the *same* buy-dominant depth snapshot now agree in sign
   (`diTilde = -0.6` for both) — pinning "uniform negation" as an explicit, direct comparison.
4. Tier 1 `SESSION_LOW` (opposite level direction) with sell-dominant depth flags
   `BULLISH_REJECTION` / `BUY_CALL_OR_LONG`, confirming the fix didn't disturb the existing,
   already-correct Tier-1 interpretation.

All 12 tests in the file pass (8 pre-existing + 4 new).

## 3. Honest re-derived verdict

Re-run for real against the live DB (`ai-quant-lab-db-v2`, port 5433) with the corrected
methodology, using today's actual date (2026-10-05) as the end of a genuinely fresh OOS window:

```
python apps/ml/run_orderbook01_oos.py --start-oos 2026-09-26 --end-date 2026-10-05 --eval-mode oos
```

```
================================================================================
ORDERBOOK-01 FORMAL PRE-REGISTERED EVALUATION ENGINE
================================================================================
Database Contact Events Window: 2026-01-01 to 2026-10-01
Evaluation Window: OUT-OF-SAMPLE (2026-09-26 to 2026-10-05)
--------------------------------------------------------------------------------
Fetching Tier 1 events (300s horizon)...
-> 1567 Tier 1 events fetched.
Fetching Tier 2 events (30s horizon)...
-> 4296 Tier 2 (PDL) events fetched.
Matching depth frames across 4 trading sessions...
-> Matched 1548 Tier 1 events and 4278 Tier 2 events.
================================================================================

HYPOTHESIS EVALUATION SUMMARY
--------------------------------------------------------------------------------
H1-R (Tier 1 Reversal Accuracy): [FALSIFIED]
  N: 1548 | Accuracy: 82.9% | Trivial baseline: 89.1% | McNemar p (vs baseline): 1.000000
  Level Types Passed: 0 / 6
    - ITL         : N= 124 | Acc= 89.5% | Baseline= 91.1% | p=1.0000 [FAIL]
    - SESSION_HIGH: N= 222 | Acc= 58.6% | Baseline= 87.4% | p=1.0000 [FAIL]
    - SWING_LOW   : N= 253 | Acc= 92.5% | Baseline= 95.7% | p=1.0000 [FAIL]
    - SWING_HIGH  : N= 257 | Acc= 88.3% | Baseline= 93.8% | p=0.9996 [FAIL]
    - ITH         : N= 117 | Acc= 83.8% | Baseline= 91.5% | p=0.9936 [FAIL]
    - SESSION_LOW : N= 575 | Acc= 84.0% | Baseline= 84.0% | p=1.0000 [FAIL]

H1-M (Tier 2 Momentum PDL Accuracy): [FALSIFIED]
  N: 4278 | Accuracy: 99.1% | Trivial baseline: 99.7% | McNemar p (vs baseline): 1.000000

H2 (DI Monotonicity Lift): [FALSIFIED]
  N: 5826 | Q4-Q1 Lift: +5.3 pp | Permutation p: 0.000000
  Quartile Accuracies (Q1->Q4): [88.7, 98.8, 97.8, 94.0]
================================================================================
FINAL VERDICT: CASE E
Details: FALSIFIED. No robust directional edge found in OOS test.
================================================================================
```

Full machine-readable output: `apps/ml/orderbook01_verdict.json` (`executed_at:
2026-10-05T11:14:18+05:30`).

### Reading this plainly

- **Every single hypothesis's model accuracy is now shown to sit *below* its real trivial
  baseline**, not just below the pre-registered absolute floor. H1-M's 99.1% looks strong in
  isolation; it is worse than the 99.7% you get by always predicting "breach" on this population.
  All six Tier-1 level types individually fail the same way — `SESSION_LOW` is the starkest case
  (84.0% model accuracy *exactly equal* to its 84.0% baseline — zero discriminative value, 0
  discordant pairs in the model's favor).
- H2 (monotonicity) also falsifies on its own pre-registered bar: `Q4-Q1 Lift = +5.3pp` is below
  the required `>= 8pp`, even though its permutation p-value is formally significant — the lift
  is real but too small to clear the pre-registered practical-significance threshold.
- Sample sizes are also thinner than the frozen pre-registration calls for: Tier 1 N=1,548 vs. the
  required 3,000 (database labels currently run through 2026-10-01; the requested window's tail
  end, 10-02 through 10-05, has no labeled events yet — this is a data-coverage fact, not a defect
  in this fix). Tier 2 N=4,278 clears its 1,000 floor.
- This reconfirms the CASE E verdict the 2026-09-28 run (pre-dating the two bugs' introduction/
  entrenchment) had already found, this time with a methodology that cannot be gamed by label
  imbalance and a gate implementation that matches what was actually tested.

**Verdict: CASE E — FALSIFIED. No robust directional edge found in OOS test.** This is reported
as-is, not spun. `ORDERBOOK01_LIVE_GATE_ENABLED` remains OFF; re-enabling it is a separate decision
for the user to make explicitly, not something this fix does.

## 4. What shipped as a result

- `apps/ml/run_orderbook01_oos.py`: `trivial_baseline_rate` + `mcnemar_one_sided_p` helpers;
  `evaluate_h1_r` and `evaluate_h1_m` rewritten to test against the real majority-class baseline
  via one-sided exact McNemar instead of a 50/50 binomial null; module docstring and print
  statements updated to report baseline accuracy and the corrected p-value alongside the headline
  numbers.
- `apps/api/src/modules/strategy-engine/domain/orderbook-directional-gate.ts`:
  `resolveConfluenceSignalFromDepth` now negates DI uniformly (`diTilde = -rawDi`) for both tiers,
  matching the Python validator.
- `apps/api/src/modules/strategy-engine/domain/orderbook-directional-gate.test.ts`: 4 new tests
  pinning the Tier-1/Tier-2 sign convention (none existed before).
- `apps/api/src/modules/strategy-engine/domain/options-entry-validator.ts`: kill-switch comment
  updated to reference this document and the corrected methodology instead of the stale
  2026-09-28/2026-10-01 history.
- `apps/ml/orderbook01_verdict.json`: overwritten with the honest 2026-10-05 re-derivation (CASE E).
- No change to `ORDERBOOK01_LIVE_GATE_ENABLED` in any `.env` file, and no change to
  `apps/api/src/interfaces/cli/bot-sandboxes.ts`, `run-backtest.ts`, or either `entry-filters` file
  (out of scope for this fix).

## 5. What would need to happen before this could ever go live

Per this project's own standard: a genuine PASS under the corrected methodology, on a properly
powered OOS window (Tier 1 needs N >= 3,000 — currently 1,548), replicated rather than patched into
existence. Nothing in this document is grounds to revisit that; if anything, the corrected
methodology has now falsified ORDERBOOK-01 twice, with the fixed implementation and the fixed
test agreeing on the result.
