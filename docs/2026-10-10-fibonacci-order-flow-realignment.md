# Fibonacci / Order-Flow Strategy: Realignment to Trade Order

> **Document Type:** Defect fix + protocol amendment + one exploratory run
> **Date:** October 10, 2026
> **Status:** Research only. `tradingExecutionAuthorized: false`. Nothing here registers or enables a live strategy.
> **Scope:** `fibonacci_pit_engine.py`, `master_scanner.py`, `experiments_f1_f4.py`, `run_phase_c_pipeline.py`, their tests, and four stale config/doc artifacts.

---

## 1. Why this was done

A specialist audit of the Fibonacci / order-flow stack (Research Specification v1.1, Contract v1.4.1) found that the
parts did not describe one coherent trade. The engine froze its leg too early, the scanner could only look one way
and mislabelled "never measured" as "measured and failed", and the research pipeline scored an outcome nobody can
trade with a matching design that could not balance. Every defect is fixed here, in the order a trade would follow.

## 2. The trade, in order, and what each stage now does

| # | Stage | What a trader would ask | Before | Now |
|---|---|---|---|---|
| 0 | Swing detection | Is this a real swing? | 1-bar wiggle counted as a pivot | Configurable fractal width; research uses 5-bar (`PIVOT_WIDTH = 2`), engine default stays 1 for backward compatibility |
| 1 | Impulse / MSS | Did structure actually break? | OK (bullish only in the scanner) | Same engine, both directions through one scanner |
| 2 | Leg anchoring | Is the leg I am measuring still the live leg? | Anchor frozen at first pause; a POI could sit >5 ATR behind price for up to 2,000 bars | A new extreme re-anchors the leg (`ANCHOR_EXTENDED`), drops the stale POI and restarts the qualification window |
| 3 | Pullback qualification | Is this a meaningful pullback? | `ticks OR ATR`: the 10-tick floor (0.5 index pts) qualified any 1-bar pause | `ticks AND ATR`: both floors must be met |
| 4 | Invalidation | When is the idea dead? | Pivot-low stop only after a POI existed | Stop applies from the MSS onward, before any POI |
| 5 | Layer 0 regime | Is the market tradeable now? | ToD veto tripped at quarter/mid session and never at the open/close | Vetoes exactly the 15-minute open and close edges; breadth veto mirrored for shorts |
| 6 | Layer 1 location | Is price in a zone of the live leg? | Zones measured from a stale frozen leg | Zones measured from the current anchor; `anchorAgeBars` = bars since the impulse extreme |
| 7 | Layer 2 order flow | Does the tape confirm? | No tape exists in the feed, so zeros failed the gates ("order flow rejected the setup") | `orderFlowAvailable` flag: absent tape reports `ORDER_FLOW_UNAVAILABLE` and `INSUFFICIENT_DATA`, never a fake rejection; shorts need the mirror P-shape |
| 8 | Layer 3 / 4 | GEX / null | Layer 4 always closed | Unchanged on purpose: still always closed, so no scan result is ever tradeable |
| 9 | Outcome | What would I have made? | Forward MFE: non-negative by construction, positive net of cost on ~80% of random bars, not capturable | Signed net return: enter next bar's open, exit at the 15-minute horizon close, long or short, minus 2 bps |

## 3. Statistics

| Defect | Fix |
|---|---|
| Controls were "the first bar of a never-touched anchor" (age ~0) while treatments sat 8+ bars into a pullback, so anchor age separated the groups by construction and nothing could be matched | Controls now come from the same live anchors, only from before the first zone contact, with forward windows that end before it, and one per horizon (`select_episode_records`) |
| Matching window/caliper had been widened to 60 min / 0.50 SD after seeing it return nothing; the cause was the control sampling, not the window | Restored the spec values: 30 min / 0.20 SD |
| `ASMD < 0.10` is a large-sample rule; at tens of pairs identical groups show ~0.3-0.6 by chance, so every zone was INCONCLUSIVE forever | Balance is judged against `max(0.10, 2.69 * sqrt(2/n))`; both the max ASMD and the threshold used are reported |
| No power information, so "not significant" read as "no effect" | Every result reports `minDetectableEffectBps` (80% power, one-sided 5%) |
| The verdict path had never been shown able to return SUPPORTED or FALSIFIED | `python run_phase_c_pipeline.py` now first runs a known +4 bps effect (must give SUPPORTED F1-F3) and a known null (must give FALSIFIED F1-F3); F4 boundary cells must also reach matching |
| Hard-coded database URL with a password as the default | Environment only; a test fails if a credential-bearing connection string is ever re-added to the source |

## 4. Protocol amendments (dated, nothing re-scored)

