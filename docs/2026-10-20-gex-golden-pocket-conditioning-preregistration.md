# Pre-Registration: Standalone Dealer Gamma Exposure (GEX) Signal Check & Conditioned Golden Pocket Retracement Interaction Test

**Document ID:** `PREREG-2026-10-20-GEX-FIB-INTERACTION-V1`  
**Date Frozen:** `2026-10-20`  
**Governance Status:** Research Specification / Protocol Pre-Registration  
**Trading Execution Authorized:** `false`  
**Parent Specifications:**
- [Phase C Numerical Pipeline Contract v1.4.1 / Research Specification v1.1](phase_c_results.json)
- [docs/2026-10-10-fibonacci-order-flow-realignment.md](2026-10-10-fibonacci-order-flow-realignment.md)
- [docs/phase-28-microstructure-information-flow.md](phase-28-microstructure-information-flow.md)
- [apps/ml/oi_pcr_signal_check.py](../apps/ml/oi_pcr_signal_check.py)

---

## 1. Executive Summary & Reality Check

The original research inquiry proposed conditioning the Phase C Fibonacci **Golden Pocket** retracement outcome on dealer gamma exposure (`netDealerGammaExposure`). 

Before executing any statistical test on outcomes, a senior analyst's primary obligation is to evaluate sample integrity and prevent under-powered, thin slices from manufacturing confident-looking noise dressed as findings.

In the baseline Phase C location-only manifest (`phase_c_results.json`), the Bullish Golden Pocket cell (`F1_GOLDEN_POCKET`) is the single best-populated treatment cell in the entire pipeline, yet it contains only:
- **44 evaluation treatment contacts**
- **35 matched pairs** (after 1:1 propensity matching with replacement-free caliper against counterfactual active-anchor controls).

A Step 0 data coverage audit conducted directly on the production database (`DATABASE_URL`) reveals that options chain capture (`option_chain_snapshots`) only commenced on **2026-08-05 06:30 UTC**, while the underlying 5m candle history spans from **2024-01-01** (for `NIFTY50`) and **2026-01-01** (for `BANKNIFTY`). Consequently:
- Of the 35 matched Golden Pocket pairs, only **12 pairs** possess `FRESH` options context at zone contact (**34.29% coverage**).
- Splitting those 12 pairs by the economic sign of `netDealerGammaExposure` produces a **9 vs. 3** bucket split.

Attempting to estimate an interaction effect on a cell with 3 observations in one bucket is mathematically vacuous and statistically reckless. Therefore, this pre-registration establishes **two distinct research tracks**:
1. **Track 1 (Standalone Continuous GEX Predictability Test):** A well-powered, broad-sample test across all complete 5m bars in the post-2026-08-05 window where `gexState == "FRESH"`, evaluating whether dealer gamma exposure predicts tradeable forward returns (`netReturnBps`) outside of thin geometric subsets.
2. **Track 2 (Conditioned Golden Pocket Interaction Test):** The literal interaction test on the Golden Pocket cell, governed by a strict, pre-registered sample floor of **minimum 15 matched pairs per GEX-sign bucket**. If either bucket fails to meet this floor, the pipeline is contractually bound to emit `INCONCLUSIVE_INSUFFICIENT_DATA` rather than reporting an ungrounded point estimate.

---

## 2. Step 0 Coverage Audit Results (Recorded Baseline)

All statistics below were computed across 100% complete intraday 5m candle bars restricted strictly to trading session hours (`09:15:00` to `15:30:00 IST`).

### Table 1: Treatment Contacts Coverage by Zone and Direction

