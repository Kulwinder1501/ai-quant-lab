# Equity Watch: R0 Research Study Pre-Registration Specification

**Status:** LOCKED / PRE-REGISTERED (Day 0)  
**Date:** 2026-10-17  
**Author:** AI Quant Lab  
**Plan Reference:** `docs/2026-10-17-equity-levels-and-r0-plan.md`  
**Rules Configuration File:** `apps/api/src/modules/equity-research/domain/equity-rules-v1.json`  
**Rules SHA-256:** `bdb3ff38b56e9f4e9885ecc8e545ee4b6ad116f6b893581fd5bebb231bf625bf`  

---

## 1. Research Question & Objective

**Primary Question:**  
Do the technical ingredients of the proposed stance (price location relative to swing levels, trend context, and liquidity gating) produce forward returns, net of realistic transaction costs, that beat simple benchmark baselines on out-of-sample data on which they were not tuned?

**Scope & Non-Tested Ingredients:**  
The corporate event, news, and secondary fundamental stance ingredients cannot be reliably evaluated historically due to lack of point-in-time point-in-history feeds. As specified in the plan, R0 explicitly tests the **technical stance ingredients only**. The live scoreboard will keep the event/news/fundamentals ingredients marked as `UNVALIDATED` until live out-of-sample tracking occurs.

---

## 2. Frozen Parameters & Rules

All thresholds and constants are bound strictly to `equity-rules-v1.json` (`sha256: bdb3ff38b56e9f4e9885ecc8e545ee4b6ad116f6b893581fd5bebb231bf625bf`). No tuning of these parameters is permitted after data inspection.

### 2.1 Level Definitions
- **Swing pivots:** Half-window $k = 5$ (`pivotHalfWindow`). Bar $i$ is a swing low if $\text{low}_i < \min(\text{low}_{i-k \dots i-1})$ and $\text{low}_i \le \min(\text{low}_{i+1 \dots i+k})$ (highs symmetrical). A pivot at $i$ is known only at bar $i + k$, and valid only if $T - 252 \le i \le T - k$.
- **Lookback:** 252 trading bars (`lookbackBars`).
- **Cluster threshold:** Single-linkage cluster gap of $1.5\%$ (`clusterGapPct = 0.015`). Level price = mean of cluster pivot prices.
- **Validity:** Minimum 2 pivots (`minPivots = 2`).
- **Recency weighting:** Half-life of 126 bars (`recencyHalfLifeBars = 126`). $\text{strength} = \sum 0.5^{(\text{age} / 126)}$.
- **ATR:** Plain 14-period mean of True Range (`atrPeriod = 14`), non-Wilder.
- **Zone half-width:** $w = \max(0.01 \times \text{level}, 0.5 \times \text{ATR14})$.

### 2.2 Technical Stance Definitions
- **BUY (Technical Component):**
  - Close sits within $1.5 \times \text{ATR14}$ above a valid support level (`maxAtrAboveSupport = 1.5`).
  - Support has at least 2 touches (`minStrengthTouches = 2`).
  - Close is not more than $10\%$ below the 200-day simple moving average (`maxBelowSma200Pct = 0.10`).
  - Meets the liquidity gate: 60-bar median traded value $\ge ₹20,000,000$ (`minMedianTradedValueInr = 20000000`).
- **SELL (Technical Component / Avoided Loss):**
  - Close sits within $1.0 \times \text{ATR14}$ below a valid resistance level (`maxAtrBelowResistance = 1.0`) with $\ge 2$ touches, AND price is stretched $>25\%$ above the 200-day SMA (`stretchAboveSma200Pct = 0.25`), OR
  - Close breaks $>1.0 \times \text{ATR14}$ below a valid support level (`breakBelowSupportAtr = 1.0`).
  - Meets the liquidity gate.

---

## 3. Pre-Registered Variants (6 Variants)

The multiplicity correction (Holm step-down procedure at $\alpha = 0.05$) will be applied across exactly these 6 pre-registered variants at the primary horizon:

| Variant ID | Name | Trigger Definition |
| :--- | :--- | :--- |
| **V1** | **BUY Full Technical** | Support touch ($\le 1.5$ ATR), $\ge 2$ touches, close $\ge -10\%$ from 200 SMA, liquidity gate. |
| **V2** | **SELL Full Technical** | Resistance touch with stretch ($>25\%$ above 200 SMA) OR support breakdown ($>1.0$ ATR), liquidity gate. |
| **V3** | **Support Touch Alone** | Price within $1.5$ ATR above valid support level, liquidity gate (no SMA trend filter). |
| **V4** | **Resistance Touch + Stretch** | Price within $1.0$ ATR below resistance AND $>25\%$ above 200 SMA, liquidity gate. |
| **V5** | **Trend Context Alone** | Close $> 200$-day SMA, liquidity gate (no level constraint). |
| **V6** | **52-Week High Proximity** | Close in top decile of 52-week price range within each calendar month, liquidity gate. |

---

## 4. Evaluation Protocol

