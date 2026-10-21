"""
Unit Tests for Binance Order Book Adapter, Sign Convention, and Depletion Validation
Pre-Registration PREREG-2026-10-21-BINANCE-DEPLETION-VALIDATION-V1
"""

from datetime import datetime, timedelta, timezone
import pytest

from ai_quant_lab_ml.cks_ofi_touch import DepthFrameRow
from ai_quant_lab_ml.depletion_trade_inference import classify_depletion_trade
from ai_quant_lab_ml.binance_book_adapter import (
    BinanceLocalOrderBook,
    SequenceGapError,
    TradeRecord,
    evaluate_depletion_classifier,
    map_binance_trade_to_aggressor_side,
    wilson_score_interval,
)

T0 = datetime(2026, 10, 21, 10, 0, 0, tzinfo=timezone.utc)


def test_binance_sign_mapping_hand_built_scenarios():
    """
    Step 2 Unit Test: Verifies Binance isBuyerMaker sign convention against 3 hand-built scenarios.
    
    Rule:
    - is_buyer_maker == True: Buyer was resting (maker on bid) -> Seller was aggressor (taker) -> "SELL"
    - is_buyer_maker == False: Seller was resting (maker on ask) -> Buyer was aggressor (taker) -> "BUY"
    """
    # Scenario 1: Retail trader places market SELL of 0.5 BTC, filling resting limit BUY at 82,800.00
    # Buyer is maker (resting) -> isBuyerMaker is True -> Aggressor side is "SELL"
    assert map_binance_trade_to_aggressor_side(True) == "SELL"

    # Scenario 2: Momentum trader places market BUY of 1.2 ETH, lifting resting limit SELL at 2,700.00
    # Seller is maker (resting) -> isBuyerMaker is False -> Aggressor side is "BUY"
    assert map_binance_trade_to_aggressor_side(False) == "BUY"

    # Scenario 3: Complete book depletion alignment check
    # Part A: Bid depleted at unchanged price 82,800.00 (from 5.0 to 3.0 BTC)
    prev_bid_dep = DepthFrameRow(
        received_at=T0, is_snapshot=False, is_duplicate=False, gap_before=None,
        bid_price_0=82800.0, bid_qty_0=5.0, ask_price_0=82801.0, ask_qty_0=2.0
    )
    curr_bid_dep = DepthFrameRow(
        received_at=T0 + timedelta(milliseconds=100), is_snapshot=False, is_duplicate=False, gap_before=None,
        bid_price_0=82800.0, bid_qty_0=3.0, ask_price_0=82801.0, ask_qty_0=2.0
    )
    classified_bid = classify_depletion_trade(prev_bid_dep, curr_bid_dep)
    assert classified_bid == ("SELL", 2.0)
    # Matching Binance trade print for this hit:
    trade_hit = TradeRecord(
        symbol="BTCUSDT", trade_id=101, price=82800.0, qty=2.0,
        trade_time_ms=int((T0 + timedelta(milliseconds=50)).timestamp() * 1000),
        is_buyer_maker=True  # buyer resting, seller hit bid
    )
    assert trade_hit.aggressor_side == classified_bid[0]

    # Part B: Ask depleted at unchanged price 82,801.00 (from 2.0 to 0.8 BTC)
    curr_ask_dep = DepthFrameRow(
        received_at=T0 + timedelta(milliseconds=200), is_snapshot=False, is_duplicate=False, gap_before=None,
        bid_price_0=82800.0, bid_qty_0=3.0, ask_price_0=82801.0, ask_qty_0=0.8
    )
    classified_ask = classify_depletion_trade(curr_bid_dep, curr_ask_dep)
    assert classified_ask == ("BUY", 1.2)
    # Matching Binance trade print for this lift:
    trade_lift = TradeRecord(
        symbol="BTCUSDT", trade_id=102, price=82801.0, qty=1.2,
        trade_time_ms=int((T0 + timedelta(milliseconds=150)).timestamp() * 1000),
        is_buyer_maker=False  # seller resting, buyer lifted ask
    )
    assert trade_lift.aggressor_side == classified_ask[0]


def test_binance_local_order_book_maintenance():
    book = BinanceLocalOrderBook(symbol="BTCUSDT")

    # Buffer diffs arriving before snapshot
    book.buffer_event({"U": 100, "u": 102, "b": [["80000.0", "1.5"]], "a": []})
    book.buffer_event({"U": 103, "u": 105, "b": [], "a": [["80001.0", "2.0"]]})

    # REST snapshot with lastUpdateId = 101
    snapshot = {
        "lastUpdateId": 101,
        "bids": [["80000.0", "1.0"], ["79999.0", "5.0"]],
        "asks": [["80001.0", "3.0"], ["80002.0", "10.0"]],
    }

    # Snapshot application should succeed because U=100 <= 101+1 <= u=102
    frame0 = book.apply_snapshot(snapshot)
    assert frame0.is_snapshot is True
    assert book.is_synchronized is True
    assert book.get_top_of_book() == (80000.0, 1.5, 80001.0, 2.0)

    # Next sequential update U=106, u=108
    frame1 = book.apply_diff({"U": 106, "u": 108, "b": [["80000.0", "1.0"]], "a": []})
    assert frame1.is_duplicate is False
    assert frame1.is_regression is False
    assert frame1.bid_qty_0 == 1.0

    # Duplicate update (u <= last_applied_u = 108)
    frame_dup = book.apply_diff({"U": 107, "u": 108, "b": [], "a": []})
    assert frame_dup.is_duplicate is True

    # Gap update (U=112 > 108 + 1)
    frame_gap = book.apply_diff({"U": 112, "u": 115, "b": [], "a": []})
    assert frame_gap.is_regression is True
    assert frame_gap.gap_before == 3  # 112 - 108 - 1
    assert book.is_synchronized is False