These change the research protocol and are recorded rather than slipped in:

1. Outcome: forward MFE replaced by signed net return (section 2, row 9).
2. Control selection: same-anchor, pre-contact, spaced (section 3).
3. Fractal width: 5-bar swings for the research pipeline (the engine default is unchanged).
4. Qualification: `AND` of the tick and ATR floors.
5. Balance rule: chance-aware threshold (section 3).
6. Matching window and caliper: spec values restored.

No result produced under the previous protocol is re-scored or reinterpreted by this document.

## 5. Exploratory real-data run (one run, reported as-is)

Run once against the live database from the scheduler container's own environment, read-only, with the code in this
change. `apps/ml/phase_c_results.json` now holds that output (the previous manifest came from the defective method;
git history keeps it). Nothing was tuned afterwards.

| Section | Zone | Matched / total treatments | Estimate (net bps) | Min detectable (bps) | Holm p | Verdict |
|---|---|---|---|---|---|---|
| Bullish (NIFTY50 + BANKNIFTY) | Golden pocket | 34 / 43 | +10.0 | 9.1 | 0.014 | SUPPORTED |
| Bullish | OTE | 9 / 12 | +19.8 | 15.5 | 0.001 | Inconclusive (too few pairs, balance not met) |
| Bullish | Deep | 9 / 13 | +13.4 | 14.2 | 0.033 | Inconclusive |
| Bearish | Golden pocket | 11 / 20 | +1.3 | 8.2 | 0.958 | Inconclusive |
| Bearish | OTE | 7 / 17 | +13.1 | 13.3 | 0.011 | Inconclusive |
| Bearish | Deep | 3 / 9 | -13.9 | 4.4 | 1.0 | Inconclusive |
| BANKNIFTY futures (basis-aligned) | all | 0-4 matched | n/a | n/a | n/a | Inconclusive |
| F4 boundary contrasts (every section) | all | 0 matched | n/a | n/a | n/a | Not testable at this sample |

The synthetic plumbing check passed in the same run (known effect detected, known null not supported).

### How to read this, honestly

- The one SUPPORTED cell is the bullish golden pocket: 34 matched pairs, an estimate of about +10 bps, with a minimum
  detectable effect of 9.1 bps. A result barely above what the sample could resolve is the profile of an
  over-estimate, not a measured edge. It is an **exploratory location-only finding**, pooled over two correlated
  instruments, from one run, before any out-of-sample data exists.
- The treatment is "price is in the zone after a pullback" against "same live leg, price not in the zone". A short-term
  reversal after a pullback would produce a positive long-side difference with no Fibonacci content at all. Nothing in
  this design separates the two, and the result cannot be read as evidence that the Fibonacci levels matter.
- **Controls are still not age-comparable on real data.** Median anchor age is 14-16 bars for treatments against
  98-217 bars for bullish controls. The matcher uses age as a covariate and balanced the golden-pocket cell, but this
  means the earlier claim that same-anchor sampling "removes the age separation" is only partly true on real data.
  Legs that sit for hundreds of bars without a zone touch, an extension or an invalidation are an artefact of the
  2,000-bar safety cap and are a candidate for a pre-registered lifetime cap before any further run.
- The three treatments that reached a verdict-sized sample were never order-flow conditioned: Layer 2 reported
  `ORDER_FLOW_UNAVAILABLE` on every zone contact, plus breadth and ToD vetoes on a further subset. This is a
  **price-location study, not an order-flow study.**
- F4 (does the zone boundary matter) has zero matched pairs everywhere. The zone edges cannot be validated with this
  amount of history, and the gaps between zones (0.650-0.702 and 0.886 upwards) remain deliberately unexplained rather
  than filled in.

## 6. Deliberately left alone

- **Zone gaps and boundaries.** Pre-registered; changing them after seeing data is exactly what the protocol forbids.
- **Layer 4 is always closed.** There is no validated exit/barrier layer, so no scan result is a trade.
- **Order flow stays unmeasured.** No trade tape or footprint is captured anywhere in the system, so Layer 2 cannot
  say yes or no. The code now says so instead of pretending to measure.
- **Hybrid-confluence "29 SD".** Not re-derived; an amendment to its validation document states it is not evidence.
- **Live bots.** `AutoBot-IctNifty15m` and `AutoBot-IctBankNifty5m` keep running until the pre-set review
  (60 closed live ICT trades or 2026-12-31). This work does not touch them.

## 7. Other fixes in this change

- `.env.example` had `ORDERBOOK01_LIVE_GATE_ENABLED=true`, contradicting the 2026-10-05 verdict that the gate stays off.
  It is now `false`.
