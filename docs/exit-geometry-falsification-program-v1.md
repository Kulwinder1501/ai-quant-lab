# Exit Geometry Falsification Program V1

How scalp stop-loss and target geometry is being decided, and why the answer is not yet "optimise the target".

Frozen 2026-08-25 after two review rounds. Builds on the [scalp research harness](scalp-engine-research-harness-v1.3.1.md), which supplies the proposals, matched controls and settlements this program reads.

## The question, and the question it is not

Every scalp strategy in the repository shares one geometry: stop at `1.0 x ATR(14, Wilder)`, target at `1.5 x` the risk distance, expiry a fixed number of bars. `momentum-v5` (1m, 5 bars), `index-v3` (5m, 3 bars) and `pattern-v4` (1m/3m/5m, 3 bars) differ in what triggers them, not in what they do afterwards. The canonical research grid uses the same shape with a 60-minute expiry.

Two prior sweeps returned negatives: `NO_VIABLE_STOP_MULTIPLE`, then `NO_VIABLE_HORIZON`. Both moved stop **and** target together at a fixed 1.5 reward-to-risk, so both traced one diagonal through a two-dimensional space. **Whether 1.5 is the right ratio has never been tested, only assumed.**

The program's premise is that this is still the wrong first question. Before asking which geometry monetises a signal, establish that the signal carries information at all — and establish it against matched controls, not against zero.

### Why the gate is control-adjusted, not gross

An earlier round of reasoning here was "gross expectancy is approximately zero, therefore stop." That is the wrong prerequisite, and it was corrected in review. Consider:

| selected | controls | reading |
| --- | --- | --- |
| −0.02R | −0.11R | real selection edge (+0.09R), currently unmonetisable |
| +0.05R | +0.08R | no selection edge despite positive money |

Both are common and they imply opposite decisions. Gross level cannot separate them; the canonical/control architecture exists precisely to do so.

## Stage order and gates

| Stage | Question | Status |
| --- | --- | --- |
| Gate 0 | Are the studies predeclared and immutable? | **done** — 4 studies registered |
| Build 1 | Are outcomes charged for friction? | **done** — R and bps, per rung |
| Build 2 | What was the forward path, with no bracket? | **done** — `BARRIER_FREE_PATH_V1` |
| G1 | Is there control-adjusted path information? | **runner built, not passed** |
| G3 | Which stop/target region monetises it? | **closed behind G1** |
| G4 | Does holding period matter? | not started |
| G5 | Is ATR(14, Wilder) the right volatility clock? | frozen until G1–G4 survive |
| G6 | Does it survive costs, multiplicity and untouched OOS? | not started |

