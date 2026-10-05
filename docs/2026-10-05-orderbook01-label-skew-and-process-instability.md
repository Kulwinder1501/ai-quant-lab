# ORDERBOOK-01: Why the Edge Keeps Appearing and Disappearing — Label Skew, a Fourth Unfixed Bug, and an Unstable Research Process

> **Document Type:** Root-Cause Investigation (follow-up to the same-day bug-fix report)
> **Date:** October 5, 2026
> **Status:** `ORDERBOOK01_LIVE_GATE_ENABLED` stays OFF. This document does not change that flag.
> **Scope:** Read `docs/2026-10-05-orderbook01-bug-fixes-and-honest-verdict.md` first — it fixed two real
> bugs (wrong null hypothesis, Tier-2 sign mismatch) and re-derived CASE E. This document asks the
> deeper question the user actually posed: why did this strategy look like it had an edge at all, three
> separate times, and is there a structural reason that keeps happening — not just "are today's numbers
> right."

---

## 0. Summary of findings

1. **The original "CASE A — FULL EDGE CONFIRMED" claim (2026-09-25/26) was not invented from nothing.**
   Its headline numbers (83.1% / 79.4% / +23.6pp) are exactly reproducible from a real code path
   (`run_orderbook01_oos.py --eval-mode calibration`) run against real data. The defect was not
   fabrication of numbers — it was reporting an **in-sample calibration run**, scored against a **50/50
   null that cannot distinguish a real edge from a skewed label**, under a document header
   ("FROZEN PRE-REGISTRATION & PRODUCTION WIRED") that implied a validated, OOS-tested result. The
   correction banner acknowledging this was added into the *same file*, the *next day*.
2. **A fourth bug, still unfixed as of this writing: the OOS evaluator never applies its own label's
   `is_active_candidate` guard.** That guard was purpose-built (see `generate-contact-labels.ts`'s own
   docstring) to exclude candidates where price is already within 20bps of the level at the moment it
   becomes knowable — "the outcome is ambiguous... rather than contaminating the label." For PDL, 98.3%
   of all labeled rows (186,540 / 189,844) fail this guard and are still scored. Restricting to the
   intended clean population drops PDL's breach-given-contact rate from the 86-99% range (which the
   contaminated population shows, varying by month/window) down to **72.2%** (929 contacted of 3,304
   active candidates, 671 breaching) — still skewed, but a materially less degenerate test than any
   verdict this project has reported to date.
3. **H2 (DI-magnitude monotonicity) has, in fact, passed cleanly once — in the calibration window, under
   today's fully-corrected statistics.** Rerunning `run_orderbook01_oos.py --eval-mode calibration` with
   the current code (both bugs fixed) gives **H2: PASS, N=46,539, Q4-Q1 lift = +66.8pp**
   (quartile accuracies 22.2% -> 73.0% -> 86.2% -> 89.0%, permutation p=0.000000) — a dramatic, clean,
   textbook-monotonic result. That same rerun still falsifies H1-R (73.9% vs 94.5% baseline) and H1-M
   (64.1% vs 90.6% baseline). **This +66.8pp calibration-window result has never once replicated
   out-of-sample**: every OOS measurement taken to date — the `decaying_di` era (+12-13pp, barely over
   the 8pp bar only under a feature that was later reverted as buggy), and raw_di OOS on 10-01 (+2.4pp)
   and 10-05 (+5.3pp) — falls far short. This is the textbook signature of overfitting to the window a
   strategy was calibrated on, not evidence of a real, exploitable monotonicity effect.
4. **DI shows no hidden edge on the harder, less-degenerate cases either.** The corrected McNemar test's
   discordant-pair counts (cases where the model and the trivial baseline disagree — exactly the subset
   where the baseline's dominance doesn't automatically decide the outcome) show the model **losing**
   these cases by a wide margin: 18 model-wins vs. 115 baseline-wins for Tier-1 (reversal), 2 vs. 25 for
   PDL. If DI carried real information specifically on the minority-outcome cases, model-wins would
   exceed baseline-wins on this subset; instead it loses by 6x (Tier-1) and 12.5x (PDL). This is a direct,
   computed answer to "is there a cleaner signal hiding underneath the noise" — there is not, not in this
   feature, not in this label.
