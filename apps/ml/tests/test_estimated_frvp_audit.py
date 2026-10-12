"""Code-level audit fixtures for FRVP allocator / LVN detector / LVN_AHEAD predicate.

Does not retune frozen thresholds. Normative:
docs/2026-10-12-frvp-momentum-scalp-phase0-preregistration.md
"""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone

import pytest

from ai_quant_lab_ml.estimated_fixed_range_volume_profile import (
    HVN_LVN_PROMINENCE_FRAC_OF_POC,
    LVN_AHEAD_MAX_ATR_FRAC,
    LVN_AHEAD_MAX_TICKS_FLOOR,
    OhlcvBar,
    allocate_bar_volume_uniform,
    build_estimated_session_profile,
    classify_profile_events_at_decision,
    map_futures_level_to_index,
    profile_policy_lvn_ahead_v1,
)

T0 = datetime(2026, 9, 1, 3, 45, tzinfo=timezone.utc)


def test_allocation_conserves_volume_exactly():
    parts = allocate_bar_volume_uniform(100.05, 100.25, 10_000.0, 0.05)
    assert abs(sum(parts.values()) - 10_000.0) < 1e-9
    # Inclusive tick bins: 100.05, 100.10, 100.15, 100.20, 100.25 → 5 bins.
    assert len(parts) == 5
    assert all(abs(v - 2000.0) < 1e-9 for v in parts.values())


def test_allocation_does_not_duplicate_volume_per_bin():
    """Invariant mentor named: must NOT add full bar volume into each overlapping bin."""
    parts = allocate_bar_volume_uniform(100.0, 101.0, 100.0, 1.0)
    assert sum(parts.values()) == pytest.approx(100.0)
    assert max(parts.values()) < 100.0  # split, not copied


def test_session_profile_conserves_input_volume():
    bars = [
        OhlcvBar(T0, 100, 102, 100, 101, 10_000),
        OhlcvBar(T0, 101, 103, 101, 102, 3_000),
        OhlcvBar(T0, 99, 100, 99, 99.5, 0),  # skipped
    ]
    profile = build_estimated_session_profile(bars, tick_size=1.0, contract_symbol="TEST")
    assert profile is not None
    assert profile.total_volume == pytest.approx(13_000.0)
    assert sum(profile.bin_volumes) == pytest.approx(13_000.0)


def test_value_area_expands_from_poc_to_70_percent():
    # Heavy center at 100, light wings — VA should include enough bins to reach ≥70%.
    bars = [
        OhlcvBar(T0, 100, 100, 100, 100, 700),
        OhlcvBar(T0, 99, 99, 99, 99, 100),
        OhlcvBar(T0, 101, 101, 101, 101, 100),
        OhlcvBar(T0, 98, 98, 98, 98, 50),
        OhlcvBar(T0, 102, 102, 102, 102, 50),
    ]
    profile = build_estimated_session_profile(bars, tick_size=1.0, contract_symbol="TEST")
    assert profile is not None
    assert profile.poc == 100.0
    included = [
        v
        for p, v in zip(profile.bin_prices, profile.bin_volumes)
        if profile.val <= p <= profile.vah
    ]
    assert sum(included) >= 0.70 * profile.total_volume


def test_lvn_detector_finds_trough_in_two_peak_profile():
    bars = [
        OhlcvBar(T0, 100, 100, 100, 100, 100),
        OhlcvBar(T0, 101, 101, 101, 101, 10),
        OhlcvBar(T0, 102, 102, 102, 102, 1),
        OhlcvBar(T0, 103, 103, 103, 103, 10),
        OhlcvBar(T0, 104, 104, 104, 104, 100),
    ]
    profile = build_estimated_session_profile(bars, tick_size=1.0, contract_symbol="TEST")
    assert profile is not None
    assert 102.0 in profile.lvns
    assert 100.0 in profile.hvns or 104.0 in profile.hvns


def test_lvn_detector_rejects_unimodal_and_monotonic():
    unimodal = [
        OhlcvBar(T0, 100, 100, 100, 100, 10),
        OhlcvBar(T0, 101, 101, 101, 101, 50),
        OhlcvBar(T0, 102, 102, 102, 102, 10),
    ]
    mono = [
        OhlcvBar(T0, 100, 100, 100, 100, 10),
        OhlcvBar(T0, 101, 101, 101, 101, 20),
        OhlcvBar(T0, 102, 102, 102, 102, 30),
        OhlcvBar(T0, 103, 103, 103, 103, 40),
    ]
    p1 = build_estimated_session_profile(unimodal, tick_size=1.0, contract_symbol="U")
    p2 = build_estimated_session_profile(mono, tick_size=1.0, contract_symbol="M")
    assert p1 is not None and p2 is not None
    # Unimodal: troughs at edges use neighbor=self so prominence 0 → no LVN.
    assert p1.lvns == ()
    assert p2.lvns == ()


def test_lvn_detector_rejects_shallow_trough_below_prominence():
    poc_vol = 100.0
    shallow = poc_vol * HVN_LVN_PROMINENCE_FRAC_OF_POC * 0.5  # half of required dip
    bars = [
        OhlcvBar(T0, 100, 100, 100, 100, poc_vol),
        OhlcvBar(T0, 101, 101, 101, 101, poc_vol - shallow),
        OhlcvBar(T0, 102, 102, 102, 102, poc_vol),
    ]
    profile = build_estimated_session_profile(bars, tick_size=1.0, contract_symbol="SHALLOW")
    assert profile is not None
    assert profile.lvns == ()


