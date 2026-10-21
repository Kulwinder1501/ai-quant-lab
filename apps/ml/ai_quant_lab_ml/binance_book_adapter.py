"""
Binance Order Book Adapter & Depletion Classifier Validation Engine
Implementation Contract v1.0 & Pre-Registration PREREG-2026-10-21-BINANCE-DEPLETION-VALIDATION-V1

Provides:
1. Binance trade sign mapping (is_buyer_maker -> "SELL" / "BUY").
2. BinanceLocalOrderBook: rigorous L2 order-book maintenance algorithm adhering to Binance Spot
   specifications (snapshot buffering, U/u sequence validation, gap detection, resynchronization).
3. DepthFrameRow adapter enabling direct reuse of unmodified classify_depletion_trade and
   split_into_valid_frame_pairs.
4. Evaluation engine for classifier validation: Confusion matrix, Precision, Recall, Silent-Miss Rate,
   and exact Wilson score confidence intervals.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from ai_quant_lab_ml.cks_ofi_touch import DepthFrameRow, split_into_valid_frame_pairs
from ai_quant_lab_ml.depletion_trade_inference import classify_depletion_trade


def map_binance_trade_to_aggressor_side(is_buyer_maker: bool) -> str:
    """
    Binance spot trade stream sign convention:
    'm' / is_buyer_maker indicates whether the buyer was the maker (resting order).
    - If is_buyer_maker is True:
      Buyer was the maker (resting order on the bid).
      The seller was the taker (aggressor hitting the bid).
      Aggressor side: "SELL".
    - If is_buyer_maker is False:
      Seller was the maker (resting order on the ask).
      The buyer was the taker (aggressor lifting the ask).
      Aggressor side: "BUY".
    """
    return "SELL" if is_buyer_maker else "BUY"


def wilson_score_interval(successes: int, trials: int, confidence: float = 0.95) -> Tuple[float, float, float]:
    """
    Computes point estimate and Wilson score confidence interval for a binomial proportion.
    Returns: (point_estimate, lower_ci, upper_ci)
    Handles zero trials safely by returning (0.0, 0.0, 0.0).
    """
    if trials <= 0:
        return (0.0, 0.0, 0.0)
    p = successes / trials
    # For 95% confidence: z = 1.959963984540054
    z = 1.959963984540054 if abs(confidence - 0.95) < 1e-4 else 1.959963984540054
    z2 = z * z
    denom = 1.0 + z2 / trials
    center = (p + z2 / (2.0 * trials)) / denom
    half_width = (z * math.sqrt((p * (1.0 - p) + z2 / (4.0 * trials)) / trials)) / denom
    lower = max(0.0, center - half_width)
    upper = min(1.0, center + half_width)
    return (p, lower, upper)


class SequenceGapError(Exception):
    """Raised when an order book sequence gap is detected and resync is required."""
    pass


class BinanceLocalOrderBook:
    """
    Maintains a Binance L2 order book in accordance with official Binance Spot protocol:
    1. Buffer incoming depthUpdate events.
    2. Obtain REST depth snapshot with lastUpdateId.
    3. Drop buffered events where u < lastUpdateId.
    4. Verify first processed event satisfies: U <= lastUpdateId + 1 <= u.
    5. Maintain sequence continuity: each subsequent event must satisfy U <= last_applied_u + 1 <= u
       (or U == last_applied_u + 1 for spot).
    6. Detect gaps (U > last_applied_u + 1) or regressions: invalidate book, trigger resync.
    7. Track touch level (bid_0, ask_0) after each applied diff.
    """

    def __init__(self, symbol: str):
        self.symbol = symbol.upper()
        self.bids: Dict[float, float] = {}  # price -> qty
        self.asks: Dict[float, float] = {}  # price -> qty
        self.last_update_id: Optional[int] = None
        self.last_applied_u: Optional[int] = None
        self.is_synchronized: bool = False
        self.buffered_events: List[Dict[str, Any]] = []
        self.gap_count: int = 0
        self.total_diffs_applied: int = 0

    def buffer_event(self, event: Dict[str, Any]) -> None:
        """Buffers a depthUpdate event while awaiting initial or resync snapshot."""
        self.buffered_events.append(event)

    def apply_snapshot(self, snapshot: Dict[str, Any]) -> DepthFrameRow:
        """
        Initializes the book from a REST snapshot and replays buffered diffs.
        Returns the initial DepthFrameRow corresponding to the snapshot state.
        Raises SequenceGapError if the buffered events cannot bridge from the snapshot.
        """
        self.last_update_id = int(snapshot["lastUpdateId"])
        self.last_applied_u = self.last_update_id
        self.bids = {float(p): float(q) for p, q in snapshot.get("bids", []) if float(q) > 0}
        self.asks = {float(p): float(q) for p, q in snapshot.get("asks", []) if float(q) > 0}

        # Filter out old events
        valid_buffered = [e for e in self.buffered_events if int(e["u"]) >= self.last_update_id]

        if not valid_buffered:
            # Buffer did not contain any events at or after lastUpdateId.
            # Book is initialized to snapshot baseline, will await matching live diff.
            self.is_synchronized = True
            self.buffered_events.clear()
            bid_p, bid_q, ask_p, ask_q = self.get_top_of_book()
            return DepthFrameRow(
                received_at=datetime.now(timezone.utc),
                is_snapshot=True,
                is_duplicate=False,
                gap_before=None,
                bid_price_0=bid_p,
                bid_qty_0=bid_q,
                ask_price_0=ask_p,
                ask_qty_0=ask_q,
                is_regression=False,
            )

        # Check first event condition: U <= lastUpdateId + 1 <= u
        first_event = valid_buffered[0]
        first_U = int(first_event["U"])
        first_u = int(first_event["u"])

        if first_U > self.last_update_id + 1:
            self.is_synchronized = False
            self.buffered_events.clear()
            self.gap_count += 1
            raise SequenceGapError(
                f"Gap between snapshot lastUpdateId={self.last_update_id} and first event U={first_U}"
            )

        # Replay valid buffered events
        for event in valid_buffered:
            u_val = int(event["u"])
            if u_val < self.last_applied_u:
                continue
            U_val = int(event["U"])
            if U_val > self.last_applied_u + 1:
                self.is_synchronized = False
                self.buffered_events.clear()
                self.gap_count += 1
                raise SequenceGapError(
                    f"Gap during buffer replay: last_applied_u={self.last_applied_u}, next U={U_val}"
                )
            self._apply_diff_payload(event)
            self.last_applied_u = u_val
            self.total_diffs_applied += 1

        self.is_synchronized = True
        self.buffered_events.clear()

        bid_p, bid_q, ask_p, ask_q = self.get_top_of_book()
        return DepthFrameRow(
            received_at=datetime.now(timezone.utc),
            is_snapshot=True,
            is_duplicate=False,
            gap_before=None,
            bid_price_0=bid_p,
            bid_qty_0=bid_q,
            ask_price_0=ask_p,
            ask_qty_0=ask_q,
            is_regression=False,
        )

    def apply_diff(self, event: Dict[str, Any], received_at: Optional[datetime] = None) -> DepthFrameRow:
        """
        Applies a live depthUpdate event to the synchronized order book.
        Validates sequence numbers and flags duplicates, regressions, and gaps.
        """
        if received_at is None:
            received_at = datetime.now(timezone.utc)

        if not self.is_synchronized:
            self.buffer_event(event)
            bid_p, bid_q, ask_p, ask_q = self.get_top_of_book()
            return DepthFrameRow(
                received_at=received_at,
                is_snapshot=False,
                is_duplicate=False,
                gap_before=None,
                bid_price_0=bid_p,
                bid_qty_0=bid_q,
                ask_price_0=ask_p,
                ask_qty_0=ask_q,
                is_regression=True,
            )

        u_val = int(event["u"])
        U_val = int(event["U"])

        # Check duplicate / old
        if u_val <= self.last_applied_u:
            bid_p, bid_q, ask_p, ask_q = self.get_top_of_book()
            return DepthFrameRow(
                received_at=received_at,
                is_snapshot=False,
                is_duplicate=True,
                gap_before=0,
                bid_price_0=bid_p,
                bid_qty_0=bid_q,
                ask_price_0=ask_p,
                ask_qty_0=ask_q,
                is_regression=False,
            )

        # Check sequence gap
        if U_val > self.last_applied_u + 1:
            gap_size = U_val - self.last_applied_u - 1
            self.gap_count += 1
            self.is_synchronized = False
            self.buffer_event(event)
            bid_p, bid_q, ask_p, ask_q = self.get_top_of_book()
            return DepthFrameRow(
                received_at=received_at,
                is_snapshot=False,
                is_duplicate=False,
                gap_before=gap_size,
                bid_price_0=bid_p,
                bid_qty_0=bid_q,
                ask_price_0=ask_p,
                ask_qty_0=ask_q,
                is_regression=True,
            )

        # Sequential update
        self._apply_diff_payload(event)
        self.last_applied_u = u_val
        self.total_diffs_applied += 1

        bid_p, bid_q, ask_p, ask_q = self.get_top_of_book()
        return DepthFrameRow(
            received_at=received_at,
            is_snapshot=False,
            is_duplicate=False,
            gap_before=None,
            bid_price_0=bid_p,
            bid_qty_0=bid_q,
            ask_price_0=ask_p,
            ask_qty_0=ask_q,
            is_regression=False,
        )

    def _apply_diff_payload(self, event: Dict[str, Any]) -> None:
        """Applies bid and ask changes from event payload."""
        for p_str, q_str in event.get("b", []):
            p = float(p_str)
            q = float(q_str)
            if q <= 0.0:
                self.bids.pop(p, None)
            else:
                self.bids[p] = q

        for p_str, q_str in event.get("a", []):
            p = float(p_str)
            q = float(q_str)
            if q <= 0.0:
                self.asks.pop(p, None)
            else:
                self.asks[p] = q

    def get_top_of_book(self) -> Tuple[float, float, float, float]:
        """Returns (bid_price_0, bid_qty_0, ask_price_0, ask_qty_0)."""
        if self.bids:
            best_bid_p = max(self.bids.keys())
            best_bid_q = self.bids[best_bid_p]
        else:
            best_bid_p, best_bid_q = 0.0, 0.0

        if self.asks:
            best_ask_p = min(self.asks.keys())
            best_ask_q = self.asks[best_ask_p]
        else:
            best_ask_p, best_ask_q = 0.0, 0.0

        return best_bid_p, best_bid_q, best_ask_p, best_ask_q


@dataclass(frozen=True)
class TradeRecord:
    symbol: str
    trade_id: int
    price: float
    qty: float
    trade_time_ms: int
    is_buyer_maker: bool

    @property
    def aggressor_side(self) -> str:
        return map_binance_trade_to_aggressor_side(self.is_buyer_maker)


@dataclass
class ValidationMetrics:
    symbol: str
    total_frames: int
    valid_pairs: int
    broken_chain_count: int
    inferred_buy_count: int
    inferred_sell_count: int
    inferred_none_count: int
    tp_buy: int
    fp_buy_cancellation: int
    fp_buy_wrong_side: int
    tp_sell: int
    fp_sell_cancellation: int
    fp_sell_wrong_side: int
    silent_miss_count: int
    tn_count: int
    total_real_trades: int
    caught_real_trades: int
    # Precision metrics
    precision_buy: float
    precision_buy_ci95: Tuple[float, float]
    precision_sell: float
    precision_sell_ci95: Tuple[float, float]
    precision_pooled: float
    precision_pooled_ci95: Tuple[float, float]
    # Recall metrics
    recall: float
    recall_ci95: Tuple[float, float]
    # Silent miss rate
    silent_miss_rate: float
    silent_miss_rate_ci95: Tuple[float, float]
    # Success bar evaluation
    precision_bar_passed: bool
    recall_bar_passed: bool
    overall_passed: bool


def evaluate_depletion_classifier(
    frames: Sequence[DepthFrameRow],
    trades: Sequence[TradeRecord],
    symbol: str,
    matching_tolerance_ms: int = 250,
    price_epsilon: float = 1e-4,
    target_precision_bar: float = 0.70,
    target_recall_bar: float = 0.50,
) -> ValidationMetrics:
    """
    Evaluates classify_depletion_trade on DepthFrameRow sequences against ground-truth TradeRecord.

    Pre-registered matching discipline:
    - Tight time window: |t_trade - t_frame| <= matching_tolerance_ms (default 250ms).
    - Exact price level match: |trade.price - level_price| <= price_epsilon.
    - Side matching:
      - Inferred BUY matches real trades with is_buyer_maker=False (taker lifted ask).
      - Inferred SELL matches real trades with is_buyer_maker=True (taker hit bid).
    """
    # Build valid pairs using unmodified split_into_valid_frame_pairs
    segments = split_into_valid_frame_pairs(frames)
    valid_pairs: List[Tuple[DepthFrameRow, DepthFrameRow]] = []
    for seg in segments:
        valid_pairs.extend(seg)

    total_frames = len(frames)
    broken_chain_count = max(0, total_frames - 1 - len(valid_pairs))

    # Index trades by timestamp in ms for fast window lookup
    # Sort trades by trade_time_ms
    sorted_trades = sorted(trades, key=lambda tr: tr.trade_time_ms)
    trade_times = [tr.trade_time_ms for tr in sorted_trades]

    import bisect

    def get_trades_in_window(center_ms: int) -> List[TradeRecord]:
        lo = center_ms - matching_tolerance_ms
        hi = center_ms + matching_tolerance_ms
        idx_lo = bisect.bisect_left(trade_times, lo)
        idx_hi = bisect.bisect_right(trade_times, hi)
        return sorted_trades[idx_lo:idx_hi]

    inferred_buy = 0
    inferred_sell = 0
    inferred_none = 0

    tp_buy = 0
    fp_buy_cancellation = 0
    fp_buy_wrong_side = 0

    tp_sell = 0
    fp_sell_cancellation = 0
    fp_sell_wrong_side = 0

    silent_miss_count = 0
    tn_count = 0

    for prev_frame, curr_frame in valid_pairs:
        frame_ms = int(curr_frame.received_at.timestamp() * 1000)
        window_trades = get_trades_in_window(frame_ms)

        classification = classify_depletion_trade(prev_frame, curr_frame)

        if classification is None:
            inferred_none += 1
            # Check if a real trade actually happened at the touch prices
            touch_bid = prev_frame.bid_price_0
            touch_ask = prev_frame.ask_price_0
            trade_at_touch = any(
                (abs(tr.price - touch_bid) <= price_epsilon and tr.aggressor_side == "SELL")
                or (abs(tr.price - touch_ask) <= price_epsilon and tr.aggressor_side == "BUY")
                for tr in window_trades
            )
            if trade_at_touch:
                silent_miss_count += 1
            else:
                tn_count += 1

        elif classification[0] == "BUY":
            inferred_buy += 1
            target_price = prev_frame.ask_price_0
            trades_at_price = [tr for tr in window_trades if abs(tr.price - target_price) <= price_epsilon]
            has_matching_buy = any(tr.aggressor_side == "BUY" for tr in trades_at_price)
            if has_matching_buy:
                tp_buy += 1
            else:
                if any(tr.aggressor_side == "SELL" for tr in trades_at_price):
                    fp_buy_wrong_side += 1
                else:
                    fp_buy_cancellation += 1

        elif classification[0] == "SELL":
            inferred_sell += 1
            target_price = prev_frame.bid_price_0
            trades_at_price = [tr for tr in window_trades if abs(tr.price - target_price) <= price_epsilon]
            has_matching_sell = any(tr.aggressor_side == "SELL" for tr in trades_at_price)
            if has_matching_sell:
                tp_sell += 1
            else:
                if any(tr.aggressor_side == "BUY" for tr in trades_at_price):
                    fp_sell_wrong_side += 1
                else:
                    fp_sell_cancellation += 1

    # Evaluate recall across all real trades that occurred inside the valid evaluation span
    # Exclude boundary trades where +/- 250ms window falls outside the captured frame span
    if frames:
        first_frame_ms = int(frames[0].received_at.timestamp() * 1000)
        last_frame_ms = int(frames[-1].received_at.timestamp() * 1000)
        eval_trades = [
            tr for tr in sorted_trades
            if (first_frame_ms + matching_tolerance_ms) <= tr.trade_time_ms <= (last_frame_ms - matching_tolerance_ms)
        ]
    else:
        eval_trades = []

    # Map frame pairs for fast lookup when evaluating recall
    pair_times = [int(curr.received_at.timestamp() * 1000) for _, curr in valid_pairs]
    pair_classifications = [classify_depletion_trade(prev, curr) for prev, curr in valid_pairs]

    caught_trades = 0
    for tr in eval_trades:
        lo = tr.trade_time_ms - matching_tolerance_ms
        hi = tr.trade_time_ms + matching_tolerance_ms
        idx_lo = bisect.bisect_left(pair_times, lo)
        idx_hi = bisect.bisect_right(pair_times, hi)

        # Did any frame in window catch this trade?
        caught = False
        for i in range(idx_lo, idx_hi):
            cls = pair_classifications[i]
            if cls is not None and cls[0] == tr.aggressor_side:
                prev_f, _ = valid_pairs[i]
                ref_price = prev_f.ask_price_0 if cls[0] == "BUY" else prev_f.bid_price_0
                if abs(tr.price - ref_price) <= price_epsilon:
                    caught = True
                    break
        if caught:
            caught_trades += 1

    # Precision calculations
    total_inferred_trades = inferred_buy + inferred_sell
    total_tp = tp_buy + tp_sell

    p_buy, p_buy_lo, p_buy_hi = wilson_score_interval(tp_buy, inferred_buy)
    p_sell, p_sell_lo, p_sell_hi = wilson_score_interval(tp_sell, inferred_sell)
    p_pool, p_pool_lo, p_pool_hi = wilson_score_interval(total_tp, total_inferred_trades)

    # Recall calculation
    rec, rec_lo, rec_hi = wilson_score_interval(caught_trades, len(eval_trades))

    # Silent miss calculation
    smr, smr_lo, smr_hi = wilson_score_interval(silent_miss_count, inferred_none)

    precision_passed = p_pool >= target_precision_bar
    recall_passed = rec >= target_recall_bar
    overall_passed = precision_passed and recall_passed

    return ValidationMetrics(
        symbol=symbol,
        total_frames=total_frames,
        valid_pairs=len(valid_pairs),
        broken_chain_count=broken_chain_count,
        inferred_buy_count=inferred_buy,
        inferred_sell_count=inferred_sell,
        inferred_none_count=inferred_none,
        tp_buy=tp_buy,
        fp_buy_cancellation=fp_buy_cancellation,
        fp_buy_wrong_side=fp_buy_wrong_side,
        tp_sell=tp_sell,
        fp_sell_cancellation=fp_sell_cancellation,
        fp_sell_wrong_side=fp_sell_wrong_side,
        silent_miss_count=silent_miss_count,
        tn_count=tn_count,
        total_real_trades=len(eval_trades),
        caught_real_trades=caught_trades,
        precision_buy=p_buy,
        precision_buy_ci95=(p_buy_lo, p_buy_hi),
        precision_sell=p_sell,
        precision_sell_ci95=(p_sell_lo, p_sell_hi),
        precision_pooled=p_pool,
        precision_pooled_ci95=(p_pool_lo, p_pool_hi),
        recall=rec,
        recall_ci95=(rec_lo, rec_hi),
        silent_miss_rate=smr,
        silent_miss_rate_ci95=(smr_lo, smr_hi),
        precision_bar_passed=precision_passed,
        recall_bar_passed=recall_passed,
        overall_passed=overall_passed,
    )
