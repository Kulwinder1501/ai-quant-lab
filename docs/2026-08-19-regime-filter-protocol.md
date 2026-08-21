# Regime Filter Protocol (revised)

Supersedes the frozen "Base Architectures & Regime Filtering" plan. The hypothesis is kept. The
experimental design is rebuilt, because three of the original's five frozen periods have no data and
the one period that does was designated untouched.

Everything below was measured against the live v2 database on 2026-08-19, **after** correcting a
grading defect described in §1b. Numbers taken before that correction were measured on a biased subset
and are shown only for comparison.

## 1. The hypothesis survives, and it is weaker than the first measurement suggested

The volatility model has real skill and it is not the base-rate artifact that killed the triple-barrier
work. But the first pass overstated it, and the corrected picture reshuffles which label is strongest:

| prediction | accuracy | realized base rate | edge | edge before correction |
|---|---|---|---|---|
| STABLE | 51.3% (n=156) | 35.7% | **+15.6pp** | +11.3pp |
| CONTRACTION | 46.2% (n=208) | 34.6% | **+11.6pp** | +20.4pp |
| EXPANSION | 36.2% (n=481) | 29.7% | +6.5pp | +7.3pp |

`CONTRACTION`'s overall edge nearly halved once the grading bias was removed, and `STABLE` is now the
strongest label. The protocol still targets `CONTRACTION` because it is the one with a high-confidence
cell worth acting on, but the reshuffle is a warning that these rankings are not yet stable.

The headline cell, corrected:

| | before (biased) | **after (corrected)** |
|---|---|---|
| CONTRACTION at confidence ≥ 0.60 | 11 / 12 = 0.917 | **16 / 23 = 0.696** |
| exact one-sided binomial vs base | p = 9.2 × 10⁻⁵ | **p = 6.7 × 10⁻⁴** |
| Bonferroni ×10 for scanned cells | p = 9.2 × 10⁻⁴ | p = 6.7 × 10⁻³ |
| Wilson 95% interval | [0.646, 0.985] | **[0.491, 0.844]** |

**The effect survived doubling the sample and removing a bias, which most hypotheses in this system
have not.** It remains the single best signal available here. But plan against 69.6%, not 91.7%, and
note the Wilson floor is now 0.491 — honestly, "somewhere between coin-flip-plus and quite good."

Split by instrument it is currently a **BANKNIFTY** result:

| instrument | high-confidence CONTRACTION | exact p |
|---|---|---|
| BANKNIFTY | 12 / 17 = 70.6% | 2.7 × 10⁻³ |
| NIFTY50 | 4 / 6 = 66.7% | **0.113 — not significant** |

BANKNIFTY's pre-correction 9/9 was the mid-session subset (§1c).

Three limits belong next to all of this, permanently:

- **n = 23.** The prediction stream begins 2026-08-04.
- **It is a small defensive trim, not a transformation.** Against a strategy taking ~14 trades a day,
  reaching n = 100 in this cell takes on the order of 100+ trading sessions.
- **The confidence scale is uncalibrated.** A 0.60 cut is a threshold on a number nothing has
  calibrated, so the threshold is a free parameter and must be frozen before use, never tuned.

## 1b. The grading defect, and why the first numbers were wrong

215 predictions carried permanent `Trailing window has N of 5 required bars` verdicts that had been
recorded while the 15m series still had gaps. The gaps were later repaired — every recent session now
holds exactly 25 bars — but `recordUnsettleable` is terminal, so those rows were never retried. A stale
verdict standing on repaired data.

Clearing only the trailing-window reasons and re-running settlement (the `INTRADAY_SESSION_ENDED_BEFORE_HORIZON`
verdicts were left alone, being genuinely permanent) gave:

```
examined 680 → settled 57, re-marked unsettleable 158, notYetMatured 465
```

57 recovered, 158 correctly re-confirmed as truly session-truncated. Every number in §1 above moved as
a result. There was **no** backlog of matured-but-ungraded predictions — an earlier claim to that
effect came from filtering `realized_label IS NULL`, which also matches rows already adjudicated
unsettleable. All 465 genuinely-pending rows have source candles from the last four sessions and are
legitimately waiting.

**Operational note:** an unsettleable verdict is permanent by design, so any future repair to a candle
series should be followed by clearing the affected verdicts and re-running settlement. Otherwise the
repair is invisible to every model already graded against the broken data.

## 1c. The signal is only measurable mid-session, and that is structural

After the correction, the settled 15m sample still spans exactly **10:30 – 14:00**. The recovered
predictions all fell *inside* that window; it did not widen.