5. **The theoretical premise this whole program was built on (STRUCTURE-01: 15bps-bandwidth volatility
   expansion near structural levels, cited in the 2026-09-25 doc as "prior research") has no independent
   validating document anywhere in this repository.** It is asserted, not shown, in the one doc that also
   made the fabricated CASE A claim. This cannot be verified as real or invented from what is available
   here, and that is reported plainly rather than assumed either way.

---

## 1. Reconstructed timeline with proximate cause (verified against git history and the live DB)

| Date | Commit(s) | Verdict claimed | Feature | Null test | TS/Python sign match? | What actually caused this verdict |
|---|---|---|---|---|---|---|
| 09-25/09-26 | `cd02381` | **CASE A** ("FULL EDGE CONFIRMED") | raw_di | 50/50 binomial | n/a (TS gate not wired to real depth yet) | Real code, real data, **calibration window = Jan 1-Sep 25 (in-sample)**, 50/50 null cannot reject a skewed-label constant classifier. Reported as "PRODUCTION WIRED" despite zero OOS evidence. |
| 09-26 (same day) | `11b3fc8`, `2f92372` | Corrected to INSUFFICIENT_DATA / early CASE E | raw_di | 50/50 | n/a | Real OOS backfill, N=11 (10 Tier-1, 1 PDL) — far below pre-registered floor; banner added acknowledging the calibration-only nature of CASE A. |
| 09-28 | `8f9930a` | (feature change, no new verdict yet) | **decaying_di** | 50/50 (unchanged) | **Bug introduced here**: `isTier1 ? -rawDi : rawDi` — asymmetric negation, undocumented | New feature (distance-weighted EMA of depth) swapped in for both the Python evaluator and the TS gate. |
| 09-28 | `9aab9e4` | Kill switch added, default OFF | — | — | — | Precaution following repeated CASE E. |
| 09-29 -> 10-01 | (nightly runs) | **CASE E every day** | decaying_di | 50/50 | asymmetric (gate was off, so never executed live) | Genuinely poor accuracy under this feature: H1-R 40-48%, H1-M 58%, both **below the 70-78% floor and often below 50%**. Notably, **H2 passed cleanly under decaying_di** (+12.4pp to +13.3pp, N growing 1,438 -> 4,997, p formally significant) — a real, non-buggy result for this feature, just not strong enough combined with H1's failure to produce anything tradeable. |
| 10-01 | `c7a5a8a` | **CASE D** ("PDL Momentum Edge Confirmed"), live gate enabled | raw_di (reverted) + 1-second lookahead bug fixed | **50/50 (not yet fixed)** | asymmetric bug still present | H1-M's 96.8% accuracy cleared the 50/50 null (p~=0) and the absolute 0.78 floor — but sat *below* the real ~97%+ trivial baseline for this population. The one-sided 50/50 test cannot see that. H2 fell to +2.4pp under raw_di (correctly falsified on its own terms). |
| 10-01 (same evening) / independent audit | — | Both remaining bugs found | — | 50/50 null found wrong; TS/Python sign mismatch found | — | Audit, not a scheduled run. |
| 10-05 | `aca8136`, `b8f78f7`/`1e8e041`, `e53bf41` | **CASE E** (re-confirmed), gate stays OFF | raw_di | **trivial-baseline + one-sided exact McNemar (fixed)** | **uniform `-rawDi` (fixed)** | Every hypothesis now falls below its real majority-class baseline; H2's lift (+5.3pp) is below the pre-registered 8pp bar despite a significant p-value. Independently reproduced by this investigation, byte-for-byte. |
| 10-05 (this document) | — (diagnostic reruns only, no code change) | N/A — diagnostic | raw_di | fixed (McNemar) | fixed | Calibration-window rerun under fully-fixed code: H1-R/H1-M still falsify; **H2 passes dramatically in-sample (+66.8pp, n=46,539)** — confirming the in-sample/OOS gap is real and large, not an artifact of any of the three already-fixed bugs. |

