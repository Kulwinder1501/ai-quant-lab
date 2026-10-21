# Pre-Registration: Empirical Classifier Validation of Book-Depletion Trade Inference

**Document ID:** `PREREG-2026-10-21-BINANCE-DEPLETION-VALIDATION-V1`  
**Date:** `2026-10-21`  
**Governance Status:** `PRE_REGISTRATION_LOCKED`  
**Trading Execution Authorized:** `false`  
**Author:** AI Quant Lab / Senior Microstructure Quant  
**Implementation Modules:**
- Target Heuristic: [`apps/ml/ai_quant_lab_ml/depletion_trade_inference.py`](../apps/ml/ai_quant_lab_ml/depletion_trade_inference.py) (`classify_depletion_trade`)
- Chain Validity: [`apps/ml/ai_quant_lab_ml/cks_ofi_touch.py`](../apps/ml/ai_quant_lab_ml/cks_ofi_touch.py) (`split_into_valid_frame_pairs`)
- Adapter & Validation Engine: [`apps/ml/ai_quant_lab_ml/binance_book_adapter.py`](../apps/ml/ai_quant_lab_ml/binance_book_adapter.py)
- Capture Daemon: [`apps/ml/capture_binance_l2_trades.py`](../apps/ml/capture_binance_l2_trades.py)
- Validation Runner: [`apps/ml/run_binance_depletion_validation.py`](../apps/ml/run_binance_depletion_validation.py)
- Unit Tests: [`apps/ml/tests/test_binance_depletion_validation.py`](../apps/ml/tests/test_binance_depletion_validation.py)

---

## 1. Research Motivation & Reality Check

### 1.1 The Context & The Question
In [`depletion_trade_inference.py`](../apps/ml/ai_quant_lab_ml/depletion_trade_inference.py), the system implements an L2-only heuristic for inferring trade executions:
> Classify a book update as an inferred BUY (ask depleted, someone lifted the offer) or inferred SELL (bid depleted, someone hit the bid) ONLY when the quantity at a touch level decreases with the price at that level UNCHANGED. Every other book change (price improvement, price withdrawal, quantity increase, both-sided depletion) is discarded as non-trade or ambiguous.

This heuristic was built because Indian broker/vendor APIs (Fyers, Kite, TrueData) provide **zero trade prints** for BANKNIFTY futures or options—only snapshot L2 depth frames. Neither the tick rule nor the quote rule can be run on NSE data because no trade tape exists in vendor feeds.

The purpose of this study is **NOT** signal discovery, returns prediction, or an Information Coefficient (IC) calculation. The question is narrower, fundamental, and strictly classification-theoretic:
> **When observable ground-truth trade prints exist, does the depletion-at-unchanged-price heuristic accurately detect that a trade occurred, and does it correctly identify the aggressor side?**

### 1.2 What This Does and Does Not Tell Us
- **What this tells us:** Whether the geometric deduction (touch quantity decrement at unchanged price $\implies$ executed trade) is mechanically sound under continuous order-driven matching with millisecond resolution, or whether it is swamped by limit order cancellations (false positives) and simultaneous replenishment (silent misses).
- **What this does NOT tell us:** A strong validation result here does **not** prove the heuristic works on NSE BANKNIFTY. Binance crypto is a continuous order-driven market with 100ms book diff broadcasts; NSE options/futures operate under discrete tick sizes, lot multipliers, broker snapshot throttling, and call auctions. This study isolates the validity of the classification logic itself under observable ground truth.

---

## 2. Data Specification

### 2.1 Feeds & Streams
Data is captured via Binance Spot public WebSocket streams (`wss://stream.binance.com:9443/stream`):
1. **L2 Depth Updates:** `<symbol>@depth@100ms`
   - Emits order-book diffs every 100ms with event time $E$, first update ID $U$, final update ID $u$, and bid/ask update arrays.
