"""Snapshot-age ceiling, spread filter and sample-size reporting of the IV-compression check."""

from __future__ import annotations

import unittest
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace

from ai_quant_lab_ml.option_chain_pcr import MAX_SNAPSHOT_AGE_MINUTES
from iv_compression_signal_check import (
    MAXIMUM_RELATIVE_SPREAD,
    MAXIMUM_SNAPSHOT_AGE_MINUTES,
    MINIMUM_DISTINCT_DAYS,
    AtmIvSnapshot,
    _mid,
    iv_features_as_of,
    sample_size_limits,
)

START = datetime(2026, 8, 4, 9, 30, tzinfo=UTC)


def _history(days: int) -> tuple[list[AtmIvSnapshot], dict[date, float], list[date]]:
    series = [
        AtmIvSnapshot(observed_at=START + timedelta(days=i), implied_volatility=0.10 + 0.001 * i)
        for i in range(days)
    ]
    daily = {snapshot.observed_at.date(): snapshot.implied_volatility for snapshot in series}
    return series, daily, sorted(daily)


class SnapshotAgeCeilingTests(unittest.TestCase):
    def test_ceiling_is_the_shared_twenty_minutes(self) -> None:
        self.assertEqual(MAXIMUM_SNAPSHOT_AGE_MINUTES, 20.0)
        self.assertEqual(MAXIMUM_SNAPSHOT_AGE_MINUTES, MAX_SNAPSHOT_AGE_MINUTES)

    def test_a_snapshot_up_to_twenty_minutes_old_is_usable_and_older_is_not(self) -> None:
        series, daily, days = _history(MINIMUM_DISTINCT_DAYS + 5)
        # Same-day snapshot as the last history point, observed at 09:30 on the final day.
        times = [snapshot.observed_at for snapshot in series]
        last = series[-1].observed_at

        at_limit = iv_features_as_of(series, times, daily, days, last + timedelta(minutes=20))
        past_limit = iv_features_as_of(series, times, daily, days, last + timedelta(minutes=21))
        # The old 15-minute ceiling would have refused 16-20 minutes; the shared one admits it.
        sixteen = iv_features_as_of(series, times, daily, days, last + timedelta(minutes=16))

        self.assertIsNotNone(at_limit)
        self.assertIsNone(past_limit)
        self.assertIsNotNone(sixteen)


class SpreadFilterTests(unittest.TestCase):
    def test_a_tight_two_sided_quote_gives_a_mid(self) -> None:
        self.assertEqual(_mid(99.0, 101.0, MAXIMUM_RELATIVE_SPREAD), 100.0)  # 2% wide

    def test_a_wide_quote_is_refused_when_the_filter_is_on(self) -> None:
        self.assertIsNone(_mid(90.0, 110.0, MAXIMUM_RELATIVE_SPREAD))  # 20% wide
        # ...and still accepted by the unfiltered call, so the default is unchanged.
        self.assertEqual(_mid(90.0, 110.0), 100.0)

    def test_the_boundary_is_inclusive(self) -> None:
        # (ask - bid) / mid == 0.05 exactly: 97.5 / 102.5 -> 5 / 100.
        self.assertEqual(_mid(97.5, 102.5, 0.05), 100.0)

    def test_one_sided_and_crossed_books_stay_refused(self) -> None:
        self.assertIsNone(_mid(None, 101.0, 0.05))
        self.assertIsNone(_mid(0.0, 101.0, 0.05))
        self.assertIsNone(_mid(102.0, 101.0, 0.05))


class SampleSizeLimitTests(unittest.TestCase):
    def test_reports_days_not_rows_and_carries_the_caveat(self) -> None:
        series, _, _ = _history(39)
        examples = [SimpleNamespace(observed_at=START + timedelta(days=i, minutes=m)) for i in range(25, 39) for m in (0, 15, 30)]

        limits = sample_size_limits(series, examples)

        self.assertEqual(limits["distinctChainDays"], 39)
        self.assertEqual(limits["distinctExampleDays"], 14)
        self.assertEqual(limits["maximumSnapshotAgeMinutes"], 20.0)
        self.assertIn("39 distinct option-chain trading days", limits["caveat"])
        self.assertIn("exploratory", limits["caveat"])


if __name__ == "__main__":
    unittest.main()
