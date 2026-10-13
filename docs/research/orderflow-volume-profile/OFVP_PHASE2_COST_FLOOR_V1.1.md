# OFVP Phase-2 cost-floor gate v1.1 (corrected)

**Document ID:** `OFVP-PHASE2-COST-FLOOR-V1.1`  
**Amended:** `2026-10-13` (labeling / tradeability caveats; figures unchanged)  
**Status:** Research only — `tradingExecutionAuthorized: false`  
**Supersedes:** gate section of `OFVP-PHASE2-BASELINE-2026-10-13` (events unchanged)  

## Framing (read this first)

This report is only **target size vs cost floor, on a post-hoc population**:

- **H1:** among probes that *did* return into prior value, the median |boundary−POC| is larger than ~9.7 bps round-trip cost.
- **H2:** among probes with a *real* HVN ahead (no 25% range fallback), that structural target is **not** larger than the cost floor.

**Tradeability is untested.** `TARGET_EXCEEDS_COST` is necessary, not sufficient. It is not a green light to build or tune a backtester on this history.

## Why this exists

The v1.0 baseline measured H1 and H2 on the wrong populations (all probes; H2 with an arbitrary fallback). v1.1 fixed those populations. The figures below match an independent recompute from `logs/ofvp-phase2-baseline.json` for everything that does not need the database.

## Verdict

| Hypothesis | Target-vs-cost label | Session median | Sessions (primary) |
|---|---|---:|---:|
| **H1** (RETURNED, “intraday” slice) | `TARGET_EXCEEDS_COST` | 19.34 bps | 22 |
| **H2** (structural HVN, non-return) | `TARGET_BELOW_COST` | 8.15 bps | 9 |

**Reading:** H1’s *post-hoc* prize is big enough vs the sealed cost floor; H2’s structural prize is not. Neither is a tradeability or edge verdict. Returning is known only after the fact; fading all probes cannot pay.

### Break-even win rate (from this report’s own stop table)

Assume one win captures median |boundary−POC| net of cost, and one loss pays median excursion beyond the boundary plus cost (a return is **not** yet a hit on the POC).

| Underlying | Net win (pts) | Loss @ 1× excursion (pts) | BE win rate | Loss @ 2× excursion | BE @ 2× |
|---|---:|---:|---:|---:|---:|
| NIFTY50 | ≈ 17.2 (39.6 − 22.4) | ≈ 38.7 (16.3 + 22.4) | **~69%** | ≈ 54.9 | **~76%** |
| BANKNIFTY | ≈ 55.0 (108.6 − 53.7) | ≈ 96.1 (42.5 + 53.7) | **~64%** | ≈ 138.6 | **~72%** |

Returned events are only **~9%** of probes. Without a **probe-time** selector that reaches roughly that 64–76% hit rate on *chosen* returns, H1 cannot pay. Nothing in this file shows such a selector exists.

## Corrections applied (population)

- H1 on RETURNED only
- H2 on `nearest_hvn_outside` only (no 25% prior-range fallback)
- one median per (underlying, session), then median across sessions
- first probe at 09:15–09:17 IST tagged as gap open (see limits below)
- sessions split by evaluation-day contract volume vs 1M bar (needs DB; not rechecked from JSON alone)

Cost floor remains **9.7 bps**. Front-month-like bar: evaluation-day contract volume ≥ **1,000,000**.

## Inventory

- Events: 833 across 45 underlying-sessions
- RETURNED (H1 population): 73 (8.8%)
- Structural H2 targets: 164; fallback excluded: 669
- Sessions whose **first** probe is a 09:15–09:17 IST gap open: 27
- Front-month-like sessions: 15; thin: 30 (DB-backed; close to an independent ~14 estimate)

## Event-level (transparency; not a trade gate)

- H1 RETURNED median target: **17.34 bps** (p25 9.88); NIFTY 17.09, BANKNIFTY 19.74
- H2 structural median target: **7.42 bps** (n=164); NIFTY 7.42, BANKNIFTY 9.78

## Session-level target-vs-cost (descriptive)

Gate codes: `TARGET_EXCEEDS_COST` | `TARGET_BELOW_COST` | `INSUFFICIENT_SESSIONS` (n &lt; 5 — shown for audit, **not** a verdict).