2. **Raw Trade Tape:** `<symbol>@trade`
   - Emits individual executed trade prints with trade ID $t$, execution price $p$, executed quantity $q$, execution time $T$, and `isBuyerMaker` flag $m$.
   - **Crucial Requirement:** Deliberately uses `@trade` (raw trades) rather than `@aggTrade`. `@aggTrade` aggregates multiple fills from a single market order into a consolidated print; `@trade` preserves the 1:1 match against touch quantity decrements modeled by the heuristic.

### 2.2 Symbols
Evaluated across two major spot symbols with continuous liquidity and deep books:
- `BTCUSDT`
- `ETHUSDT`

---

## 3. Order-Book Maintenance Protocol (Step 1)

Binance local order-book maintenance follows the official Binance Spot specification:
1. Connect to WebSocket stream and immediately begin buffering incoming `depthUpdate` events.
2. Fetch REST depth snapshot (`GET /api/v3/depth?symbol=<symbol>&limit=1000`) returning `lastUpdateId`, `bids`, and `asks`.
3. Discard buffered events where $u < \text{lastUpdateId}$.
4. Verify the first processed event satisfies:
   $$U \le \text{lastUpdateId} + 1 \le u$$
   If this condition fails (buffer does not bridge snapshot), discard buffer, record gap, and re-fetch snapshot.
5. Apply diffs sequentially, maintaining bids and asks dictionaries. Verify that for each subsequent event:
   $$U \le \text{last\_applied\_u} + 1 \le u$$
6. **Gap & Regression Detection:** If an event arrives with $U > \text{last\_applied\_u} + 1$, a sequence gap is declared. The book marks `is_regression = True`, invalidates synchronization, records `gap_before`, buffers incoming events, and triggers an immediate REST re-snapshot.
7. After each applied diff, compute best touch:
   $$\text{bid\_price\_0} = \max(\text{bids}), \quad \text{bid\_qty\_0} = \text{bids}[\text{bid\_price\_0}]$$
   $$\text{ask\_price\_0} = \min(\text{asks}), \quad \text{ask\_qty\_0} = \text{asks}[\text{ask\_price\_0}]$$

Captured events are persisted to SQLite (`depth_updates` and `trades`) with WAL mode enabled.

---

## 4. Sign Convention Mapping (Step 2)

Binance's trade message flag `m` (`isBuyerMaker`) denotes whether the buyer was the maker (resting order):
$$\text{isBuyerMaker} = \text{True} \implies \text{Buyer was Maker (resting bid)} \implies \text{Taker was Seller (hitting bid)} \implies \text{Aggressor Side} = \mathbf{\text{"SELL"}}$$
$$\text{isBuyerMaker} = \text{False} \implies \text{Seller was Maker (resting offer)} \implies \text{Taker was Buyer (lifting ask)} \implies \text{Aggressor Side} = \mathbf{\text{"BUY"}}$$

This mapping is tested and frozen in [`apps/ml/tests/test_binance_depletion_validation.py`](../apps/ml/tests/test_binance_depletion_validation.py) across 3 hand-built scenarios before running against live data.

---

## 5. Unmodified Heuristic Adapter (Step 3)

The classification logic is **not** rewritten for crypto. Captured frames are converted to [`DepthFrameRow`](../apps/ml/ai_quant_lab_ml/cks_ofi_touch.py) instances and passed through:
1. [`split_into_valid_frame_pairs`](../apps/ml/ai_quant_lab_ml/cks_ofi_touch.py): Breaks chains on snapshots, duplicates, regressions, sequence gaps, and non-comparable books.
2. [`classify_depletion_trade`](../apps/ml/ai_quant_lab_ml/depletion_trade_inference.py):
   - Ask depleted at unchanged price $\implies \mathbf{(\text{"BUY"}, \Delta q)}$
   - Bid depleted at unchanged price $\implies \mathbf{(\text{"SELL"}, \Delta q)}$
   - Price changed, quantity increased, or both sides depleted $\implies \mathbf{\text{None}}$

---

## 6. Metrics & Statistical Alignment (Step 4)

