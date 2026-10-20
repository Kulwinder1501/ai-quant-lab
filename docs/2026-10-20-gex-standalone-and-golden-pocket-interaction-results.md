# Empirical Results: Standalone Dealer Gamma Exposure (GEX) Signal Check & Conditioned Golden Pocket Retracement Interaction Test

**Document ID:** `RESULTS-2026-10-20-GEX-FIB-INTERACTION-V1`  
**Date Executed:** `2026-10-20`  
**Governance Status:** `PHASE_C_RESEARCH_EXECUTION_COMPLETE`  
**Trading Execution Authorized:** `false`  
**Pre-Registration Reference:** [docs/2026-10-20-gex-golden-pocket-conditioning-preregistration.md](2026-10-20-gex-golden-pocket-conditioning-preregistration.md) (`PREREG-2026-10-20-GEX-FIB-INTERACTION-V1`)  
**Pre-Registration Frozen Commits:** `b80b522b`, `71c614fb`, `8e8d985c`  
**Execution Manifest:** [`apps/ml/gex_experiment_results.json`](../apps/ml/gex_experiment_results.json)  

---

## 1. Executive Summary & Senior Analyst Verdict

Following the pre-registered protocol, the empirical evaluation was executed across two distinct tracks:
1. **Track 1 (Standalone Continuous Test on 5,116 Real Bars):** Evaluated whether dealer gamma exposure (`netDealerGammaExposure`) predicts tradeable 15-minute forward net returns (`netReturnBps`, minus 2.0 bps round-trip friction) across all complete 5m candle bars where GEX resolved `FRESH` (snapshot age $\le 15$ min) in the post-2026-08-05 capture window across `NIFTY50` and `BANKNIFTY`.
   - **Verdict:** **`NULL_NO_EDGE`** (Falsified).
   - **Primary Test (Session-Block Bootstrap Difference in Means):** $\widehat{\Delta} = +0.26\text{ bps}$, 95% CI $[-0.61, +1.09]\text{ bps}$, $\text{SE} = 0.43\text{ bps}$, $p = 0.5600$. The confidence interval firmly covers zero.
   - **Classification Benchmarking:** Directional accuracy ($56.18\%$) fails to beat the trivial majority baseline ($64.82\%$). Macro-F1: $0.497$. GEX has zero standalone predictive edge on 15m forward returns.
2. **Track 2 (Conditioned Golden Pocket Retracement Interaction Test):** Evaluated the literal interaction hypothesis—whether the Golden Pocket's causal incremental surplus over its matched counterfactual control (`pair.deltaNetReturnBps`) is enhanced in the Short Gamma regime (`GEX < 0`) and damped in the Long Gamma regime (`GEX > 0`).
   - **Verdict:** **`INCONCLUSIVE_INSUFFICIENT_DATA`** (Refusal to Estimate).
   - **Sample Floor Enforcement:** The pre-registered floor of **minimum 15 matched pairs per GEX-sign bucket** strictly bound. Among the 35 matched pairs, only 12 had fresh GEX, splitting into **3 Short Gamma pairs** and **9 Long Gamma pairs** ($3 < 15$ and $9 < 15$).
   - **Point Estimate Suppressed:** In accordance with pre-registration §5.3, the pipeline refused to emit a point estimate (`estimateHatDeltaBps = None`), preventing 3 noisy pairs from being paraded as a discovery.

---

## 2. Track 1: Standalone Continuous GEX Signal Check Findings

### 2.1 Population & Sample Statistics
- **Evaluation Window:** 2026-08-05 06:30 UTC to 2026-10-19 10:00 UTC (all sessions with live `option_chain_snapshots` capture).
- **In-Session Bars Evaluated:** **5,116 bars** (`NIFTY50`: 2,486 bars; `BANKNIFTY`: 2,630 bars).
- **Regime Distribution:**
  - Short Gamma (`netDealerGammaExposure < 0`): 1,482 bars (28.97%)
  - Long Gamma (`netDealerGammaExposure > 0`): 3,634 bars (71.03%)

### 2.2 Results Table

| Cohort | Direction | Bars | Short Gamma Bars | Long Gamma Bars | Primary Bootstrap Diff (Short - Long) | 95% Bootstrap CI | Boot SE | $p$-value | Directional Accuracy vs. Baseline | Macro-F1 | Primary Verdict |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Pooled** | Bullish (Long) | 5,116 | 1,482 | 3,634 | $+0.26\text{ bps}$ | $[-0.61, +1.09]\text{ bps}$ | $0.43\text{ bps}$ | $0.5600$ | $56.18\%$ vs. $64.82\%$ | $0.497$ | **`NULL_NO_EDGE`** |
| **Pooled** | Bearish (Short) | 5,116 | 1,482 | 3,634 | $-0.26\text{ bps}$ | $[-1.09, +0.61]\text{ bps}$ | $0.43\text{ bps}$ | $0.5600$ | $52.50\%$ vs. $57.43\%$ | $0.483$ | **`NULL_NO_EDGE`** |
| `NIFTY50` | Bullish | 2,486 | 732 | 1,754 | $+0.15\text{ bps}$ | $[-1.02, +1.33]\text{ bps}$ | $0.60\text{ bps}$ | $0.7970$ | $56.11\%$ vs. $66.41\%$ | $0.492$ | **`NULL_NO_EDGE`** |
| `NIFTY50` | Bearish | 2,486 | 732 | 1,754 | $-0.15\text{ bps}$ | $[-1.33, +1.02]\text{ bps}$ | $0.60\text{ bps}$ | $0.7970$ | $51.69\%$ vs. $57.72\%$ | $0.475$ | **`NULL_NO_EDGE`** |
| `BANKNIFTY` | Bullish | 2,630 | 750 | 1,880 | $+0.37\text{ bps}$ | $[-1.10, +2.03]\text{ bps}$ | $0.78\text{ bps}$ | $0.6155$ | $56.24\%$ vs. $63.31\%$ | $0.502$ | **`NULL_NO_EDGE`** |
| `BANKNIFTY` | Bearish | 2,630 | 750 | 1,880 | $-0.37\text{ bps}$ | $[-2.03, +1.10]\text{ bps}$ | $0.78\text{ bps}$ | $0.6155$ | $53.27\%$ vs. $57.15\%$ | $0.491$ | **`NULL_NO_EDGE`** |