### 4.1 Horizons
- **Primary Horizon:** $H = 63$ trading bars (approx. 3 calendar months). Pass/fail criteria are strictly evaluated at this horizon.
- **Secondary Horizons:** $H = 21$ trading bars (1 month) and $H = 126$ trading bars (6 months). Reported descriptively for horizon sensitivity; not used for pass/fail.

### 4.2 Independence & Cooldown
- **Cooldown:** At least 10 trading bars between events for the same stock on the same side (`cooldownBars = 10`).
- **Monthly Cap for Independence:** At most 1 event per stock per calendar month counted toward independent event sample size.

### 4.3 Friction & Cost Model
- **Large-Cap Tier:** $0.30\%$ round-trip friction (`roundTripLargeCapPct = 0.003`) for stocks ranked in the top 100 by 60-bar median traded value.
- **Other Constituents Tier:** $1.00\%$ round-trip friction (`roundTripOtherPct = 0.010`).
- **Net Forward Return (BUY variants):**
  $$R_{\text{net}} = \frac{\text{close}_{T+H}}{\text{close}_T} - 1 - \text{cost}$$
- **Avoided Loss (SELL variants):**
  $$\text{AvoidedLoss}_{\text{net}} = \text{Baseline} - \left(\frac{\text{close}_{T+H}}{\text{close}_T} - 1\right) - \text{cost}$$

### 4.4 Baselines (All Three Must Be Exceeded)
To claim an edge, the net return of each variant must exceed all three baselines:
1. **Stock-Year Benchmark:** The same stock's average $H$-bar forward return across the same calendar year.
2. **Market Benchmark:** NIFTY 50 (`^NSEI`) buy-and-hold forward return over the exact same date window $[T, T+H]$.
3. **Random Placebo:** Empirical distribution from 1,000 random-date draws matched to the exact number of events per stock-year.

---

## 5. Statistical Inference & Pass Criteria

### 5.1 Bootstrap Protocol
- **Method:** Block bootstrap in calendar-month blocks (resample calendar months with replacement, average across events within the month).
- **Draws:** 5,000 replications (`bootstrapDraws = 5000`).
- **Confidence Interval:** $95\%$ one-sided lower confidence bound (`ciLevel = 0.95`).
- **Multiplicity Correction:** Holm step-down method at family-wise error rate $\alpha = 0.05$ across the 6 pre-registered variants.
- **Random Seed:** Fixed to `20261017` for byte-identical reproducibility.

### 5.2 Out-of-Sample & Stability Partitions
- **Chronological Halves:** The sample is split chronologically into Half 1 and Half 2.
- **Holdout Partition:** The most recent 24 calendar months (`holdoutMonths = 24`) are held out entirely and evaluated only once at the conclusion of research, without modification.

### 5.3 Frozen Pass / Fail Criteria
At the primary horizon ($H = 63$ bars), a variant is classified as:
- **PASS:**
  1. The $95\%$ bootstrap lower bound of net excess return is strictly $> 0$ against all three baselines.
  2. The sign of net excess return is positive in Half 1, Half 2, and the 24-month holdout.
  3. Sample size reaches at least 300 independent events across at least 40 stocks (`minIndependentEvents = 300`, `minStocks = 40`).
  4. Statistically significant after Holm step-down adjustment at $\alpha = 0.05$.
- **FAIL:**
  - The upper bound of the $95\%$ bootstrap interval is $< 0$, OR
  - The sign of net excess return flips between chronological halves.
- **INCONCLUSIVE:**
  - Fails to meet the minimum sample size threshold (insufficient independent events), or interval spans zero without flipping sign.

**Overall Verdict Definition:**
- **Supported:** V1 or V2 achieves PASS.
- **Not Supported:** V1 and V2 both FAIL or show no significant edge over baselines.
- **Inconclusive:** Insufficient sample size or ambiguous bootstrap intervals.

---

## 6. Data Integrity & Survivorship Bias

1. **Constituent Universe:** Nifty 500 constituents downloaded manually from NSE index archives into `apps/ml/data/equity_universe_nifty500.csv` with download URL and date in the header.
2. **Quality Rules:**
   - Drop series with fewer than 756 daily trading bars.
   - Any bar with a 1-day absolute move $> 40\%$ is flagged as a suspected corporate action/demerger artifact (`artifactMovePct = 0.40`). Every event whose lookback or forward window touches such a bar is excluded in the primary count (results reported with and without exclusion).
   - Drop non-positive or non-finite closes.
3. **Survivorship Bias Acknowledgment:** Free daily historical data from Yahoo Finance reflects survivor constituents. The final report will document the direction and likely magnitude of this bias for each variant rather than relegating it to a footnote.

---

## 7. Pre-Registration Verification Hashes

- `apps/api/src/modules/equity-research/domain/equity-rules-v1.json`:  
  `SHA-256: bdb3ff38b56e9f4e9885ecc8e545ee4b6ad116f6b893581fd5bebb231bf625bf`
- This specification file (`docs/2026-10-17-equity-stance-r0-spec.md`):  
  `SHA-256: 9186de80b4c1c9b08dec2ece3209cd218f58eb5366e8e29622c39fb235e88efb` (initial freeze)