**Reading this table:** three different "it looks like it works" moments (CASE A, the `decaying_di`-era H2
near-passes, CASE D) each trace to a *different* one of three mechanisms — in-sample evaluation, a null
test that cannot see label skew, and a sign convention that silently diverged between the tested code and
the deployed code. That is not one bug recurring; it is three independent ways this specific evaluation
pipeline has produced an over-optimistic read, each only caught after the fact. The fourth
(`is_active_candidate` not being applied) has not yet produced a false verdict as far as this
investigation found, but it has never been fixed either, and it inflates every baseline PDL has been
tested against so far.

---

## 2. Is the breach/sweep label degenerate? (real numbers, live DB)

`generate-contact-labels.ts` computes two nested thresholds from the **same** forward 1-minute candle(s):
"contact" (price gets within 10bps of the level) and "breach" (price goes 5bps *beyond* the level) —
both measured over the same horizon window (30s for PDL, 300s for Tier-1), both anchored to the fixed
`known_at_time`. For PDL specifically, 99.9% of candidate rows have **exactly one** 1-minute candle inside
the 30-second window (189,850 of 192,340), i.e. contact and breach are usually decided from a single bar's
low against two prices only 15bps apart.

Querying `liquidity_contact_labels` directly against the live DB (`ai-quant-lab-db-v2`, port 5433):

| Population | n active | n contacted | breach given contact |
|---|---|---|---|
| PDL, all rows, no `is_active_candidate` filter (full history) | — | 187,012 | **92.28%** |
| PDL, restricted to the `is_active_candidate = TRUE` guard the label schema defines | 3,304 | 929 | **72.23%** |
| PDL, per-month breakdown (contacted=TRUE -> breached), unfiltered | — | 14,134-35,471/mo | ranges 83.4%-98.3% across 10 months |

