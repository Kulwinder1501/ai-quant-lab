# OFVP Phase-2 baseline + cost-floor gate

**Document ID:** `OFVP-PHASE2-BASELINE-2026-10-13`  
**Generated:** `2026-10-13T13:43:01.115648+00:00`  
**Status:** Research only — `tradingExecutionAuthorized: false`  
**Data scope:** `VP_PRICE_VOLUME_ONLY` (bar-volume allocation; no aggressor / Delta / CVD)  
**Profile:** `frvp-rows48-v2`  

## Verdict

- **Overall go/no-go:** `CLEARS_COST_FLOOR_CONTINUE_BASE_RATES_ONLY`
- **BANKNIFTY:** `CLEARS_COST_FLOOR_CONTINUE_BASE_RATES_ONLY`
- **NIFTY50:** `CLEARS_COST_FLOOR_CONTINUE_BASE_RATES_ONLY` — **knife-edge on H1** (median 9.88 bps vs 9.7 floor; p25 ≈ 7.2 bps is below the floor)
- **Sample:** 28 distinct OK dates / 45 underlying-sessions (need ~60 for provisional stability per plan §9.6); **INCONCLUSIVE on edge** regardless of cost floor.

This is a **cost-floor and base-rate** report. It is **not** an edge verdict and does not
authorize live trading. Per §5.6 the gate uses the **median** target distance; NIFTY H1 clears that
median only barely, so treat it as provisional, not a green light to build a full backtester.

## Cost floor (sealed)

Round-trip friction ≈ **9.7 bps** from `docs/2026-10-09-cost-stack-validation-record.md`
(statutory/brokerage 6.23 + spread 2.45 + slippage 1.00).

| Universe | Events | H1 median target (bps) | H1 gate | H2 median target (bps) | H2 gate | Cost pts @ mean mid |
|---|---:|---:|---|---:|---|---:|
| All | 833 | 10.97 | `CLEARS_COST_FLOOR` | 18.83 | `CLEARS_COST_FLOOR` | 32.68 |
| BANKNIFTY | 273 | 19.74 | `CLEARS_COST_FLOOR` | 28.63 | `CLEARS_COST_FLOOR` | 53.65 |
| NIFTY50 | 560 | 9.88 | `CLEARS_COST_FLOOR` | 18.17 | `CLEARS_COST_FLOOR` | 22.45 |

## Event definition (frozen for this run)

- Prior session: completed IST day with ≥300 paired minutes;
  densest FUTURE contract that day; futures volume on index high-low (same as live FRVP).
- Probe: minute close beyond prior VAH/VAL by ≥ 1× row width.
- **OFVP-H1-like RETURNED:** re-enter inside value within 30 minutes.
- **OFVP-H2-like HELD_OUTSIDE:** stay outside for 15 consecutive minutes
  without reclaim (within the scan window).
- H1 target distance for the gate: |VA boundary − POC|.
- H2 target distance: |boundary − nearest HVN outside|, else 25% of prior session range.

## Outcome base rates

- OK evaluation sessions: **45** (28 distinct dates)
- Probe events: **833**
- Outcomes (all): `RETURNED 73` · `HELD_OUTSIDE 694` · `AMBIGUOUS 39` · `TIMEOUT_STILL_OUT 27`
- BANKNIFTY (273): returned 29 · held outside 217 · ambiguous 17 · timeout 10
- NIFTY50 (560): returned 44 · held outside 477 · ambiguous 22 · timeout 17

**Base-rate reading:** most probes **hold outside** (~83%) rather than fail back into value within 30 minutes (~9%). That is descriptive only; it does not mean H2 has an edge.

H1 target distance quartiles (bps): BANKNIFTY 9.4 / **19.7** / 23.5; NIFTY50 7.2 / **9.9** / 26.0.

## What not to do next

- Do not build Delta/CVD/footprint until a trade-print feed exists (optional: one session capture test of last-trade quantity on the quote feed).
- Do not treat this median clear as permission for a full trading backtest on NIFTY H1 without noting the p25-under-floor share.
- Do not treat a cost-floor clear on ~28 dates as an OOS PASS.

Machine-readable: `logs/ofvp-phase2-baseline.json`
