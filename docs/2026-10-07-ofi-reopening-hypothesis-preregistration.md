# Pre-Registration: Order Flow Imbalance (OFI) Re-Opening Hypothesis (V1)

**Date**: 2026-10-07  
**Status**: PRE-REGISTERED (Offline Research Scope Only)  
**Author**: Antigravity Quant Research  

---

## 1. Executive Context & Motivation

Phase 28 (`docs/phase-28-microstructure-information-flow.md`) evaluated unconditioned raw Order Flow Imbalance (OFI) and established that unconditioned OFI suffers from **sign instability** across independent test windows. The Phase 28 verdict states:

> "Sign reversal on both horizons. Verdict: DOES NOT REPLICATE... Status: closed, not advanced."

Fixing feature units alone (e.g. converting IC to raw feature units) does NOT constitute a valid reopening of Phase 28. To systematically evaluate whether OFI contains conditional information flow, this document formally pre-registers a conditional hypothesis prior to any code refactoring or re-testing.

---

## 2. Hypothesis Specification

### Primary Hypothesis (H_OFI_CONDITIONAL)
Order Flow Imbalance (OFI) exhibits statistically and economically significant directional predictive power *only when conditioned on specific market microstructure regimes*:
1. **Time-of-Day (ToD) Regime**: Information content is concentrated in `MORNING_TREND` (09:45 - 11:30) and `AFTERNOON_EXPANSION` (13:30 - 15:00), while `MIDDAY_CONSOLIDATION` contains noise.
2. **Days-to-Expiry (DTE)**: Information flow in index futures/options OFI is state-dependent on DTE (DTE <= 1 vs DTE > 1).
3. **Volatility Regime**: Price impact of OFI is scaled by Yang-Zhang volatility (\(\sigma_{YZ}\)).

---

## 3. Governance Invariants & Metric Hierarchy

### Unambiguous Metric Specification
To prevent post-hoc metric selection ("p-hacking"), evaluation must strictly adhere to the following metric hierarchy:

- **Primary Metric**: `Cost-Adjusted Net Return (bps)`
- **Secondary Metric**: `Directional Gross Return (bps)`

### Comparison Baseline & Cohort Invariance
- Benchmark Baseline: `OFI_BASELINE_V1` (NIFTY50 + BANKNIFTY_FUT, PIT-isolated, matched pairs).
- Candidate models (OFI, OFI + ToD, OFI + ToD + YZ_Vol) MUST be evaluated on the exact same immutable comparison cohort. No candidate model may silently alter row eligibility or bar selection.

### Anti-P-Hacking Rule
If the pre-registered hyperparameter bounds fail the statistical or economic significance gates, the hypothesis is **FALSIFIED**. It cannot be rescued by post-hoc grid-search tuning on the same dataset. Any subsequent modification requires registering a new hypothesis document with a fresh out-of-sample data window.

---

## 4. Acceptance Gates

For H_OFI_CONDITIONAL to pass research evaluation:
1. **Statistical Gate**: t-statistic > 3.0 on `Cost-Adjusted Net Return (bps)` across out-of-sample split.
2. **Sign Stability Gate**: Directional sign must be uniform across all out-of-sample test windows (zero sign reversals).
3. **Economic Gate**: Net return after friction (slippage + transaction costs) > 1.5 bps per trade.
4. **Combined-Gate Isolation**: Passing individually does NOT authorize live inference wiring. Live wiring requires an explicit secondary gate approval document.

---

## 5. Implementation Boundaries

- All research code for this pre-registration must remain strictly within `apps/ml/`.
- No code from this investigation may be imported into `apps/api/src/domain/` or live trading bots.
