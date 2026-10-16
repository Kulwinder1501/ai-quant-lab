# Brain V2.2 Option Friction Constants & Telemetry Audit (2026-10-16)

## Executive Summary

This document provides full traceability for the empirical friction constants and telemetry gate implemented in Brain V2.2 P8 Risk Approver (`risk-approver.ts`) and the shadow decision runner (`run-shadow-decisions.ts`).

---

## 1. Traceability of Calibrated ATM Friction Constants

The P8 shadow option friction calculation uses:
- **BANKNIFTY:** `4.35` premium points round-trip (`1.70 pts` ATM spread + `2.65 pts` statutory fees)
- **NIFTY50:** `1.08` premium points round-trip (`0.25 pts` ATM spread + `0.83 pts` statutory fees)
- **Delta:** `0.50` (ATM option benchmark)

### 1.1 Empirical Bid/Ask Spread (Restricted to ATM Contracts)

An initial unconstrained query across all 3.3 million ticks in `option_premium_ticks` included illiquid, deep out-of-the-money and in-the-money contracts with spreads as wide as 793 pts, skewing the overall mean. Restricting the query to genuine ATM contracts (`abs(strike_price - underlying_value) <= strike_step`, where `strike_step` is 100 for BANKNIFTY and 50 for NIFTY50) yields 1,412,500 ATM ticks:

```sql
SELECT 
    underlying_symbol,
    count(*) as atm_ticks,
    round(avg(ask - bid), 4) as avg_spread,
    round(percentile_cont(0.5) within group (order by ask - bid)::numeric, 4) as median_spread,
    round(percentile_cont(0.75) within group (order by ask - bid)::numeric, 4) as p75_spread,
    round(min(ask - bid), 4) as min_spread,
    round(max(ask - bid), 4) as max_spread,
    round(avg((ask + bid)/2.0), 2) as avg_mid_premium,
    round(percentile_cont(0.5) within group (order by (ask + bid)/2.0)::numeric, 2) as median_mid_premium
FROM option_premium_ticks
WHERE ask > bid
  AND underlying_value IS NOT NULL
  AND (
      (underlying_symbol = 'BANKNIFTY' AND abs(strike_price - underlying_value) <= 100)
   OR (underlying_symbol = 'NIFTY50' AND abs(strike_price - underlying_value) <= 50)
  )
GROUP BY underlying_symbol;
```

**Query Results:**

| Instrument | ATM Ticks | Mean Spread (pts) | Median Spread (pts) | P75 Spread (pts) | Mean ATM Premium | Median ATM Premium |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **BANKNIFTY** | 682,107 | **1.70** (1.6961) | **1.55** | 2.20 | 581.61 | 563.05 |
| **NIFTY50** | 730,393 | **0.25** (0.2517) | **0.25** | 0.35 | 107.74 | 109.35 |
| **Combined** | **1,412,500** | — | — | — | — | — |

*(Note: If using half-strike windows or unexpired contract subsets, counts adjust to ~346k / ~369k with identical median and mean spreads).*

### 1.2 Statutory Round-Trip Fees with Registered Lot Sizes

Modelled via [`apps/api/src/modules/paper-trading/domain/brokerage-calculator.ts`](file:///c:/Users/Kulwinder%20Singh/Desktop/personal/AI%20Quant%20Lab/apps/api/src/modules/paper-trading/domain/brokerage-calculator.ts) using the contract lot sizes registered in the `instruments` table (migrations 019, 020, 053: `BANKNIFTY = 30`, `NIFTY50 = 75`):
- **Brokerage:** ₹20 flat per executed order (₹40 round-trip).
- **Exchange Turnover Charges:** 0.03503% on premium turnover.
- **GST:** 18% on (brokerage + exchange charges).
- **STT (Securities Transaction Tax):** 0.1% on sell side premium turnover.
- **SEBI Charges:** ₹10 per crore turnover.
- **Stamp Duty:** 0.003% on buy side premium turnover.

**Fee Calculation at Observed ATM Premiums:**
1. **BANKNIFTY (`lot_size = 30`, ATM premium ~580 pts):**
   - Entry Fees: ₹31.34
   - Exit Fees: ₹48.22
   - Total Round-Trip Fees: ₹79.56
   - Fee Points: ₹79.56 / 30 = **2.65 premium points**
   - **Total Round-Trip Friction: 1.70 spread + 2.65 fees = 4.35 premium points** (or 4.20 pts with median spread).

2. **NIFTY50 (`lot_size = 75`, ATM premium ~108 pts):**
   - Entry Fees: ₹27.20
   - Exit Fees: ₹35.06
   - Total Round-Trip Fees: ₹62.26
   - Fee Points: ₹62.26 / 75 = **0.83 premium points**
   - **Total Round-Trip Friction: 0.25 spread + 0.83 fees = 1.08 premium points** (identical with mean or median spread).

### 1.3 Correction from Earlier Draft (7.68 and 2.95)

An earlier pass computed 7.68 pts for BANKNIFTY and 2.95 pts for NIFTY50. That calculation had two defects:
1. **Unfiltered Spreads:** Spreads were computed across all strikes including deep OTM/ITM contracts (yielding 3.33 pts for BANKNIFTY and 0.46 pts for NIFTY50 instead of 1.70 pts and 0.25 pts).
2. **Outdated Lot Sizes:** Assumed historical lot sizes of 15 (BANKNIFTY) and 25 (NIFTY50), spreading the ₹40 flat brokerage over far fewer units and inflating fee points by 36% to 190%.

Updating to genuine ATM spreads and registered lot sizes corrects the friction from `7.68 -> 4.35` (BANKNIFTY) and `2.95 -> 1.08` (NIFTY50), preventing false vetoes on viable setups.

### 1.4 Delta Benchmark Assumption

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
