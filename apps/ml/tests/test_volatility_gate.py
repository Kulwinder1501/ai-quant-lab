from __future__ import annotations

import unittest
from datetime import date

from volatility_gate import latest_vix_before_session


class LatestVixBeforeSessionTests(unittest.TestCase):
    def test_excludes_the_same_session_daily_close(self) -> None:
        history = [
            (date(2026, 8, 11), 0.11),
            (date(2026, 8, 12), 0.12),
            (date(2026, 8, 13), 0.13),
        ]

        self.assertEqual(latest_vix_before_session(history, date(2026, 8, 13)), 0.12)

    def test_carries_the_latest_completed_close_across_calendar_gaps(self) -> None:
        history = [
            (date(2026, 8, 13), 0.13),
            (date(2026, 8, 14), 0.14),
        ]

        self.assertEqual(latest_vix_before_session(history, date(2026, 8, 17)), 0.14)

    def test_returns_none_when_no_prior_close_exists(self) -> None:
        history = [(date(2026, 8, 13), 0.13)]

        self.assertIsNone(latest_vix_before_session(history, date(2026, 8, 13)))


if __name__ == "__main__":
    unittest.main()
