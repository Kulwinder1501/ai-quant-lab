"""Swing clusters from 200 to 257 bars: the Python reference for the TypeScript fallback in
apps/api/src/modules/equity-research/domain/levels.ts (MIN_BARS_FOR_PARTIAL_SWING). The parity fixtures pin the
numbers; these tests pin the boundaries (199 / 200 / 257 / 258)."""

import math
from datetime import date, timedelta

from apps.ml.equity_stance_r0.levels import (
    MIN_BARS_FOR_PARTIAL_SWING,
    Bar,
    compute_levels,
    find_swing_pivots,
)


def wave_bars(count: int) -> list[Bar]:
    """A repeating wave, so swing pivots recur near the same prices and form clusters."""
    start = date(2026, 1, 1)
    bars = []
    for i in range(count):
        close = 100 + 5 * math.sin(i * 2 * math.pi / 20)
        bars.append(Bar((start + timedelta(days=i)).isoformat(), close - 0.2, close + 1.5, close - 1.5, close, 10_000))
    return bars


def levels_for(count: int):
    return compute_levels(wave_bars(count))


def swing_count(res) -> int:
    return sum(1 for lvl in res.levels if lvl.kind == "SWING")


def test_threshold_is_200():
    assert MIN_BARS_FOR_PARTIAL_SWING == 200


def test_below_200_bars_swing_levels_are_withheld_and_the_need_is_stated():
    res = levels_for(199)
    assert res.state == "INSUFFICIENT_HISTORY"
    assert swing_count(res) == 0
    assert any("Requires at least 200 trading bars to compute swing levels; 199 available." in w for w in res.warnings)


def test_exactly_200_bars_builds_swing_levels_and_warns():
    res = levels_for(200)
    assert res.state == "OK"
    assert swing_count(res) > 0
    assert any("built from 200 trading bars, fewer than the 258" in w for w in res.warnings)


def test_warning_holds_to_257_and_goes_at_258():
    assert any("fewer than the 258" in w for w in levels_for(257).warnings)
    full = levels_for(258)
    assert full.state == "OK"
    assert swing_count(full) > 0
    assert not any("fewer than the 258" in w for w in full.warnings)


def test_shortened_window_takes_every_bar():
    bars = wave_bars(230)
    shortened = find_swing_pivots(bars, 5, 230 - 5 - 1)
    unbounded = find_swing_pivots(bars, 5, 10_000)
    assert shortened and shortened == unbounded
