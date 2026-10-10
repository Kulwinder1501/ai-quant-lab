"""
Regression tests for the 2026-10-10 order-flow / liquidity audit fixes
(docs/2026-10-10-orderbook-liquidity-audit-fixes.md). Pure unit tests -- no database.
"""

from datetime import datetime, timedelta, timezone
import zoneinfo

import pytest

import run_cost_stack_validation as cost_stack
import run_orderbook01_experiment as experiment
import run_orderbook01_feature_select as feature_select
import run_orderbook01_oos as oos
import run_phase_c_pipeline as pipeline
import shadow_orderbook_audit as shadow_audit
from ai_quant_lab_ml.cks_ofi_touch import (
    DepthFrameRow,
    compute_windowed_ofi_series,
    contract_for_date,
    recompute_sequence_flags,
)
from ai_quant_lab_ml.orderbook_di import (
    DI_MIN_HISTORY_MINUTES,
    causal_detrend_di,
    collapse_to_level_days,
    latest_value_at_or_before,
    raw_depth_imbalance,
)

IST = zoneinfo.ZoneInfo("Asia/Kolkata")
T0 = datetime(2026, 9, 30, 4, 0, 0, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# Item 6 / 8: sequence flags, regression chain break, contract validity
# ---------------------------------------------------------------------------

def test_recompute_flags_marks_a_reset_once_and_later_frames_clean():
    # 1,2,3 then a reset to 1 WITHOUT a snapshot, then a normal continuation 2,3.
    flags = recompute_sequence_flags([(1, False), (2, False), (3, False), (1, False), (2, False), (3, False)])
    assert [f[2] for f in flags] == [False, False, False, True, False, False]  # regression only at the reset
    assert flags[4][0] == 0 and flags[5][0] == 0  # gap_before 0 = contiguous, NOT null


def test_recompute_flags_duplicate_gap_snapshot_and_missing_sequence():
    flags = recompute_sequence_flags([(10, False), (10, False), (14, False), (3, True), (None, False), (4, False)])
    assert flags[0] == (None, False, False)
    assert flags[1] == (0, True, False)          # duplicate
    assert flags[2] == (3, False, False)         # gap of 3 missing sequence numbers
    assert flags[3] == (None, False, False)      # snapshot re-bases the marker, no regression
    assert flags[4] == (None, False, False)      # unusable sequence: unchanged marker, no flag
    assert flags[5] == (0, False, False)


def _frame(ms, bid_p, bid_q, ask_p, ask_q, **kw):
    return DepthFrameRow(
        received_at=T0 + timedelta(milliseconds=ms), is_snapshot=kw.get("snap", False),
        is_duplicate=False, gap_before=None, bid_price_0=bid_p, bid_qty_0=bid_q,
        ask_price_0=ask_p, ask_qty_0=ask_q, is_regression=kw.get("reg", False),
    )


def test_regression_frame_breaks_the_ofi_chain_like_a_snapshot():
    frames = [
        _frame(0, 100.0, 50.0, 101.0, 40.0, snap=True),
        _frame(100, 100.5, 30.0, 101.0, 40.0),               # +30
        _frame(200, 100.0, 90.0, 101.0, 40.0, reg=True),     # reset: must NOT difference against the prior frame
        _frame(300, 100.5, 10.0, 101.0, 40.0),               # fresh baseline -> +10
    ]
    obs = compute_windowed_ofi_series(frames)
    assert [o.window_sum for o in obs] == [30.0, 10.0]


def test_oct_contract_ends_on_its_real_expiry_last_tuesday_of_october_2026():
    assert contract_for_date("2026-10-27") == "NSE:BANKNIFTY26OCTFUT"
    assert contract_for_date("2026-10-28") is None   # was mapped to the dead OCT contract until 2026-12-31
    assert contract_for_date("2026-12-15") is None
    # 2026-10-27 really is the last Tuesday of the month.
    d = datetime(2026, 10, 27)
    assert d.weekday() == 1 and (d + timedelta(days=7)).month == 11


# ---------------------------------------------------------------------------
# Item 2 / 5: causal DI detrending, past-only matching, level-day independence
# ---------------------------------------------------------------------------

def _minutes(n, per_minute=2):
    base = datetime(2026, 9, 30, 9, 15, tzinfo=IST)
    return [base + timedelta(minutes=m, seconds=30 * k) for m in range(n) for k in range(per_minute)]


def test_constantly_negative_di_day_is_unavailable_then_centred_not_a_constant_sign():
    times = _minutes(45)
    dis = [-0.30] * len(times)  # the real pathology: DI < 0 ALL day
    out = causal_detrend_di(times, dis)
    warmup = DI_MIN_HISTORY_MINUTES * 2
    assert all(v is None for v in out[:warmup])           # unavailable, never 0
    assert all(v == pytest.approx(0.0) for v in out[warmup:])  # a constant series carries no signal
    # raw sign would be "sell-heavy" (-0.3 < 0) at every frame; detrended it is neutral


def test_detrended_di_responds_to_a_deviation_from_the_days_own_baseline():
    times = _minutes(45)
    dis = [-0.30] * len(times)
    spike = 40 * 2  # minute 40 onward: DI rises toward balance -> +0.2 above baseline
    for i in range(spike, len(dis)):
        dis[i] = -0.10
    out = causal_detrend_di(times, dis)
    assert out[spike] == pytest.approx(0.20)  # strictly BEFORE the current minute -> baseline still -0.3


def test_detrend_never_uses_the_current_or_future_minutes():
    times = _minutes(40)
    dis = [-0.2 + 0.001 * i for i in range(len(times))]
    base = causal_detrend_di(times, dis)
    perturbed = list(dis)
    for i in range(60, len(perturbed)):
        perturbed[i] += 5.0  # change only the future
    after = causal_detrend_di(times, perturbed)
    assert base[:60] == after[:60]


def test_missing_di_is_skipped_and_not_zero_filled():
    times = _minutes(30)
    dis = [-0.3 if i % 2 == 0 else None for i in range(len(times))]
    out = causal_detrend_di(times, dis)
    assert all(out[i] is None for i in range(len(times)) if dis[i] is None)
    assert raw_depth_imbalance(None, 5.0) is None
    assert raw_depth_imbalance(0.0, 0.0) is None
    assert raw_depth_imbalance(30.0, 10.0) == pytest.approx(0.5)


def test_latest_value_is_past_only_even_when_a_future_frame_is_nearer():
    times = [T0, T0 + timedelta(seconds=4)]
    values = [0.1, 0.9]
    q = T0 + timedelta(seconds=3.9)
    assert latest_value_at_or_before(times, values, q) == (0.1, pytest.approx(3.9))
    assert latest_value_at_or_before(times, values, T0 - timedelta(seconds=1)) is None
    assert latest_value_at_or_before(times, values, T0 + timedelta(seconds=10)) is None  # 6s stale > 5s


def _event(minute, pool="SWING_HIGH", price=100.0, breached=False, day=30):
    return {
        "contact_time": datetime(2026, 9, day, 10, minute, tzinfo=IST), "pool_type": pool,
        "level_price": price, "breached": breached, "symbol": "BANKNIFTY", "timeframe": "5m",
    }


def test_collapse_keeps_the_earliest_contact_per_level_day():
    events = [_event(30), _event(10), _event(20, price=101.0), _event(15, day=29)]
    kept = collapse_to_level_days(events)
    assert len(kept) == 3
    same_level = [e for e in kept if e["level_price"] == 100.0 and e["contact_time"].day == 30]
    assert same_level[0]["contact_time"].minute == 10


def test_oos_matching_uses_negative_detrended_di_past_only_and_skips_unavailable():
    t = [datetime(2026, 9, 30, 10, 0, s, tzinfo=IST) for s in (0, 2, 4, 6)]
    raw = [-0.3, -0.3, -0.3, -0.3]
    detrended = [None, 0.2, None, -0.4]
    ev_ok = _event(0)  # contact at 10:00:00 -> frame 0 only, unavailable
    ev_ok["contact_time"] = datetime(2026, 9, 30, 10, 0, 3, tzinfo=IST)  # latest past frame: t[1], detrended 0.2
    ev_future = _event(0)
    ev_future["contact_time"] = datetime(2026, 9, 30, 9, 59, 59, tzinfo=IST)  # before every frame
    ev_unavail = _event(0, price=105.0)
    ev_unavail["contact_time"] = datetime(2026, 9, 30, 10, 0, 4, 500000, tzinfo=IST)  # t[2] has no detrended value;
    matched = oos.match_events_to_depth([ev_ok, ev_future, ev_unavail], t, raw, detrended)
    by_price = {m["level_price"]: m for m in matched}
    assert by_price[100.0]["di_tilde"] == pytest.approx(-0.2)   # di_tilde = -detrended
    assert by_price[100.0]["lag_sec"] == pytest.approx(1.0)
    assert 105.0 in by_price and by_price[105.0]["di_tilde"] == pytest.approx(-0.2)  # falls back to the last past value <= 5s
    assert len(matched) == 2                                    # the pre-frame event is dropped, never matched to a future frame


def test_oos_n_floor_is_enforced_on_distinct_level_days_and_reports_insufficient_not_falsified():
    # 400 perfectly "correct" events, but only 4 distinct level-days.
    events = []
    for lvl in range(4):
        for k in range(100):
            e = _event(k % 60, price=100.0 + lvl)
            e["di_tilde"] = 0.5
            e["breached"] = False
            events.append(e)
    assert oos.effective_independent_n(events) == 4
    res = oos.evaluate_h1_r(events, is_oos=True)
    assert res["n"] == 400 and res["n_independent_level_days"] == 4
    assert res["criteria_checks"]["n_ge_3000"] is False
    assert res["status"] == "INSUFFICIENT_DATA"
    assert oos.verdict_status(False, False) == "INSUFFICIENT_DATA"
    assert oos.verdict_status(False, True) == "FALSIFIED"
    assert oos.verdict_status(True, True) == "PASS"


def test_oos_build_day_series_keeps_missing_totals_as_none():
    frames = [
        {"received_at": datetime(2026, 9, 30, 9, 15, tzinfo=IST), "total_buy_qty": None, "total_sell_qty": 5.0},
        {"received_at": datetime(2026, 9, 30, 9, 15, 1, tzinfo=IST), "total_buy_qty": 30.0, "total_sell_qty": 10.0},
    ]
    times, raw, detrended = oos.build_day_di_series(frames)
    assert raw == [None, pytest.approx(0.5)]
    assert detrended == [None, None]  # no history yet -> unavailable


def test_experiment_nearest_frame_is_past_only_and_skips_missing_totals():
    frames = [
        (T0, 10.0, 20.0),
        (T0 + timedelta(seconds=2), None, 20.0),       # missing total: skipped, not zero
        (T0 + timedelta(seconds=4), 99.0, 1.0),        # AFTER the contact
    ]
    contact = T0 + timedelta(seconds=3.9)
    assert experiment.find_nearest_depth_frame(frames, contact) == (10.0, 20.0)
    assert experiment.find_nearest_depth_frame(frames, T0 - timedelta(seconds=0.5)) is None
    assert experiment.find_nearest_depth_frame(frames, T0 + timedelta(seconds=30)) is None


def test_sign_convention_is_di_tilde_minus_di_for_every_level_and_tier():
    for pool in ("PDH", "PDL", "SWING_HIGH", "SWING_LOW", "SESSION_HIGH", "ITL"):
        assert experiment.aligned_di_for(0.25) == -0.25
    for side, tier in (("UP", "reversal"), ("DOWN", "reversal"), ("UP", "momentum"), ("DOWN", "momentum")):
        assert feature_select.aligned(0.25, side, tier) == -0.25  # the old PDH branch returned +0.25


# ---------------------------------------------------------------------------
# Item 8: depth rows in the pipelines carry real flags and missing is not zero
# ---------------------------------------------------------------------------

def test_phase_c_depth_rows_recompute_flags_per_capture_session_and_break_at_session_start():
    def row(sec, sess, seq, snap=False, vals=(100.0, 5.0, 101.0, 6.0)):
        return (T0 + timedelta(seconds=sec), sess, seq, snap, *vals)

    rows = [
        row(0, "A", 1), row(1, "A", 2), row(2, "A", 2), row(3, "A", 6), row(4, "A", 1), row(5, "A", 2),
        row(6, "B", 500), row(7, "B", 501, vals=(100.0, None, 101.0, 6.0)),
    ]
    frames = pipeline.build_depth_frame_rows(rows)
    assert frames[0].is_snapshot is True                 # session start = chain break
    assert frames[2].is_duplicate is True
    assert frames[3].gap_before == 3
    assert frames[4].is_regression is True and frames[5].is_regression is False
    assert frames[5].gap_before == 0
    assert frames[6].is_snapshot is True                 # new capture session: sequence numbers unrelated
    # NULL qty => whole touch zeroed => "not comparable", never a real zero-size queue
    assert (frames[7].bid_price_0, frames[7].bid_qty_0, frames[7].ask_price_0, frames[7].ask_qty_0) == (0.0,) * 4


def test_cost_stack_frames_carry_real_flags_and_do_not_bridge_dropped_frames():
    def raw(sec, seq, valid=True, snap=False):
        recv = datetime(2026, 9, 30, 10, 0, sec, tzinfo=IST)
        event_ts = recv.timestamp() - 1 if valid else recv.timestamp() + 100  # invalid = event after receipt
        return (recv, 100.0, 90.0, event_ts, None, [100.0], [5.0], [101.0], [6.0],
                "NSE:BANKNIFTY26SEPFUT", "sess", seq, snap)

    rows = [raw(0, 10, snap=True), raw(1, 11), raw(2, 12, valid=False), raw(3, 13), raw(4, 13), raw(5, 3)]
    frames = cost_stack.build_frames_by_symbol(rows)["NSE:BANKNIFTY26SEPFUT"]
    assert len(frames) == 5                                   # the invalid-timestamp frame is dropped
    assert frames[0].is_snapshot is True
    assert frames[2].gap_before == 1                          # 13 follows dropped 12: not bridged
    assert frames[3].is_duplicate is True
    assert frames[4].is_regression is True


# ---------------------------------------------------------------------------
# Item 10: shadow audit net-protection
# ---------------------------------------------------------------------------

def test_net_protection_is_minus_the_blocked_pnl_and_never_a_fake_zero():
    rows = [("ALLOWED", 10, 6, 1.0, 10.0), ("BLOCKED", 4, 1, -2.0, -8.0)]
    line = shadow_audit.format_net_protection_line(rows)
    assert "+8.00" in line and "counterfactual" in line
    assert "not computable" in shadow_audit.format_net_protection_line([("ALLOWED", 10, 6, 1.0, 10.0)])
    assert "not computable" in shadow_audit.format_net_protection_line([("BLOCKED", 0, 0, None, None)])