| Cohort | Total Contacts | `FRESH` & Non-Null GEX | Coverage % | `STALE` (>15m) | `UNAVAILABLE` (Pre-Aug-5) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **All Index Treatments** (NIFTY50 + BANKNIFTY, Bull + Bear) | 162 | 26 | **16.05%** | 7 | 129 |
| **Bullish Treatments** (All zones: GP, OTE, Deep Retracement) | 84 | 22 | **26.19%** | 5 | 57 |
| **Bearish Treatments** (All zones: GP, OTE, Deep Retracement) | 78 | 4 | **5.13%** | 2 | 72 |
| **Golden Pocket (Bullish)** | 52 | 16 | **30.77%** | 4 | 32 |
| **Golden Pocket (Bearish)** | 35 | 0 | **0.00%** | 1 | 34 |
| **Golden Pocket (Combined Bull + Bear)** | 87 | 16 | **18.39%** | 5 | 66 |
| **All Controls** (Counterfactual active-anchor legs) | 13,490 | 2,493 | **18.48%** | 260 | 10,737 |

### Table 2: Golden Pocket Evaluation & Matched-Pair Coverage (Bullish F1 Cell)

| Stage | Total Count | `FRESH` GEX | Coverage % | Long Gamma (`>0`) | Short Gamma (`<0`) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Evaluation Slice** (80% post-calibration) | 44 | 16 | 36.36% | 12 | 4 |
| **1:1 Matched Pairs** (`F1_GOLDEN_POCKET`) | 35 | 12 | 34.29% | **9** | **3** |

### Empirical Validation of Bullish vs. Bearish Coverage Asymmetry
Bearish Golden Pocket yielded 0 / 35 `FRESH` contacts. A line-by-line audit of all 35 contacts confirmed this is entirely an empirical clustering reality, not a scanner or resolver bug:
- **NIFTY50 Bearish GP (13 contacts):** All 13 contacts occurred between `2024-01-02` and `2026-07-13` (strictly prior to options chain capture initiation).
- **BANKNIFTY Bearish GP (22 contacts):** 21 contacts occurred between `2026-01-01` and `2026-08-03` (strictly pre-capture). Exactly 1 contact occurred post-August 5 (`2026-09-04 05:10 UTC`), and arrived during a >15-minute capture pause, correctly classifying as `STALE`.
- For other bearish zones post-August 5 (OTE and Deep Retracement), 4 contacts resolved `FRESH` with valid, non-null GEX, confirming the bearish scan path resolves options context identically to the bullish path.

---

## 3. Economic Hypothesis & Theoretical Mechanism

The conditioning rule rejects post-hoc median splitting, arbitrary quantile cuts, or threshold optimization. The split is strictly governed by the physical market-structure sign of `netDealerGammaExposure`:

$$\text{sign}(\text{netDealerGammaExposure}) = \begin{cases} +1 & \text{if } \text{netDealerGammaExposure} > 0 \quad (\text{Long Gamma}) \\ -1 & \text{if } \text{netDealerGammaExposure} < 0 \quad (\text{Short Gamma}) \end{cases}$$

### Economic Justification (Pre-Committed Verbatim)
> **Dealers net short gamma (negative) $\rightarrow$ dealers must hedge with the move (buy as it rises, sell as it falls) $\rightarrow$ trending, momentum-friendly.**  
> **Dealers net long gamma (positive) $\rightarrow$ dealers hedge against the move $\rightarrow$ pinning, mean-reversion.**  
> **A Fibonacci retracement setup is a continuation bet. The theory-consistent prediction is: it should work better in the short-gamma (negative) regime and worse/reverse in the long-gamma (positive) regime.**

This forms an explicit, falsifiable prediction:
- In the **Short Gamma** regime (`netDealerGammaExposure < 0`), continuation out of the Golden Pocket retracement should yield higher signed `netReturnBps`.
- In the **Long Gamma** regime (`netDealerGammaExposure > 0`), continuation should be damped or reversed by dealer counter-hedging (pinning), yielding lower or negative signed `netReturnBps`.

---

## 4. Track 1: Standalone High-Power Test Specification

