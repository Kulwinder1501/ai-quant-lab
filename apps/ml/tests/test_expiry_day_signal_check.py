"""Trading-day counting for the expiry-proximity check (replaces calendar_days * 5 / 7)."""

from __future__ import annotations

import unittest
from datetime import UTC, date, datetime

from expiry_day_signal_check import (
    EXPIRY_FEATURE_SCHEMA,
    expiry_features_as_of,
    trading_days_until,
)

FRIDAY = date(2026, 9, 4)
MONDAY = date(2026, 9, 7)
TUESDAY = date(2026, 9, 8)
THURSDAY = date(2026, 9, 10)


class TradingDaysUntilTests(unittest.TestCase):
    def test_counts_sessions_after_start_through_end(self) -> None:
        self.assertEqual(trading_days_until(MONDAY, THURSDAY), 3)  # Tue, Wed, Thu
        self.assertEqual(trading_days_until(THURSDAY, THURSDAY), 0)  # expiry day itself

    def test_weekend_is_skipped_exactly_where_five_sevenths_was_not(self) -> None:
        # Friday -> Tuesday holds exactly two sessions (Mon, Tue). 4 calendar days * 5/7 = 2.86.
        self.assertEqual(trading_days_until(FRIDAY, TUESDAY), 2)
        self.assertNotEqual(float(trading_days_until(FRIDAY, TUESDAY)), 4 * 5.0 / 7.0)

    def test_a_holiday_is_not_a_session(self) -> None:
        holidays = frozenset({date(2026, 9, 9)})  # Wednesday
        self.assertEqual(trading_days_until(MONDAY, THURSDAY, holidays), 2)
        # Without the calendar the weekdays-only approximation over-counts by the holiday.
        self.assertEqual(trading_days_until(MONDAY, THURSDAY), 3)

    def test_past_or_equal_end_is_zero(self) -> None:
        self.assertEqual(trading_days_until(THURSDAY, MONDAY), 0)


class ExpiryFeaturesTests(unittest.TestCase):
    EXPIRIES = [date(2026, 9, 10), date(2026, 9, 17)]

    def test_schema_is_the_single_non_constant_feature(self) -> None:
        self.assertEqual(EXPIRY_FEATURE_SCHEMA, ("expiry.days_to_nearest",))

    def test_feature_is_integer_trading_sessions_to_nearest_expiry(self) -> None:
        as_of = datetime(2026, 9, 7, 5, 0, tzinfo=UTC)  # Monday 10:30 IST
        self.assertEqual(expiry_features_as_of(self.EXPIRIES, as_of), {"expiry.days_to_nearest": 3.0})

    def test_on_expiry_day_the_count_is_zero_and_the_next_expiry_is_not_used(self) -> None:
        as_of = datetime(2026, 9, 10, 5, 0, tzinfo=UTC)
        self.assertEqual(expiry_features_as_of(self.EXPIRIES, as_of), {"expiry.days_to_nearest": 0.0})

    def test_uses_the_ist_date_not_the_utc_date(self) -> None:
        # 21:00 UTC on Wed 9 Sep is 02:30 IST on Thu 10 Sep: expiry day, not one session away.
        as_of = datetime(2026, 9, 9, 21, 0, tzinfo=UTC)
        self.assertEqual(expiry_features_as_of(self.EXPIRIES, as_of), {"expiry.days_to_nearest": 0.0})

    def test_the_old_constant_feature_is_gone(self) -> None:
        as_of = datetime(2026, 9, 7, 5, 0, tzinfo=UTC)
        features = expiry_features_as_of(self.EXPIRIES, as_of)
        assert features is not None
        self.assertNotIn("expiry.is_expiry_week", features)

    def test_after_the_last_known_expiry_is_unmeasurable(self) -> None:
        self.assertIsNone(expiry_features_as_of(self.EXPIRIES, datetime(2026, 9, 18, 5, 0, tzinfo=UTC)))


if __name__ == "__main__":
    unittest.main()