The boundary is the label rule, not the data. For intraday timeframes both windows are confined to one
IST session, so a bar before 10:30 can never have 5 same-session trailing bars, and a bar after 14:00
can never have 5 forward bars. 223 predictions are permanently ungradeable for exactly this reason.

So a `CONTRACTION` call can only ever be validated across the calmest 3.5 hours of a 6.25-hour session
— which is precisely when ranges naturally stay tight. Applying the filter all session while validating
it only mid-session would be testing one distribution and deploying on another.

**Letting the trailing window cross the session boundary is rejected.** It would unlock the open, but
overnight gaps would inflate the trailing range and bias the label toward CONTRACTION — manufacturing
the very effect under test. The same-session rule is correct; it is merely restrictive.

**Frozen constraint: the filter applies only to signals between 10:30 and 14:00 IST.** Outside that
window it does not act, because outside that window it has never been measured.

## 2. The binding constraint: no instrument has both the history and the signal

This is the fact that reshapes the whole design.

**Price history.** 1m is not the source of truth the original plan assumed — on the indices it does not
exist before 2026.

| series | sessions | from |
|---|---|---|
| NIFTYBEES / BANKBEES **5m** | **1,888** (245–252 per year) | 2019-01-01 |
| NIFTYBEES / BANKBEES **1m** | 897 / 895 | 2023-01-02 |
| NIFTY50 **5m** | 175 | 2024-01-01 |
| NIFTY50 / BANKNIFTY **1m** | 153 / 151 | **2026-01-01** |
| BANKNIFTY **5m** | 153 | 2026-01-01 |
| NIFTYBEES **15m** | 394 | 2025-01-01 |
| BANKBEES **15m** | 48 | 2026-06-08 |

**Regime predictions** begin 2026-08-04 and exist nowhere earlier: NIFTY50 650 raised / 222 settled,
BANKNIFTY 362 / 127, NIFTYBEES 162 / 123, twenty equities at 39 / 3 each.

**And the signal does not replicate onto the deep series.** This is the decisive measurement,
post-correction:

| instrument | CONTRACTION, any confidence | vs 34.6% base | before correction |
|---|---|---|---|
| NIFTY50 | 48/91 = **52.7%** | +18pp | 27/49 = 55.1% |
| BANKNIFTY | 40/97 = **41.2%** | +7pp | 28/47 = 59.6% |
| **NIFTYBEES** | 4/16 = **25.0%** | **−10pp, below base** | 3/11 = 27.3% |

The high-confidence cell is **12/17 BANKNIFTY plus 4/6 NIFTY50, and zero NIFTYBEES**. So the skill
lives on the two indices — the series with 153–175 sessions of 5m — while the 1,888-session ETF series
shows the effect pointing the wrong way on the sample it has.

Note the instability across the correction: at any confidence BANKNIFTY fell from 59.6% to 41.2% while
NIFTY50 held near 53%, yet in the high-confidence cell BANKNIFTY is the stronger of the two. Which index
is "best" is not yet a stable fact, and no design decision should rest on it.

That is the exact shape of the confluence failure: monotone on two ETFs, reversed on twenty equities.
Here it is visible *before* the experiment rather than after, which is the only good news about it.

**Consequence, and it is not negotiable:** Experiment A must run where the price history is, and
Experiment B must run where the signal is, and those are different instruments. The design below makes
that split explicit and gates the handoff, instead of hiding it.

## 3. Why Experiment B cannot be run retrospectively at all

The original design puts REGIME DISCOVERY in 2025 H1 and REGIME PORTFOLIO in 2025 H2. There are zero
predictions before 2026-08-04, on any instrument, so both periods are empty.

Backfilling them would be worse than leaving them empty. The production model's training window ends
in mid-2026, so generating 2025 predictions from it means the model has seen the future relative to
the test period. The original plan's point-in-time contract guards the **prediction timestamp** and
says nothing about the **model's training window** — and the second is the larger leak, invisible to
the check as written.

Either retrain a model whose window ends before the test period, or accumulate forward. This protocol
accumulates forward, because the machinery for it already exists (§6).

## 4. EXPERIMENT A — Base architecture selection

**Instruments: NIFTYBEES and BANKBEES. Timeframe candidates: 1m, 3m, 5m.**

3m is aggregated deterministically from audited 1m bars, anchored to the 09:15 session open, never
blending across sessions — kept exactly as the original specified.

**Window: 2023-01-02 → 2026-08-14, the intersection where all three timeframes exist.** 5m has 1,888
sessions and 1m has 897; comparing them over different windows would compare eras, not architectures.
The 2019–2022 5m depth is deliberately left unused here and stays available for §7.

