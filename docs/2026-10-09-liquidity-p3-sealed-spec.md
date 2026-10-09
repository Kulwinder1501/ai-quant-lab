# LIQUIDITY-P3: Order-Flow Replenishment Replication & Execution Gate (Sealed Spec v2.12)

This document represents the completely sealed protocol, data integrity requirements, and statistical gates for the independent replication of the `H_OFI_REPLENISHMENT_DIRECTIONAL` hypothesis. The specification is frozen as of 2026-10-09.

## 1. Frozen Hypothesis & Scope
- **Baseline Policy:** `OFI_BASELINE_V1`
- **Conditional Policy (FAST):** `OFI_BASELINE_V1` restricted to the `Q1` Point-in-Time Area Under the Curve (PIT_AUC) replenishment state.
- **Independence:** NIFTY and BANKNIFTY futures streams are strictly segregated.

## 2. Prospective Holdout, Joint Power Check & Stopping Rule
- **Joint Power Check Methodology:** Monte Carlo simulation ($N_{\text{sim}}=10,000$, Seed=42) on discovery data to compute joint sample requirements.
  - **Required Simulation Inputs:** The simulation must explicitly retain the underlying time-aligned FAST-state indicators, baseline outcomes, conditional policy outcomes, and valid-observation masks.
  - **Dependence-Aware Resampling:** The simulation strictly utilizes **contemporaneous session-block resampling**. For each simulation draw, the exact same sampled session indices are applied simultaneously to both NIFTY and BANKNIFTY, strictly preserving their respective valid-observation masks.
  - **Alternative Generation & Placebo Alignment:** The discovery outcomes are deterministically centered at zero. A prespecified mean incremental return of **+1.0 bps** is mechanically injected *exclusively* into the actual, unshifted FAST-policy alignment. 
    - **Crucial Clarification:** The injected effect targets a mean incremental return of exactly +1.0 bps per *eligible baseline decision opportunity*, after the prescribed Stage A friction—not merely +1.0 bps per FAST trade.
    - **Placebo Stricture:** The injection is rigidly applied *only* to the actual alignment; all 20 placebo statistics are mathematically computed entirely without that injected effect.
    - **Sample Stricture:** The actual and placebo statistics deterministically utilize the exact same final eligible sample.
  - **Target Joint Power:** Based on the preflight discovery validation mathematically achieving 83.1% joint power, the evaluation requires simultaneous passage of all statistical gates across both instruments.
- **Minimum Sample Floors (Hardcoded Numerical Targets):** The sample constraints are explicitly frozen as derived from the preflight joint-power run:
  - **Effective Calendar Sessions:** Exactly **112 shared calendar sessions** after applying the 20-session placebo truncation (requiring a minimum of **132 raw shared calendar sessions** before truncation). This floor must be satisfied by the shared calendar timeline affecting both instruments.
  - **NIFTY FAST Opportunities:** $\ge 6,420$ eligible opportunities post-truncation.
  - **BANKNIFTY FAST Opportunities:** $\ge 7,110$ eligible opportunities post-truncation.
- **Deterministic Stopping Rule:** The dataset seals at the close of the first session where the shared calendar and both independent instruments clear their respective numerical target floors simultaneously. To accommodate the 132 raw session minimum, the absolute maximum deadline is frozen at **180 completed raw sessions or August 7, 2027**. 

## 3. Information Cutoff, Clock Mapping & Data Integrity
- **Strict Point-in-Time Cutoff:** Signal and limit-price construction must use ONLY book updates whose **local receive timestamps** are strictly at or before the mechanical decision timestamp $t$. 
- **Deterministic Tie-Breaking:** For any feed updates sharing an identical sub-millisecond timestamp, they are deterministically ordered sequentially strictly by their native exchange sequence numbers.
- **Clock Mapping & Exchange Arrival:** The local receive clock and the exchange match-engine clock are explicitly mapped. The mechanical entry/exit decision at $t$ is mapped to the exact modeled exchange arrival at $t+50\text{ ms}$. 
- **Clock Uncertainty Fail-Safe:** If empirical clock alignment cannot statistically support a defensible $50\text{ ms}$ simulation, Stage B must be recorded as **not validated**.
- **Feed-Gap Recovery Invariant:** After a material feed gap or reconnect, the reconstructed order book remains explicitly invalid until a predefined full-snapshot recovery condition is satisfied. Unknown book states must *never* be forward-filled.

