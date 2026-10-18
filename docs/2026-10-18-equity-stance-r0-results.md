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

Key empirical conclusions:
- **No Stance Rule Validated:** No technical stance candidate met the pre-registered pass criteria. In particular, neither support touch nor resistance touch demonstrated an out-of-sample edge after friction.
- **Status Badge:** All stance indicators in the system must permanently carry the **`UNVALIDATED`** status badge until prospective real-time tracking provides evidence.
- **Levels Engine Role:** The Levels Engine provides historical structural reference points (swing support, resistance, ATR zones, and unfilled gaps). Stance rules built on top of these levels did not demonstrate an edge over unconditional baselines.

---

## 2. Primary Horizon ($H = 63$ Trading Bars) Scoreboard Across All Three Baselines

To prevent hiding divergent benchmark behaviors, the table below explicitly presents performance against **all three pre-registered baselines**: the stock's own unconditional year average ($B_{\text{stock-year}}$), the NIFTY 50 index ($B_{\text{nifty50}}$), and the matched random-date placebo ($B_{\text{placebo}}$).

| Variant | Description | Events | Indep. | Month Mean (SY) | 95% LB (SY) | 95% UB (SY) | p (SY) | Month Mean (NIFTY) | p (NIFTY) | Placebo Mean | p (Plac) | Max p | Holm Sig | Verdict |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **V1** | BUY Full Technical | 67,097 | 40,208 | -1.91% | -2.90% | -0.88% | 0.9990 | +1.13% | 0.0008 | -0.86% | 1.0000 | 1.0000 | No | **FAIL** |
| **V2** | SELL Full Technical | 34,801 | 25,708 | -1.25% | -2.42% | -0.13% | 0.9668 | -2.72% | 1.0000 | -0.25% | 1.0000 | 1.0000 | No | **FAIL** |
| **V3** | Support Touch Alone | 74,590 | 44,050 | -1.23% | -2.21% | -0.19% | 0.9746 | +1.31% | 0.0002 | -0.87% | 0.0000 | 0.9746 | No | **FAIL** |
| **V4** | Resistance Touch + Stretch | 5,803 | 4,707 | +5.94% | +4.44% | +7.36% | 0.0000 | -5.29% | 1.0000 | +0.59% | 0.0000 | 1.0000 | No | **FAIL** |
| **V5** | Trend Context Alone | 34,393 | 34,393 | -4.21% | -5.35% | -3.03% | 1.0000 | +1.76% | 0.0000 | -1.06% | 1.0000 | 1.0000 | No | **FAIL** |
| **V6** | 52W High Proximity | 5,511 | 5,511 | -6.08% | -7.22% | -4.90% | 1.0000 | +1.58% | 0.0010 | -0.64% | 1.0000 | 1.0000 | No | **FAIL** |

> **Note on Benchmark Divergence:**  
> - **V1 and V3** beat NIFTY 50 (+1.13% and +1.31%, p < 0.005) because individual high-beta equities in the universe outperformed the index, but they underperformed the stock's own same-year baseline (-1.91% and -1.23%), indicating that support touches lagged random holding periods of the same stocks after friction.  
> - **V4** shows the exact reverse: avoided loss of +5.94% against the stock-year baseline (stocks pulled back from extreme stretches), but -5.29% against NIFTY 50 (p = 1.0000) because strong trending stocks continued outperforming the broader market.

---

## 3. Estimator Distinction: Month-Weighted vs Event-Weighted

The evaluation reports two distinct estimators:  
1. **Month-Block Weighted Mean (Primary for Inference):** Computes the arithmetic mean within each calendar month first, then averages across all months. This prevents high-event recent bull-market months from swamping earlier periods.  
2. **Event-Weighted Mean:** The simple pooled average over all events.