### 2.3 Descriptive Confounded Diagnostics (Overlapping Window Hazard)
As mandated by pre-registration §4.3, correlation and parametric tests are demoted to descriptive diagnostics due to the 3-bar forward horizon serial dependence:
- **Pooled Pearson Correlation:** $r = -0.0101$ ($p = 0.472$)
- **Pooled Spearman Rank Correlation:** $\rho = -0.0181$ ($p = 0.195$)
- **Pooled Welch's $t$-test:** $t = 0.81$ ($p = 0.420$)
Even under overlapping window assumptions that artificially tighten variance, GEX displays no statistically detectable linear or monotonic association with 15-minute forward returns.

---

## 3. Track 2: Conditioned Golden Pocket Interaction Findings

### 3.1 Empirical Sample Counts & Floor Status

| Cell | Total Matched Pairs | Fresh GEX Pairs | Short Gamma Matched ($S^-$) | Long Gamma Matched ($S^+$) | Minimum Pre-Reg Floor | Floor Passed | Causal Point Estimate $\widehat{\Delta}_{\text{interaction}}$ | Formal Verdict |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Bullish Golden Pocket** | 35 | 12 | **3** | **9** | **15** | **`false`** | **`null`** (Suppressed) | **`INCONCLUSIVE_INSUFFICIENT_DATA`** |
| **Bearish Golden Pocket** | 11 | 0 | **0** | **0** | **15** | **`false`** | **`null`** (Suppressed) | **`INCONCLUSIVE_INSUFFICIENT_DATA`** |

### 3.2 Anatomy of the Refusal to Estimate
In the Bullish Golden Pocket cell:
- **Short Gamma Causal Delta:** $\overline{\Delta}_{\text{short}} = +22.12\text{ bps}$ ($n = 3$)
- **Long Gamma Causal Delta:** $\overline{\Delta}_{\text{long}} = +10.13\text{ bps}$ ($n = 9$)

Without a pre-registered gate, an analyst might have calculated a raw difference of $+11.99\text{ bps}$ and falsely claimed that Short Gamma amplifies the Golden Pocket effect by 12 bps. 

Because $n(S^-) = 3 \ll 15$, the pre-registered floor bound as intended. The pipeline cleanly suppressed the point estimate, logging `refusalToEstimate = true` and declaring the test **`INCONCLUSIVE_INSUFFICIENT_DATA`**.

---

## 4. Verification Checklist Audit

| Audit Item | Status | Verification Evidence |
| :--- | :---: | :--- |
| **1. Pre-registration doc committed before real data pass** | **VERIFIED** | Pre-registration commits `b80b522b`, `71c614fb`, `8e8d985c` precede code and execution |
| **2. Independent DB coverage match** | **VERIFIED** | Step 0 audit matches exact pipeline episode extraction (16%–36% coverage, 12 fresh matched pairs) |
| **3. Strict sign rule (no magnitude or threshold tuning)** | **VERIFIED** | Conditioning split is strictly $\text{sign}(\text{netDealerGammaExposure})$, zero cutoff tuning |
| **4. Synthetic validation actually ran and passed** | **VERIFIED** | All 4 synthetic gates (Injected, Null, Floor, Market-Drift Confound) passed in `test_gex_experiment.py` |
| **5. Floor binding produces refusal to estimate** | **VERIFIED** | $n=3 < 15 \rightarrow \widehat{\Delta} = \text{None}$, verdict recorded as `INCONCLUSIVE_INSUFFICIENT_DATA` |
| **6. Overlapping window serial dependence handled** | **VERIFIED** | Sole primary decision-bearing test is session-block bootstrap; Pearson/Welch demoted to descriptive |
| **7. Delta-based counterfactual interaction** | **VERIFIED** | Operates on matched pair $\Delta\text{NetReturnBps}$ (treatment minus control), confirmed by Gate D pass |

---

## 5. Governance & Non-Authorization Notice

> [!CAUTION]
> **EXPLORATORY RESEARCH DIAGNOSTIC ONLY — NO TRADING AUTHORIZED.**
> 1. Standalone dealer gamma exposure (`netDealerGammaExposure`) exhibits no tradeable edge on 15m forward returns (`NULL_NO_EDGE`).
> 2. The conditioned Golden Pocket interaction hypothesis cannot be empirically falsified or supported due to severe data sparsity ($n = 3$ vs. $9$, below the pre-registered $n \ge 15$ floor), yielding `INCONCLUSIVE_INSUFFICIENT_DATA`.
> 3. Neither finding authorizes live trading, paper trading execution, parameter changes, or model deployment.
