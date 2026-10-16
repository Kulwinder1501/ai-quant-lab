# Brain V2.2 Option Friction Constants & Telemetry Audit (2026-10-16)

## Executive Summary

This document provides full traceability for the empirical friction constants and telemetry gate implemented in Brain V2.2 P8 Risk Approver (`risk-approver.ts`) and the shadow decision runner (`run-shadow-decisions.ts`).

---

## 1. Traceability of Friction Constants

The P8 shadow option friction calculation uses:
- **BANKNIFTY:** `7.68` premium points round-trip
- **NIFTY50:** `2.95` premium points round-trip
- **Delta:** `0.50` (ATM option benchmark)

### 1.1 Empirical Bid/Ask Spread (from 3.3M Ticks)

Measured directly from the production `option_premium_ticks` table using PostgreSQL:

```sql
SELECT underlying_symbol,
       count(*) as tick_count,
       round(avg(ask - bid), 4) as avg_spread,
       round(min(ask - bid), 4) as min_spread,
       round(max(ask - bid), 4) as max_spread,
       round(percentile_cont(0.5) within group (order by ask - bid)::numeric, 4) as median_spread
FROM option_premium_ticks
WHERE ask > bid
GROUP BY underlying_symbol;
```

**Query Results:**

| Instrument | Tick Count | Mean Spread (pts) | Median Spread (pts) | Min Spread | Max Spread |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **BANKNIFTY** | 1,581,742 | **3.3336** (~3.334) | 1.8500 | 0.0500 | 793.8500 |
| **NIFTY50** | 1,720,421 | **0.4634** (~0.463) | 0.3000 | 0.0500 | 364.0000 |
| **Combined** | **3,302,163** | — | — | — | — |

### 1.2 Statutory Round-Trip Fees (Zerodha / NSE Schedule)

Modelled via [`apps/api/src/modules/paper-trading/domain/brokerage-calculator.ts`](file:///c:/Users/Kulwinder%20Singh/Desktop/personal/AI%20Quant%20Lab/apps/api/src/modules/paper-trading/domain/brokerage-calculator.ts):
- **Brokerage:** ₹20 flat per executed order (₹40 round-trip).
- **Exchange Turnover Charges:** 0.03503% on premium turnover.
- **GST:** 18% on (brokerage + exchange charges).
- **STT (Securities Transaction Tax):** 0.1% on sell side premium turnover.
- **SEBI Charges:** ₹10 per crore turnover.
- **Stamp Duty:** 0.003% on buy side premium turnover.

**Conversion to Premium Points per Contract:**
1. **BANKNIFTY (15 qty lot size, weighted average ATM premium ~650 pts):**
   - Entry Fees: ₹25.92
   - Exit Fees: ₹39.33
   - Total Round-Trip Fees: ₹65.25
   - Fee Points: ₹65.25 / 15 = **4.35 premium points**
   - **Total Round-Trip Friction: 3.334 spread + 4.35 fees = 7.68 premium points**

2. **NIFTY50 (25 qty lot size, weighted average ATM premium ~325 pts):**
   - Entry Fees: ₹24.58
   - Exit Fees: ₹37.72
   - Total Round-Trip Fees: ₹62.30
   - Fee Points: ₹62.30 / 25 = **2.49 premium points**
   - **Total Round-Trip Friction: 0.463 spread + 2.49 fees = 2.95 premium points**

### 1.3 Delta Benchmark Assumption

- At ATM strikes, option delta is mathematically $\approx 0.50$ ($\Delta_{call} \approx 0.50$, $|\Delta_{put}| \approx 0.50$).
- Target points in index space are scaled by $0.50$ to estimate expected option premium move points:
  $$\text{expectedPremiumMovePoints} = \text{targetPoints} \times 0.50$$
- If $\frac{\text{estimatedFrictionPoints}}{\text{expectedPremiumMovePoints}} > 0.35$ or $\text{expectedPremiumMovePoints} \le \text{estimatedFrictionPoints}$, `wouldVeto` is flagged with `EXCESSIVE_OPTION_FRICTION`.

---

## 2. Rejection & Silence Diagnosis

Between 2026-09-22 and 2026-10-16, the `native-pipeline` recorded 4,896 observations with zero approvals:
1. **Root Cause:** In [`apps/api/src/modules/autonomous-v2/domain/thesis-builder.ts`](file:///c:/Users/Kulwinder%20Singh/Desktop/personal/AI%20Quant%20Lab/apps/api/src/modules/autonomous-v2/domain/thesis-builder.ts#L101), `HAS_VALIDATED_ENTRY_RULE = false`.
2. **Flag Decoupling:** Added `--enable-empirical-liquidity-rule` to allow controlled test evaluations of candidate setups without altering production baseline invariants.
3. **Current Invariant:** The flag is deliberately **not enabled** in the live production scheduler to prevent premature execution on an unvalidated entry rule.

---

## 3. Producer Disambiguation (Option 3 Clarification)

In `differential_observations`:
- `ported-v1`: 712 observations (equivalence harness verifying port integrity against legacy V1, NOT native V2.2 decisions).
- `native-pipeline`: 110 approvals (Sep 15–21, 2026) + 4,896 abstentions/rejections (Sep 22–Oct 16, 2026).
- Grading all 822 would conflate two disparate producers. The 110 true native approvals are fully graded in `run-brain-v22-cost-adjusted-grading.ts`.
