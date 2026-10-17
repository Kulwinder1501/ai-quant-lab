# Equity Watch: R0 Research Study Pre-Registration Specification

**Status:** LOCKED / PRE-REGISTERED (Day 0, with Amendment 1 applied before any data fetched)  
**Date:** 2026-10-17  
**Author:** AI Quant Lab  
**Plan Reference:** `docs/2026-10-17-equity-levels-and-r0-plan.md`  
**Initial Anchor Commit:** `b1859530`  
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
  - Meets the point-in-time liquidity gate: 60-bar median traded value $\ge ₹20,000,000$ (`minMedianTradedValueInr = 20000000`).
- **SELL (Technical Component / Avoided Loss):**
  - Close sits within $1.0 \times \text{ATR14}$ below a valid resistance level (`maxAtrBelowResistance = 1.0`) with $\ge 2$ touches, AND price is stretched $>25\%$ above the 200-day SMA (`stretchAboveSma200Pct = 0.25`), OR
  - Close breaks $>1.0 \times \text{ATR14}$ below a valid support level (`breakBelowSupportAtr = 1.0`).
  - Meets the point-in-time liquidity gate.

---

## 3. Pre-Registered Variants (6 Variants)

The multiplicity correction (Holm step-down procedure at $\alpha = 0.05$) will be applied across exactly these 6 pre-registered variants at the primary horizon:

| Variant ID | Name | Trigger Definition | Sampling Rule |
| :--- | :--- | :--- | :--- |
| **V1** | **BUY Full Technical** | Support touch ($\le 1.5$ ATR), $\ge 2$ touches, close $\ge -10\%$ from 200 SMA, liquidity gate. | Event-driven on bar $T$, subject to 10-bar cooldown. |
| **V2** | **SELL Full Technical** | Resistance touch with stretch ($>25\%$ above 200 SMA) OR support breakdown ($>1.0$ ATR), liquidity gate. | Event-driven on bar $T$, subject to 10-bar cooldown. |
| **V3** | **Support Touch Alone** | Price within $1.5$ ATR above valid support level, liquidity gate (no SMA trend filter). | Event-driven on bar $T$, subject to 10-bar cooldown. |
| **V4** | **Resistance Touch + Stretch** | Price within $1.0$ ATR below resistance AND $>25\%$ above 200 SMA, liquidity gate. | Event-driven on bar $T$, subject to 10-bar cooldown. |
| **V5** | **Trend Context Alone** | Close $> 200$-day SMA, liquidity gate (no level constraint). | Evaluated on the **last trading bar of each month** where the condition holds. |
| **V6** | **52-Week High Proximity** | Proximity to 52-week high, liquidity gate. | Evaluated on the **last trading bar of each month**: rank qualifying stocks by $\text{close} / \text{high}_{52\text{W}}$, select the **top 10% (top decile)**. |

---

## 4. Evaluation Protocol

### 4.1 Horizons
- **Primary Horizon:** $H = 63$ trading bars (approx. 3 calendar months). Pass/fail criteria are strictly evaluated at this horizon.
- **Secondary Horizons:** $H = 21$ trading bars (1 month) and $H = 126$ trading bars (6 months). Reported descriptively for horizon sensitivity; not used for pass/fail.

### 4.2 Trade Execution Timing (Zero Look-Ahead)
- Signals are generated after the market close of bar $T$.
- **Entry:** Executed at the **Open of bar $T+1$** ($\text{open}_{T+1}$).
- **Exit:** Executed at the **Close of bar $T+H$** ($\text{close}_{T+H}$).
- **Variant Net Return (BUY):**
  $$R_{\text{net}} = \frac{\text{close}_{T+H}}{\text{open}_{T+1}} - 1 - \text{cost}$$
- **Variant Gross Return:**
  $$R_{\text{gross}} = \frac{\text{close}_{T+H}}{\text{open}_{T+1}} - 1$$

### 4.3 Point-in-Time Friction & Cost Model
- **Point-in-Time Cost Tier:** At signal date $T$, rank all stocks that have active trading data on $T$ by their 60-bar median traded value ($\text{close} \times \text{volume}$). The top 100 stocks receive the large-cap cost tier; all other constituents receive the other tier.
  - Large-Cap Tier: $0.30\%$ round-trip friction (`roundTripLargeCapPct = 0.003`).
  - Other Constituents Tier: $1.00\%$ round-trip friction (`roundTripOtherPct = 0.010`).
- **Point-in-Time Liquidity Gate:** 60-bar median traded value up to $T$ must be $\ge ₹20,000,000$.

### 4.4 Independence & Cooldown
- **Cooldown:** At least 10 trading bars between events for the same stock on the same side (`cooldownBars = 10`).
- **Monthly Cap for Independence:** At most 1 event per stock per calendar month counted toward independent event sample size.

### 4.5 Baselines & Net Excess Formulas
All baselines are computed **gross (zero transaction costs)**; the variant carries the full transaction cost (conservative protocol).
1. **Stock-Year Benchmark ($B_{\text{stock-year}}$):** The same stock's average gross $H$-bar forward return (measured open-to-close) across all trading days in the same calendar year.
2. **Market Benchmark ($B_{\text{nifty50}}$):** Gross return of NIFTY 50 (`^NSEI`) over the exact execution window $[\text{open}_{T+1}, \text{close}_{T+H}]$.
3. **Random Placebo ($B_{\text{placebo}}$):** Empirical distribution from 1,000 random-date draws matched to the exact number of events per stock-year.

**Net Excess Formulas:**
- **For BUY Variants (V1, V3, V5, V6):**
  $$\text{Net Excess} = R_{\text{net}} - B_{\text{gross}}$$
