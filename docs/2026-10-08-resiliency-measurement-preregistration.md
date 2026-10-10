# Pre-Registration: Resiliency Measurement Validation (H_RESILIENCY_MEASUREMENT_V1)

**Date**: 2026-10-08  
**Status**: PRE-REGISTERED (Frozen for execution)  
**Author**: Antigravity Quant Research  

---

## 1. Executive Context & Motivation

Before testing whether orderbook resiliency predicts Order Flow Imbalance (OFI) returns, we must establish that our Level 2 data feed can reliably observe and quantify "resiliency." The preceding static-depth experiment (`H_OFI_RESILIENCY`) demonstrated that instantaneous snapshots of total opposing depth do not linearly correspond to price impact, suggesting that HFT algorithms may be rapidly spoofing or replenishing liquidity. 

The microstructure literature (Large 2007; Lo & Hall) defines true resiliency as the *probability and speed of depth recovery following a liquidity shock*. Before treating this recovery rate as a predictive feature, we must conduct a measurement validation study.

This document formally pre-registers `H_RESILIENCY_MEASUREMENT_V1`. **This is not a trading profitability hypothesis.** It is a data validation experiment designed to answer: *Following objectively identified opposing-liquidity depletion events, does the L2 book exhibit measurable and repeatable depth recovery?*

---

## 2. Definitional Framework

### Baseline Depth ($D_{pre}$)
At any timestamp $t$, the short-term baseline standing depth is defined as the median of the total opposing standing quantity over the strictly trailing 5-second window.
- Lookback window: $D_{t-5s}$ to $D_{t-0.5s}$.
- Requirement: No prior shock episode active, and at least 5 seconds of valid pre-event depth.

### Depletion Event (The "Shock")
A liquidity shock occurs when the depth drops precipitously relative to the baseline.
- **Depletion Fraction ($S_t$)**: $S_t = \max\left(0, \frac{D_{pre} - D_{min, t:t+1s}}{D_{pre}}\right)$
- A valid shock episode is triggered when $S_t$ exceeds a statically calibrated threshold $X$, where $X$ is defined from the PRE-OOS history per instrument and per side.

### Calibration Constraint
- **Threshold $X$**: The 99th percentile ($Q_{0.99}$) of the depletion fraction ($S_t$).
- **De-clustering**: Evaluated over non-overlapping 1-second candidate windows in the Pre-OOS data, retaining at most one candidate per 30-second episode. 

### Non-Overlapping Episode Constraint
To prevent double-counting the same liquidity event, a shock triggers an active *recovery episode*. No new shock can be initiated for that specific instrument/side until the current recovery measurement window (30 seconds) has elapsed.

---

## 3. Recovery Curve Measurement

For every valid shock episode, we measure the recovery trajectory from the exact moment of minimum depth ($t_{min}$), **not** the start of the shock window ($t_0$). 

The normalized recovery fraction at horizon $h$ is:
$$Recovery(h) = \frac{D(t_{min}+h) - D_{min}}{D_{pre} - D_{min}}$$
where $h \in \{1s, 3s, 5s, 10s, 20s, 30s\}$. (Recovery fractions are NOT capped at 1.0, preserving overshoot information).

**Primary Metrics Collected per Episode:**
- `recovery_1s`, `recovery_3s`, `recovery_5s`, `recovery_10s`, `recovery_20s`, `recovery_30s` 
- `recovery_30s_fraction` (Completeness: How much of the consumed depth returned by 30s?)
- `T50_or_null` (Derived Half-Life $T_{50}$: The first horizon where $Recovery(h) \geq 0.50$; NULL if never reached)
- `cause_class` (`DEPTH_DEPLETION` vs `EXECUTION_CONFIRMED` vs `UNCONFIRMED_CAUSE`)

---

## 4. Methodological Invariants & Output

### Output Dataset
The primary output of this study is a serialized research dataset containing the following fields for every identified shock episode across the 7 OOS capture sessions:
- `episode_id`
- `shock_start_at` ($t_0$)
- `shock_min_at` ($t_{min}$)
- `instrument`
- `direction` (upward/downward)
- `opposing_side` (sell/buy)
- `pre_shock_depth` ($D_{pre}$)
- `minimum_depth` ($D_{min}$)
- `depletion_fraction`
- `recovery_1s`, `recovery_3s`, `recovery_5s`, `recovery_10s`, `recovery_20s`, `recovery_30s`
- `T50_or_null`
- `recovery_30s_fraction`
- `depth_event_at`, `depth_received_at`, `depth_age_ms`
- `cause_class`
- `episode_quality` (`COMPLETE_30S`, `PARTIAL`, `INVALID`)

### Success Criteria
This measurement validation will be considered "PASSED" if:
1. The data feed contains a statistically significant population of non-overlapping shock episodes across the OOS window.
2. The recovery curves exhibit coherent structural behavior (e.g., distinguishable fast-recovery vs. incomplete-recovery profiles) rather than pure random noise or uniformly instant recovery that suggests data artifacts.

*Note: There are NO FAST/SLOW quartile classifiers defined in this experiment. That step is explicitly deferred until the measurement capabilities are fully validated.*