To determine whether `netDealerGammaExposure` contains any predictive information regarding forward asset returns outside of small geometric subsets, Track 1 executes a standalone signal check.

### 4.1 Population Definition
- **Instruments:** `NIFTY50` and `BANKNIFTY` evaluated independently and pooled.
- **Time Window:** All completed 5m bars from **2026-08-05 06:30 UTC** to date where:
  1. Bar timestamp falls within official session hours (`09:15:00` to `15:30:00 IST`).
  2. Bar is not near session close (entry bar $\le$ `15:15:00 IST`).
  3. `gexState == "FRESH"` (snapshot age $\le 15$ minutes).
  4. `netDealerGammaExposure` is non-null.

### 4.2 Outcome Metric & Horizon
- **Metric:** Signed tradeable net return in basis points (`netReturnBps`), identical to Phase C Contract v1.4.1:
  $$\text{netReturnBps} = \text{direction\_sign} \times \left( \frac{\text{exit\_price} - \text{entry\_price}}{\text{entry\_price}} \right) \times 10{,}000 - \text{friction\_bps}$$
- **Execution Convention:**
  - Entry price = next bar's `open` ($t+1$).
  - Exit price = close of the bar at horizon end ($t + 3$ bars for 5m timeframe = 15 minutes).
  - Friction = 2.0 bps round-trip (`ROUND_TRIP_FRICTION_BPS`).
- **Directional Stratification:**
  - Evaluated for **Bullish** (long forward return, direction sign = $+1$).
  - Evaluated for **Bearish** (short forward return, direction sign = $-1$).
- **Anti-Pattern Guard:** No 3-class triple-barrier direction labeling is used. In alignment with previous project learnings (`apps/ml/gap-analysis-*`), direction classification masks continuous edge; continuous `netReturnBps` is the primary outcome.

