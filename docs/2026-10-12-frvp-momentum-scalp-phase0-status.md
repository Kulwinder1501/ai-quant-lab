# FRVP-MSP Phase 0 status — 2026-10-12

**Experiment:** `FRVP-MSP-P0-2026-10-12`  
**Protocol:** frozen in `docs/2026-10-12-frvp-momentum-scalp-phase0-preregistration.md`  
**Closed record:** `docs/2026-10-12-frvp-msp-phase0-closed-record.md`  
**Data gate:** **DATA_GATE_PASS**  
**Hypothesis A (signal-only):** **INCONCLUSIVE** (closed)  
**Next stage:** **not authorized**

## Verdict

FRVP calculation is **not shown broken**; the registered policy is **too selective to evaluate** on this sample (0 takes). Empty policy ≠ FRVP ineffective and ≠ FAIL/PASS. Locked OOS cannot meet prereg thresholds. **Do not retune this holdout.** Options replay / production / Pillar 6 / score / live Sniper remain unauthorized.

Implementation audit: `docs/2026-10-12-frvp-phase0-implementation-audit.md`.

## Completed pipeline

| Step | Artifact |
|---|---|
| Data gate | `logs/frvp-msp-phase0-data-gate.json` |
| Futures ingest + roll example | `ingest-index-futures-ohlcv.ts`, `docs/2026-10-12-index-futures-roll-worked-example.md` |
| Baseline export (unchanged MSP) | `logs/frvp-msp-phase0-baseline-manifest.json`, `…-candidates.jsonl` |
| FRVP attach + policy | `logs/frvp-msp-phase0-candidates-attached.jsonl` |
| Chronological splits (frozen first) | `logs/frvp-msp-phase0-chronological-splits.json` |
| Signal-only replay decision | `logs/frvp-msp-phase0-replay-result.json` |

## Baseline identity (recorded)

- Strategy: `momentum-scalp-pattern` v2  
- Config hash: `e34a13c80ab8490e62d2168ba659af504c12ace9daf9c144a7414c6f92e35377`  
- Effective config matches prereg defaults (`candlestick-v2`, `scoreThreshold=5`, optional flags **absent**)  
- Window: decisions **2026-10-01 → 2026-10-12** (prior session for first day is 2026-09-30 = OCT-only by expiry after SEP 2026-09-29)  
- Candidates: **1334** (NIFTY/BANKNIFTY × 1m/5m; **3m series empty** in DB)  
- Signal-only R; friction 0

## Causal contract check

Row-level selection recorded on every attached candidate. In this window every row selected `NIFTY26OCTFUT` / `BANKNIFTY26OCTFUT` via `MAX_PRIOR_SESSION_VOLUME` among expiry-eligible contracts. Incomplete AUG/SEP Fyers history is why the window starts at 2026-10-01 rather than earlier September.

## Attach summary

| Metric | Value |
|---|---|
| Candidates | 1334 |
| `PROFILE_UNAVAILABLE` | 0 |
| `LVN_AHEAD` | **0** |
| Policy takes (raw) | **0** |
| Locked test session | 2026-10-12 |
| Baseline OOS trades (one-position) | 150 |
| Policy OOS trades | 0 |

Most prior-session estimated profiles had **0 LVN troughs** under the frozen prominence rule; a minority had 1–3. Event codes still fired (`INSIDE_VALUE` / `ABOVE_VAH` / `BELOW_VAL` / some `ENTRY_AT_HVN`). Primary policy never armed.

## Acceptance vs result

| Criterion | Required | Observed |
|---|---|---|
| Baseline OOS n | ≥ 250 | 150 (test day) |
| Policy OOS n | ≥ 100 | 0 |
| Policy mean R > baseline + 95% day-clustered CI excludes 0 | yes | CI not estimable |

→ **INCONCLUSIVE**

## Explicitly not done / not authorized

- Production `vpContext`, Pillar 6, score changes, live/shadow enrollment  
- Editing `momentum-scalp-pattern-strategy.ts`  
- Options-level Sniper replay (next gate only after signal-only **PASS**)  
- Retuning LVN window / prominence on this holdout  

## If extending later (amendment required before re-inspecting outcomes)

1. Licensed expired FUTIDX history (AUG/SEP) or longer live OCT/NOV collect.  
2. Ensure 3m candle series if Sniper 3m is in scope.  
3. Dated protocol amendment before any definition change.