def test_wilson_score_interval_properties():
    # 0 trials
    assert wilson_score_interval(0, 0) == (0.0, 0.0, 0.0)

    # 100 trials, 80 successes
    p, lo, hi = wilson_score_interval(80, 100)
    assert p == 0.80
    assert 0.70 < lo < 0.80
    assert 0.80 < hi < 0.90
    assert lo < p < hi

    # 100 trials, 100 successes
    p_full, lo_full, hi_full = wilson_score_interval(100, 100)
    assert p_full == 1.0
    assert hi_full == 1.0
    assert lo_full > 0.95


def test_evaluate_depletion_classifier_synthetic_fixtures():
    # Build 7 frames spaced 1000ms apart (0ms to 6000ms) creating 6 pairs:
    # Pair 0 (1000ms): Snapshot -> Frame 1 (ask drops from 10 to 6 at unchanged 100.0) -> Inferred BUY
    # Pair 1 (2000ms): Frame 1 -> Frame 2 (ask drops from 6 to 3 at unchanged 100.0) -> Inferred BUY (Cancellation, no trade)
    # Pair 2 (3000ms): Frame 2 -> Frame 3 (bid drops from 8 to 4 at unchanged 99.0) -> Inferred SELL
    # Pair 3 (4000ms): Frame 3 -> Frame 4 (bid drops from 4 to 1 at unchanged 99.0) -> Inferred SELL (Wrong side trade)
    # Pair 4 (5000ms): Frame 4 -> Frame 5 (price unchanged, qty unchanged) -> Inferred None (with silent miss)
    # Pair 5 (6000ms): Frame 5 -> Frame 6 (price unchanged, qty unchanged) -> Inferred None (True Negative, no trade)

    frames = [
        DepthFrameRow(T0, True, False, None, 99.0, 8.0, 100.0, 10.0),
        DepthFrameRow(T0 + timedelta(milliseconds=1000), False, False, None, 99.0, 8.0, 100.0, 6.0),
        DepthFrameRow(T0 + timedelta(milliseconds=2000), False, False, None, 99.0, 8.0, 100.0, 3.0),
        DepthFrameRow(T0 + timedelta(milliseconds=3000), False, False, None, 99.0, 4.0, 100.0, 3.0),
        DepthFrameRow(T0 + timedelta(milliseconds=4000), False, False, None, 99.0, 1.0, 100.0, 3.0),
        DepthFrameRow(T0 + timedelta(milliseconds=5000), False, False, None, 99.0, 1.0, 100.0, 3.0),
        DepthFrameRow(T0 + timedelta(milliseconds=6000), False, False, None, 99.0, 1.0, 100.0, 3.0),
    ]

    t0_ms = int(T0.timestamp() * 1000)

    trades = [
        # Trade 1: Taker BUY at 100.0 matching Pair 0 (t = 1000ms)
        TradeRecord("BTCUSDT", 1, 100.0, 4.0, t0_ms + 1000, is_buyer_maker=False),
        # Trade 2: Taker SELL at 99.0 matching Pair 2 (t = 3000ms)
        TradeRecord("BTCUSDT", 2, 99.0, 4.0, t0_ms + 3000, is_buyer_maker=True),
        # Trade 3: Taker BUY at 99.0 during Pair 3 (t = 4000ms) -> Wrong side trade for inferred SELL
        TradeRecord("BTCUSDT", 3, 99.0, 3.0, t0_ms + 4000, is_buyer_maker=False),
        # Trade 4: Taker SELL at 99.0 during Pair 4 (t = 5000ms) -> Touch level trade when heuristic said None
        TradeRecord("BTCUSDT", 4, 99.0, 1.0, t0_ms + 5000, is_buyer_maker=True),
    ]

    metrics = evaluate_depletion_classifier(
        frames=frames,
        trades=trades,
        symbol="BTCUSDT",
        matching_tolerance_ms=250,
        target_precision_bar=0.50,
        target_recall_bar=0.50,
    )

    # Inferred counts: 2 BUY, 2 SELL, 2 None
    assert metrics.inferred_buy_count == 2
    assert metrics.inferred_sell_count == 2
    assert metrics.inferred_none_count == 2

    # Precision breakdown:
    # BUY: 1 TP, 1 FP cancellation -> Precision = 1/2 = 0.50
    assert metrics.tp_buy == 1
    assert metrics.fp_buy_cancellation == 1
    assert metrics.precision_buy == 0.50

    # SELL: 1 TP, 1 FP wrong side -> Precision = 1/2 = 0.50
    assert metrics.tp_sell == 1
    assert metrics.fp_sell_wrong_side == 1
    assert metrics.precision_sell == 0.50

    # Pooled Precision: 2/4 = 0.50
    assert metrics.precision_pooled == 0.50

    # Silent miss count: Pair 4 had Trade 4 at touch bid 99.0 -> 1 silent miss out of 2 None -> 50%
    assert metrics.silent_miss_count == 1
    assert metrics.tn_count == 1
    assert metrics.silent_miss_rate == 0.50

    # Recall:
    # 4 evaluated trades (all within [250ms, 5750ms]).
    # Trade 1 was caught by Pair 0.
    # Trade 2 was caught by Pair 2.
    # Trade 3 was missed (Pair 3 classified SELL, not BUY).
    # Trade 4 was missed (Pair 4 classified None).
    # Caught = 2 / 4 = 0.50
    assert metrics.total_real_trades == 4
    assert metrics.caught_real_trades == 2
    assert metrics.recall == 0.50