### 4.3 Statistical Test & Falsification Posture
- Modeled directly on [apps/ml/oi_pcr_signal_check.py](../apps/ml/oi_pcr_signal_check.py).
- **Overlapping-Window Confound (Critical Statistical Hazard):** Each 5m bar evaluates forward returns over a 15-minute (3-bar) horizon. Bar $i$'s window $[i+1, i+3]$ and Bar $i+1$'s window $[i+2, i+4]$ share 2 of 3 bars. Standard tests assuming independent observations (Pearson/Spearman correlation and Welch's t-test) will suffer severe variance underestimation and manufacture artificially deflated p-values from intra-session serial dependence.
- **Sole Primary Decision-Bearing Test:** The **session-block bootstrap difference in means** (`_session_bootstrap_means` from `experiments_f1_f4.py`) is the sole primary, decision-bearing test. By resampling entire sessions as indivisible blocks, it preserves the true intraday autocorrelation and serial dependence structure. A finding of significance requires the 95% session-block bootstrap CI on $\overline{\text{netReturnBps}}_{S^-} - \overline{\text{netReturnBps}}_{S^+}$ to exclude zero.
- **Descriptive-Only Metrics:** Pearson $r$, Spearman $\rho$, and Welch's two-sample $t$-test are demoted to descriptive diagnostics only and must be explicitly labeled: *"not a significance claim, confounded by window overlap."*
- **Baseline Benchmarking:** If discretized into binary direction (positive vs. negative net return), report **both** accuracy and macro-F1 against the trivial majority baseline (preventing F1 artifacts from masking accuracy edges).

---

## 5. Track 2: Conditioned Golden Pocket Interaction Test Specification

Track 2 tests the literal interaction hypothesis: does conditioning the Phase C Golden Pocket retracement setup on GEX regime modulate its treatment effect?

### 5.1 Population & Matching Protocol
- **Treatment Cohort:** `GOLDEN_POCKET` treatment episodes from the 80% evaluation split in `load_historical_episodes_from_db`.
- **Counterfactual Control Cohort:** Non-zone observations from the same live anchors prior to first zone contact.
- **Matching Algorithm:** Deterministic 1:1 Nearest-Neighbor Propensity Matching without replacement (`PropensityMatcher.match_1to1_deterministic`), with:
  - Exact match on instrument (`symbol`) and session (`sessionDate`).
  - Caliper $\le 0.20$ standard deviations of logit propensity scores (`PROPENSITY_CALIPER_SD = 0.20`).
  - Maximum temporal distance $\le 30$ minutes (`SAME_SESSION_MATCH_WINDOW_MS = 30 * 60 * 1000`, the frozen spec value restored on 2026-10-10).

### 5.2 Conditioning Rule
For each matched pair, the treatment episode's GEX regime is determined strictly at the moment of entry bar contact:
- **Short Gamma Bucket ($S^-$):** `netDealerGammaExposure < 0` and `gexState == "FRESH"`.
- **Long Gamma Bucket ($S^+$):** `netDealerGammaExposure > 0` and `gexState == "FRESH"`.
- Observations with `gexState != "FRESH"` or `netDealerGammaExposure == 0` are excluded from the conditioned comparison.

### 5.3 The Sample Floor Gate (Pre-Registered Falsification Barrier)
- **Minimum Bucket Floor:** **$n_{\text{min}} \ge 15$ matched pairs** per GEX-sign bucket.
- **Binding Rule:** If either $n(S^-) < 15$ or $n(S^+) < 15$, the pipeline **must refuse to report a point estimate or claim an interaction edge**.
- **Mandatory Verdict:** Under floor violation, the formal test result must be recorded as:
  $$\text{Verdict} = \mathbf{INCONCLUSIVE\_INSUFFICIENT\_DATA}$$
  with the observed pair counts ($n=9$ and $n=3$) and the required threshold ($n=15$) explicitly reported in the manifest.

### 5.4 Test Statistic (Applicable Only if Floor Passes)
If and only if both buckets meet the $n \ge 15$ floor:
$$\widehat{\Delta}_{\text{interaction}} = \overline{\text{netReturnBps}}_{S^-} - \overline{\text{netReturnBps}}_{S^+}$$
- Standard Error and 95% Confidence Interval computed via session-block bootstrap (`_session_bootstrap_means` from `experiments_f1_f4.py`).
- Minimum Detectable Effect (MDE) reported at $\alpha = 0.05, \beta = 0.20$.

---

## 6. Synthetic Plumbing Validation Gate

In accordance with Phase C pipeline protocol (Contract v1.4.1), no empirical outcome from real data will be computed or reported until the statistical machinery passes synthetic validation:

1. **Injected Interaction Validation:** Generate synthetic episodes with a known injected GEX interaction ($\Delta = +10.0\text{ bps}$ in short gamma vs. $-2.0\text{ bps}$ in long gamma; $n \ge 50$ per bucket). The code must correctly recover the sign and reach `SUPPORTED`.
2. **Known Null Validation:** Generate synthetic episodes with zero interaction ($\Delta = 0.0\text{ bps}$; identical outcome distributions across GEX sign). The code must reach `FALSIFIED` or null without false-positive inflation.
3. **Floor Enforcement Validation:** Generate synthetic episodes with $n = 12$ matched pairs (9 vs. 3). The code must strictly emit `INCONCLUSIVE_INSUFFICIENT_DATA` and refuse point estimation.

---

## 7. Execution Order & Protocol Commitments

1. This pre-registration document is committed to version control before code extensions or real evaluations execute.
2. Step 2 code change implements `netDealerGammaExposure: Optional[float] = None` as an additive field in `ObservationEpisode`.
3. Synthetic plumbing validation runs and passes.
4. Standalone Track 1 script executes on the post-2026-08-05 dataset.
5. Conditioned Track 2 executes with the $n \ge 15$ sample floor enforced.
6. Final manifest and writeup emit full findings with standard exploratory notice and explicit non-authorization of trading execution.