def test_lvn_ahead_predicate_long_and_short_and_behind():
    bars = [
        OhlcvBar(T0, 100, 100, 100, 100, 50),
        OhlcvBar(T0, 101, 101, 101, 101, 5),
        OhlcvBar(T0, 102, 102, 102, 102, 1),
        OhlcvBar(T0, 103, 103, 103, 103, 5),
        OhlcvBar(T0, 104, 104, 104, 104, 50),
    ]
    profile = build_estimated_session_profile(bars, tick_size=1.0, contract_symbol="TEST")
    assert profile is not None
    atr = 8.0  # ahead_max = max(8, 0.25*8)=8 → window covers 102 from 100
    long_ok = classify_profile_events_at_decision(
        side="LONG", entry_price_index=100.0, profile_index=profile, atr_1m=atr, prior_bars_index=[],
    )
    assert "LVN_AHEAD" in long_ok
    short_ok = classify_profile_events_at_decision(
        side="SHORT", entry_price_index=104.0, profile_index=profile, atr_1m=atr, prior_bars_index=[],
    )
    assert "LVN_AHEAD" in short_ok
    # LVN is behind LONG entry at 104 → must not fire.
    long_behind = classify_profile_events_at_decision(
        side="LONG", entry_price_index=104.0, profile_index=profile, atr_1m=atr, prior_bars_index=[],
    )
    assert "LVN_AHEAD" not in long_behind


def test_lvn_ahead_blocked_by_intervening_hvn():
    # Strictly declining from POC@100 into secondary HVN@104, then deep trough@105.
    # Only qualifying LVN ahead of 100 is 105; HVN 104 blocks the corridor.
    bars = [
        OhlcvBar(T0, 100, 100, 100, 100, 100),
        OhlcvBar(T0, 101, 101, 101, 101, 90),
        OhlcvBar(T0, 102, 102, 102, 102, 85),
        OhlcvBar(T0, 103, 103, 103, 103, 82),
        OhlcvBar(T0, 104, 104, 104, 104, 95),
        OhlcvBar(T0, 105, 105, 105, 105, 1),
        OhlcvBar(T0, 106, 106, 106, 106, 40),
    ]
    profile = build_estimated_session_profile(bars, tick_size=1.0, contract_symbol="BLOCK")
    assert profile is not None
    assert profile.poc == 100.0
    assert profile.lvns == (105.0,)
    assert 104.0 in profile.hvns
    events = classify_profile_events_at_decision(
        side="LONG", entry_price_index=100.0, profile_index=profile, atr_1m=20.0, prior_bars_index=[],
    )
    assert "LVN_AHEAD" not in events


def test_lvn_ahead_outside_distance_window_rejected():
    bars = [
        OhlcvBar(T0, 100, 100, 100, 100, 50),
        OhlcvBar(T0, 110, 110, 110, 110, 1),
        OhlcvBar(T0, 120, 120, 120, 120, 50),
    ]
    profile = build_estimated_session_profile(bars, tick_size=1.0, contract_symbol="FAR")
    assert profile is not None
    atr = 4.0
    ahead_max = max(LVN_AHEAD_MAX_TICKS_FLOOR * 1.0, LVN_AHEAD_MAX_ATR_FRAC * atr)
    assert ahead_max < 10  # LVN at 110 is beyond window from 100
    events = classify_profile_events_at_decision(
        side="LONG", entry_price_index=100.0, profile_index=profile, atr_1m=atr, prior_bars_index=[],
    )
    assert "LVN_AHEAD" not in events


def test_basis_mapping_convention_and_round_trip():
    fut_level = 25_000.0
    basis = 42.5
    idx = map_futures_level_to_index(fut_level, basis)
    assert idx == pytest.approx(fut_level - basis)
    # Comparing index entry to mapped level ≡ comparing futures-equivalent to fut level.
    index_entry = 24_950.0
    fut_equivalent = index_entry + basis
    assert abs(index_entry - idx) == pytest.approx(abs(fut_equivalent - fut_level))


def test_mapped_profile_preserves_relative_geometry():
    bars = [
        OhlcvBar(T0, 100, 100, 100, 100, 50),
        OhlcvBar(T0, 102, 102, 102, 102, 1),
        OhlcvBar(T0, 104, 104, 104, 104, 50),
    ]
    profile = build_estimated_session_profile(bars, tick_size=1.0, contract_symbol="MAP")
    assert profile is not None
    basis = 10.0
    mapped = replace(
        profile,
        poc=map_futures_level_to_index(profile.poc, basis),
        vah=map_futures_level_to_index(profile.vah, basis),
        val=map_futures_level_to_index(profile.val, basis),
        hvns=tuple(map_futures_level_to_index(x, basis) for x in profile.hvns),
        lvns=tuple(map_futures_level_to_index(x, basis) for x in profile.lvns),
        session_vwap=map_futures_level_to_index(profile.session_vwap, basis),
    )
    events = classify_profile_events_at_decision(
        side="LONG",
        entry_price_index=90.0,  # 100 fut - 10 basis
        profile_index=mapped,
        atr_1m=8.0,
        prior_bars_index=[],
    )
    assert "LVN_AHEAD" in events
    assert profile_policy_lvn_ahead_v1(events) is True
