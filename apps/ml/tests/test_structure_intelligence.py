"""Unit tests for STRUCTURE-01 Structure Intelligence module."""

from datetime import datetime, date, time, timezone
import zoneinfo
import numpy as np
import pytest

from ai_quant_lab_ml import structure_intelligence
from ai_quant_lab_ml.structure_intelligence import (
    StructuralLevel,
    ProximityEvent,
    CalibrationSummary,
    compute_daily_levels,
    compute_4h_levels_from_5m,
    build_active_levels,
    compute_confluence_merge_stats,
    run_calibration_experiment,
    DEFAULT_CONFLUENCE_TOLERANCE_PCT,
)

INDIA_TZ = zoneinfo.ZoneInfo("Asia/Kolkata")


def test_compute_daily_levels_non_leakage():
    daily_candles = [
        {
            "open_time": datetime(2026, 1, 1, 3, 45, tzinfo=timezone.utc),
            "close_time": datetime(2026, 1, 1, 10, 0, tzinfo=timezone.utc),
            "high": 48500.0,
            "low": 48000.0,
        },
        {
            "open_time": datetime(2026, 1, 2, 3, 45, tzinfo=timezone.utc),
            "close_time": datetime(2026, 1, 2, 10, 0, tzinfo=timezone.utc),
            "high": 48700.0,
            "low": 48200.0,
        },
    ]
    levels = compute_daily_levels(daily_candles)
    assert date(2026, 1, 2) in levels
    assert levels[date(2026, 1, 2)]["PDH"] == 48500.0
    assert levels[date(2026, 1, 2)]["PDL"] == 48000.0


def test_compute_4h_levels_afternoon_block():
    bars_5m = [
        # Session Jan 1 - Morning
        {
            "open_time": datetime(2026, 1, 1, 3, 45, tzinfo=timezone.utc),  # 09:15 IST
            "high": 48100.0,
            "low": 48000.0,
        },
        # Session Jan 1 - Afternoon
        {
            "open_time": datetime(2026, 1, 1, 7, 45, tzinfo=timezone.utc),  # 13:15 IST
            "high": 48600.0,
            "low": 48150.0,
        },
        # Session Jan 2 - Morning
        {
            "open_time": datetime(2026, 1, 2, 3, 45, tzinfo=timezone.utc),  # 09:15 IST
            "high": 48700.0,
            "low": 48500.0,
        },
    ]

    levels_4h = compute_4h_levels_from_5m(bars_5m)
    assert date(2026, 1, 2) in levels_4h
    # Prior afternoon block (13:15 IST) had high 48600.0 and low 48150.0
    assert levels_4h[date(2026, 1, 2)]["P4HH"] == 48600.0
    assert levels_4h[date(2026, 1, 2)]["P4HL"] == 48150.0


# --- Confluence-merge tolerance (0.0005 default, swept in
# docs/2026-10-05-confluence-tolerance-calibration.md) ---


def test_build_active_levels_merges_within_tolerance():
    """PDH and P4HH within the tolerance band merge into CONFLUENCE_HIGH,
    not two separate PDH/P4HH levels."""
    s_date = date(2026, 1, 2)
    # 48500 and 48520 are ~0.041% apart -- inside the default 0.05% tolerance.
    levels = build_active_levels(
        pdh=48500.0, p4hh=48520.0, pdl=None, p4hl=None,
        session_date=s_date, confluence_tolerance_pct=DEFAULT_CONFLUENCE_TOLERANCE_PCT,
    )
    level_types = {lvl.level_type for lvl in levels}
    assert level_types == {"CONFLUENCE_HIGH"}
    merged = next(lvl for lvl in levels if lvl.level_type == "CONFLUENCE_HIGH")
    assert merged.price == pytest.approx((48500.0 + 48520.0) / 2.0)


def test_build_active_levels_isolated_outside_tolerance():
    """PDH and P4HH further apart than the tolerance stay as two isolated
    levels rather than merging."""
    s_date = date(2026, 1, 2)
    # 48500 and 49500 are ~2.06% apart -- well outside any tested tolerance.
    levels = build_active_levels(
        pdh=48500.0, p4hh=49500.0, pdl=None, p4hl=None,
        session_date=s_date, confluence_tolerance_pct=DEFAULT_CONFLUENCE_TOLERANCE_PCT,
    )
    level_types = {lvl.level_type for lvl in levels}
    assert level_types == {"PDH", "P4HH"}


def test_build_active_levels_tolerance_is_the_switch():
    """The same pair of prices merges at a looser tolerance and stays
    isolated at a tighter one -- proving the parameter actually controls the
    merge decision (not just accepted and ignored)."""
    s_date = date(2026, 1, 2)
    pdh, p4hh = 48500.0, 48550.0  # ~0.103% apart

    tight = build_active_levels(pdh, p4hh, None, None, s_date, confluence_tolerance_pct=0.0005)
    loose = build_active_levels(pdh, p4hh, None, None, s_date, confluence_tolerance_pct=0.0020)

    assert {lvl.level_type for lvl in tight} == {"PDH", "P4HH"}
    assert {lvl.level_type for lvl in loose} == {"CONFLUENCE_HIGH"}