| period | dates | sessions | purpose |
|---|---|---|---|
| DEVELOPMENT | 2023-01-02 → 2023-12-31 | ~246 | build and validate the harness. No conclusions. |
| BASE SELECTION | 2024-01-01 → 2024-12-31 | ~249 | measure 1m vs 3m vs 5m. |
| OUT-OF-ERA CHECK | 2025-01-01 → 2025-12-31 | ~249 | does the winner survive a different year? |
| HELD | 2026-01-01 → 2026-08-14 | ~151 | not opened during A. |

**Strategy: `momentum-scalp-index`, the base strategy — not the pattern strategies.** From the
candidate settlement ledger, against a 40% break-even at rr 1.5:

| strategy | TARGET | STOP | resolved hit rate |
|---|---|---|---|
| momentum-scalp-index | 46 | 64 | **41.8%** |
| momentum-scalp-pattern | 1 | 6 | 14.3% |
| momentum-scalp-pattern-v2 | 1 | 6 | 14.3% |

Pattern gating also degraded a 5m scalp monotonically in backtest across 13.7k–18.6k trades per cell on
both ETFs. A defensive filter needs something worth defending, and the base is the only candidate near
break-even. The pattern strategies are out of scope for this protocol.

**Costs and endpoint** carry over unchanged: `netPnl = grossPnl − brokerage − taxes −
statutoryCharges − slippageCost`, tested at 1, 2 and 5 bps, with **2 bps the declared primary
endpoint** and the others recorded as sensitivity only. Note the ETFs are equity instruments, so the
schedule is not the option schedule the live bots use; the cost model must be stated per instrument
class rather than inherited.

**Selection** is unchanged and remains strict: an architecture is superior only if the **day-level 95%
confidence interval of its expectancy delta excludes zero** in the favourable direction. A CI
containing zero establishes nothing. The frozen tie-breaker — better 5-bps expectancy, then lower
drawdown, then the slower timeframe — and the `NO_UNIQUE_WINNER` terminal outcome both stand.

**Hard data-readiness gate** before A begins, unchanged in intent: audit the native 1m series for
missing sessions, duplicate timestamps, out-of-session bars and session misalignment. Holidays and
known short sessions are acceptable; unexplained gaps inside a valid session are a FAIL and abort the
run. This is not ceremony — a 5m NIFTYBEES series once sat at 47.1% indicator coverage and produced
zero signals for a strategy that later fired 72,140 times on the same bars.

## 5. GATE A→B — replication onto the instrument B must use

**New, and required.** Experiment B can only run on BANKNIFTY and NIFTY50. A's winner is selected on
the ETFs. Before B starts, the winning architecture must be re-run on the indices' own 2026 5m data
(NIFTY50 175 sessions, BANKNIFTY 153) and must show **non-negative net expectancy at 2 bps on both**.

If it does not, the honest reading is that A selected an ETF architecture, and B has no base to filter.
Terminal outcome: `BASE_DOES_NOT_TRANSFER`. Do not proceed to B and do not retune A to force it.

This gate exists because §2 already shows one quantity failing to cross between ETF and index. The
cheapest robustness check available here is cross-instrument replication, and it belongs before the
expensive step rather than after.

## 6. EXPERIMENT B — Regime filter, forward-accumulating

**The data layer already exists.** As of 2026-08-18 the system records, per bar and point-in-time:

- `regime_observations` — the model's `CONTRACTION | STABLE | EXPANSION` with confidence and its
  evidence cutoff, plus the VIX-derived `HIGH_VOL | LOW_VOL`, with the source constants that define
  each label. A reading whose evidence postdates the observation is dropped by a CHECK constraint.
- `candidate_settlements` — every candidate settled forward over its own geometry through
  `resolveBracket`, which shares the live exit policy's rules, with `UNSETTLEABLE` kept distinct from
  `UNRESOLVED`.

They join on `trade_ideas.source_candle_id = regime_observations.source_candle_id`, which is verified
working (35 candidates carried both within a day of deployment). Two properties matter:

- It covers **every candidate, not just executed trades**, so B1 gets the full signal population
  rather than the subset that passed capital, quote-freshness and position limits.
- Nothing reads either table at decision time, so accumulating this data changes no behaviour.

### Measurement B1 — signal-level isolation

Population: all settled candidates on BANKNIFTY and NIFTY50 from 2026-08-04 forward, **restricted to
signals whose source bar closes between 10:30 and 14:00 IST** (§1c). Signals outside that window are
excluded from both groups, because the regime label backing the filter is not gradeable there and never
will be under the current rule.