- `apps/ml/orderbook01_oos_rerun_2026-09-26.json` is annotated as an invalid run (window start after end), and
  `run_orderbook01_oos.py` now exits with an error and writes nothing for an inverted window.
- `docs/2026-09-28-hybrid-liquidity-confluence-v1-validation.md` has a dated amendment.

## 8. Credential rotation

The removed default carried a live-looking database password for the `ai_quant_lab` role. It was committed to git
history, so removing it from the file does not un-leak it. **Rotate that database password**, and treat the old value
as public. Use `DATABASE_URL` from the environment only.

## 9. Verification

- Full ML suite: 448 passed (includes the new regression tests for each fix above).
- Engine, scanner and pipeline tests run in the project's Docker image; the new tests cover anchor extension,
  pre-POI invalidation, both qualification floors, fractal width, both scan directions, unmeasured order flow, the
  ToD gate minute by minute, control selection, the net-return outcome, MDE, the balance rule and the synthetic
  known-effect / known-null validation.
- Not committed, pushed or deployed as part of this change.

---

## 10. Addendum: second-look findings and the pre-registration for the next run

Written the same day, after re-reading the real-data run with a critical eye. These are **not** applied to the run in
section 5 (that run is final and is not re-scored); they bind the **next** run, which may only use bars that close
after 2026-10-10.

### 10.1 Weaknesses of the section 5 run, stated plainly

1. **Not a clean one-shot.** The pipeline was reshaped after earlier audits had already shown its diagnostics
   (treatment ages, matching starvation, the MFE artefact), so the single SUPPORTED cell is hypothesis-generating.
2. **Effective n is below 34.** Treatments from consecutive setups in one trend are serially dependent, and NIFTY50
   and BANKNIFTY are near-duplicates on the same day. The session-block bootstrap resamples whole sessions, which
   helps, but the sample is closer to about 20 independent observations than 34.
3. **No placebo.** A pullback followed by a bounce gives a positive long-side result at almost any depth. Nothing in
   the run shows 0.618-0.650 is special.
4. **The gates were not part of the study.** Treatments ignored the Layer 0 breadth, volatility and time-of-day
   vetoes (breadth alone vetoed 151 NIFTY50 and 249 BANKNIFTY bullish zone contacts), so the run does not describe
   the gated strategy.
5. **Stale setups.** The 2,000-bar safety cap lets a setup stay open for hundreds of bars (median control age 98-217
   against 14-16 for treatments).
6. **No exit rule.** A fixed 15-minute hold is scored; Layer 4 is closed.

### 10.2 Feasibility: this cannot be validated at the current signal rate

The run found 43 bullish golden-pocket contacts in about 2.7 years across both instruments. The minimum detectable
effect scales as 1/sqrt(n), so detecting 3 bps instead of 9.1 bps needs about 9 times the pairs (roughly 300). At
the observed rate that is decades of 5-minute index bars. Any further run on these two instruments only repeats the
same underpowered test. A second instrument family or finer timeframe is a precondition, not an option.

### 10.3 Pre-registration for the next run (frozen before any post-2026-10-10 bar is scored)

1. **Window:** only bars closing after 2026-10-10. No bar used in section 5 may be used again.
2. **Precondition (sample):** the primary test is not run until at least 100 matched golden-pocket pairs exist. If the
   existing universe cannot reach that within 12 months, the universe must first be widened (the 20 breadth-universe
   stocks, only if their 5-minute candle history is complete) *before* running, and this is recorded as an amendment.
3. **Setup lifetime cap:** a setup expires 75 bars (one 5-minute session) after qualification. 75 is chosen as one
   trading session, not from the observed age distribution.
4. **Placebo levels:** the same pipeline is run on three non-Fibonacci bands of the same width as the golden pocket
   (0.032 of the leg): 0.400-0.432, 0.500-0.532 and 0.550-0.582. All use the same controls, matching, outcome and gates.
5. **Primary hypothesis:** golden-pocket net return minus the mean placebo net return exceeds 1.0 bp, one-sided,
   Holm-adjusted together with the zone-level tests. A golden-pocket effect that the placebo bands also show is
   reported as "no evidence the Fibonacci level matters" regardless of its size.
6. **Unit of analysis:** one cluster per trading session, with both instruments pooled in that cluster, so the near-
   duplicate instruments cannot double the sample.
7. **Gated analysis:** a second analysis restricts treatments and controls to bars that pass Layer 0 (the version
   that would actually trade). Both analyses are reported; neither replaces the other.
8. **No run is a trading authorization.** `tradingExecutionAuthorized` stays false. Even a confirmed result would
   still need an exit rule, a costed fill model and a separate live-shadow period.