The gap between 92-98% (what every verdict to date has actually been scored against) and 72% (what the
label's own design says the population *should* be) is explained structurally: `generate-liquidity-
candidates.ts`'s invalidate/re-register loop immediately re-emits a new PDL candidate the instant the old
one is breached, at the bar where the breach just happened — meaning the new candidate's reference price
is, by construction, already very close to the new level. `is_active_candidate` exists precisely to filter
these out ("if price is already at the pool, the outcome is ambiguous ... rather than contaminating the
label" — the schema's own docstring), but the evaluator's `fetch_contact_events` SQL filters only on
`contacted = TRUE`, never on `is_active_candidate`. 98.3% of all PDL label rows fail that guard and have
been included in every verdict run to date regardless.

For Tier-1 levels, the picture is different and more benign: contact itself is close to tautological for
`SESSION_HIGH`/`SESSION_LOW` specifically (100% contact rate even restricted to `is_active_candidate = TRUE`,
because a rolling intra-session extreme is, by construction, a price level the market was just at) — but
**breach given contact is not** degenerate in the same direction: 5.0-11.8% across all six Tier-1 level
types (active-only, per-type query against the live DB). Rejection dominating 84-97% of the time at
structural levels is a plausible, real market-structure fact (this project's own `STRUCTURE-01`/volatility
work and the separate `hybrid-liquidity-confluence-v1` validation both treat "levels usually reject on
first test" as the baseline, not a label artifact), not obviously a tautology of how the label is built.

**Verdict on degeneracy: partially yes, and previously undocumented.** PDL's label is not exactly
tautological (the clean, `is_active_candidate`-respecting population still shows a real but much less
extreme 72%/28% skew, not 97%/3%), but every verdict produced by this evaluator to date — CASE A, CASE D,
and the 10-05 CASE E re-derivation — was scored against a baseline inflated by a labeling-guard omission
nobody had caught. Tier-1's "contact" concept is near-tautological by construction, but the quantity that
actually matters for trading (breach vs. rejection) is not, which is the more important of the two for
assessing whether this is "a dead program" vs. "a program with a specific, fixable measurement flaw."

---

## 3. H2 across the whole history — has DI-magnitude monotonicity ever held up?

| Window | Feature | Null/stat | N | Q4-Q1 lift | Verdict |
|---|---|---|---|---|---|
| Calibration (Jan 1-Sep 25), original 09-26 run | raw_di | old (irrelevant to H2) | 5,159 | +23.6pp | PASS |
| OOS, early backfill (09-26) | raw_di | — | 11 | n/a | INSUFFICIENT_DATA |
| OOS, `decaying_di` era (09-29) | decaying_di | permutation (unaffected by null bug) | 1,438 | +12.4pp | PASS |
| OOS, `decaying_di` era (09-30) | decaying_di | permutation | 3,098 | +13.3pp | PASS |
| OOS, `decaying_di` era (10-01, pre-fix) | decaying_di | permutation | 4,997 | +12.6pp | PASS |
| OOS, raw_di restored, pre-sign-fix (10-01, `c7a5a8a`) | raw_di | permutation | 6,411 | +2.4pp | FALSIFIED |
| OOS, fully fixed (10-05, official) | raw_di | permutation | 5,826 | +5.3pp | FALSIFIED (below 8pp bar; p is significant but effect is too small) |
| **Calibration, rerun today under fully-fixed code (this document)** | raw_di | permutation | **46,539** | **+66.8pp** | **PASS** (quartile accuracies 22.2% / 73.0% / 86.2% / 89.0%) |
| **All-history, rerun today, `is_active_candidate = TRUE` only (this document)** | raw_di | permutation | **735** | **+57.7pp** | **PASS** (quartile accuracies 33.7% / 34.1% / 89.2% / 91.4%) — same conclusion holds on the clean population from Section 2 |

H2 is the test the user correctly flagged as structurally less vulnerable to label skew (it is a
within-event comparison by `|DI|` magnitude, not an absolute-accuracy-vs-base-rate test), and it is also
the one hypothesis that has shown a real, large, statistically unambiguous pass — but **only ever in
broad historical windows**, and that pass has gotten *smaller*, not larger, every time it has been
re-measured on new, genuinely out-of-sample data (+66.8pp in-sample -> +12-13pp under a since-abandoned
feature -> +2.4pp -> +5.3pp under the feature now considered correct).

This is not an artifact of the `is_active_candidate` gap from Section 2 either: rerunning
`--eval-mode all` (full Jan-Oct history) *with* the `is_active_candidate = TRUE` guard applied gives
H2 **PASS, N=735, Q4-Q1 lift = +57.7pp** (quartiles 33.7% / 34.1% / 89.2% / 91.4%, p=0.000000) — still a
huge effect, on the intended clean population (H1-R and H1-M still falsify completely on this same clean,
depth-matched population: N=627 Tier-1 at 56.0% vs. 95.5% baseline, N=108 PDL at 100% vs. 100% baseline —
no discriminating power at all once properly matched). So the in-sample-vs-OOS gap is not explained by the
label contamination found in Section 2; it is a separate, genuine overfitting signature. This is the
single cleanest piece of evidence in this investigation that what looked like signal was broad-window
overfitting, not a fragile-but-real effect: a real effect would not shrink this consistently and this much
every time the window moves forward to genuinely new data.

## 4. Is there a cleaner signal on the harder cases? (real numbers)

From the official 10-05 `orderbook01_verdict.json`, the corrected McNemar test's discordant-pair counts —
cases where the model and the trivial baseline actually disagree, which is exactly the subset where the
baseline's dominance isn't automatically deciding the result:

| Hypothesis | Model right, baseline wrong (n10) | Baseline right, model wrong (n01) | Ratio |
|---|---|---|---|
| H1-R (Tier-1, overall) | 18 | 115 | model loses 6.4x |
| H1-M (PDL) | 2 | 25 | model loses 12.5x |

If DI carried real information specifically about the harder, minority-outcome cases, `n10` would exceed
`n01`. Instead the model is *decisively worse* than the trivial baseline on exactly the cases where the
two disagree, for both hypotheses. This directly answers the "cleaner signal hiding underneath the noise"
question with a real, computed result rather than a hypothetical: there is no recoverable edge in these
discordant cases. Per-level detail (`ITL`: 0 vs 2, `SESSION_HIGH`: 10 vs 74, `SWING_LOW`: 0 vs 8,
`SWING_HIGH`: 4 vs 18, `ITH`: 4 vs 13, `SESSION_LOW`: 0 vs 0) shows the same pattern everywhere there is
any discordant data at all.

---

## 5. Honest recommendation

**Retire ORDERBOOK-01 as currently specified.** The case for this, point by point:

- H1-R and H1-M have now failed every real out-of-sample measurement, including the largest one run to
  date (the calibration-window rerun in this document, N=16,643 / 29,896, both well below their real
  baselines).
- H2's only clean pass is in-sample and has shrunk by roughly 10-25x every time it has been re-measured
  on genuinely new data since. There is no reasonable reading of that pattern as "fragile but real."
- The McNemar discordant-pair evidence rules out a hidden edge specifically on the harder cases, which was
  the most promising remaining place such an edge could have hidden.
- Three of the four methodology problems found across this strategy's life (wrong null, sign mismatch,
  1-second lookahead) are now fixed and independently reproduced here. The fourth
  (`is_active_candidate` not applied) is real, is not fixed, and matters most for PDL — but fixing it would
  make the honest baseline *less* extreme (72% vs. 92-99%), which if anything makes H1-M's already-failing
  96.8%-99.1% accuracy numbers look worse relative to a fairer baseline, not better. There is no plausible
  fix remaining that would flip today's CASE E.
- The original theoretical premise (STRUCTURE-01's level-proximity volatility-expansion claim) cannot be
  independently verified from this repository; this is reported as an open gap, not as grounds for
  suspicion on its own.

**If this is ever revisited**, it should not be revisited as "re-run the same evaluator and see." It would
need: (1) the `is_active_candidate` fix applied and baselines re-derived on the intended clean population,
(2) the calibration window (Jan 1-Sep 25) retired from ever being used again to justify a go-live decision
— it has now produced one false-positive-shaped result (CASE A) and one in-sample-only "pass" for H2 that
did not replicate; re-using it a third time would not be a fresh test, (3) a single pre-registered,
genuinely fresh OOS window evaluated once, with the sample-size floors (N >= 3,000 Tier-1, N >= 1,000 PDL)
met *before* looking at the result, and (4) if that single look still fails, treat the program as closed —
per this project's own standard, a result should be replicated once before being trusted, not re-run
repeatedly in search of a pass. Given the consistency of the falsification across every real OOS
measurement available, the realistic expectation is that it would fail again, and the better use of
research time is elsewhere.

## 6. What this document does and does not change

- No code changes. No `.env` changes. `ORDERBOOK01_LIVE_GATE_ENABLED` remains OFF, unchanged by this
  document (per `docs/2026-10-05-orderbook01-bug-fixes-and-honest-verdict.md`).
- `apps/ml/orderbook01_verdict.json` is unchanged from the 10-05 CASE E re-derivation (`executed_at:
  2026-10-05T11:14:18+05:30`) — a calibration-mode diagnostic rerun was performed in the course of this
  investigation and its output was reverted (`git checkout`) before concluding, so the production artifact
  reflects only the official OOS re-derivation.
- The `is_active_candidate` gap in `fetch_contact_events` (both Tier 1 and Tier 2 queries in
  `apps/ml/run_orderbook01_oos.py`) is flagged here as a real, unfixed methodology issue but intentionally
  **not fixed in this document** — per this project's research-vs-code-fix discipline, a fix that would
  change a live verdict's baseline should be its own reviewed change with its own before/after numbers,
  not bundled into a root-cause writeup. The numbers in Section 2 above (72.2% vs. 86-99%) are the
  evidence for why that fix is worth making before this program is ever reopened.
