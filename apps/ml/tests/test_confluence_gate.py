"""Unit tests for the CONFLUENCE directional gate's two-level agreement fix.

Background: `confluence_gate.py`'s level selection used to track only the
single nearest structural level and act on it, even when a second active
level nearby pointed the other way (e.g. spot sitting 10bps from a
SESSION_HIGH but also 15bps from a contradictory SWING_LOW). These tests
cover:
1. Two nearby levels that agree on direction -> gate fires as before.
2. Two nearby levels that disagree -> neutral / no-signal, not a silent pick
   of the nearer one (the core regression case from the review).
3. Exactly one level nearby -> still usable on its own (single-level path
   preserved, not removed).
4. Zero levels nearby -> not proximate, no action, no crash.
"""

from __future__ import annotations

from datetime import datetime
import zoneinfo

from ai_quant_lab_ml.confluence_gate import (
    evaluate_confluence_signal,
    select_confluent_level,
)

UTC = zoneinfo.ZoneInfo("UTC")
AS_OF = datetime(2026, 9, 1, 5, 0, tzinfo=UTC)


class _FakeCursor:
    def __init__(self, rows_by_query: dict[str, list[tuple]]) -> None:
        self._rows_by_query = rows_by_query
        self._last_rows: list[tuple] = []

    def __enter__(self) -> "_FakeCursor":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False

    def execute(self, query: str, params=None) -> None:
        if "liquidity_pool_candidates" in query:
            self._last_rows = self._rows_by_query.get("levels", [])
        elif "depth_frames" in query:
            self._last_rows = self._rows_by_query.get("depth", [])
        elif "candles" in query:
            self._last_rows = self._rows_by_query.get("candles", [])
        else:
            self._last_rows = []

    def fetchall(self) -> list[tuple]:
        return self._last_rows

    def fetchone(self):
        return self._last_rows[0] if self._last_rows else None


class _FakeConnection:
    """Minimal stand-in for psycopg.Connection driven by canned query results."""

    def __init__(self, levels=None, depth=None, candles=None) -> None:
        self._rows = {
            "levels": levels or [],
            "depth": depth or [],
            "candles": candles or [],
        }

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self._rows)


# ---------------------------------------------------------------------------
# select_confluent_level: pure level-selection logic, no DB involved.
# ---------------------------------------------------------------------------


def test_two_agreeing_levels_both_up_are_actionable():
    spot = 100.0
    levels = [
        ("SESSION_HIGH", 100.10),  # ~10 bps away
        ("SWING_HIGH", 100.12),    # ~12 bps away
    ]
    selection = select_confluent_level(levels, spot, bandwidth_bps=15.0)

    assert selection.is_proximate is True
    assert selection.nearest_level_type == "SESSION_HIGH"
    assert selection.second_level_type == "SWING_HIGH"
    assert selection.levels_agree is True


def test_two_disagreeing_levels_are_flagged_not_silently_resolved():
    """The exact review scenario: SESSION_HIGH @ ~10bps vs SWING_LOW @ ~15bps."""
    spot = 100.0
    levels = [
        ("SESSION_HIGH", 100.10),  # ~10.0 bps away, UP side
        ("SWING_LOW", 99.85),      # ~15.0 bps away, DOWN side
    ]
    selection = select_confluent_level(levels, spot, bandwidth_bps=16.0)

    assert selection.is_proximate is True
    assert selection.nearest_level_type == "SESSION_HIGH"
    assert selection.second_level_type == "SWING_LOW"
    assert selection.levels_agree is False


def test_single_level_nearby_has_nothing_to_compare_but_is_still_usable():
    spot = 100.0
    levels = [("SESSION_HIGH", 100.10)]
    selection = select_confluent_level(levels, spot, bandwidth_bps=15.0)

    assert selection.is_proximate is True
    assert selection.nearest_level_type == "SESSION_HIGH"
    assert selection.second_level_type is None
    assert selection.levels_agree is None  # N/A, not False


def test_second_level_outside_band_degrades_to_single_level_case():
    spot = 100.0
    levels = [
        ("SESSION_HIGH", 100.05),  # ~5 bps away
        ("SWING_LOW", 95.0),       # ~526 bps away, well outside the band
    ]
    selection = select_confluent_level(levels, spot, bandwidth_bps=15.0)

    assert selection.is_proximate is True
    assert selection.nearest_level_type == "SESSION_HIGH"
    # Far level must not be treated as a contradicting second level.
    assert selection.second_level_type is None
    assert selection.levels_agree is None


