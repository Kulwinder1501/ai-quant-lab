# FRVP × Momentum Scalp Phase 0 — Preregistration v1.0 (Frozen)

**Experiment ID:** `FRVP-MSP-P0-2026-10-12`  
**Status:** `CLOSED — HYPOTHESIS A INCONCLUSIVE` (see `docs/2026-10-12-frvp-msp-phase0-closed-record.md`)  
**Scope:** Research-only. No production wiring, no score/Pillar changes, no live or default shadow enrollment.  
**Baseline strategy:** `momentum-scalp-pattern` (live Sniper key), unchanged entry / stop / target / exit.

A Phase 0 **Pass** authorizes the **next research stage** (options-level historical replay), not production deployment.

---

## 1. Purpose and primary claim

**Primary hypothesis (A):** Existing `momentum-scalp-pattern` candidates have higher after-cost net expectancy in **index-space R (signal-only)** when, at decision time, a qualifying prior-session LVN corridor lies ahead in the trade direction (`LVN_AHEAD`), versus the same candidates without applying that filter.

**Null:** The single frozen profile-conditioned policy does not improve out-of-sample signal-only expectancy vs the baseline policy under the same costs and management rules.

**Secondary (not primary; do not promote on these):**  
- **B:** Congestion near HVN/POC (exploratory diagnostics).  
- **C:** Pattern Intelligence adapter incremental value (separate research path; not live Sniper PI).

---

## 2. Baseline identity (frozen)

| Field | Frozen value |
|---|---|
| Strategy key | `momentum-scalp-pattern` |
| Strategy version integer in registration | `2` (`momentumScalpPatternStrategyVersion`) |
| Live bot | AutoBot-Sniper (paper); research must not edit frozen strategy source |
| Default configuration | `indicatorAlgorithmVersion=ta-v1`, `candlestickAlgorithmVersion=candlestick-v2`, `priceActionAlgorithmVersion=price-action-v2`, `scoreThreshold=5`, `atrStopMultiple=1.0`, `rewardRiskMultiple=1.5`, `maxSrDistanceAtr=1.5`, `volumeSurgeRatio=1.1`, `expiryCandles=3`; `requireStrictTrendAlignment` / `enableSrVeto` / `srLookbackBars` absent |
| Pattern scope for Phase 0 | Live candlestick + price-action flags only. **Pattern Intelligence research adapter is Hypothesis C only.** |
| Harness note | `pattern-v5-research` evaluates V2 twin with `scoreThreshold:0` — **not** the Phase 0 baseline. Do not mix. |

Configuration hash must be recorded in the run manifest from `computeConfigurationHash` on the effective config at export time. Any config drift vs this table → stop and amend.

---

## 3. Profile construction (frozen)

| Field | Frozen value |
|---|---|
| Profile type | Prior **completed** regular session Fixed Range Volume Profile |
| Developing session profile | **Out of scope** for Phase 0 |
| Profile volume source | Verified **traded volume** of the historically eligible **index futures** contract (`FUTIDX` NIFTY / BANKNIFTY), not spot-index volume |
| Signal series | Existing Sniper index series (`NIFTY50` / `BANKNIFTY`) for candidate generation |
| Estimation label | If built from OHLCV bars (not trade ticks): always `estimated_volume_profile` |
| Allocation method (v1 estimate) | Uniform volume across price bins spanning each bar’s `[low, high]` inclusive on the tick grid (document as estimate; sensitivity logged, not optimized) |
| Row / bin size | 1 contract tick of the futures contract used for the profile |
| Value area | 70% |
| POC tie-break | Tied bin nearest session VWAP of the profile contract; then lower price |
| VA expansion tie-break | Prefer lower-price adjacent bin first |
| HVN / LVN | Local max / min of bin volume vs both immediate neighbours; minimum prominence = max(1 lot-equivalent, 5% of POC volume). Exact prominence frozen here; no hand-drawn nodes |
| Missing futures volume | Feature `UNAVAILABLE`; candidate remains baseline-only with reason `NO_TRADE_PROFILE_UNAVAILABLE` / attach status `PROFILE_UNAVAILABLE` — **never** substitute index or ETF volume silently |

### 3.1 Active futures contract (causal)

At each **session start** (IST), select the eligible front-month index future using **only prior completed sessions’** futures volume:

1. Among listed `FUTIDX` contracts for that underlying with expiry ≥ session date, take the contract with highest **prior completed session** traded volume.  
2. Roll to the next expiry only when the next contract’s prior-session volume exceeds the current contract’s prior-session volume for **two consecutive** completed sessions.  
3. Record `provider_symbol`, expiry, and selection inputs on every profile.  
4. Never merge profile bins across expiries; reset state on roll.

Worked example and effective-dated contract master source must be archived before confirmatory outcome evaluation.

### 3.2 Futures → index mapping

\[
B_t = F_t - I_t,\quad L^{index}_t = L^{futures} - B_t
\]

| Field | Frozen value |
|---|---|
| \(F_t\) | Last completed 1m futures close ≤ decision time |
| \(I_t\) | Last completed 1m index close ≤ decision time (same underlying) |
| Sync tolerance | Both closes within 60 seconds of each other; else basis `STALE` / profile levels unavailable for that decision |
| Stale profile | If profile contract ≠ active contract at decision session → unavailable |

This is a **mapping convention to test**, not behavioural identity of futures and index.

---

## 4. Decision-time event codes (frozen taxonomy)

Classified using **only** information available at candidate decision time \(t\) (bar close). Post-entry path belongs in **outcomes**, not features.

