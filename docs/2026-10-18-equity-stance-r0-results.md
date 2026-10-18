# Equity Stance R0 Research: Final Evaluation & Verdict

**Study Pre-Registration Spec:** `docs/2026-10-17-equity-stance-r0-spec.md`  
**Rules File:** `apps/api/src/modules/equity-research/domain/equity-rules-v1.json`  
**Random Seed:** `20261017` (fixed for byte-identical reproducibility)  
**Overall Verdict:** **NOT SUPPORTED**  

---

## 1. Executive Summary & Verdict

> [!IMPORTANT]
> **Overall Finding: NOT SUPPORTED.**  
> Both core technical stance variants (**V1 BUY Full Technical** and **V2 SELL Full Technical**) failed to demonstrate positive net excess return over simple baselines after realistic transaction costs. The 95% bootstrap confidence intervals for net excess return against the stock-year baseline are strictly below zero for both V1 and V2, and neither variant survives Holm step-down multiplicity correction.

In accordance with the pre-registered protocol:
- The Levels Engine and technical levels remain fully useful as objective structural reference points (swing support/resistance, ATR zones, and risk distances).
- However, **no technical condition meets the frozen statistical threshold to earn the status of 'VALIDATED'**.
- Consequently, all stance signals in the application **must remain clearly labeled as `UNVALIDATED`** until out-of-sample forward tracking provides empirical evidence.

---

## 2. Primary Horizon ($H = 63$ Trading Bars) Summary Scoreboard

| Variant | Description | Total Events | Indep. Events | Mean Excess (SY) | 95% Boot LB | 95% Boot UB | p-val (Max) | Holm Sig | Verdict |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **V1** | BUY Full Technical | 67,097 | 40,208 | -1.91% | -2.90% | -0.88% | 0.9990 | No | **FAIL** |
| **V2** | SELL Full Technical | 34,801 | 25,708 | -1.25% | -2.42% | -0.13% | 1.0000 | No | **FAIL** |
| **V3** | Support Touch Alone | 74,590 | 44,050 | -1.23% | -2.21% | -0.19% | 0.9746 | No | **FAIL** |
| **V4** | Resistance Touch + Stretch | 5,803 | 4,707 | +5.94% | +4.44% | +7.36% | 1.0000 | No | **INCONCLUSIVE** |
| **V5** | Trend Context Alone | 34,393 | 34,393 | -4.21% | -5.35% | -3.03% | 1.0000 | No | **FAIL** |
| **V6** | 52W High Proximity | 5,511 | 5,511 | -6.08% | -7.22% | -4.90% | 1.0000 | No | **FAIL** |

---

## 3. Detailed Partition Breakdown & Stability Analysis

The pre-registered protocol tests stability across chronological halves (Half 1 vs Half 2), a sealed 24-month holdout (`2024-10-18` to `2026-10-17`), and a clean holdout excluding the 50 exploratory stocks.

| Variant | Half 1 Excess (SY) | Half 2 Excess (SY) | Holdout (All) | Clean Holdout (~450 Stocks) | Sign Consistent? | Half Flipped? |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **V1** | -0.44% | -1.18% | -3.92% | -4.14% | No | No |
| **V2** | -1.46% | -1.79% | -1.27% | -1.22% | No | No |
| **V3** | +0.25% | -0.67% | -2.66% | -2.78% | No | Yes |
| **V4** | +4.65% | +5.13% | +14.18% | +14.31% | Yes | No |
| **V5** | -3.63% | -3.41% | -7.58% | -8.05% | No | No |
| **V6** | -5.19% | -5.54% | -8.48% | -9.53% | No | No |

---

## 4. Horizon Sensitivity ($H = 21, 63, 126$) & Artifact Sensitivity

| Variant | Net Excess $H=21$ | Net Excess $H=63$ (Primary) | Net Excess $H=126$ | With Artifacts $H=63$ | Artifact Impact |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **V1** | -0.99% | -1.91% | -1.36% | -1.10% | +0.81% |
| **V2** | -0.88% | -1.25% | -2.42% | -1.77% | -0.52% |
| **V3** | -0.77% | -1.23% | -0.54% | -0.58% | +0.65% |
| **V4** | +1.02% | +5.94% | +8.99% | +4.98% | -0.96% |
| **V5** | -1.63% | -4.21% | -5.39% | -3.75% | +0.47% |
| **V6** | -2.52% | -6.08% | -8.44% | -5.84% | +0.24% |

---

## 5. Survivorship Bias & Half-Imbalance Disclosure

1. **Survivorship Bias Magnitude & Direction:**
   - The historical daily dataset from Yahoo Finance represents the survivor constituents of the Nifty 500 as of October 2026.
   - Because delisted, acquired, and failed companies from the 1990s and 2000s are excluded, unconditional long stock returns exhibit a structural upward drift.
   - **Impact on BUY Variants (V1, V3, V5, V6):** Survivorship bias inflates the raw returns of all stocks, but comparing against the stock's own same-year benchmark ($B_{\text{stock-year}}$) isolates and neutralizes this general drift. Despite this favorable survivorship environment, BUY variants failed to generate positive net excess.
   - **Impact on SELL Variants (V2, V4):** Strong upward drift in survivor stocks raises the hurdle for avoiding losses. When survivor stocks continue advancing in long-term secular bull markets, selling leads to underperformance relative to buy-and-hold.

2. **Half Imbalance & Liquidity Gating:**
   - Half 1 (`1991` to `2007`) contains significantly fewer events than Half 2 (`2008` to `2024`) due to the ₹20,000,000 median traded value liquidity gate, which was rarely met by Indian equities prior to 2004.
   - Using calendar-month block bootstrapping ensures that each month is given appropriate weight, preventing recent high-event bull market periods from artificially dominating statistical inference.

---

## 6. Product & Architecture Implications

1. **Historical Structural Reference Only:** The engine strictly displays levels and risk distances as past price reference points. No forward advice or timing claims are made.
2. **Unvalidated Badge:** Any future stance UI must permanently display the `UNVALIDATED` status badge until prospective real-time out-of-sample forward evaluation is conducted.
3. **Levels Feature Value:** The Levels Engine remains fully justified for production deployment: it provides traders with objective support, resistance, ATR bands, and gap detection without making unproven timing promises.
