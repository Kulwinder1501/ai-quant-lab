"""Parity-style checks for the Python frvp-rows48-v2 port."""

from __future__ import annotations

from ai_quant_lab_ml.fixed_row_volume_profile import (
    VOLUME_PROFILE_ROWS,
    ProfileBar,
    build_fixed_row_volume_profile,
)
from ai_quant_lab_ml.ofvp_baseline_events import (
    COST_FLOOR_BPS,
    TimedBar,
    label_session_probes,
    points_to_bps,
    summarize_cost_floor,
)
from datetime import datetime, timezone


def _bar(low: float, high: float, volume: float) -> ProfileBar:
    return ProfileBar(low=low, high=high, close=(low + high) / 2, volume=volume)


def _two_zone_bars() -> list[ProfileBar]:
    bars: list[ProfileBar] = []
    for _ in range(10):
        bars.append(_bar(100, 110, 1000))
    for _ in range(10):
        bars.append(_bar(130, 140, 1000))
    bars.append(_bar(110, 130, 100))
    return bars


def test_volume_is_conserved():
    bars = [_bar(100, 112.3, 500), _bar(101, 120, 800), _bar(99.5, 103, 250), _bar(110, 110, 40)]
    profile = build_fixed_row_volume_profile(bars)
    assert profile is not None
    assert len(profile.row_volumes) == VOLUME_PROFILE_ROWS
    assert abs(sum(profile.row_volumes) - 1590) < 1e-6
    assert profile.total_volume == 1590


def test_zero_range_bar_does_not_steal_poc():
    bars: list[ProfileBar] = []
    for i in range(50):
        bars.append(_bar(55_000 + i, 55_030 + i, 100))
    bars.append(_bar(54_950, 54_950, 180))
    profile = build_fixed_row_volume_profile(bars)
    assert profile is not None
    assert profile.poc > 55_000


def test_value_area_contains_poc_and_covers_70pct():
    profile = build_fixed_row_volume_profile(_two_zone_bars())
    assert profile is not None
    inside = 0.0
    for row, vol in enumerate(profile.row_volumes):
        bottom = profile.low + row * profile.row_width
        if bottom >= profile.val - 1e-9 and bottom + profile.row_width <= profile.vah + 1e-9:
            inside += vol
    assert inside / profile.total_volume >= 0.7 - 1e-9
    assert profile.val <= profile.poc <= profile.vah


def test_lvn_between_two_zones():
    profile = build_fixed_row_volume_profile(_two_zone_bars())
    assert profile is not None
    assert len(profile.lvns) == 1
    assert 115 < profile.lvns[0] < 125


def test_failed_auction_and_hold_outside_labels():
    # Prior: volume concentrated near 100, thin tails to 80/120 so VAH/VAL sit near mid.
    prior_clean: list[TimedBar] = []
    t0 = datetime(2026, 10, 1, 3, 45, tzinfo=timezone.utc)
    for i in range(320):
        prior_clean.append(
            TimedBar(t0.replace(minute=(i % 60), hour=3 + i // 60), 102, 98, 100, 200)
        )
    for _ in range(20):
        prior_clean.append(TimedBar(t0.replace(minute=0, hour=9), 120, 80, 100, 10))

    today: list[TimedBar] = []
    base = datetime(2026, 10, 2, 4, 0, tzinfo=timezone.utc)
    for i in range(5):
        today.append(TimedBar(base.replace(minute=i), 101, 99, 100, 50))
    for i in range(5, 12):
        today.append(TimedBar(base.replace(minute=i), 130, 125, 128, 50))
    for i in range(12, 18):
        today.append(TimedBar(base.replace(minute=i), 101, 99, 100, 50))
    for i in range(18, 45):
        today.append(TimedBar(base.replace(minute=i % 60, hour=4 + i // 60), 135, 130, 132, 50))

    events = label_session_probes(
        underlying="BANKNIFTY",
        session_date="2026-10-02",
        prior_session_date="2026-10-01",
        contract="TEST",
        prior_bars=prior_clean,
        today_bars=today,
    )
    assert any(e.outcome == "RETURNED" for e in events)
    assert any(e.outcome == "HELD_OUTSIDE" for e in events)


def test_cost_floor_rejects_tiny_targets():
    from ai_quant_lab_ml.ofvp_baseline_events import ProbeEvent

    tiny = ProbeEvent(
        underlying="BANKNIFTY",
        session_date="2026-10-02",
        prior_session_date="2026-10-01",
        contract="X",
        side="ABOVE",
        probe_time="t",
        probe_close=55000,
        boundary=54990,
        poc=54995,
        vah=54990,
        val=54900,
        row_width=5,
        buffer_points=5,
        outcome="RETURNED",
        return_or_hold_time="t2",
        minutes_to_outcome=5,
        h1_target_points=5.0,
        h1_target_bps=points_to_bps(5.0, 55000),
        h2_target_points=5.0,
        h2_target_bps=points_to_bps(5.0, 55000),
        h2_target_kind="nearest_hvn_outside",
        excursion_beyond_boundary_points=10,
        mid_price=55000,
    )
    summary = summarize_cost_floor([tiny])
    assert tiny.h1_target_bps < COST_FLOOR_BPS
    assert summary["h1_cost_floor"] == "REJECT_UNECONOMIC"
