# Pre-Registration: Order Flow Imbalance (OFI) Resiliency Hypothesis (H_OFI_RESILIENCY)

**Date**: 2026-10-07  
**Status**: PRE-REGISTERED (Offline Research Scope Only)  
**Author**: Antigravity Quant Research  

---

## 1. Executive Context & Motivation

Following the evaluation of `H_OFI_CONDITIONAL` which falsified the notion that OFI edge could be rescued purely through time-of-day and volatility filters, we pivot to structural microstructure dependencies. 

Academic literature (Cont, Kukanov and Stoikov) establishes that short-horizon price changes are driven strongly by OFI, but the *impact slope* is inversely related to market depth. A highly imbalanced order flow will not displace the mid-price if it meets a highly resilient (deep) standing orderbook. Therefore, OFI must be evaluated as a function of the opposing liquidity it attempts to consume.

This document formally pre-registers `H_OFI_RESILIENCY` to systematically evaluate whether OFI contains predictive power when conditioned on standing orderbook depth. 
*(Note: While part of the "resiliency" research family, this specific experiment tests the standing-depth capacity component of liquidity; it does not directly measure replenishment speed, which is reserved for a future `H_OFI_REPLENISHMENT` study).*

---

## 2. Hypothesis Specification

### Primary Hypothesis (H_OFI_RESILIENCY)
Does OFI have greater price impact when opposing standing depth is thin?
Specifically, high OFI accurately predicts a successful sweep (breach) with higher monetary expectancy **only when the opposing standing depth is relatively low** (high price-impact elasticity). When standing depth is thick, even extreme OFI fails to reliably breach the level.

### Canonical Research Unit
The opportunity is defined strictly as `(decisionAt, instrument, candidatePool)`, where `candidatePool.availableAt <= decisionAt`. The structural sweep/contact is a strictly *forward* outcome, never a precursor to the observation.

### Independent Variables
1. **OFI (Order Flow Imbalance)**: Raw or decaying touch-level OFI accumulated over a trailing 5-second window leading up to `decisionAt`.
2. **Opposing Standing Depth / Liquidity Capacity**: 
   - Measured as the total standing volume on the opposing side of the orderbook (`total_sell_qty` for upward structural resistance, `total_buy_qty` for downward structural support).
   - Evaluated using a **Point-in-Time (PIT) historical percentile rank**. 
   - The thresholds (Q25, Q50, Q75) must be static, computed from the PRE-OOS warmup history independently per instrument and per side (e.g., NIFTY buy-depth vs BANKNIFTY sell-depth).
3. **Diagnostic Metadata**:
   - `top5_opposing_depth` and `top5_share` will be persisted as diagnostic metadata for future concentration studies, but do not gate this hypothesis.

---

## 3. Governance Invariants & Metric Hierarchy

### Unambiguous Metric Specification
To prevent post-hoc metric selection ("p-hacking"), evaluation must strictly adhere to the following metric hierarchy:

- **Primary Inference**: Opportunity-level monotonic relationship between `opposing_depth_percentile` and `Cost-Adjusted Net Return (bps)`.
- **Secondary Diagnostic**: Q1 / Q2 / Q3 / Q4 descriptive table mapping thin vs. thick depth against expected returns.

### Comparison Baseline & Cohort Invariance
- Benchmark Baseline: Unconditioned structural sweeps (`OFI_BASELINE_V1`).
- The evaluation logic MUST programmatically enforce an exact-match assertion against `OFI_BASELINE_V1` to ensure depth observation does not silently alter row eligibility or baseline calculation.

### Point-in-Time (PIT) Constraints
- **Dual-Clock Strict Enforcement**: The `depth_frame` utilized must be strictly prior to `decisionAt`. We define `canonical_event_at = exchange_feed_time ?? vendor_send_time`. The frame MUST satisfy BOTH:
  - `canonical_event_at <= decisionAt`
  - `received_at <= decisionAt`
- **Lag Audit**: `depth_age_ms` (`decisionAt - canonical_event_at`) and `availability_lag_ms` (`received_at - canonical_event_at`) will be computed and recorded.
- Static pre-OOS thresholds must strictly use data prior to the OOS window boundary. Global or dynamic OOS quartiles are explicitly forbidden to prevent leakage.

### Anti-P-Hacking Rule
If the pre-registered hyperparameter bounds fail the statistical or economic significance gates, the hypothesis is **FALSIFIED**. It cannot be rescued by post-hoc grid-search tuning on the same dataset. 

---

## 4. Acceptance Gates

For `H_OFI_RESILIENCY` to pass research evaluation:
1. **Statistical Gate**: Exact enumeration of all 5,040 whole-session permutations of the return blocks, preserving within-session ordering, using a one-sided test for H1: Spearman $\rho_S < 0$ between `opposing_depth_percentile` and `Cost-Adjusted Net Return`. A statistically significant negative association is required.
2. **Economic Gate**: Net return after friction (slippage + transaction costs) > 2.0 bps per trade in the highest-elasticity (lowest-depth/Q1) regime.
3. **Replication Requirement**: Passing these gates across the 7-session discovery window results in a "PROSPECTIVE REPLICATION REQUIRED" status, rather than immediate live authorization.

---

## 5. Implementation Boundaries

- All research code for this pre-registration must remain strictly within `apps/ml/`.
- No code from this investigation may be imported into `apps/api/src/domain/` or live trading bots until explicit authorization via a secondary gate approval document.
