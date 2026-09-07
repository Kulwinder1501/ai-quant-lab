"""Unit tests for the point-in-time breadth panel math."""

from __future__ import annotations

import statistics
import unittest
from datetime import UTC, datetime, timedelta

from ai_quant_lab_ml.breadth import PanelBar, compute_breadth_contexts, latest_breadth_at

# 15:30 IST expressed in UTC, the close every NSE daily bar in this project uses.
SESSION_CLOSE_UTC_HOUR = 10


def close_at(day_index: int) -> datetime:
    return datetime(2026, 3, 2, SESSION_CLOSE_UTC_HOUR, tzinfo=UTC) + timedelta(days=day_index)


def series(closes: list[float], *, volume: float = 500.0) -> list[PanelBar]:
    return [PanelBar(close_time=close_at(index), close=close, volume=volume) for index, close in enumerate(closes)]


# Twelve roster members clears the ten-participant floor. Exactly two banks and
# two IT names take part, the sector minimum, so the spread is measurable and
# every member's contribution to it is stated below.
UP = [100.0, 101.0]      # +100 bps on session 2
DOWN = [100.0, 98.0]     # -200 bps
FLAT = [100.0, 100.0]    # 0 bps

TWO_SESSION_PANEL = {
    "AXISBANK": series(UP),      # bank, up
    "HDFCBANK": series(UP),      # bank, up
    "INFY": series(DOWN),        # IT, down
    "TCS": series(DOWN),         # IT, down
    "RELIANCE": series(UP),
    "ITC": series(UP),
    "LT": series(UP),
    "MARUTI": series(UP),
    "TITAN": series(UP),
    "NESTLEIND": series(DOWN),
    "ASIANPAINT": series(DOWN),
    "BHARTIARTL": series(FLAT),
}
TWO_SESSION_RETURNS = [100.0] * 7 + [-200.0] * 4 + [0.0]


class ComputeBreadthContextsTests(unittest.TestCase):
    def test_first_session_has_no_returns_and_is_omitted(self) -> None:
        contexts = compute_breadth_contexts(TWO_SESSION_PANEL)

        # Session 1 has no prior close for any member, so it publishes nothing.
        self.assertEqual(len(contexts), 1)
        self.assertEqual(contexts[0].observed_at, close_at(1))

    def test_cross_sectional_statistics_are_exact(self) -> None:
        context = compute_breadth_contexts(
            TWO_SESSION_PANEL,
            primary_index_bars=series([100.0, 100.5]),   # +50 bps
            secondary_index_bars=series([100.0, 100.2]), # +20 bps
        )[0]

        self.assertAlmostEqual(context.advance_decline or 0.0, (7 - 4) / 12, places=10)
        self.assertAlmostEqual(context.median_return_bps or 0.0, 100.0, places=6)
        self.assertAlmostEqual(
            context.return_dispersion_bps or 0.0, statistics.stdev(TWO_SESSION_RETURNS), places=6
        )
        # Banks +100 each, IT -200 each.
        self.assertAlmostEqual(context.bank_it_spread_bps or 0.0, 300.0, places=6)
        self.assertAlmostEqual(context.index_return_gap_bps or 0.0, 30.0, places=6)
        # Two sessions cannot fill a 20-session trailing window.
        self.assertIsNone(context.above_sma20_share)
        self.assertIsNone(context.median_volume_ratio)

    def test_below_participation_floor_publishes_nothing(self) -> None:
        small_panel = {symbol: TWO_SESSION_PANEL[symbol] for symbol in list(TWO_SESSION_PANEL)[:9]}

        self.assertEqual(compute_breadth_contexts(small_panel), [])

    def test_sector_spread_requires_both_sides(self) -> None:
        # Drop one IT name: one participant is below the two-per-side minimum,
        # but the session itself still clears the overall floor via a filler.
        panel = dict(TWO_SESSION_PANEL)
        del panel["TCS"]
        panel["ULTRACEMCO"] = series(FLAT)

        context = compute_breadth_contexts(panel)[0]
        self.assertIsNone(context.bank_it_spread_bps)
        self.assertIsNotNone(context.advance_decline)

    def test_trailing_windows_fill_after_twenty_sessions(self) -> None:
        # Rising closes: every session's close sits above its own 20-session
        # mean once the window is full, and constant volume pins the ratio at 1.
        rising = [100.0 + index for index in range(21)]
        panel = {symbol: series(rising) for symbol in TWO_SESSION_PANEL}

        contexts = compute_breadth_contexts(panel)
        last = contexts[-1]
        self.assertEqual(last.observed_at, close_at(20))
        self.assertAlmostEqual(last.advance_decline or 0.0, 1.0, places=10)
        self.assertAlmostEqual(last.above_sma20_share or 0.0, 1.0, places=10)
        self.assertAlmostEqual(last.median_volume_ratio or 0.0, 1.0, places=10)
        # The window first fills at the 20th bar (contexts[-2]); one session
        # before that it was one bar short for both statistics.
        self.assertIsNotNone(contexts[-2].above_sma20_share)
        self.assertIsNone(contexts[-3].above_sma20_share)
        self.assertIsNone(contexts[-3].median_volume_ratio)

    def test_duplicate_session_bars_keep_the_first_print(self) -> None:
        panel = dict(TWO_SESSION_PANEL)
        duplicated = list(panel["RELIANCE"]) + [PanelBar(close_time=close_at(1), close=999.0, volume=1.0)]
        panel["RELIANCE"] = duplicated

        context = compute_breadth_contexts(panel)[0]
        # The 999 print would have made RELIANCE's return enormous; the median
        # and dispersion prove the first print won.
        self.assertAlmostEqual(context.median_return_bps or 0.0, 100.0, places=6)

    def test_missing_index_series_leaves_only_the_gap_unmeasured(self) -> None:
        context = compute_breadth_contexts(TWO_SESSION_PANEL, primary_index_bars=series([100.0, 100.5]))[0]

        self.assertIsNone(context.index_return_gap_bps)
        self.assertIsNotNone(context.median_return_bps)


class LatestBreadthAtTests(unittest.TestCase):
    def setUp(self) -> None:
        rising = [100.0 + index for index in range(3)]
        panel = {symbol: series(rising) for symbol in TWO_SESSION_PANEL}
        self.contexts = compute_breadth_contexts(panel)
        self.assertEqual([context.observed_at for context in self.contexts], [close_at(1), close_at(2)])

    def test_same_close_attaches_the_same_session(self) -> None:
        # A daily bar and the panel settle at the same instant; its label only
        # starts afterwards, so same-close breadth is as-of evidence.
        self.assertEqual(latest_breadth_at(self.contexts, close_at(2)), self.contexts[1])

    def test_between_sessions_attaches_the_previous_one(self) -> None:
        self.assertEqual(latest_breadth_at(self.contexts, close_at(1) + timedelta(hours=20)), self.contexts[0])

    def test_before_the_first_context_is_none(self) -> None:
        self.assertIsNone(latest_breadth_at(self.contexts, close_at(0)))

    def test_stale_context_is_none_rather_than_carried_forward(self) -> None:
        self.assertIsNone(latest_breadth_at(self.contexts, close_at(2) + timedelta(days=6)))
        self.assertIsNotNone(latest_breadth_at(self.contexts, close_at(2) + timedelta(days=5)))


if __name__ == "__main__":
    unittest.main()
