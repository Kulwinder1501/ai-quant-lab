"""Session scoping and the time-of-day trivial baseline of the volatility-expansion label."""

from __future__ import annotations

import unittest
from datetime import UTC, datetime, timedelta

from ai_quant_lab_ml.volatility_expansion import (
    SessionScopedTrailingWindow,
    VolatilityExpansionError,
    is_intraday_timeframe,
    time_of_day_key,
    time_of_day_majority_predictions,
    timeframe_minutes,
    trivial_scores,
)

# 2026-09-01 03:45 UTC = 09:15 IST, the NSE open.
OPEN_DAY_1 = datetime(2026, 9, 1, 3, 45, tzinfo=UTC)
OPEN_DAY_2 = OPEN_DAY_1 + timedelta(days=1)
BAR = timedelta(minutes=15)


def push_session(window: SessionScopedTrailingWindow, open_time: datetime, bars: int, base: float) -> list[bool]:
    """Push ``bars`` 15m bars (closing at open + (i+1)*15m); return `.full` after each push."""
    fulls = []
    for index in range(bars):
        close_time = open_time + (index + 1) * BAR
        window.push(close_time, high=base + index + 1, low=base + index)
        fulls.append(window.full)
    return fulls


class SessionScopedTrailingWindowTests(unittest.TestCase):
    def test_the_window_does_not_cross_the_overnight_gap(self) -> None:
        window = SessionScopedTrailingWindow(5, session_scoped=True)
        push_session(window, OPEN_DAY_1, 8, base=100.0)
        fulls = push_session(window, OPEN_DAY_2, 8, base=200.0)

        # Bars 0-3 of the new session have a trailing window shorter than K and are skipped
        # by the builder; bar 4 is the first with a full, same-session window.
        self.assertEqual(fulls, [False, False, False, False, True, True, True, True])
        # And that full window holds only day-2 bars, so its envelope is day 2's own range.
        window_after_bar_4 = SessionScopedTrailingWindow(5, session_scoped=True)
        push_session(window_after_bar_4, OPEN_DAY_1, 8, base=100.0)
        push_session(window_after_bar_4, OPEN_DAY_2, 5, base=200.0)
        self.assertEqual(min(window_after_bar_4.lows), 200.0)
        self.assertEqual(max(window_after_bar_4.highs), 205.0)

    def test_without_session_scoping_the_old_leak_is_visible(self) -> None:
        window = SessionScopedTrailingWindow(5, session_scoped=False)
        push_session(window, OPEN_DAY_1, 8, base=100.0)
        fulls = push_session(window, OPEN_DAY_2, 2, base=200.0)

        self.assertEqual(fulls, [True, True])  # full at bar 0 of the new day
        self.assertLess(min(window.lows), 150.0)  # holding yesterday's bars: the contamination

    def test_a_continuous_market_never_resets(self) -> None:
        window = SessionScopedTrailingWindow(5, session_scoped=True)
        start = datetime(2026, 9, 1, 0, 0, tzinfo=UTC)
        for index in range(40):  # 10 hours of 15m bars, no gap above the session threshold
            window.push(start + (index + 1) * BAR, high=100.0 + index, low=99.0 + index)
        self.assertTrue(window.full)
        self.assertEqual(len(window.highs), 5)

    def test_a_lunch_break_inside_the_session_does_not_reset(self) -> None:
        window = SessionScopedTrailingWindow(3, session_scoped=True)
        window.push(OPEN_DAY_1 + BAR, 101.0, 100.0)
        window.push(OPEN_DAY_1 + 2 * BAR, 102.0, 101.0)
        window.push(OPEN_DAY_1 + 2 * BAR + timedelta(hours=1), 103.0, 102.0)  # a 1h hole
        self.assertTrue(window.full)

    def test_timeframe_helpers(self) -> None:
        self.assertEqual(timeframe_minutes("15m"), 15)
        self.assertEqual(timeframe_minutes("1h"), 60)
        self.assertIsNone(timeframe_minutes("1d"))
        self.assertTrue(is_intraday_timeframe("5m"))
        self.assertTrue(is_intraday_timeframe("60m"))
        self.assertFalse(is_intraday_timeframe("1d"))
        self.assertFalse(is_intraday_timeframe("4h"))