- **For SELL Variants (V2, V4 / Avoided Loss):**
  $$\text{Net Excess}_{\text{avoided}} = B_{\text{gross}} - R_{\text{gross}} - \text{cost}$$
  *(A positive excess indicates the sell stance successfully avoided losses exceeding the benchmark net of costs).*

---

## 5. Statistical Inference & Pass Criteria

### 5.1 Bootstrap Protocol
- **Method:** Block bootstrap in calendar-month blocks (resample calendar months with replacement, average across events within the month).
- **Draws:** 5,000 replications (`bootstrapDraws = 5000`).
- **Confidence Interval:** $95\%$ one-sided lower confidence bound (`ciLevel = 0.95`).
- **Multiplicity Correction:** Holm step-down method at family-wise error rate $\alpha = 0.05$ across the 6 pre-registered variants.
- **Variant p-value:** The variant's empirical $p$-value is defined conservatively as the **largest one-sided bootstrap $p$-value across the three baselines**:
  $$p = \max(p_{\text{stock-year}}, p_{\text{nifty50}}, p_{\text{placebo}})$$
- **Random Seed:** Fixed to `20261017` for byte-identical reproducibility.

### 5.2 Out-of-Sample, Stability & Holdout Partitions
- **Holdout Partition:** The most recent 24 calendar months (`holdoutMonths = 24`, 2024-10-18 to 2026-10-17) are sealed and evaluated only once at the end of the study.
- **Holdout Boundary Constraint:** Any non-holdout event whose forward evaluation window reaches into the holdout ($T+H \ge \text{holdout\_start}$) is excluded from non-holdout metrics to ensure zero leakage.
- **Chronological Halves:** Non-holdout data is split at the calendar midpoint between the earliest available date in the dataset and the holdout start date.

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

## 6. Data Integrity & Prior Exposure Disclosure

1. **Constituent Universe:** Nifty 500 constituents downloaded manually from NSE index archives into `apps/ml/data/equity_universe_nifty500.csv` with download URL and date in the header.
2. **Benchmark Data:** NIFTY 50 (`^NSEI`) fetched with the exact same daily granularity assertion (`meta.dataGranularity == "1d"`).
3. **Quality Rules:**
   - Drop series with fewer than 756 daily trading bars.
   - Any bar with a 1-day absolute move $> 40\%$ is flagged as a suspected corporate action/demerger artifact (`artifactMovePct = 0.40`). Every event whose lookback or forward window touches such a bar is excluded in the primary count (results reported with and without exclusion).
   - Drop non-positive or non-finite closes.
4. **Survivorship Bias Acknowledgment:** Free daily historical data from Yahoo Finance reflects survivor constituents. The final report will document the direction and likely magnitude of this bias for each variant.
5. **Prior Exposure Disclosure (Exploratory 50 Stocks):**
   - The preliminary exploratory study in `docs/2026-10-17-equity-signal-research.md` inspected 50 large-cap stocks through 2026-10-16. Therefore, the 24-month holdout is not strictly pristine for these 50 names:
     `RELIANCE`, `TCS`, `HDFCBANK`, `INFY`, `ICICIBANK`, `HINDUNILVR`, `ITC`, `SBIN`, `BHARTIARTL`, `KOTAKBANK`, `LT`, `AXISBANK`, `ASIANPAINT`, `MARUTI`, `SUNPHARMA`, `TITAN`, `ULTRACEMCO`, `NESTLEIND`, `WIPRO`, `HCLTECH`, `M&M`, `BAJFINANCE`, `POWERGRID`, `NTPC`, `ONGC`, `TATASTEEL`, `JSWSTEEL`, `ADANIPORTS`, `COALINDIA`, `TECHM`, `GRASIM`, `HINDALCO`, `DRREDDY`, `CIPLA`, `EICHERMOT`, `BPCL`, `HEROMOTOCO`, `DIVISLAB`, `BRITANNIA`, `INDUSINDBK`, `APOLLOHOSP`, `TATACONSUM`, `BAJAJ-AUTO`, `SUZLON`, `TATAMOTORS`, `PIDILITIND`, `DABUR`, `GAIL`, `IOC`, `SIEMENS`.
   - **Remedy:** The R0 evaluation will report holdout performance **overall (all stocks)** AND **separately for the ~450 stocks outside this 50-stock list**, ensuring a clean out-of-sample check.

---

## 7. Pre-Registration Verification & Amendment Log

- **Initial Freeze Commit:** `b1859530`
- **Rules Configuration File:** `apps/api/src/modules/equity-research/domain/equity-rules-v1.json` (`sha256: bdb3ff38b56e9f4e9885ecc8e545ee4b6ad116f6b893581fd5bebb231bf625bf`)
- **Amendment 1 (Day 0 Review, before any data fetched):**
  - Removed self-referential hash in favor of commit anchor + rules file hash.
  - Defined V5 (month-end close $> 200$ SMA) and V6 (month-end top decile close / 52W high).
  - Explicitly defined net excess formulas (gross baselines, variant carries costs; avoided loss for sell variants).
  - Fixed trade execution: entry at next bar Open ($\text{open}_{T+1}$), exit at bar $T+H$ Close ($\text{close}_{T+H}$).
  - Set variant $p$-value to $\max(p_{\text{stock-year}}, p_{\text{nifty50}}, p_{\text{placebo}})$.
  - Point-in-time cost tier ranking and liquidity gating.
  - Enforced holdout forward window boundary constraint ($T+H \ge \text{holdout\_start}$ excluded from non-holdout).
  - Added prior exposure disclosure for 50 exploratory names with separate ~450 unexposed stock holdout reporting.
  - Specified `^NSEI` daily granularity check.
