"""Unit tests for the CONFLUENCE directional gate.

Two independent fixes are covered here:

1. Two-level agreement (`select_confluent_level`): level selection used to
   track only the single nearest structural level and act on it, even when a
   second active level nearby pointed the other way (e.g. spot sitting 10bps
   from a SESSION_HIGH but also 15bps from a contradictory SWING_LOW). These
   tests cover:
   - Two nearby levels that agree on direction -> gate fires as before.
   - Two nearby levels that disagree -> neutral / no-signal, not a silent
     pick of the nearer one (the core regression case from the review).
   - Exactly one level nearby -> still usable on its own (single-level path
     preserved, not removed).
   - Zero levels nearby -> not proximate, no action, no crash.

2. The structural-level query (`fetch_active_structural_levels`):
   liquidity_pool_candidates has no `status` column — a prior version of
   this function filtered on `status = 'ACTIVE'` and `created_at`, neither
   of which exist/are point-in-time-safe on the real schema, and never
   scoped by instrument. These tests pin the corrected query shape against a
   fake cursor (no live DB required) and the real schema's columns.
"""

from __future__ import annotations

from datetime import datetime, timezone
import zoneinfo

from ai_quant_lab_ml.confluence_gate import (
    evaluate_confluence_signal,
    fetch_active_structural_levels,
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


# ---------------------------------------------------------------------------
# fetch_active_structural_levels: the liquidity_pool_candidates query itself.
# ---------------------------------------------------------------------------


class FakeCursor:
    def __init__(self, connection: "FakeConnection") -> None:
        self._connection = connection
        self._rows: list[tuple] = []

    def __enter__(self) -> "FakeCursor":
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> bool:
        return False

    def execute(self, query: str, params: tuple | None = None) -> None:
        self._connection.calls.append((" ".join(query.split()), params))
        self._rows = self._connection.outcomes.pop(0)

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class FakeConnection:
    def __init__(self, outcomes: list[list[tuple]]) -> None:
        self.outcomes = list(outcomes)
        self.calls: list[tuple[str, tuple | None]] = []

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)


QUERY_AS_OF = datetime(2026, 9, 1, 5, 0, tzinfo=timezone.utc)


def test_fetch_active_structural_levels_does_not_reference_status_column():
    conn = FakeConnection(outcomes=[[("SWING_HIGH", 100.0)]])
    fetch_active_structural_levels(conn, "NIFTY50", QUERY_AS_OF)

    query, params = conn.calls[0]
    assert "status" not in query.lower()
    assert "invalidated_at_time" in query
    assert "known_at_time" in query
    assert "created_at " not in f" {query} "


def test_fetch_active_structural_levels_scopes_by_symbol():
    conn = FakeConnection(outcomes=[[("SWING_HIGH", 100.0)]])
    fetch_active_structural_levels(conn, "BANKNIFTY", QUERY_AS_OF)

    query, params = conn.calls[0]
    assert "symbol = %s" in query
    assert params[0] == "BANKNIFTY"


def test_fetch_active_structural_levels_filters_active_as_of_time():
    conn = FakeConnection(outcomes=[[("PDL", 48000.0)]])
    fetch_active_structural_levels(conn, "NIFTY50", QUERY_AS_OF)

    query, params = conn.calls[0]
    assert "known_at_time <= %s" in query
    assert "invalidated_at_time IS NULL OR invalidated_at_time > %s" in query
    # symbol, known_at_time bound, invalidated_at_time bound: all anchored on as_of_time.
    assert params == ("NIFTY50", QUERY_AS_OF, QUERY_AS_OF)


def test_fetch_active_structural_levels_parses_rows():
    conn = FakeConnection(outcomes=[[("SWING_HIGH", 100.5), ("PDL", 98.25)]])
    levels = fetch_active_structural_levels(conn, "NIFTY50", QUERY_AS_OF)

    assert levels == [("SWING_HIGH", 100.5), ("PDL", 98.25)]


def test_fetch_active_structural_levels_falls_back_to_daily_candles_when_empty():
    conn = FakeConnection(
        outcomes=[
            [],  # liquidity_pool_candidates query returns nothing
            [(datetime(2026, 8, 31, tzinfo=timezone.utc), 48700.0, 48100.0, 48500.0)],
        ]
    )
    levels = fetch_active_structural_levels(conn, "NIFTY50", QUERY_AS_OF)

    assert levels == [("PDH", 48700.0), ("PDL", 48100.0)]
    # The fallback query still scopes by symbol via the instruments join.
    fallback_query, fallback_params = conn.calls[1]
    assert "i.symbol = %s" in fallback_query
    assert fallback_params[0] == "NIFTY50"


def test_evaluate_confluence_signal_uses_only_the_requested_symbols_levels():
    # A level for a different instrument must never leak in: the fake connection
    # only ever returns what the (now symbol-scoped) query would return for the
    # requested symbol, so a NIFTY50 call sees none of BANKNIFTY's levels.
    conn = FakeConnection(
        outcomes=[
            [],  # liquidity_pool_candidates: no NIFTY50 levels active
            [],  # daily-candle fallback: no prior day candle either
        ]
    )
    signal = evaluate_confluence_signal(
        conn, "NIFTY50", spot_price=100.0, as_of_time=QUERY_AS_OF
    )

    assert signal.is_level_proximate is False
    assert signal.gate_action == "NO_ACTION"
    levels_query, levels_params = conn.calls[0]
    assert levels_params[0] == "NIFTY50"