## 4. Two-Stage Evaluation Protocol

### Stage A: Predictive Performance Replication (Standardized Friction)
**Objective:** Verify that the FAST conditional policy has reproducible incremental predictive value.
- **Return Convention:** Uses the frozen **generic 2.0 bps round-trip research friction**, charged *only* when the policy trades. Invalid-feed opportunities are excluded consistently.
- **Statistical Gate (Per Instrument):** 
  - $t_{\text{HAC, NIFTY}} > 3.0 \quad\text{and}\quad t_{\text{HAC, BANKNIFTY}} > 3.0$
  - The mean incremental net return must be strictly positive separately for both instruments.
  - **Amplitude Modulated (AM) HAC Estimator:** Mandated (Datta & Du, 2012). Missing positions are represented as zeros *exclusively in the transformed amplitude-modulated series*. Bandwidth is strictly frozen at $L = 30$ grid intervals = 15 minutes with a Bartlett kernel.
  - **Missingness Independence Decision Gate:** Logistic regression tests gap occurrence against 1-minute preceding message intensity, volatility, and time-of-day. 95% CI Odds Ratios must fall strictly within $[0.90, 1.10]$. Significance ($p < 0.05$ with Bonferroni correction) or bounds violation blocks the AM confirmation (`ESTIMATOR_VALIDATION_FAIL`).
  - **AM Estimator Calibration Gate:** Validated using $N_{\text{sim}}=100,000$ independent bootstraps (Seed=100) under the centered known-null. False-positive frequency for $t_{\text{HAC}}>3.0$ must fall strictly within **$[0.0010, 0.0020]$**.
- **Placebo Dominance Gate:** Exactly 20 non-circular offsets: **Offsets = {+1, +2, ..., +20}** whole trading sessions. Intraday timestamps matched across sessions. The actual $t_{\text{HAC}}$ must strictly exceed all 20 identically-truncated surrogate statistics.

### Stage B: Tradability & Execution Gate
*Execution authorized exclusively if Stage A passes.*
**Objective:** Evaluate whether the replicated effect remains economically viable.
- **Contract Selection, Rollover & Lot Sizing:** 
  - Executions strictly target the Front-Month index futures contract.
  - **Expiry Rule:** NIFTY and BANKNIFTY futures officially expire on the **last Tuesday** of the expiry month. If Tuesday is a holiday, expiration shifts to the previous trading day.
  - **Rollover Rule:** Rollover occurs deterministically at the open of the trading session exactly two trading days prior to the expiration day. 
  - **Dynamic Lot Sizing:** Position sizing applies the exact dynamically published **date-effective exchange lot size**.