- **BLOCKED GROUP:** `model_regime = 'CONTRACTION' AND model_confidence >= 0.60`
- **ALLOWED GROUP:** everything else inside the window

Compare net expectancy of BLOCKED against ALLOWED, Holm-adjusted, at the 2-bps endpoint.

**Pre-registered minimum sample: 100 settled candidates in the BLOCKED group.** The cell stood at 23 on
2026-08-19, so this is on the order of 100+ further trading sessions. Two cautions on the arithmetic:
the earlier "0.80 firings per day" estimate counted rows that were in fact permanently ungradeable, and
the one-off recovery in §1b will not repeat. Reporting B1 before the threshold is prohibited — an
interim look is a peek, and peeking at a growing sample until it turns significant is how this becomes
a fishing expedition.

If BLOCKED does not show significantly lower expectancy: `REGIME_FILTER_REJECTED`, and B2 is skipped.

### Measurement B2 — portfolio backtest

Only if B1 confirms. RAW versus REGIME-FILTERED over the accumulated forward window. The pass
conditions are the original's, unchanged, because they were the strongest part of that document:

1. Δ Net Expectancy > 0 at 2 bps.
2. Day-level CI for Δ Expectancy excludes 0 at 2 bps.
3. `Filtered Net PF @2bps >= RAW Net PF @2bps`.
4. `Filtered MaxDD <= RAW MaxDD × 1.05`.
5. Δ Expectancy non-negative at all of 1, 2 and 5 bps; significance required only at 2 bps.

**Added condition 6 — cross-instrument replication.** The filter must not worsen expectancy on either
BANKNIFTY or NIFTY50 individually. A filter that helps one index and hurts the other is drift, and
§2 already shows this signal is instrument-sensitive.

## 7. FINAL OOS

Run the frozen architecture once, no parameter changes.

- **Experiment A's OOS** is the ETF 2026-01-01 → 2026-08-14 block held in §4, plus, optionally, the
  unused 2019–2022 5m depth as a second untouched era.
- **Experiment B has no OOS block and cannot be given one**, because its data starts 2026-08-04 and is
  being consumed as it arrives. Its out-of-sample test is therefore forward only: freeze the filter
  after B2 and evaluate the following 100 BLOCKED candidates without changing anything.

Stating this plainly matters. The original plan's locked-OOS lifecycle is correct in principle, and it
cannot be applied to B; pretending otherwise would consume the only untouched block on the first look.

## 8. Pre-registered kill conditions

Written before running, so they cannot be renegotiated afterwards:

- **A:** CI contains zero on every pairwise contrast → `NO_UNIQUE_WINNER`, protocol ends.
- **Gate:** winner has negative 2-bps expectancy on either index → `BASE_DOES_NOT_TRANSFER`, ends.
- **B1:** BLOCKED expectancy not significantly lower → `REGIME_FILTER_REJECTED`, ends.
- **B2:** any of the six conditions fails → filter rejected, base architecture kept unfiltered.
- **Any stage:** if the NIFTYBEES CONTRACTION accuracy stays below the 34.6% base rate as its sample
  grows past n = 50, record `REGIME_SIGNAL_IS_INDEX_SPECIFIC`. That does not kill B on the indices, but
  it forbids generalising the filter to any non-index instrument. It currently sits at 4/16 = 25.0%.
- **Any stage:** if the high-confidence CONTRACTION accuracy falls below **45%** as the sample grows,
  record `REGIME_SIGNAL_DECAYED` and stop. This threshold is set now, before the data arrives, because
  the cell has already moved from 91.7% (n=12) to 69.6% (n=23) once a bias was removed, and a metric
  that has halved its edge under one correction can do so again. 45% is deliberately above the 34.6%
  base rate: a filter that merely beats chance is not worth the machinery.
- **Never:** do not re-derive the 0.60 confidence threshold, the 10:30–14:00 window, or the label rule
  from the data being tested. Each is frozen here. Changing any of them invalidates every settlement
  recorded under the old definition and restarts B's sample from zero.

## 9. What is unchanged from the original

The parts worth keeping, and they are the majority of its discipline: deterministic 3m aggregation
anchored to the session open; the hard data-readiness gate; the date-aware cost engine with 2 bps as
the single declared endpoint; Holm adjustment across pairwise contrasts; day-level confidence intervals
as the selection criterion; frozen tie-breakers written in advance; `modelVersion`,
`predictionTimestamp`, `regime`, `confidence` and `featuresAsOf` persisted alongside execution; and
terminal research outcomes treated as legitimate results rather than failures.

The one addition to the anti-lookahead contract: **the model's training window must end before the
test period begins**, and that must be asserted, not assumed. Guarding the prediction timestamp alone
is insufficient and was the original's most dangerous gap.