def test_zero_levels_nearby_is_not_proximate_and_does_not_crash():
    selection = select_confluent_level([], 100.0, bandwidth_bps=15.0)

    assert selection.is_proximate is False
    assert selection.nearest_level_type is None
    assert selection.levels_agree is None


def test_nearest_level_beyond_band_is_not_proximate():
    levels = [("SESSION_HIGH", 110.0)]  # ~909 bps away
    selection = select_confluent_level(levels, 100.0, bandwidth_bps=15.0)

    assert selection.is_proximate is False
    assert selection.nearest_level_type == "SESSION_HIGH"
    assert selection.levels_agree is None


def test_duplicate_level_type_trivially_agrees_with_itself():
    # Two ACTIVE pool rows of the same type should never look contradictory.
    levels = [("SESSION_HIGH", 100.10), ("SESSION_HIGH", 100.11)]
    selection = select_confluent_level(levels, 100.0, bandwidth_bps=15.0)

    assert selection.levels_agree is True


# ---------------------------------------------------------------------------
# evaluate_confluence_signal: full pipeline, DB calls faked out.
# ---------------------------------------------------------------------------


def test_gate_fires_when_two_nearby_levels_agree():
    conn = _FakeConnection(
        levels=[("SESSION_HIGH", 100.10), ("SWING_HIGH", 100.12)],
        depth=[(60.0, 40.0)],  # raw_di=+0.2 -> di_tilde=-0.2
    )
    signal = evaluate_confluence_signal(conn, "BANKNIFTY", 100.0, AS_OF, bandwidth_bps=15.0)

    assert signal.is_level_proximate is True
    assert signal.levels_agree is True
    # UP level, di_tilde < 0 -> BULLISH_SWEEP / BUY_CALL_OR_LONG per the
    # existing ORDERBOOK-01 rules (unchanged by this fix).
    assert signal.directional_bias == "BULLISH_SWEEP"
    assert signal.gate_action == "BUY_CALL_OR_LONG"


def test_gate_reports_neutral_when_two_nearby_levels_disagree():
    """Core regression test: previously this would have acted on SESSION_HIGH alone."""
    conn = _FakeConnection(
        levels=[("SESSION_HIGH", 100.10), ("SWING_LOW", 99.85)],
        depth=[(60.0, 40.0)],
    )
    signal = evaluate_confluence_signal(conn, "BANKNIFTY", 100.0, AS_OF, bandwidth_bps=16.0)

    assert signal.is_level_proximate is True
    assert signal.levels_agree is False
    assert signal.second_level_type == "SWING_LOW"
    assert signal.directional_bias == "NONE"
    assert signal.gate_action == "NO_ACTION"
    # Depth imbalance must not even be consulted once levels disagree.
    assert signal.raw_di is None
    assert signal.di_tilde is None


def test_gate_still_fires_on_a_single_nearby_level():
    conn = _FakeConnection(
        levels=[("SESSION_HIGH", 100.10)],
        depth=[(40.0, 60.0)],  # raw_di=-0.2 -> di_tilde=+0.2
    )
    signal = evaluate_confluence_signal(conn, "BANKNIFTY", 100.0, AS_OF, bandwidth_bps=15.0)

    assert signal.is_level_proximate is True
    assert signal.levels_agree is None
    assert signal.nearest_level_type == "SESSION_HIGH"
    # UP level, di_tilde > 0 -> BEARISH_REJECTION / BUY_PUT_OR_SHORT.
    assert signal.directional_bias == "BEARISH_REJECTION"
    assert signal.gate_action == "BUY_PUT_OR_SHORT"


def test_gate_no_action_when_zero_levels_nearby():
    conn = _FakeConnection(levels=[], depth=[(60.0, 40.0)])
    signal = evaluate_confluence_signal(conn, "BANKNIFTY", 100.0, AS_OF, bandwidth_bps=15.0)

    assert signal.is_level_proximate is False
    assert signal.levels_agree is None
    assert signal.directional_bias == "NONE"
    assert signal.gate_action == "NO_ACTION"


def test_non_positive_spot_price_is_handled_before_any_level_lookup():
    conn = _FakeConnection(levels=[("SESSION_HIGH", 100.10)], depth=[(60.0, 40.0)])
    signal = evaluate_confluence_signal(conn, "BANKNIFTY", 0.0, AS_OF, bandwidth_bps=15.0)

    assert signal.is_level_proximate is False
    assert signal.gate_action == "NO_ACTION"