- **Executable Return Model:**
  - **Decision & Price Construction at $t_{entry}$:** Limit prices are constructed exclusively from information visible at $t_{entry}$. A buy Limit Price is calculated as the Best Ask available at $t_{entry}$ plus 50 bps, strictly **rounded down** to the applicable date-effective index-band tick size. A sell Limit Price is calculated as the Best Bid available at $t_{entry}$ minus 50 bps, strictly **rounded up**.
  - **Arrival Matching & Validation at $t_{entry} + 50\text{ ms}$:** The frozen limit order arrives exactly at $t_{entry} + 50\text{ ms}$. The submitted price is strictly validated against the prevailing exchange Limit Price Protection (LPP) and operating-price-range rules effective at arrival. If the submitted limit violates these constraints, the order is **outright rejected**.
  - **Execution & Depth Consumption:** If valid, the Limit IOC order sweeps physical L2 depth at $t_{entry} + 50\text{ ms}$ up to the submitted limit price. Any residual unfilled quantity is definitively cancelled (Fill-and-Kill).
  - **Exit Discipline & Residual Liquidation Policy:** 
    - Exit decisions trigger mathematically relative to the *entry decision* timestamp: $t_{\text{exit decision}} = t_{\text{entry decision}} + 15\text{ minutes}$. Limit IOC prices are computed exactly as above using the L1 book at $t_{\text{exit decision}}$, and the order arrives at $t_{\text{exit decision}} + 50\text{ ms}$.
    - The target exit quantity strictly equals the *actual quantity filled* on the entry order.
    - **Stranded Residual Liquidation Rule:** If the 15-minute exit IOC is rejected or partially filled, the unclosed quantity remains an active open position. The strategy enters a mechanical liquidation retry loop: a new Marketable Limit IOC is generated every 30 seconds using the latest L1 quote and the exact same 50-bps aggressiveness/rounding rules. While this stranded residual remains open, it continues to consume the exposure cap.
    - **End-Of-Session Cutoff Failure:** If the position remains unliquidated when the specific, date-effective trading and broker schedule cutoff arrives (e.g. 3:15 PM), **the strategy explicitly registers an execution-policy failure**. Guaranteed "market-on-close" fills or theoretical closing valuations are prohibited. Because overnight exposure is fundamentally prohibited, any inventory surviving the final permitted physical liquidation attempt invalidates the trade as an unresolvable residual failure.
  - **Portfolio Exposure:** Maximum concurrent exposure is strictly capped at 1 date-effective lot per instrument. Overlapping entries/exits processed sequentially.
- **Date-Effective Transaction Cost Schedule:** All statutory and exchange charges use a strict **date-effective versioned cost database**:
  - **Futures STT:** 0.05% strictly applied to the sell-side only.
  - **Stamp Duty:** 0.002% strictly applied to the buy-side only.
  - **Exchange & Regulatory Charges:** Explicitly modeled as separate items (e.g., ETC + SEBI Turnover).
  - **Brokerage:** Retail assumption of ₹20 strictly per *executed order leg*.
  - **GST:** 18% applied to the sum of (Brokerage + ETC + SEBI Turnover Fees).
- **Promotion Gate (Per Instrument):** 
  - **NIFTY & BANKNIFTY futures:** FAST mean net executable return has a strictly positive one-sided 95% bootstrap lower bound.
  - **NIFTY & BANKNIFTY futures:** Incremental net executable performance versus baseline has a strictly positive one-sided 95% bootstrap lower bound.
- **Bootstrap Mechanics:** Resampled session indices must be identical for both instruments within each joint replicate. 1,000 replicates using empirical 5th percentile.
- **Block-Length Decision Rule:** Ljung-Box portmanteau test (up to lag 5) on discovery aggregated session returns. If $p < 0.05$, block length = 6 sessions. Else, 1 session.

## 5. Exit States & Hard Stopping Rule
- **`ESTIMATOR_VALIDATION_FAIL`**: The discovery-data missingness independence check or the 100,000-run AM estimator calibration failed. Stage B execution-timing uncertainty can also trigger this if timestamp precision cannot defend a 50ms latency model.
- **`INCONCLUSIVE / INSUFFICIENT_SAMPLE`**: Hits the maximum collection deadline without achieving the absolute minimum floors and precomputed power samples (post truncation).
- **`STAGE_A_FAIL`**: No confirmed predictive replication.
- **`STAGE_A_PASS_STAGE_B_FAIL`**: Predictive replication mathematically succeeded, but executable profitability was not established on one or both instruments (fails the bootstrap or violates execution policy due to stranded unliquidated inventory).
- **`STAGE_B_PASS / EXECUTION_GATE_PASSED`**: The frozen replication and execution criteria have fully passed on both independent instruments simultaneously. 

*No tuning or post-hoc adjustments are permitted.*
*(SHA-256 Hash of this specification to be recorded externally upon final approval)*
