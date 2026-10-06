"""
Unit tests for the real CKS touch-level OFI port (cks_ofi_touch.py), hand-checked against
the same per-level arithmetic as the validated TypeScript implementation
(order-flow-imbalance.ts).
"""

from datetime import datetime, timedelta, timezone

from ai_quant_lab_ml.cks_ofi_touch import (
    DepthFrameRow,
    OfiWindowObservation,
    _touch_level_delta,
    compute_mid_price_candles,
    compute_windowed_ofi_series,
    contract_for_date,
    join_nearest_prior,
)

T0 = datetime(2026, 9, 30, 4, 0, 0, tzinfo=timezone.utc)


def make_frame(t_offset_ms: int, bid_p: float, bid_q: float, ask_p: float, ask_q: float,
                is_snapshot: bool = False, is_duplicate: bool = False, gap_before=None) -> DepthFrameRow:
    return DepthFrameRow(
        received_at=T0 + timedelta(milliseconds=t_offset_ms),
        is_snapshot=is_snapshot, is_duplicate=is_duplicate, gap_before=gap_before,
        bid_price_0=bid_p, bid_qty_0=bid_q, ask_price_0=ask_p, ask_qty_0=ask_q,
    )


def test_touch_delta_bid_tick_up_adds_full_new_size():
    prev = make_frame(0, 100.0, 50.0, 101.0, 40.0)
    curr = make_frame(100, 100.5, 30.0, 101.0, 40.0)  # bid ticked up
    assert _touch_level_delta(prev, curr) == 30.0  # bidFlow=+30 (new size), askFlow=0 (unchanged)


def test_touch_delta_bid_tick_down_removes_old_size():
    prev = make_frame(0, 100.0, 50.0, 101.0, 40.0)
    curr = make_frame(100, 99.5, 30.0, 101.0, 40.0)  # bid ticked down
    assert _touch_level_delta(prev, curr) == -50.0  # bidFlow=-50 (old size removed)


def test_touch_delta_bid_same_price_is_size_change():
    prev = make_frame(0, 100.0, 50.0, 101.0, 40.0)
    curr = make_frame(100, 100.0, 70.0, 101.0, 40.0)  # size grew at same price
    assert _touch_level_delta(prev, curr) == 20.0


def test_touch_delta_ask_tick_down_is_negative_full_new_size():
    prev = make_frame(0, 100.0, 50.0, 101.0, 40.0)
    curr = make_frame(100, 100.0, 50.0, 100.5, 25.0)  # ask ticked down (more aggressive buying)
    assert _touch_level_delta(prev, curr) == -25.0


def test_touch_delta_ask_tick_up_is_positive_prior_size():
    prev = make_frame(0, 100.0, 50.0, 101.0, 40.0)
    curr = make_frame(100, 100.0, 50.0, 101.5, 15.0)  # ask ticked up (sellers back away)
    assert _touch_level_delta(prev, curr) == 40.0


def test_touch_delta_combined_bid_and_ask_move():
    prev = make_frame(0, 100.0, 50.0, 101.0, 40.0)
    curr = make_frame(100, 100.5, 30.0, 101.0, 20.0)  # bid up (+30), ask same size shrank (+20)
    assert _touch_level_delta(prev, curr) == 50.0


def test_touch_delta_zero_or_missing_price_is_not_comparable():
    prev = make_frame(0, 0.0, 50.0, 101.0, 40.0)
    curr = make_frame(100, 100.5, 30.0, 101.0, 40.0)
    assert _touch_level_delta(prev, curr) is None


def test_snapshot_duplicate_and_gap_each_break_the_chain():
    frames = [
        make_frame(0, 100.0, 50.0, 101.0, 40.0, is_snapshot=True),   # opens segment 1 (no obs)
        make_frame(100, 100.5, 30.0, 101.0, 40.0),                   # obs: +30
        make_frame(200, 100.5, 30.0, 101.0, 40.0, is_duplicate=True),  # duplicate: skipped
        make_frame(300, 100.0, 50.0, 101.0, 40.0, gap_before=3),     # gap: breaks -> opens segment 2
        make_frame(400, 100.5, 10.0, 101.0, 40.0),                   # obs: +10 (fresh baseline)
    ]
    obs = compute_windowed_ofi_series(frames)
    # 2 observations total: one from segment 1 (before the gap), one from segment 2 (after it).
    assert len(obs) == 2
    assert obs[0].window_sum == 30.0
    assert obs[1].window_sum == 10.0  # fresh segment -- does not inherit the +30 from segment 1


