# 2026-10-07 Gold Macro/Micro Preregistration (Phase 0)

**Status:** LOCKED for Execution
**Target Market:** XAU/USD (Gold)
**Timeframe:** 15m Primary

## 1. Research Question & Falsification Hypotheses

**Research Question:** Does incorporating structural macro-regime filtering (specifically Synthetic DXY expansion/contraction environments) significantly improve the risk-adjusted returns (Sharpe, Profit Factor, Max Drawdown) of a baseline momentum-continuation strategy on XAU/USD 15m, compared to the baseline executed in isolation?

**Null Hypothesis ($H_0$):** 
The risk-adjusted returns (measured primarily by Profit Factor and Sharpe Ratio) of the DXY-gated strategy are less than or equal to the risk-adjusted returns of the baseline strategy, after accounting for transaction costs.

**Alternative Hypothesis ($H_1$):** 
The risk-adjusted returns of the DXY-gated strategy are strictly greater than the baseline strategy. 

**Falsification Conditions:**
The macro-regime filtering will be deemed a failure and falsified if ANY of the following occur during the Out-Of-Sample test:
1. The DXY-gated strategy produces a lower Profit Factor than the baseline.
2. The DXY-gated strategy produces a larger Maximum Drawdown than the baseline.
3. The sample size of triggered trades drops by more than 80% (over-filtering) making the strategy statistically untradable.

## 2. Frozen XAU_USD 15m Baseline

**Strategy Definition (Momentum Continuation):**
- **Trigger:** A 15m candle closes with a body size greater than the 20-period Simple Moving Average of 15m candle bodies.
- **Direction:** Long if the trigger candle is bullish; Short if bearish.
- **Stop Loss:** Placed at the opposite extreme of the trigger candle (Low for Long, High for Short).
- **Take Profit:** 1.5x the risk distance (1.5R).
- **Session:** Unrestricted (runs 24/5).

**Friction Assumptions (Immutable):**
- **Spread/Slippage:** Fixed at 2.0 pips (20 pipettes) per round trip.
- **Commission:** Fixed at $0.00 equivalent (costs absorbed in spread).

## 3. Exact DXY Feature / Gate Definition

The Synthetic DXY is calculated at the close of every 15m candle using the exact basket formula:
`DXY = 50.14348112 * (EURUSD^-0.576) * (USDJPY^0.136) * (GBPUSD^-0.119) * (USDCAD^0.091) * (USDSEK^0.042) * (USDCHF^0.036)`

**The Gate Condition:**
- We calculate the 15m Volatility of DXY (using Yang-Zhang 20-day median logic adapted for the 15m scale, as defined below).
- **Long XAU/USD Trades:** Only permitted if DXY is in a downward structural trend (DXY 15m Close < DXY 50-period SMA) AND DXY volatility is expanding (current YZ volatility > Rolling Median YZ Volatility).
- **Short XAU/USD Trades:** Only permitted if DXY is in an upward structural trend (DXY 15m Close > DXY 50-period SMA) AND DXY volatility is expanding.

## 4. Exact Yang-Zhang (YZ) 20-Day Calculation & Rolling-Median Construction

To prevent forward-looking bias, the median volatility must be calculated dynamically.

**Yang-Zhang Volatility Formula:**
Calculated daily using 20 lookback days of the synthetic DXY:
1. Overhead/Overnight variance (Close to Open).
2. Open to Close variance.
3. Rogers-Satchell variance (High, Low, Open, Close).
The sum of these variances, weighted, produces the daily YZ Volatility figure.

**Rolling-Median Construction (FROZEN DEFINITION):**
- **Window:** 20 Trading Days (approx. 28 calendar days).
- **Mechanism:** At any decision time $T$, the rolling median is computed **strictly** from the 20 most recent *completed* daily YZ observations available prior to $T$.
- **No Future Data:** We emphatically do NOT compute a single median across the entire dataset. A trade at index $i$ only has access to the YZ observations from $i-20\_days$ to $i-1\_day$.

---

**LOCK COMMITMENT:** 
*No parameter, date split, feature definition, session window, friction assumption, baseline rule, or statistical test may be changed after Test 0 begins without creating a new preregistration/version and treating the previous experiment as the official result.*