| Code | Meaning at \(t\) |
|---|---|
| `LVN_AHEAD` | Qualifying LVN trough lies ahead of entry in trade direction within `[1 tick, max(8 ticks, 0.25×ATR(14,1m))]` and before the next HVN or VA boundary in that direction |
| `ENTRY_AT_LVN` | Entry within `max(2 ticks, 0.10×ATR(14,1m))` of an LVN bin mid |
| `ENTRY_AT_HVN` | Entry within same proximity of an HVN (Hypothesis B diagnostic) |
| `ENTRY_AT_POC` | Entry within same proximity of POC |
| `INSIDE_VALUE` | Entry between VAL and VAH (inclusive) |
| `ABOVE_VAH` / `BELOW_VAL` | Entry outside prior value area |
| `PREDECISION_LVN_CROSS` | In the last 3 completed 1m bars before \(t\), price crossed the LVN bin in the trade direction |
| `PREDECISION_LVN_REJECTION` | In the last 3 completed 1m bars, price touched LVN proximity and closed back through the approach side |
| `PROFILE_UNAVAILABLE` | Missing futures volume, basis stale, or profile not computable |

**Primary policy rule (exactly one):**  
`PROFILE_POLICY_LVN_AHEAD_v1` — take the baseline candidate **if and only if** event set contains `LVN_AHEAD` and does **not** contain `PROFILE_UNAVAILABLE`. Entry/stop/target unchanged.

No other LVN rule may enter the locked holdout. Other codes are diagnostics only.

---

## 5. Policies compared

| Policy | Definition |
|---|---|
| Baseline | All historically regenerated `momentum-scalp-pattern` candidates under frozen config |
| Profile policy | Same stream filtered by `PROFILE_POLICY_LVN_AHEAD_v1` |

Same stop/target/expiry; same non-overlap / one-position rules as baseline export. Report policy-level outcomes (not selected vs rejected as interchangeable populations).

---

## 6. Outcomes and economics

| Label | Definition |
|---|---|
| Phase 0 primary metric | **Signal-only** index-space net expectancy in **R**, where 1R = distance from entry to stop in index points at decision time |
| Costs in Phase 0 | Index-point friction placeholder: 0 for signal-only tag; do **not** call this after-cost executable P&L |
| Win / loss | Target hit before stop within `expiryCandles` of the candidate timeframe; else mark `EXPIRED` / MFE-MAE recorded |
| Forbidden claim | Spot/index R as Sniper option P&L |

**Next gate after Phase 0 Pass:** replay through existing option-entry selection + cost stack with historically available option data.

---

## 7. Chronological protocol

1. Split by complete IST sessions: 60% development / 20% validation / 20% locked test. Record exact date bounds **before** outcome inspection on the test set.  
2. One-session embargo at each split boundary.  
3. Locked test read once for the registered decision.  
4. Day-clustered bootstrap (or equivalent) for expectancy CI.  
5. Sensitivity (allocation uniform vs OHLC-weighted; bin 1 vs 2 ticks) logged on **development only**; not used to pick a winner into the holdout.

---

## 8. Acceptance (predeclared)

Phase 0 may return only `PASS` / `FAIL` / `INCONCLUSIVE`:

1. **PASS (signal-only):** Locked OOS profile policy net R expectancy > baseline; 95% day-clustered CI for the difference excludes 0; ≥ 250 eligible baseline OOS candidates and ≥ 100 profile-policy OOS trades where feasible; no data-leakage or profile-construction defect; futures volume + basis gates passed for the evaluation window.  
2. **INCONCLUSIVE:** Data gate fail, underpowered sample, unstable profile under preregistered sensitivity, or CI not estimable — **not** a licence to retune the holdout.  
3. **FAIL:** Powered comparison shows no incremental signal value (or worse) on the primary policy.

**Smoke only (not Pass):** ~40 trades/arm operational check.

A Pass authorizes **options-level historical replay**, not production, score changes, or Pillar 6.

---

## 9. Data gate (blocking)

Phase 0 confirmatory replay **must not run** until:

| Gate | Requirement |
|---|---|
| G-FUT-VOL | DB (or licensed store) contains historically eligible NIFTY/BANKNIFTY `FUTIDX` OHLCV (or trade VAP) with positive traded volume |
| G-ROLL | Causal roll rule + worked example archived |
| G-BASIS | Synchronized futures/index 1m series for mapping |
| G-BASELINE | Baseline candidates exportable under frozen config hash |
| G-PIT | Profiles and event codes use only ≤ decision-time data |

**Lab disposition at freeze (2026-10-12):** instruments table has **no** `FUTURE` rows; candles exist for index `NIFTY50`/`BANKNIFTY` and ETFs, not index futures. Depth frames under `NSE:*FUT` are **not** traded volume. → **G-FUT-VOL FAIL** until futures volume is ingested. Index/ETF volume **must not** be substituted.

---

## 10. Explicit non-goals

- Production `vpContext` wiring, score 10→11, Pillar 6  
- Editing `momentum-scalp-pattern-strategy.ts` in place (checksum-frozen research isolation)  
- AFG-5 / trade-tape footprint claims  
- Renaming index-volume estimates as futures FRVP  
- Promoting on win rate alone  

---

## 11. Deliverables for this freeze

1. This preregistration (normative).  
2. Research-only estimated FRVP + event-code library and tests.  
3. `run_frvp_phase0_data_gate.py` — audit G-FUT-VOL / related gates.  
4. Replay runner that **refuses** confirmatory evaluation while data gate fails.

---

## 12. Change control

Any change to baseline identity, profile rules, mapping, primary policy, splits, or acceptance bars requires a dated amendment **before** inspecting affected outcomes.