def test_window_sum_truncates_at_5000ms_and_slides():
    frames = [make_frame(0, 100.0, 50.0, 103.0, 40.0, is_snapshot=True)]
    # Four bid-ticks-up 2000ms apart, ask side held constant throughout so only the bid side
    # contributes: each delta is +qty (the full new bid size).
    prices = [(100.5, 10.0), (101.0, 10.0), (101.5, 10.0), (102.0, 10.0)]
    for i, (new_bid, qty) in enumerate(prices):
        frames.append(make_frame((i + 1) * 2000, new_bid, qty, 103.0, 40.0))
    obs = compute_windowed_ofi_series(frames)
    # Each tick-up delta is +qty (10.0). At t=2000ms: window [−3000,2000] sees just this one delta.
    assert obs[0].window_sum == 10.0
    # At t=4000ms: window [−1000,4000] still sees both deltas (2000ms apart, window=5000ms).
    assert obs[1].window_sum == 20.0
    # At t=6000ms: window [1000,6000] now drops the delta at t=0... wait there is none at t=0
    # (snapshot contributes no observation); it drops nothing extra here since deltas are at
    # 2000/4000/6000 and window reaches back to 1000, so all three are still in range.
    assert obs[2].window_sum == 30.0
    # At t=8000ms: window [3000,8000] drops the delta at t=2000 (outside), keeps 4000/6000/8000.
    assert obs[3].window_sum == 30.0


def test_contract_for_date_never_blends_a_roll():
    assert contract_for_date("2026-08-23") == "NSE:BANKNIFTY26AUGFUT"
    assert contract_for_date("2026-09-15") == "NSE:BANKNIFTY26SEPFUT"
    assert contract_for_date("2026-10-01") == "NSE:BANKNIFTY26OCTFUT"
    assert contract_for_date("2026-08-26") is None  # the one-day gap between Aug and Sep contracts


def test_mid_price_candles_bucket_ohlc_and_skip_empty_buckets():
    """
    Regression test for the spot/futures basis fix: Fibonacci zones for BANKNIFTY_FUT are now
    computed from this bucketed mid-price series (the same book OFI reads), instead of the
    cash index. Verifies real OHLC extraction within a bucket, and that a bucket with zero
    captured frames is skipped entirely rather than interpolated/forward-filled as a flat
    candle -- real captured depth has exactly this kind of intraday gap.
    """
    frames = [
        make_frame(0, 100.0, 1.0, 102.0, 1.0),        # t=4:00:00, mid=101 (bucket 1 open)
        make_frame(60_000, 102.0, 1.0, 104.0, 1.0),   # t=4:01:00, mid=103 (bucket 1 high)
        make_frame(120_000, 98.0, 1.0, 100.0, 1.0),   # t=4:02:00, mid=99  (bucket 1 low)
        make_frame(240_000, 101.0, 1.0, 103.0, 1.0),  # t=4:04:00, mid=102 (bucket 1 close)
        make_frame(300_000, 110.0, 1.0, 112.0, 1.0),  # t=4:05:00, mid=111 (bucket 2, sole frame)
        # bucket [4:10, 4:15) has zero frames -- a real capture gap.
        make_frame(900_000, 90.0, 1.0, 92.0, 1.0),    # t=4:15:00, mid=91 (bucket 4, sole frame)
    ]
    candles = compute_mid_price_candles(frames, timeframe_minutes=5)

    assert [c.close_time for c in candles] == [
        T0 + timedelta(minutes=5), T0 + timedelta(minutes=10), T0 + timedelta(minutes=20),
    ]
    bucket1 = candles[0]
    assert (bucket1.open, bucket1.high, bucket1.low, bucket1.close) == (101.0, 103.0, 99.0, 102.0)
    bucket2 = candles[1]
    assert (bucket2.open, bucket2.high, bucket2.low, bucket2.close) == (111.0, 111.0, 111.0, 111.0)


def test_mid_price_candles_excludes_crossed_or_one_sided_book():
    frames = [
        make_frame(0, 100.0, 1.0, 102.0, 1.0),   # mid=101, valid
        make_frame(60_000, 0.0, 1.0, 102.0, 1.0),  # bid<=0 -> excluded
        make_frame(120_000, 100.0, 1.0, 0.0, 1.0),  # ask<=0 -> excluded
    ]
    candles = compute_mid_price_candles(frames, timeframe_minutes=5)
    assert len(candles) == 1
    assert (candles[0].open, candles[0].high, candles[0].low, candles[0].close) == (101.0, 101.0, 101.0, 101.0)


def test_join_nearest_prior_respects_staleness_and_no_lookahead():
    obs = [
        OfiWindowObservation(at=T0, window_sum=5.0),
        OfiWindowObservation(at=T0 + timedelta(seconds=10), window_sum=-3.0),
    ]
    targets = [
        T0 - timedelta(seconds=1),               # before any observation -> None
        T0 + timedelta(seconds=5),                # 5s stale from first obs -> within 60s tolerance
        T0 + timedelta(seconds=10, milliseconds=1),  # just after the 2nd obs -> that one, not future
        T0 + timedelta(seconds=200),               # 190s stale from 2nd obs -> too stale
    ]
    results = join_nearest_prior(obs, targets, max_staleness_seconds=60.0)
    assert results == [None, 5.0, -3.0, None]
