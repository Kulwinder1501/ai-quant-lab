# Pre-Registration: Cross-Asset Order Flow Imbalance (H_CROSS_ASSET_OFI_V1)

**Status:** PRE-REGISTERED — EXPLORATORY  
**Date**: 2026-10-09  
**Parent research program:** Phase 28 Microstructure Information Flow  
**Purpose:** Evaluate cross-impact and incremental-prediction by testing whether lagged OFI from a source index provides predictive information for a target index's future return, beyond the target's own OFI.

## 1. Primary Hypothesis

**H_CROSS_ASSET_OFI_V1**

Adding a lagged, valid source-instrument OFI observation improves the forecasting of a target instrument's forward return, providing incremental predictive value strictly beyond that captured by the target instrument's own contemporaneous OFI.

This hypothesis is tested bidirectionally but independently:
1. `NIFTY` (Source) $\to$ `BANKNIFTY` (Target)
2. `BANKNIFTY` (Source) $\to$ `NIFTY` (Target)

## 2. Frozen Design Decisions

1. **Source Signal**: Unchanged `OFI_BASELINE_V1` construction. The continuous OFI series is used (no top 1% threshold restrictions) to preserve statistical power.
2. **Cross-Asset Lag ($\ell$)**: One full, completed 30-second OFI interval before the target decision time ($t$). The source OFI must strictly precede the target decision ($t_{source} \le t - 30\text{s}$), ensuring causal lead-lag ordering verified by feed timestamps.
3. **Outcome Horizon**: The canonical 15-minute forward-return horizon already frozen in the baseline `OFI_BASELINE_V1` evaluation. No new horizons may be searched.
4. **Primary Comparison**: Target's own OFI versus (Target's own OFI + Lagged Source OFI).
5. **Evaluation Population**: All eligible, correctly timestamp-aligned target opportunities within the historical dataset.

## 3. Incremental Prediction Model

For a target opportunity at decision time $t$:
$$R_{\text{target}, t \to t+15m} = \beta_0 + \beta_1 \times OFI_{\text{target}, t} + \beta_2 \times OFI_{\text{source}, t-\ell} + \epsilon_t$$

The core estimand is whether the contribution of the cross-asset term ($\beta_2$) is statistically significant in the correct direction (e.g., source buying pressure predicts target positive returns).

## 4. Statistical Safeguards

- **Dependence-Aware Inference**: Standard errors and t-statistics must be computed using dependence-robust methods (e.g., HAC/Newey-West or block bootstrap) that respect overlapping 15-minute forward returns and intraday serial correlation.
- **Multiple Testing**: A pre-registered multiple-testing correction (e.g., Bonferroni) must be applied to the two directional tests ($p_{adj} < 0.05$).
- **Confluence is Secondary**: Evaluating the subset of events where Source OFI and Target OFI are perfectly aligned (Same-Direction Confluence) is retained strictly as a secondary diagnostic. It cannot rescue a primary hypothesis failure.

## 5. Falsification & Interpretation

- If the lagged cross-asset term fails to provide statistically significant incremental value ($p_{adj} \ge 0.05$) in either direction, the cross-impact hypothesis is FALSIFIED for that direction.
- This is an EXPLORATORY study utilizing the historical 7-session Phase 28 dataset. A positive result merely justifies an independently registered prospective replication.
- No live trading policies or scanner logic will be changed based on these findings.
