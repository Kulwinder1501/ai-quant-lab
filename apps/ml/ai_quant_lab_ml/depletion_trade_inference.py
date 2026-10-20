"""
Book-depletion trade inference: an L2-only proxy for "a trade happened here," for use where no
real trade tape exists -- confirmed true of every vendor integrated in this codebase (Fyers' own
TBT websocket SDK has no trade message type at all; Kite and TrueData's own user communities report
the same gap). This module exists because the literal tick rule / quote rule cannot be built: both
classify a KNOWN TRADE PRICE against the prevailing quote, and there is no trade price captured
anywhere for BANKNIFTY futures -- only order-book depth (depth_frames: bid/ask price and quantity
per level, no last-traded-price, no last-traded-quantity).

What this computes instead: classify a book update as an inferred BUY (ask depleted, someone
lifted the offer) or inferred SELL (bid depleted, someone hit the bid) ONLY when the quantity at
a touch level decreases with the price at that level UNCHANGED -- the one case that plausibly
indicates an execution rather than a new quote or a cancellation. Every other book change (price
improvement, price withdrawal, quantity increase, both-sided depletion in the same update) is
discarded as non-trade or ambiguous rather than guessed.

This is deliberately NARROWER than touch-level OFI (cks_ofi_touch.py): OFI (Cont-Kukanov-Stoikov)
counts EVERY touch-level change as a proxy for buying/selling pressure, with no attempt to
distinguish a trade from a cancellation or a new resting order. This module counts only the
same-price-depletion subset. Whether that narrower, more trade-like signal says anything
DIFFERENT from OFI, or is simply a quieter restatement of the same thing, is exactly the empirical
question depletion_vs_ofi_signal_check.py exists to answer -- this module makes no claim either
way on its own.

Both signals are built from `cks_ofi_touch.split_into_valid_frame_pairs`, the SAME chain-validity
rule (snapshot/duplicate/gap/regression/one-sided-book breaks), so a difference between the two
series reflects the metric, not two differently-filtered views of the data.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import List, Optional, Sequence, Tuple

from ai_quant_lab_ml.cks_ofi_touch import DepthFrameRow, split_into_valid_frame_pairs

# Matches OFI_WINDOW_MS (cks_ofi_touch.py) exactly, so the two series are comparable window-for-window.
DEPLETION_WINDOW_MS = 5000

InferredSide = str  # 'BUY' | 'SELL'


def classify_depletion_trade(previous: DepthFrameRow, current: DepthFrameRow) -> Optional[Tuple[InferredSide, float]]:
    """
    ('BUY', qty): the ask depleted at an unchanged price -- someone plausibly lifted the offer.
    ('SELL', qty): the bid depleted at an unchanged price -- someone plausibly hit the bid.
    None: price moved, quantity did not decrease, or both sides depleted in the same update (a
    one-sided inference would be a guess, not a classification, so neither side is credited).
    """
    bid_depleted = current.bid_price_0 == previous.bid_price_0 and current.bid_qty_0 < previous.bid_qty_0
    ask_depleted = current.ask_price_0 == previous.ask_price_0 and current.ask_qty_0 < previous.ask_qty_0

    if bid_depleted and not ask_depleted:
        return ("SELL", previous.bid_qty_0 - current.bid_qty_0)
    if ask_depleted and not bid_depleted:
        return ("BUY", previous.ask_qty_0 - current.ask_qty_0)
    return None


@dataclass(frozen=True)
class DepletionWindowObservation:
    at: datetime
    window_sum: float  # signed: +inferred buy qty, -inferred sell qty, summed over the trailing window
    inferred_trade_count: int  # how many of the pairs in this window classified as a trade at all


def compute_windowed_depletion_flow_series(frames: Sequence[DepthFrameRow]) -> List[DepletionWindowObservation]:
    """
    Trailing-window sum of inferred buy/sell flow, one observation per valid frame pair --
    deliberately emitted at the SAME timestamps compute_windowed_ofi_series would produce from the
    same frames (both iterate split_into_valid_frame_pairs), so the two series align 1:1 for a
    direct correlation check rather than needing a nearest-prior join that could itself introduce
    a difference unrelated to the metric.
    """
    observations: List[DepletionWindowObservation] = []
    window_ms = timedelta(milliseconds=DEPLETION_WINDOW_MS)

    for segment in split_into_valid_frame_pairs(frames):
        signed_deltas: List[float] = []
        is_trade: List[bool] = []
        for previous, current in segment:
            classified = classify_depletion_trade(previous, current)
            if classified is None:
                signed_deltas.append(0.0)
                is_trade.append(False)
            else:
                side, qty = classified
                signed_deltas.append(qty if side == "BUY" else -qty)
                is_trade.append(True)

        window_start = 0
        window_sum = 0.0
        window_trade_count = 0
        for cursor in range(len(segment)):
            window_sum += signed_deltas[cursor]
            window_trade_count += 1 if is_trade[cursor] else 0
            current_at = segment[cursor][1].received_at
            cutoff = current_at - window_ms
            while window_start < cursor and segment[window_start][1].received_at < cutoff:
                window_sum -= signed_deltas[window_start]
                window_trade_count -= 1 if is_trade[window_start] else 0
                window_start += 1
            observations.append(DepletionWindowObservation(
                at=current_at, window_sum=window_sum, inferred_trade_count=window_trade_count,
            ))

    return observations