| Variant | Month-Weighted Mean (SY) | Event-Weighted Mean (SY) | Difference | Rationale |
| :--- | :---: | :---: | :---: | :--- |
| **V1** | -1.91% | -1.10% | -0.81% | Equal weighting of early thin months pulls month-mean down |
| **V2** | -1.25% | -1.76% | +0.51% | Equal weighting of early thin months pulls month-mean down |
| **V3** | -1.23% | -0.58% | -0.65% | Equal weighting of early thin months pulls month-mean down |
| **V4** | +5.94% | +5.06% | +0.88% | Equal weighting of early thin months pulls month-mean down |
| **V5** | -4.21% | -3.44% | -0.78% | Equal weighting of early thin months pulls month-mean down |
| **V6** | -6.08% | -5.50% | -0.58% | Equal weighting of early thin months pulls month-mean down |

---

## 4. Stability Partitions (Half 1, Half 2, Holdouts)

| Variant | Half 1 Excess (SY) | Half 2 Excess (SY) | Holdout (All) | Clean Holdout (~450 Stocks) | Sign Consistent? | Half Flipped? |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **V1** | -0.44% | -1.18% | -3.92% | -4.14% | No | No |
| **V2** | -1.46% | -1.79% | -1.27% | -1.22% | No | No |
| **V3** | +0.25% | -0.67% | -2.66% | -2.78% | No | Yes |
| **V4** | +4.65% | +5.13% | +14.18% | +14.31% | Yes | No |
| **V5** | -3.63% | -3.41% | -7.58% | -8.05% | No | No |
| **V6** | -5.19% | -5.54% | -8.48% | -9.53% | No | No |

---

## 5. Horizon & Artifact Sensitivity (Consistent Estimator)

Using consistent estimators throughout, artifact exclusion has virtually zero effect on signal excess return:

| Variant | Net Excess $H=21$ (Month) | Net Excess $H=63$ (Month) | Net Excess $H=126$ (Month) | Without Artifacts $H=63$ (Event) | With Artifacts $H=63$ (Event) | Artifact Impact (Event) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **V1** | -1.20% | -1.91% | -2.22% | -1.10% | -1.10% | +0.00% |
| **V2** | -1.19% | -1.25% | -1.96% | -1.76% | -1.77% | -0.01% |
| **V3** | -0.98% | -1.23% | -1.04% | -0.58% | -0.58% | -0.00% |
| **V4** | +2.10% | +5.94% | +9.03% | +5.06% | +4.98% | -0.08% |
| **V5** | -1.93% | -4.21% | -5.87% | -3.44% | -3.75% | -0.31% |
| **V6** | -2.46% | -6.08% | -8.96% | -5.50% | -5.84% | -0.34% |

---

## 6. Survivorship Bias & Half-Imbalance Analysis

1. **Direction of Survivorship Bias Per Variant:**
   - **BUY Variants (V1, V3, V5, V6):** Survivorship bias exerts an upward drift on stock returns by excluding historic bankruptcies, failures, and delisted entities. This structurally flatters dip-buying and bounce strategies (such as support touches). Despite this substantial structural tailwind, all BUY variants produced negative net excess after realistic transaction costs.
   - **SELL Variants (V2, V4):** Survivorship bias penalizes exit strategies. Because surviving equities in the Nifty 500 exhibited persistent multi-year compounding, exiting stocks that were stretched above their 200-day average or breaking down resulted in forgone returns when those survivor stocks resumed their secular advance.

2. **Half Imbalance & Liquidity Gate Dynamics:**
   - Half 1 spans 1995 to 2007 (data begins in 1995 when stocks first met the ₹20,000,000 median traded value liquidity threshold; Half 1 ends 2007-11-23).
   - Early years had far fewer qualified stocks than Half 2 (2007-11-24 to 2024-10-17). The month-block bootstrap explicitly controls for this imbalance by weighting each calendar month equally rather than allowing the volume of recent years to dominate.

---

## 7. Product Architecture Directives

1. **Strict Reference Labeling:** Support and resistance levels must be presented strictly as historical price zones, with zero forward advice or timing claims.
2. **Unvalidated Badge Enforcement:** In accordance with the pre-registration protocol, all stance components must display the `UNVALIDATED` badge in all user interfaces.
3. **Scientific Integrity:** The research conclusion of `NOT SUPPORTED` stands on frozen criteria with full byte-identical reproducibility.
