# Pre-Registration: Order Flow Imbalance (OFI) Dynamic Replenishment Hypothesis (H_OFI_REPLENISHMENT)

**Date**: 2026-10-08  
**Status**: PRE-REGISTERED (Frozen for execution)  
**Author**: Antigravity Quant Research  

---

## 1. Executive Context & Motivation

The measurement validation study (`H_RESILIENCY_MEASUREMENT_V1`) confirmed that our Level 2 data feed can empirically measure a dynamic depth-recovery process following extreme opposing-depth depletion episodes. The average empirical behavior demonstrates that static snapshots of a "thin" book are highly misleading because liquidity tends to structurally recover to ~97% fullness within 3 seconds.

This document formally pre-registers `H_OFI_REPLENISHMENT`. This hypothesis leverages the **historical dynamic recovery state** of the orderbook. We define this state using the continuous Area Under the Curve (AUC) of the liquidity deficit following recent shocks.

---

## 2. Hypothesis Specification

### Primary Hypothesis
**Conditional on the unchanged `OFI_BASELINE_V1` signal, the subsequent net price response differs systematically with the Point-In-Time (PIT) state of prior opposing-liquidity recovery, measured from completed shock episodes available before `decisionAt`.**

*(Note: In accordance with preliminary NSE-specific empirical evidence, we remain explicitly agnostic on the expected sign (continuation vs. mean reversion) of the interaction term. We test for a systematic difference in expected net return across regimes rather than mandating a specific directional profit mechanism).*

---

## 3. Definitional Framework

### The Predictive Feature: Liquidity Deficit AUC
For any completed shock episode $E$ (measured via the exact `H_RESILIENCY_MEASUREMENT_V1` methodology), we define the **30-second Liquidity Deficit Area Under the Curve (AUC)** using discrete measurement horizons $h \in \{0s, 1s, 3s, 5s, 10s, 20s, 30s\}$:

$$ Deficit(h) = 1 - Recovery_E(h) $$
*(Where $Recovery_E(0s) = 0$ by definition).*

The $AUC_{30}$ is computed via fixed trapezoidal integration over the pre-registered recovery horizons. A higher AUC represents a slower or more incomplete recovery (persistent liquidity deficit).

### The Point-In-Time (PIT) Trailing State
At any decision moment $t$ (`decisionAt`):
1. Identify the $N=5$ most recently *completed* shock episodes for the relevant instrument and opposing side. An episode is strictly completed only after its 30-second measurement window has fully elapsed prior to $t$.
2. **Staleness Constraint**: The oldest of the $N=5$ episodes must have completed $\ge t - 30\text{min}$. If fewer than 5 eligible completed episodes exist within the last 30 minutes, the state is `STATE_UNAVAILABLE`.
3. The conditional feature $PIT\_AUC(t)$ is defined as the median $AUC_{30}$ of these 5 trailing episodes.

### Calibration & Regime Definition
Using strictly PRE-OOS history, we compile the empirical distribution of completed shock $AUC_{30}$ values and freeze quartiles per instrument and opposing side:
- **Q1**: Lowest AUC (Fastest / most resilient recovery).
- **Q4**: Highest AUC (Slowest / least resilient recovery).

If the state is `STATE_UNAVAILABLE`, no quartile is assigned and the opportunity is excluded from the conditional test.

---

## 4. Methodological & Statistical Invariants

- **Comparison Baseline**: Exact-match enforcement against `OFI_BASELINE_V1`.
- **Primary Endpoint**: Cost-adjusted signed net return.
- **Primary Null Hypothesis ($H_0$)**: $E[R_{net}|Q1] = E[R_{net}|Q2] = E[R_{net}|Q3] = E[R_{net}|Q4]$
- **Primary Statistical Test**: Omnibus quartile-heterogeneity statistic measuring dispersion of the four group means around the overall conditional mean.
- **Inference**: Session-preserving **30-minute circular-block randomization test** (100,000 fixed-seed permutations). This breaks the contemporaneous alignment between the persistent AUC state and OFI return sequence while preserving intra-session autocorrelation and state persistence.
- **Secondary Diagnostics**: Endpoint contrast ($\Delta_{Q4-Q1}$), absolute return, MFE/MAE variance, and coverage statistics.

---

## 5. Acceptance Gates
1. **Statistical Gate**: Omnibus heterogeneity permutation p-value $< 0.05$.
2. **Economic Gate**: At least one recovery regime quartile achieves a Cost-Adjusted Net Return $> 2.0$ bps per trade.
