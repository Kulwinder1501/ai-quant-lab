# Equity Alerts Historical Replay Report (Gate E7)

**Evaluated Engine:** Shipped TypeScript implementation (`evaluateAlerts` and `computeLevels`)  
**Rule Set:** `apps/api/src/modules/equity-research/domain/equity-alerts-v1.json`  
**Execution Date:** 2026-10-19  
**Gate E7 Verdict:** **PASS**

---

## 1. Frequency Budget Audit Summary

| Metric | Budget Target | Measured Shipped TypeScript Value | Gate E7 Status |
|---|:---:|:---:|:---:|
| **Median Level Alerts per Stock-Month** | $\le 3.0$ | **2.0** | **PASS** |
| **95th Percentile per Stock-Month** | $\le 8.0$ | **8.0** | **PASS** |
| Mean Level Alerts per Stock-Month | Descriptive | 2.86 | Info |
| 75th Percentile | Descriptive | 4.0 | Info |
| 90th Percentile | Descriptive | 6.0 | Info |
| 99th Percentile | Descriptive | 10.0 | Info |
| Maximum Single Stock-Month | Descriptive | 20 | Info |
| Total Stocks Evaluated | - | 433 | Confirmed |
| Total Active Stock-Months | - | 91,188 | Robust Sample |
| Alert Kind Breakdown | - | BREAK: 41,411 (15.9%), ZONE_ENTER: 141,660 (54.4%), APPROACH: 77,521 (29.7%) | Measured Distribution |

---

## 2. Methodology & Controls

1. **Direct Code Execution:** Evaluated through the shipped TypeScript `evaluateAlerts` and `computeLevels` domain functions, eliminating cross-language drift.
2. **Lookback Requirement:** Evaluated on daily bars with a 600-bar rolling window starting after 258 bars (lookbackBars 252 + pivotHalfWindow 5 + 1).
3. **Zone-Entry Discipline:** `LEVEL_ZONE_ENTER` requires current day close to land strictly inside the zone after closing outside it. Intraday wicks that close outside do not trigger zone entries.
4. **Same-Day Level Priority:** At most one level alert per level per day, prioritized as `LEVEL_BREAK` > `LEVEL_ZONE_ENTER` > `LEVEL_APPROACH`. Breaks are never shadowed.
5. **Cooldown Scope:** Cooldown is tracked per `(stock, kind, levelKey)` for 10 trading days (two calendar trading weeks), guaranteeing that an approach alert cannot silence a subsequent break.
6. **Scale-Aware Keys:** Logarithmic 0.5% relative price buckets prevent level collision on low-priced equities (e.g. ₹25) and level fragmentation on high-priced equities (e.g. ₹50,000).
7. **Point-in-Time & Date Guard:** Look-ahead strictly blocked; evaluation returns empty if `levelsAtT.asOfDate !== evalDate`.

---

## 3. Verdict
The measured frequency distribution strictly satisfies the pre-registered budget criteria (Median 2.0 $\le 3.0$, p95 8.0 $\le 8.0$). Gate E7 status is **PASS**.