## Addendum (2026-08-20) — the base architecture does not clear costs on the indices, and both cost levers are now exhausted

This is an empirical postscript, not part of the pre-registered protocol above. Two exploratory sweeps
were run on the index 2026 block **after** the A→B gate had already consumed it, so neither can confirm
anything — each can only generate or kill a hypothesis, and anything alive would need untouched data.
Both returned terminal negatives, and together they bound the problem.

The A→B gate found the base momentum-scalp architecture net-negative on the indices at 2 bps despite a
small *positive* gross edge (+0.0301 R/day): a 5-minute ATR bracket is too tight to carry the friction.
That leaves exactly two levers that move cost without touching the signal — bracket **width** and
holding-period **horizon** — because round-trip cost in R is `bps × price / riskPerUnit` and depends on
neither the number of trades nor the signal itself.

- **Stop-multiple sweep** (`research:stop-sweep`) → `NO_VIABLE_STOP_MULTIPLE`. Cost in R falls as
  `1/width`, exactly as predicted, but the gross edge is ~13× too small to close, and widening only
  scales the timed-out mass toward zero.
- **Horizon sweep** (`research:horizon-sweep`, this addendum) → `NO_VIABLE_HORIZON`. Lengthening
  `expiryCandles` from 3 to 75 drives the resolved share from 0.68 to 0.9999 (timeouts collapse from
  ~3,900 to 1) and lifts the resolved target-hit rate to **41.1%** — a hair above the 40% geometric
  break-even for a 1.5 reward:risk. That yields a gross edge of only +0.047 R/day against a fixed
  0.376 R/trade cost, so net stays pinned at **−0.33 R/day**, full 95% CI below zero on both NIFTY50 and
  BANKNIFTY at every horizon.

The horizon sweep is the direct test of the one open question the stop sweep left — *does the signal
predict a move large enough to pay friction at any holding period?* Given unlimited room to play out,
the signal resolves almost every bracket and still barely beats a coin-weighted break-even. The answer
is no. **The momentum-scalp index architecture is finished, not mistuned:** a regime filter refines
*which* of these trades to take, and refining a base that clears no cost-covering configuration at any
width or horizon cannot produce a positive expectancy. Before Experiment B is worth running, a base
architecture that clears 2 bps on untouched data has to exist first — and on the indices, none does.

## Addendum (2026-08-21) — the remaining bar sizes were swept too, and they close the question

The addendum above exhausted bracket width and holding horizon. The one axis left was bar size, and
it is now measured. Both runs used `measureTier`'s gated-vs-unconditional methodology — the column
that matters is whether the strategy beats *the same geometry taken on every bar*, not its raw rate.

- **15m** (stored bars, frictionless): NIFTY50 LONG 19.2% and SHORT 38.0%, both below the 40%
  break-even. BANKNIFTY SHORT 39.0%, below. BANKNIFTY LONG 41.9%, clearing break-even and beating
  baseline by 0.9pp.
- **3m** (derived from audited 1m via `aggregateBars`, session-anchored, partial buckets discarded):
  LONG dead on both (36.2% / 38.0%). NIFTY50 SHORT 42.1%, clears break-even and beats baseline by
  0.49pp. BANKNIFTY SHORT 40.4% — clears break-even but sits **0.96pp below its own baseline**.

Neither apparent winner is usable, for two independent reasons.

**It does not replicate.** 3m SHORT passes on NIFTY50 and fails against baseline on BANKNIFTY, on
the same rule and the same 20k-bar sample. Cross-instrument replication is the cheapest robustness
check available here and §5 already made it mandatory; this fails it.

**The search produced exactly the number of winners chance predicts.** Eight side/timeframe cells
were compared with no multiplicity correction. One-to-two thin passes at margins under 1pp is the
null hypothesis behaving normally. This document insists on Holm adjustment for the *experiments* it
governs; the same discipline applied to this sweep disqualifies its own best cell.

**Terminal outcome: `NO_VIABLE_BAR_SIZE`.** All three cost-and-geometry axes — width, horizon, bar
size — are now exhausted on this architecture. 1m was disabled in the strategy registry on
2026-08-20 (89 closed live trades, −Rs 13,858, 82% of it BANKNIFTY). 5m remains enabled and is a
known-dead configuration whose live sample is merely too small to have shown the drawdown yet.

The pivot away from directional bar prediction is recorded in
[phase-28-microstructure-information-flow.md](phase-28-microstructure-information-flow.md), whose
Phase 0 established that the order-book data such a pivot requires is in fact available.