### 6.1 Matching Discipline
For each valid frame pair $(F_{t-1}, F_t)$ evaluated at timestamp $t_{\text{frame}}$:
- **Time Window:** $[t_{\text{frame}} - 250\text{ms}, t_{\text{frame}} + 250\text{ms}]$ (matching the 100ms book broadcast cadence).
- **Price Level:** Exact price match ($|\text{trade.price} - \text{level\_price}| \le 10^{-4}$).
- **Side Matching:**
  - Inferred BUY matched against real trades with $\text{isBuyerMaker} = \text{False}$ at `prev.ask_price_0`.
  - Inferred SELL matched against real trades with $\text{isBuyerMaker} = \text{True}$ at `prev.bid_price_0`.

### 6.2 Primary Metrics
1. **Precision (Positive Predictive Value):**
   - $\text{Precision}_{\text{BUY}} = \frac{\text{TP}_{\text{BUY}}}{\text{Inferred BUY}}$
   - $\text{Precision}_{\text{SELL}} = \frac{\text{TP}_{\text{SELL}}}{\text{Inferred SELL}}$
   - $\text{Precision}_{\text{Pooled}} = \frac{\text{TP}_{\text{BUY}} + \text{TP}_{\text{SELL}}}{\text{Inferred BUY} + \text{Inferred SELL}}$
   - False Positives are decomposed into:
     - $\text{FP}_{\text{cancellation}}$: No trade occurred at that price in the window (cancellation).
     - $\text{FP}_{\text{wrong\_side}}$: Only opposite-side trades occurred at that price.
2. **Recall (Sensitivity):**
   - For every real trade in the interior of the session:
     $$\text{Recall} = \frac{\text{Trades Caught by Inferred Depletion}}{\text{Total Real Trades Evaluated}}$$
3. **Silent-Miss Rate:**
   - Fraction of pairs where the heuristic output `None`, but a real trade executed at the touch price within the window:
     $$\text{Silent-Miss Rate} = \frac{\text{Silent Miss Count}}{\text{Inferred None Count}}$$
4. **Wilson Score Confidence Intervals:**
   All metrics are reported with exact 95% Wilson score confidence intervals:
   $$w = \frac{\hat{p} + \frac{z^2}{2n} \pm z \sqrt{\frac{\hat{p}(1-\hat{p})}{n} + \frac{z^2}{4n^2}}}{1 + \frac{z^2}{n}}, \quad z = 1.95996$$

---

## 7. Pre-Registered Pass/Fail Success Bar

Prior to real evaluation, the following criteria are frozen:
1. **Capture Duration Floor:** $\ge 2.0$ hours of continuous active trading for both `BTCUSDT` and `ETHUSDT`.
   - If duration $< 2.0$ hours, the pipeline enforces a duration floor refusal (`INSUFFICIENT_CAPTURE_DURATION`).
2. **Target Precision Bar:** $\ge 0.70$ (70.0%) pooled precision for **both** symbols.
   - At least 70% of touch depletions at unchanged price must be verified trade prints rather than limit order cancellations.
3. **Target Recall Bar:** $\ge 0.50$ (50.0%) recall for **both** symbols.
   - The heuristic must catch at least 50% of real executed trade prints. (Remaining misses are expected from intra-cadence replenishments and multi-tick market orders).
4. **Final Verdict Decision Rule:**
   - **`SUPPORTED`**: Capture duration $\ge 2.0$h AND $\text{Precision} \ge 0.70$ AND $\text{Recall} \ge 0.50$ on both symbols.
   - **`FALSIFIED`**: Capture duration $\ge 2.0$h AND ($\text{Precision} < 0.70$ OR $\text{Recall} < 0.50$ on either symbol).
   - **`INCONCLUSIVE_INSUFFICIENT_DURATION`**: Capture duration $< 2.0$h.

---

## 8. Governance & Non-Authorization Notice

> [!CAUTION]
> **EXPLORATORY RESEARCH ONLY — NO TRADING AUTHORIZED.**
> This study evaluates classifier mechanics on crypto spot data to validate the physical premise of order-book depletion trade inference when trade tape is observable. It does not evaluate alpha, Sharpe ratio, or market-making P&L, and does not authorize trading execution in any environment.
