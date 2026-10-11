"""
Unit tests for Time-of-Day regime classifier module.
"""

import unittest
import pandas as pd

from apps.ml.tod_regime import (
    AFTERNOON_EXPANSION,
    CLOSING_AUCTION,
    MIDDAY_CONSOLIDATION,
    MORNING_TREND,
    OPENING_DRIVE,
    OUT_OF_SESSION,
    add_tod_features,
    classify_tod_regime,
)


class TestTodRegime(unittest.TestCase):
    def test_classify_tod_regime_times(self):
        self.assertEqual(classify_tod_regime("2026-10-07 09:20:00"), OPENING_DRIVE)
        self.assertEqual(classify_tod_regime("2026-10-07 10:15:00"), MORNING_TREND)
        self.assertEqual(classify_tod_regime("2026-10-07 12:00:00"), MIDDAY_CONSOLIDATION)
        self.assertEqual(classify_tod_regime("2026-10-07 14:15:00"), AFTERNOON_EXPANSION)
        self.assertEqual(classify_tod_regime("2026-10-07 15:10:00"), CLOSING_AUCTION)
        self.assertEqual(classify_tod_regime("2026-10-07 08:30:00"), OUT_OF_SESSION)
        self.assertEqual(classify_tod_regime("2026-10-07 16:00:00"), OUT_OF_SESSION)

    def test_add_tod_features(self):
        timestamps = [
            "2026-10-07 09:30:00",
            "2026-10-07 10:30:00",
            "2026-10-07 12:30:00",
            "2026-10-07 14:30:00",
            "2026-10-07 15:15:00",
        ]
        df = pd.DataFrame({"timestamp": timestamps, "price": [100, 101, 102, 103, 104]})
        df_feat = add_tod_features(df, timestamp_col="timestamp")

        self.assertIn("tod_regime", df_feat.columns)
        self.assertIn("is_opening_drive", df_feat.columns)
        self.assertEqual(df_feat["tod_regime"].iloc[0], OPENING_DRIVE)
        self.assertEqual(df_feat["is_opening_drive"].iloc[0], 1)
        self.assertEqual(df_feat["is_morning_trend"].iloc[0], 0)


if __name__ == "__main__":
    unittest.main()
