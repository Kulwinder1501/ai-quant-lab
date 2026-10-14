# Phase 27 Step 2 — Premium measurement result

**Document ID:** `PHASE27-STEP2-PREMIUM-MEASURE-V1-RESULT`  
**Judged:** `2026-10-14`  
**Prereg:** [2026-10-14-phase27-step2-premium-measurement-preregistration.md](2026-10-14-phase27-step2-premium-measurement-preregistration.md)  
**Runner:** `apps/ml/run_phase27_step2_premium_measure.py`  
**Machine JSON:** `logs/phase27-step2-premium-measure-interim.json`

## Verdict: **FAIL**

`tradingExecutionAuthorized: false` (unchanged). Step 3 is **not** authorized. This frozen signal family (`S_premium_1m`) is closed for Phase 27; a different rule needs a new document ID.

## Sample rule

| Requirement | NIFTY50 | BANKNIFTY |
|---|---:|---:|
| Sessions (≥10) | 21 | 28 |
| Primary trades (≥200) | 1,056 | 1,307 |
| Sample met | yes | yes |

Eval window: **2026-09-01 .. 2026-10-13**. Lot size: **5 × 75** (NIFTY) / **5 × 30** (BANKNIFTY). Primary scenario: **+1 tick adverse** each leg.

## Primary scenario (B) economics

| Underlying | Mean net ₹ | Win rate | Mean net return on premium | Day-perm p (one-sided) |
|---|---:|---:|---:|---:|
| NIFTY50 | **−342.76** | 36.7% | −0.66% | 1.0 |
| BANKNIFTY | **−597.36** | 34.4% | −0.55% | 1.0 |

Holm: neither underlying passes. Both means are negative → **FAIL** without needing a close call on p-values.

## Reading

Dense `option_premium_ticks` were enough to power the study. The frozen 1m premium momentum rule does **not** clear premium-space round-trip costs at five lots under the preregistered adverse-tick scenario. That matches the parent doc’s prior that 1m option scalping is hard once fees dominate.

This does **not** prove every premium strategy fails — only that **this** preregistered rule fails. Live index-signal option bots are unchanged and are not cleared by this result either.
