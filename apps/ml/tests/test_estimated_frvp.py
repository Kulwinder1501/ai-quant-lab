"""Unit tests for Phase 0 estimated FRVP + causal event codes (synthetic only)."""

from __future__ import annotations

from datetime import datetime, timezone

from ai_quant_lab_ml.estimated_fixed_range_volume_profile import (
    OhlcvBar,
    allocate_bar_volume_uniform,
    build_estimated_session_profile,
    classify_profile_events_at_decision,
    map_futures_level_to_index,
    profile_policy_lvn_ahead_v1,
)


T0 = datetime(2026, 9, 1, 3, 45, tzinfo=timezone.utc)


def test_uniform_allocation_splits_volume_across_ticks():
    parts = allocate_bar_volume_uniform(100.0, 102.0, 30.0, 1.0)
    assert parts == {100.0: 10.0, 101.0: 10.0, 102.0: 10.0}


def test_poc_and_value_area_deterministic():
    bars = [
        OhlcvBar(T0, 100, 101, 100, 100.5, 100),
        OhlcvBar(T0, 100, 100, 99, 99.5, 10),
        OhlcvBar(T0, 101, 102, 101, 101.5, 10),
    ]
    profile = build_estimated_session_profile(bars, tick_size=1.0, contract_symbol="TEST")
    assert profile is not None
    assert profile.estimation_label == "estimated_volume_profile"
    assert profile.poc == 100.0
    assert profile.val <= profile.poc <= profile.vah


def test_basis_mapping():
    assert map_futures_level_to_index(50000.0, basis=20.0) == 49980.0


def test_lvn_ahead_long_is_causal_feature_not_outcome():
    # Artificial U-shape volume: trough at 102, peaks at 100 and 104.
    bars = [
        OhlcvBar(T0, 100, 100, 100, 100, 50),
        OhlcvBar(T0, 101, 101, 101, 101, 5),
        OhlcvBar(T0, 102, 102, 102, 102, 1),
        OhlcvBar(T0, 103, 103, 103, 103, 5),
        OhlcvBar(T0, 104, 104, 104, 104, 50),
    ]
    profile = build_estimated_session_profile(bars, tick_size=1.0, contract_symbol="TEST")
    assert profile is not None
    events = classify_profile_events_at_decision(
        side="LONG",
        entry_price_index=100.0,
        profile_index=profile,
        atr_1m=2.0,
        prior_bars_index=[],
    )
    assert "LVN_AHEAD" in events
    assert profile_policy_lvn_ahead_v1(events) is True
    assert profile_policy_lvn_ahead_v1(("PROFILE_UNAVAILABLE", "LVN_AHEAD")) is False


def test_unavailable_when_atr_invalid():
    bars = [OhlcvBar(T0, 100, 100, 100, 100, 10)]
    profile = build_estimated_session_profile(bars, tick_size=1.0, contract_symbol="TEST")
    assert profile is not None
    events = classify_profile_events_at_decision(
        side="LONG", entry_price_index=100.0, profile_index=profile, atr_1m=0.0, prior_bars_index=[],
    )
    assert events == ("PROFILE_UNAVAILABLE",)