def test_build_active_levels_handles_low_side_and_missing_levels():
    s_date = date(2026, 1, 2)
    # Only PDL present (no P4HL) -- must appear isolated, never merged.
    levels = build_active_levels(
        pdh=None, p4hh=None, pdl=48000.0, p4hl=None,
        session_date=s_date, confluence_tolerance_pct=DEFAULT_CONFLUENCE_TOLERANCE_PCT,
    )
    assert {lvl.level_type for lvl in levels} == {"PDL"}


def test_compute_confluence_merge_stats_counts_sessions_not_events():
    daily_levels = {
        date(2026, 1, 2): {"PDH": 48500.0, "PDL": 48000.0},
        date(2026, 1, 3): {"PDH": 48500.0, "PDL": 48000.0},
        date(2026, 1, 4): {"PDH": 48500.0},  # PDL missing -- excluded from low pair count
    }
    levels_4h = {
        date(2026, 1, 2): {"P4HH": 48520.0, "P4HL": 50000.0},  # high merges, low isolated
        date(2026, 1, 3): {"P4HH": 49500.0, "P4HL": 48010.0},  # high isolated, low merges
        date(2026, 1, 4): {"P4HH": 48510.0},
    }
    stats = compute_confluence_merge_stats(daily_levels, levels_4h, confluence_tolerance_pct=0.0005)
    assert stats == {"high_merged": 2, "high_isolated": 1, "low_merged": 1, "low_isolated": 1}


def test_run_calibration_experiment_tolerance_changes_level_types(monkeypatch):
    """End-to-end: confluence_tolerance_pct threaded into run_calibration_experiment
    actually changes which level_type proximity events get recorded under --
    not just build_active_levels in isolation.

    PDH (48500.0) and P4HH (48510.0) are ~0.0206% apart: isolated at the
    0.02% grid point, merged at the 0.05% grid point and above. PDL/P4HL are
    set far apart (~1%) so they stay isolated and silent at every tested
    tolerance, isolating the test to the high-side merge decision.
    """
    daily_candles = [
        {"open_time": datetime(2026, 1, 1, 3, 45, tzinfo=timezone.utc), "high": 48500.0, "low": 48000.0},
        {"open_time": datetime(2026, 1, 2, 3, 45, tzinfo=timezone.utc), "high": 48600.0, "low": 48100.0},
    ]
    bars_5m = [
        # Prior session's afternoon 4H block (13:15 IST = 07:45 UTC): P4HH=48510, P4HL=47500.
        {"open_time": datetime(2026, 1, 1, 7, 45, tzinfo=timezone.utc),
         "open": 48000.0, "high": 48510.0, "low": 47500.0, "close": 48000.0},
        # Test session bar: straddles PDH (48500) and sits within 15bps of P4HH (48510).
        {"open_time": datetime(2026, 1, 2, 4, 0, tzinfo=timezone.utc),
         "open": 48500.0, "high": 48505.0, "low": 48498.0, "close": 48500.0},
        # Forward-window filler bars (forward_window_bars=3 needs these to exist).
        {"open_time": datetime(2026, 1, 2, 4, 5, tzinfo=timezone.utc),
         "open": 48500.0, "high": 48503.0, "low": 48499.0, "close": 48502.0},
        {"open_time": datetime(2026, 1, 2, 4, 10, tzinfo=timezone.utc),
         "open": 48502.0, "high": 48504.0, "low": 48500.0, "close": 48503.0},
        {"open_time": datetime(2026, 1, 2, 4, 15, tzinfo=timezone.utc),
         "open": 48503.0, "high": 48506.0, "low": 48501.0, "close": 48504.0},
    ]

    def fake_fetch_candles(symbol, timeframe="5m", start_dt=None, end_dt=None):
        return daily_candles if timeframe == "1d" else bars_5m

    monkeypatch.setattr(structure_intelligence, "fetch_candles", fake_fetch_candles)

    isolated_summary = run_calibration_experiment(
        symbol="TEST", start_date=date(2026, 1, 2), end_date=date(2026, 1, 2),
        confluence_tolerance_pct=0.0002,
    )
    merged_summary = run_calibration_experiment(
        symbol="TEST", start_date=date(2026, 1, 2), end_date=date(2026, 1, 2),
        confluence_tolerance_pct=0.0005,
    )

    assert "CONFLUENCE_HIGH" not in isolated_summary.by_level_type
    assert "PDH" in isolated_summary.by_level_type or "P4HH" in isolated_summary.by_level_type

    assert "CONFLUENCE_HIGH" in merged_summary.by_level_type
    assert "PDH" not in merged_summary.by_level_type
    assert "P4HH" not in merged_summary.by_level_type

    assert isolated_summary.confluence_tolerance_pct == 0.0002
    assert merged_summary.confluence_tolerance_pct == 0.0005