| Slice | Sessions | Median bps | p25 | p75 | Label |
|---|---:|---:|---:|---:|---|
| H1 RETURNED, all sessions | 26 | 18.10 | 9.38 | 28.58 | `TARGET_EXCEEDS_COST` |
| H1 RETURNED, after dropping first gap-open probe only | 22 | 19.34 | 9.88 | 33.19 | `TARGET_EXCEEDS_COST` |
| H1 RETURNED BANKNIFTY | 11 | 14.05 | 7.82 | 22.76 | `TARGET_EXCEEDS_COST` |
| H1 RETURNED NIFTY50 | 15 | 18.93 | 10.58 | 28.58 | `TARGET_EXCEEDS_COST` |
| H1 RETURNED front-month-like | 8 | 27.30 | 17.26 | 51.96 | `TARGET_EXCEEDS_COST` |
| H1 RETURNED thin-contract | 18 | 13.03 | 8.68 | 22.76 | `TARGET_EXCEEDS_COST` |
| H2 structural HVN, all such probes | 10 | 7.79 | 2.79 | 10.72 | `TARGET_BELOW_COST` |
| H2 structural HVN, non-return | 9 | 8.15 | 2.79 | 10.72 | `TARGET_BELOW_COST` |
| H2 structural HVN, non-return, after gap-open drop | 9 | 8.15 | 2.79 | 10.72 | `TARGET_BELOW_COST` |
| H2 structural NIFTY50 | 7 | 7.42 | 3.30 | 8.15 | `TARGET_BELOW_COST` |
| H2 structural thin | 8 | 5.73 | 2.79 | 9.78 | `TARGET_BELOW_COST` |
| H2 structural BANKNIFTY | 3 | 9.78 | 1.26 | 34.39 | `INSUFFICIENT_SESSIONS` (ignore) |
| H2 structural front-month-like | 2 | 21.08 | 7.42 | 34.73 | `INSUFFICIENT_SESSIONS` (ignore) |

**Sample frailty:** 10 of 26 H1 returned sessions have exactly one returned event, so that session’s “median” is a single print. H2’s primary verdict uses 9 sessions; some sessions contribute many of the 148 non-return structural events. Small-n H2 “clears” rows above are **not** gate results.

## Stop / excursion note (returned events)

- **NIFTY50** (n=44): median excursion beyond boundary **16.26 pts** vs median H1 target **39.58 pts**; cost floor ≈ **22.36 pts** at mean mid.
- **BANKNIFTY** (n=29): median excursion beyond boundary **42.46 pts** vs median H1 target **108.62 pts**; cost floor ≈ **53.67 pts** at mean mid.

## Limits that remain after the population fix

1. **Post-hoc population.** “Returned” is not known at probe time. The 17–19 bps figure is the size of the prize *if* you could already pick returners.
2. **Target &gt; cost ≠ tradeable.** Break-even win rates above (~64–76%) sit next to any `TARGET_EXCEEDS_COST` label.
3. **Gap-open split is thin.** It removes only each session’s **first** probe. Other early-session events in those 27 sessions remain in the “intraday” slice.
4. **Thin September liquidity.** Many of the ~45 sessions are not front-month-like; do not treat the full set as a stable training history.

## What not to do next

- **Do not** build or tune a selector/backtester on this ~45-session history (thin September + post-hoc labels).
- **Do not** treat `TARGET_EXCEEDS_COST` as permission to fade probes.
- **Do** wait for forward-stamped `FRVP_OBS` trades under the frozen observation protocol. Any selector must be fixed in advance from probe-time features only, then judged against the ~64–76% economic bar on stamped outcomes — not on this retrospective probe file.

## Artifacts

- Input events: `logs/ofvp-phase2-baseline.json` (unchanged; do not treat re-runs of heavy scripts as required to read this amendment)
- Machine JSON (labels amended to match this doc): `logs/ofvp-phase2-cost-floor-v1.1.json`
- Original flawed-gate report (audit trail): `docs/research/orderflow-volume-profile/OFVP_PHASE2_BASELINE_COST_FLOOR_V1.md`
