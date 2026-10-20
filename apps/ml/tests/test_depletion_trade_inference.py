"""
Tests for ai_quant_lab_ml.depletion_trade_inference: the classification rule must only fire on
same-price depletion (never on a price move or a quantity increase), and the windowed series must
align 1:1 in timestamps with compute_windowed_ofi_series over the same frames.
"""

from datetime import datetime, timedelta, timezone

from ai_quant_lab_ml.cks_ofi_touch import DepthFrameRow, compute_windowed_ofi_series
from ai_quant_lab_ml.depletion_trade_inference import (
    DEPLETION_WINDOW_MS,
    classify_depletion_trade,
    compute_windowed_depletion_flow_series,
)

T0 = datetime(2026, 9, 30, 4, 0, 0, tzinfo=timezone.utc)


def make_frame(t_offset_ms: int, bid_p: float, bid_q: float, ask_p: float, ask_q: float,
                is_snapshot: bool = False, is_duplicate: bool = False, gap_before=None) -> DepthFrameRow:
    return DepthFrameRow(
        received_at=T0 + timedelta(milliseconds=t_offset_ms),
        is_snapshot=is_snapshot, is_duplicate=is_duplicate, gap_before=gap_before,
        bid_price_0=bid_p, bid_qty_0=bid_q, ask_price_0=ask_p, ask_qty_0=ask_q,
    )


def test_ask_depletion_at_unchanged_price_is_inferred_buy():
    prev = make_frame(0, 100.0, 50.0, 101.0, 40.0)
    curr = make_frame(100, 100.0, 50.0, 101.0, 25.0)  # ask qty dropped, price unchanged
    assert classify_depletion_trade(prev, curr) == ("BUY", 15.0)


def test_bid_depletion_at_unchanged_price_is_inferred_sell():
    prev = make_frame(0, 100.0, 50.0, 101.0, 40.0)
    curr = make_frame(100, 100.0, 30.0, 101.0, 40.0)  # bid qty dropped, price unchanged
    assert classify_depletion_trade(prev, curr) == ("SELL", 20.0)


def test_price_move_is_not_a_trade_even_if_quantity_also_changed():
    prev = make_frame(0, 100.0, 50.0, 101.0, 40.0)
    curr = make_frame(100, 100.5, 10.0, 101.0, 40.0)  # bid price moved up, not a depletion
    assert classify_depletion_trade(prev, curr) is None


def test_quantity_increase_at_unchanged_price_is_not_a_trade():
    prev = make_frame(0, 100.0, 50.0, 101.0, 40.0)
    curr = make_frame(100, 100.0, 70.0, 101.0, 40.0)  # bid qty grew: a new resting order, not a hit
    assert classify_depletion_trade(prev, curr) is None


def test_both_sides_depleting_in_one_update_is_ambiguous_and_discarded():
    prev = make_frame(0, 100.0, 50.0, 101.0, 40.0)
    curr = make_frame(100, 100.0, 30.0, 101.0, 25.0)  # both bid and ask qty dropped
    assert classify_depletion_trade(prev, curr) is None


def test_unchanged_frame_is_not_a_trade():
    prev = make_frame(0, 100.0, 50.0, 101.0, 40.0)
    curr = make_frame(100, 100.0, 50.0, 101.0, 40.0)
    assert classify_depletion_trade(prev, curr) is None


def test_windowed_series_aligns_1to1_with_ofi_series_timestamps():
    frames = [
        make_frame(0, 100.0, 50.0, 101.0, 40.0, is_snapshot=True),
        make_frame(1000, 100.0, 30.0, 101.0, 40.0),   # bid depletion -> inferred SELL
        make_frame(2000, 100.0, 30.0, 101.0, 25.0),   # ask depletion -> inferred BUY
        make_frame(3000, 100.5, 20.0, 101.0, 25.0),   # price move -> no trade, still a valid pair
    ]
    ofi_obs = compute_windowed_ofi_series(frames)
    depletion_obs = compute_windowed_depletion_flow_series(frames)
    assert [o.at for o in ofi_obs] == [o.at for o in depletion_obs]
    assert len(depletion_obs) == 3  # one per valid pair, same as OFI


def test_window_truncates_at_5000ms_matching_ofi_window():
    assert DEPLETION_WINDOW_MS == 5000
    frames = [make_frame(0, 100.0, 100.0, 101.0, 100.0, is_snapshot=True)]
    # Bid depletes by 10 every second for 7 seconds. At t=7000ms, cutoff = 7000-5000 = 2000ms;
    # t=1000's event (< 2000) is excluded, t=2000's (not < 2000) is kept -- mirrors
    # test_window_sum_truncates_at_5000ms_and_slides's own cutoff convention exactly.
    for i in range(1, 8):
        frames.append(make_frame(i * 1000, 100.0, 100.0 - i * 10.0, 101.0, 100.0))
    depletion_obs = compute_windowed_depletion_flow_series(frames)
    last = depletion_obs[-1]
    assert last.at == T0 + timedelta(milliseconds=7000)
    # Window keeps t=2000..7000 (6 events x -10 = -60), drops t=1000's.
    assert last.window_sum == -60.0
    assert last.inferred_trade_count == 6


def test_inferred_trade_count_only_counts_classified_pairs_in_window():
    frames = [
        make_frame(0, 100.0, 50.0, 101.0, 40.0, is_snapshot=True),
        make_frame(500, 100.0, 30.0, 101.0, 40.0),    # trade (SELL)
        make_frame(1000, 100.5, 10.0, 101.0, 40.0),   # price move, not a trade
        make_frame(1500, 100.5, 10.0, 101.0, 25.0),   # trade (BUY)
    ]
    depletion_obs = compute_windowed_depletion_flow_series(frames)
    assert depletion_obs[-1].inferred_trade_count == 2