Gates are evaluated **per cell**, never for the study as a whole — see [Cell-local gating](#cell-local-gating).

## Gate 0 — the study registry

`research_scalp.study_registrations` (migration 080) stores each study's frozen specification with a content hash, written before the study produces a figure.

| Study | Provenance | Purpose |
| --- | --- | --- |
| `PATH_STUDY_V1` | pre-specified | barrier-free forward path, pointwise verdict |
| `PATH_STUDY_V2` | pre-specified | identical measurement, simultaneous-band verdict |
| `GEOMETRY_MATRIX_V1` | pre-specified | 5 stops x 7 targets = 35 cells |
| `FIXED_POINTS_V1` | **data-inspected** | 10/15/20-point NIFTY50 targets |

The registry exists because the deflated Sharpe ratio and probability-of-backtest-overfitting corrections take the number of configurations examined as an *input*. Reconstructed after the fact that number is always too small — nobody remembers the grids they abandoned — and the correction becomes decorative.

`FIXED_POINTS_V1` is flagged `DATA_INSPECTED` because its levels were chosen after observing 2026-08-24 and 2026-08-25. That does not disqualify it; testing it unrecorded would be worse. But a post-hoc family and a pre-specified grid carry different evidential weight, and the flag is what keeps the multiplicity accounting from flattening both into "one more parameter family".

### Immutability, verified rather than intended

A registered study cannot be edited. Re-registering an unchanged definition is a no-op; a changed one is refused by hash comparison. Verified against the live database:

| Attempt | Outcome |
| --- | --- |
| re-register identical definition | `ALREADY_REGISTERED` |
| register a widened horizon list under the same key | refused on hash mismatch |
| `UPDATE` as the research role | `permission denied for table study_registrations` |
| `UPDATE` as the owner role | `research_scalp records are append-only` |

The third is stronger than designed for — the research role has no `UPDATE` privilege at all, so the append-only trigger is the second line of defence rather than the first.

A change to a specification is a new versioned key. `PATH_STUDY_V1` plus `PATH_STUDY_V2` is two trials and is counted as two; a silently widened V1 would be one trial that has been lied about.

## Build 1 — friction, in risk units

`canonicalOutcomeR` reported gross only. Basis points are exact for every row but carry no geometry: the charge is a constant `2 x rung`. Cost in **risk units** scales as the inverse of the stop distance, which is the mechanism that makes a tight bracket look attractive gross and fail net.

`terminal_settlements` is append-only, so a risk-basis column could only ever be populated for rows settled after it was added — every existing row would stay null forever. `impliedRiskPerUnit` derives the denominator instead:

```
returnBps = signedMove / entryFillPrice x 10000
rMultiple = signedMove / riskPerUnit
=>  riskPerUnit = entryFillPrice x returnBps / (10000 x rMultiple)
```

Both stored figures come from the same `signedMove`, so the quotient returns the distance the row was actually graded against — not a re-read of an ATR snapshot that recompute passes may since have rewritten. Exact to about `1e-8` relative; the six-decimal storage of both inputs is the limit. A settlement resolving exactly on its entry price gives `0/0` and is reported as uncovered rather than guessed.

Stamped `RISK_BASIS_DERIVATION_V1`, and the version is not decoration: the algebra is valid only while `rMultiple` means *gross* signed move over planned risk. A cost-adjusted `rMultiple` would keep returning a plausible number that is no longer a risk distance, so the semantic assumptions are asserted directly in `canonical-friction.test.ts`.

### Measured on 2,613 settled rows

| cohort (2 sessions) | gross R | friction R @1bp | net R @1bp | net R @2bp |
| --- | --- | --- | --- | --- |
| momentum native | 0.105 | 0.448 | −0.340 | −0.788 |
| momentum canonical | 0.245 | 0.587 | −0.343 | −0.930 |
| momentum controls | −0.030 | 0.600 | −0.629 | −1.229 |
| index native | 0.389 | 0.594 | −0.206 | −0.800 |
| pattern native | −0.001 | 0.299 | −0.300 | −0.599 |

Risk-basis coverage 2,612 of 2,613. Every cohort is net-negative at 2 bps.

**Tight-stop rows of `GEOMETRY_MATRIX_V1` therefore carry a known ex-ante friction disadvantage**, roughly 2x the incumbent at 0.5 ATR and 1.33x at 0.75 ATR. This is stated in advance and deliberately **not** encoded into the acceptance rule: no geometry region is presumed to survive. G3 reports gross and net surfaces separately, because "strong gross, killed by friction" and "dead before friction" are different findings.

Every net figure must be quoted with `costModel: canonicalFrictionModel`. It is a sensitivity instrument on *underlying notional*, not option economics — an option's spread is a percentage of premium and far wider, and premium movement is not underlying movement once IV and delta are involved. That is Track B, and it has its own machinery in `d2-premium-cost-gate`.

### The gap-fill asymmetry is deliberate

Review asked for regression tests pinning the pessimistic gap rules. They already existed. `settlement.ts` resolves gaps asymmetrically and on purpose:

- `GAP_THROUGH_STOP` fills at `candle.open` — the **worse** price;
- `GAP_THROUGH_TARGET` fills at the frozen `targetPrice` — never the better open.

A bar that opened through the stop really did fill worse than the stop, so booking the stop price would under-report losses on exactly the trades that went worst; a favourable gap must not manufacture positive slippage. `settlement.test.ts` asserts both prices in one test so the pair cannot drift apart. Do not "simplify" this into symmetry.

## Build 2 — the barrier-free path

`walkPath` answers "what did *this bracket* do by horizon H". Its loop returns the instant a stop or target is touched, so **every stored 5/15/30/60-minute observation is bracket-truncated**. Using those rows to choose a bracket would be circular: the geometry under test would already have decided which part of the path was observed.

`BARRIER_FREE_PATH_V1` answers the prior question — where price actually went. The guarantee is structural rather than promised: `BarrierFreePathInput` carries no stop, no target and no expiry, so there is nothing in scope for the loop to terminate on. The pinning test walks one path twice; settlement books `-1R` on a minute-2 stop while the walker reports the `+2.2`-point recovery at +5m. If those ever agree on the tail, the walker has grown a barrier.

Per horizon it reports directional return, MFE and MAE in points, bps and ATR units, time-to-peak, and both give-back and retention:

```
giveBackRatio_h  = (mfe_h - directionalReturn_h) / mfe_h     [null when mfe_h <= 0]
retentionRatio_h = directionalReturn_h / mfe_h               [null when mfe_h <= 0]
```

Null rather than zero: zero would assert a peak existed and none of it was surrendered, which is a stronger claim than "price never traded above the reference". Neither is clamped — a reversal through the reference gives retention `-1` and give-back `2`, which is the honest reading of a move that gave back more than its peak.

Session-boundary eligibility calls `horizonEligibility()` from `policies.ts` rather than reimplementing it, so the barrier-free and bracket curves stay comparable at exactly the boundary where boundary-heavy sessions live.

Unlike settlement, a data gap spoils only the horizons that needed it and every later one; earlier horizons stay intact. Losing the tail of a session should cost the tail of the curve. Settlement has one terminal answer and so must abandon the subject entirely.

### Both curves, always

Horizon eligibility falls through a session: a decision taken late cannot support a 60-minute horizon. Smoke-tested on 1,480 real control points, attrition is exactly `4h − 2` (two instruments x two directions per minute):

| horizon | complete | ineligible |
| --- | --- | --- |
| +1m | 1,478 | 2 |
| +5m | 1,462 | 18 |
| +15m | 1,422 | 58 |
| +30m | 1,362 | 118 |
| +60m | 1,242 | 238 |

**16% of decisions drop out between +1m and +60m.** Read alone, that composition shift can present as information decay. So G1 reports two curves: available-case (every legally eligible decision per horizon) and common-eligible (only decisions eligible at every horizon). Agreement makes a decay reading credible. Divergence is not an error to correct away — it is evidence that session composition matters, which is its own finding.

## G1 — the Directional Information Curve

For each horizon: the selected population's forward path, the mean of its matched controls' paths, and the difference. The difference is the quantity the gate reads.

A subject contributes at a horizon only when its own observation is complete **and** every one of its controls resolves there. Averaging over whichever controls survived would measure that subject against a smaller, different baseline than its peers, and the difference between baselines would enter the estimate as though it were signal.

Three decay landmarks are reported separately — peak, half-decay, zero-cross — rather than one "half-life". A half-life is only meaningful for a curve decaying monotonically from a maximum, and an information curve can be non-monotonic, cross zero, or peak at its first horizon. Each may be null. All three read point estimates and are descriptive; the gate reads intervals.

### Cell-local gating

The unit is `cohort x instrument x timeframe x direction` — 36 cells on current data.

Gates are evaluated per cell. A cell advances on its own independent-session support; a sparse cell stays unresolved indefinitely without holding back a dense one, and is **never** merged into a neighbouring timeframe to reach a threshold. Timeframe is the distinction the 1m-versus-5m question turns on: pooling a 1m cell peaking at +3m with a 5m cell peaking at +20m manufactures a smooth curve describing neither.

"This setup is too rare to support a standalone claim from the data available" is a legitimate research outcome.

| sessions | standing |
| --- | --- |
| 0–1 | `INSUFFICIENT_DAYS` |
| 2–4 | `DEGENERATE_INTERVAL` |
| 5–19 | `PROVISIONAL` |
| 20+ | `DECISION_ELIGIBLE` |

`DECISION_ELIGIBLE` does not mean proven. It means a Gate-1 reading can be taken seriously; effect size, interval width, cross-instrument stability, opportunity count and multiplicity all remain separate questions.

## Two inference defects, both measured

### At 2–3 clusters the interval is degenerate

With `d` day means a bootstrap replicate draws `d` with replacement, so `P(every draw hits the minimum) = d^-d` — 25% at two days, 3.7% at three. Both exceed the 2.5% percentile being read, so **the reported lower bound *is* the minimum day mean** and `lower > 0` collapses into "every day happened to be positive". A null simulation confirms it fires **24%** of the time at two days.

The first version of the G1 verdict reported `PATH_INFORMATION` on 14 of 36 real cells from exactly this. Across 170 two-day interval tests noise predicts about 41 hits; 30 were observed — *below* chance.

The mechanism stops binding at four days (`4^-4` = 0.390625%, already under 2.5%). The ceiling is set at **five**, and the extra day is governance rather than arithmetic: escaping one discrete-bootstrap pathology does not make a four-cluster percentile interval trustworthy. Below it, verdicts return `DEGENERATE_INTERVAL` and report how many horizons *would* have registered, so refusing is not hiding.

### "Any horizon clears zero" is a search

Ten pointwise 95% intervals do not give 95% coverage across ten inspected horizons. Null calibration over 600 synthetic cells with day-level and cross-horizon dependence, true edge exactly zero:

| days | `SIMULTANEOUS_DAY_MAXT_V1` band | any-pointwise-horizon |
| --- | --- | --- |
| 5 | 3.3% | 16.7% |
| 10 | 4.8% | 11.8% |
| 20 | 4.2% | 7.7% |

The band holds nominal at every count. **The pointwise reading is still about 1.5x over nominal at twenty sessions**, so this was never only a small-sample problem.

## PATH_STUDY_V2 and SIMULTANEOUS_DAY_MAXT_V1

V2 is a new registration rather than a correction to V1, because it changes *how evidence becomes a claim* — part of the research definition, not a presentation detail. The argument that a stricter procedure needs no version is true and still the wrong one to make: the registry exists so inferential semantics are not renegotiated after results have been looked at.

The timing was chosen deliberately. V1 had produced 36 cells, 360 interval examinations and zero valid information claims, every cell `INSUFFICIENT_DAYS` or `DEGENERATE_INTERVAL`. Versioning while everything is still early-diagnostic is not the same as versioning after a 20-session result someone disliked.

Horizons, cell identity, path definition and matching policy are identical to V1 and pinned by test, so the two differ in exactly one dimension and a V1-versus-V2 comparison isolates the inference.

### The statistic

```
H0:  edge_h <= 0 for every retained horizon
H1:  edge_h >  0 for at least one retained horizon

U*_h = (mean*_h - mean_h) / SE*_h     T* = max_h U*_h     c = quantile_0.95(T*)
lower_h = mean_h - c x SE_h
```

Trading days resample. Each replicate draws **one** day set serving every horizon — that is what preserves the cross-horizon dependence the maximum is taken over; per-horizon day sets would make the maximum a statistic over incomparable quantities. Studentizing is load-bearing: unstudentized, the maximum would simply select the widest-scale horizon.

One-sided, because the Gate-1 question is one-sided. No two-sided band is produced — it would be an unregistered quantity sitting beside an authoritative one, and the pointwise intervals already serve visualisation.

The band controls the ten-horizon search **within one cell**. The 36 cells remain a separate multiplicity problem for the trial ledger. It is not a familywise guarantee over the study.

### Exclusions, all resolved before resampling

Nothing is dropped mid-run: removing a horizon from a maximum *lowers* the critical value and weakens the test, which is the opposite of what an exclusion should do.

1. **`INSUFFICIENT_OWN_SUPPORT`** — a horizon with fewer than two days of its own support is dropped *before* the day intersection. Intersecting first would let one systematically boundary-limited horizon collapse an entire cell.
2. **`ZERO_DAY_LEVEL_VARIANCE`** — a horizon that cannot be studentized is dropped and the intersection recomputed, since removing one can only add days. The loop terminates because the retained set strictly shrinks.
3. **Days** without a contribution at every retained horizon leave the resampled set and are counted.

A replicate whose draw collapses onto a single day has zero bootstrap scale. The registered rule forbids discarding it, so the observed standard error is substituted for that horizon and the count is reported. Discarding it would strip the most extreme draws from the critical value.

No band is produced below five common-support days. Means and standard errors are still reported; only the inferential claim is withheld.

## The execution ledger

Two tables, because `research_scalp` forbids `UPDATE` and so a trial cannot carry a mutable status:

```
study_trials          -> declaration (before computation)
study_trial_results   -> outcome (after computation)

trial + result   = a completed, accountable trial
trial, no result = an execution that started and did not finish
```

The second state is visible rather than absent. Under a compute-then-log design a crash between computation and the write leaves an examined configuration with no record at all, and the trial count silently understates the search.

Order is **not** negotiable:

```
verify registration -> enumerate cells -> DECLARE all trials (one transaction) -> compute -> record results
```

Declaration is all-or-nothing. A partial declaration would leave some cells accountable and others not, with no way to tell which, so a failure there stops the run rather than degrading it.

The trial unit is the grouping cell, not the invocation. G1 has no free parameter — the horizon ladder is frozen at registration — but examining 36 curves and reporting the best is 36 configurations examined.

### Three identities, separately frozen

| identity | column | answers |
| --- | --- | --- |
| policy | `study_definition_hash` | what was predeclared |
| implementation | `code_version` | which code produced the numbers |
| dataset | `session_set_hash`, `input_snapshot_hash` | which observations were visible |

`dataset_cutoff` is recorded but deliberately **excluded** from identity: it defaults to now, so including it would make every retry a new set of trials and the recovery path unreachable.

`session_set_hash` digests the exact session set rather than first/last/count, which agree across genuinely different collections. `input_snapshot_hash` digests the decision rows and bars the walk actually reads, because two inputs here are mutable: the nightly healer appends repaired bars to sessions already counted, and `indicator_snapshots` is rewritten wholesale by recompute passes — which is where every decision's ATR comes from. Without it, a healed dataset yields the same trial key and a different result, and the ledger reports `DETERMINISM_VIOLATION` when nothing nondeterministic happened. The input changed, and that deserves to be a new legitimate execution.

`code_version` is a content hash of the declared domain files, not a commit hash. A commit hash moves when unrelated code changes, so a real change becomes indistinguishable from noise, and it is unavailable in a container built without `.git`. It also closes the gap the research manifest leaves: an unchanged registration hash proves declared *policy* is unchanged, never the implementation.

The hash cannot reach `interfaces/cli`, which is a real boundary. Forward-window slicing and unit assembly were result-affecting logic sitting in the runner and therefore outside the guarantee; they were moved into `path-study-inputs.ts`. **A runner reads arguments, fetches rows and prints. If it computes, the computation belongs in the domain.**

### Recording outcomes

| outcome | meaning |
| --- | --- |
| `RECORDED` | no result existed; this one is now the trial's |
| `IDEMPOTENT` | a result existed with a matching payload hash; nothing written |
| `DETERMINISM_VIOLATION` | a result existed with a different payload hash |

The third means something outside the trial's identity moved the answer — a mutated candle series, a recomputed snapshot, estimator nondeterminism — and the run is not trustworthy until it is explained. It mirrors `POLICY_DETERMINISM_VIOLATION` one layer up.

Verified live: pass one `RECORDED` 36/36; pass two `IDEMPOTENT` 36/36 with no new rows; a deliberately divergent payload under the same identity returns `DETERMINISM_VIOLATION` and leaves the stored verdict untouched.

### The runner refuses an inference it does not implement

```
PATH_STUDY_V2 declares inferencePolicy SIMULTANEOUS_DAY_MAXT_V1, which this runner
does not implement (it has POINTWISE_INTERVAL_V1)
```

That refusal is what made registering V2 ahead of its implementation safe. A study whose `inferencePolicy` is absent predates the distinction and reads as pointwise. The band's replicate count comes from the registration rather than `--replicates`, so a flag cannot quietly retune the critical value.

## Current state

**G1 is not passed. G3 is closed. Target geometry is not eligible for optimisation.**

`PATH_STUDY_V1`, 36 cells: 19 `INSUFFICIENT_DAYS`, 17 `DEGENERATE_INTERVAL`, 0 information claims, 360 interval tests disclosed.

`PATH_STUDY_V2`, 36 cells: all `NO_BAND` — 19 with no horizon reaching two days of its own support, 17 refused below the five-day minimum.

Nothing further is buildable until sessions accumulate. The dense cells (`BANKNIFTY 1m`, `NIFTY50 1m`, the 5m pairs) carry 12–59 opportunities per session and will reach `PROVISIONAL` first; the thin cross-timeframe cells may never resolve, which is an acceptable outcome.

Accumulation is unattended — see [The scheduled run](#the-scheduled-run). At one session per trading day the dense cells reach `PROVISIONAL` (5 sessions) inside a week and `DECISION_ELIGIBLE` (20 sessions) in roughly a month, assuming no collector outages.

## Commands

```powershell
npm run db:migrate
npm run research:studies:register
npm run research:studies:register -- --dry-run
npm run research:studies:path -- --study PATH_STUDY_V2
npm run research:studies:path -- --study PATH_STUDY_V1 --metric MFE_BPS --replicates 4000
npm run research:scalp:estimate -- --replicates 2000
```

Registration is idempotent and safe on every deploy. The path study needs `SCALP_RESEARCH_DATABASE_URL` pointed at the research login role; it reads operational tables and writes only `research_scalp`.

### The scheduled run

`scalp-research-scheduler-v2` runs registration followed by `PATH_STUDY_V2` every **Saturday 07:00 IST** — after Friday's 15:31 drain and after the overnight candle heal, so the week's data is final. A path study reads settled rows and adds nothing to them, so it gains information only when a session completes; an intraday slot would re-examine an unchanged dataset.

Re-registering weekly is deliberate. Registration refuses a changed specification, so a deploy that edits one fails loudly on the next scheduled run rather than at whatever future moment someone next looks.

Only V2 is scheduled. V1's pointwise verdict is superseded, and it would emit a weekly stream of readings already shown to overfire. It also halves the number of looks, which matters for a reason worth stating plainly:

> **Repeatedly examining a growing dataset is itself a form of multiple testing.** Each weekly run over a dataset with a new session declares a fresh set of trials — correctly, since the dataset genuinely differs — so by the time a cell reaches twenty sessions the ledger will hold on the order of twenty looks at nested data. That is the classic optional-stopping problem, and it is why the decision gate sits at a predeclared session count rather than at "whenever a cell first looks good". Intermediate looks are diagnostics; the ledger records every one so the eventual correction can account for them, and a `PROVISIONAL` reading is never grounds to open G3.

A run over a week with no new sessions is a no-op: the trial key derives from the session set and input snapshot, so it returns `IDEMPOTENT` for every cell rather than declaring duplicates. Verified — 36 of 36 idempotent on a repeat run.

A V1-versus-V2 comparison stays available on demand; the runner is deterministic, so it reproduces any past window exactly.

## Reading the output

- An interval spanning zero establishes nothing, however large the point estimate.
- A pointwise interval is descriptive under V2. Only the band carries a verdict.
- A peak is not evidence. A peak whose interval spans zero is a peak in noise.
- `DECISION_ELIGIBLE` is permission to take a reading seriously, not a result.
- Net figures are meaningless without `costModel`, and are not option economics.
- An unfinished trial still counts as a configuration examined.