class TimeOfDayKeyTests(unittest.TestCase):
    def test_key_is_the_ist_open_bucket_and_agrees_for_aware_and_naive_times(self) -> None:
        # The 09:15-09:30 bar closes at 09:30 IST = 04:00 UTC.
        aware = datetime(2026, 9, 1, 4, 0, tzinfo=UTC)
        naive_ist = datetime(2026, 9, 1, 9, 30)
        self.assertEqual(time_of_day_key(aware, 15), (9 * 60 + 15) // 15)
        self.assertEqual(time_of_day_key(naive_ist, 15), time_of_day_key(aware, 15))
        # The next bar is exactly one bucket later.
        self.assertEqual(time_of_day_key(aware + BAR, 15), time_of_day_key(aware, 15) + 1)

    def test_rejects_a_non_positive_bar_length(self) -> None:
        with self.assertRaises(VolatilityExpansionError):
            time_of_day_key(OPEN_DAY_1, 0)


class TimeOfDayBaselineTests(unittest.TestCase):
    def setUp(self) -> None:
        # Bar 0 is mostly CONTRACTION, bar 5 mostly EXPANSION (the audit's shape, exaggerated).
        self.train_keys = [0] * 100 + [5] * 100
        self.train_labels = (
            ["CONTRACTION"] * 70 + ["STABLE"] * 20 + ["EXPANSION"] * 10
            + ["EXPANSION"] * 70 + ["STABLE"] * 20 + ["CONTRACTION"] * 10
        )

    def test_a_clock_only_model_beats_the_global_majority_but_not_the_stratified_one(self) -> None:
        actual = list(self.train_labels)
        keys = list(self.train_keys)
        global_majority = max(
            {label: actual.count(label) for label in set(actual)}.items(), key=lambda e: (e[1], e[0])
        )[0]
        global_scores = trivial_scores(actual, [global_majority] * len(actual))

        stratified = time_of_day_majority_predictions(
            train_keys=self.train_keys, train_labels=self.train_labels, holdout_keys=keys,
        )
        stratified_scores = trivial_scores(actual, stratified)
        # A model that has learned nothing but the clock predicts the per-bar majority.
        clock_model_scores = trivial_scores(actual, list(stratified))

        self.assertAlmostEqual(global_scores[0], 0.40, places=10)
        self.assertAlmostEqual(stratified_scores[0], 0.70, places=10)
        self.assertGreater(clock_model_scores[0], global_scores[0])  # "beats trivial" on the old baseline
        self.assertLessEqual(clock_model_scores[0], stratified_scores[0])  # and does not on the new one
        self.assertLessEqual(clock_model_scores[1], stratified_scores[1])

    def test_majority_comes_from_training_only(self) -> None:
        # The holdout's own labels are not an input: flipping them cannot change the baseline.
        first = time_of_day_majority_predictions(
            train_keys=self.train_keys, train_labels=self.train_labels, holdout_keys=[0, 5, 0],
        )
        self.assertEqual(first, ["CONTRACTION", "EXPANSION", "CONTRACTION"])

    def test_an_unseen_bucket_falls_back_to_the_global_training_majority(self) -> None:
        predictions = time_of_day_majority_predictions(
            train_keys=self.train_keys, train_labels=self.train_labels, holdout_keys=[99],
        )
        # CONTRACTION 80 / EXPANSION 80 / STABLE 40: the tie goes to the larger label string.
        self.assertEqual(predictions, ["EXPANSION"])

    def test_empty_training_partition_is_rejected(self) -> None:
        with self.assertRaises(VolatilityExpansionError):
            time_of_day_majority_predictions(train_keys=[], train_labels=[], holdout_keys=[0])

    def test_trivial_scores_matches_the_closed_form(self) -> None:
        actual = ["CONTRACTION"] * 6 + ["STABLE"] * 3 + ["EXPANSION"] * 1
        accuracy, macro_f1 = trivial_scores(actual, ["CONTRACTION"] * 10)
        self.assertAlmostEqual(accuracy, 0.6, places=10)
        # Majority prevalence p = 0.6: F1 = 2p / (1 + p), the other two classes score 0.
        self.assertAlmostEqual(macro_f1, (2 * 0.6 / 1.6) / 3, places=10)


if __name__ == "__main__":
    unittest.main()
