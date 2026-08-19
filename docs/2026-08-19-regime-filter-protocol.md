# Regime Filter Protocol (revised)

Supersedes the frozen "Base Architectures & Regime Filtering" plan. The hypothesis is kept. The
experimental design is rebuilt, because three of the original's five frozen periods have no data and
the one period that does was designated untouched.

Everything below was measured against the live v2 database on 2026-08-19.

## 1. The hypothesis survives, and it is narrower than it looked

The original plan's audit was right on every point I could check. The volatility model has real skill,
it is concentrated in `CONTRACTION`, and it is not the base-rate artifact that killed the
triple-barrier work:

| prediction | accuracy | realized base rate | edge |
|---|---|---|---|
| CONTRACTION | 55.9% (n=111) | 35.5% | **+20.4pp** |
| STABLE | 43.8% (n=121) | 32.5% | +11.3pp |
| EXPANSION | 39.3% (n=300) | 32.0% | +7.3pp |

The headline cell holds up under a strict test:

| | |
|---|---|
| CONTRACTION at confidence ≥ 0.60 | **11 / 12** = 0.917 |
| exact one-sided binomial vs the 0.355 base rate | **p = 9.2 × 10⁻⁵** |
| Bonferroni ×10, for the cells that were scanned | p = 9.2 × 10⁻⁴ |
| Wilson 95% interval | **[0.646, 0.985]** |

So the effect is not eyeballed and it is not the majority class. It is the first thing in this system
that clears a base-rate comparison and a multiplicity penalty together.

Three limits belong next to it, permanently:

- **n = 12, over 15 calendar days.** The prediction stream begins 2026-08-04. "91.7%" honestly reads
  as "somewhere between two-thirds and near-certain."
- **It fires 0.80 times per day.** Against a strategy taking ~14 trades a day this is a small
  defensive trim, not a transformation. Reaching n = 100 takes ~125 trading sessions.
- **The confidence scale is uncalibrated.** A 0.60 cut is a threshold on a number nothing has
  calibrated, so the threshold itself is a free parameter and must be frozen before use, not tuned.

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

**And the signal does not replicate onto the deep series.** This is the decisive measurement:

| instrument | CONTRACTION, any confidence | vs 35.5% base |
|---|---|---|
| BANKNIFTY | 28/47 = **59.6%** | +24pp |
| NIFTY50 | 27/49 = **55.1%** | +20pp |
| **NIFTYBEES** | 3/11 = **27.3%** | **−8pp, below base** |

The 11/12 headline cell is **9/9 BANKNIFTY plus 2/3 NIFTY50, and zero NIFTYBEES**. So the skill lives
on the two indices — the series with 153–175 sessions of 5m — while the 1,888-session ETF series shows
the effect pointing the wrong way on the sample it has.

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

Population: all settled candidates on BANKNIFTY and NIFTY50 from 2026-08-04 forward.

- **BLOCKED GROUP:** `model_regime = 'CONTRACTION' AND model_confidence >= 0.60`
- **ALLOWED GROUP:** everything else

Compare net expectancy of BLOCKED against ALLOWED, Holm-adjusted, at the 2-bps endpoint.

**Pre-registered minimum sample: 100 settled candidates in the BLOCKED group.** At the observed 0.80
firings per day that is roughly 125 sessions. Reporting B1 before that threshold is prohibited; an
interim look is a peek, and peeking at a growing sample until it is significant is how this becomes a
fishing expedition.

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
- **Any stage:** if the NIFTYBEES CONTRACTION accuracy stays below the 35.5% base rate as its sample
  grows past n = 50, record `REGIME_SIGNAL_IS_INDEX_SPECIFIC`. That does not kill B on the indices, but
  it forbids generalising the filter to any non-index instrument.

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
