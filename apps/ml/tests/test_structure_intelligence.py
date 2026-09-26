"""Unit tests for STRUCTURE-01 Structure Intelligence module."""

from datetime import datetime, date, time, timezone
import zoneinfo
import numpy as np
import pytest

from ai_quant_lab_ml.structure_intelligence import (
    StructuralLevel,
    ProximityEvent,
    CalibrationSummary,
    compute_daily_levels,
    compute_4h_levels_from_5m,
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
