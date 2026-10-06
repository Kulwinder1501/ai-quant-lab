"""Unit Test Suite for VOLUME-01 Time-of-Day Volume Intelligence Engine.

Tests:
1. Bucket partitioning (09:15 - 15:30 IST -> 75 5m buckets).
2. Non-parametric bin assignment (1..6).
3. Jonckheere-Terpstra statistic correctness against monotonic data.
4. Whole-day label-vector permutation mechanics.
5. Day-level paired bootstrap resampling with zero-trade day handling.
"""

import unittest
from datetime import datetime, date, time
import zoneinfo
import numpy as np
import pandas as pd

from ai_quant_lab_ml.volume_intelligence import (
    get_tod_bucket_index,
    assign_rvol_bin,
    jonckheere_terpstra_statistic,
    whole_day_label_vector_permutation,
)
from ai_quant_lab_ml.volume_gate_evaluator import day_level_paired_bootstrap

INDIA_TZ = zoneinfo.ZoneInfo("Asia/Kolkata")


class TestVolumeIntelligenceEngine(unittest.TestCase):

    def test_tod_bucket_index(self):
        # 09:15 IST -> Bucket 1
        dt1 = datetime(2026, 7, 1, 9, 15, tzinfo=INDIA_TZ)
        self.assertEqual(get_tod_bucket_index(dt1), 1)

        # 09:19 IST -> Bucket 1
        dt2 = datetime(2026, 7, 1, 9, 19, tzinfo=INDIA_TZ)
        self.assertEqual(get_tod_bucket_index(dt2), 1)

        # 09:20 IST -> Bucket 2
        dt3 = datetime(2026, 7, 1, 9, 20, tzinfo=INDIA_TZ)
        self.assertEqual(get_tod_bucket_index(dt3), 2)

        # 15:25 IST -> Bucket 75
        dt4 = datetime(2026, 7, 1, 15, 25, tzinfo=INDIA_TZ)
        self.assertEqual(get_tod_bucket_index(dt4), 75)

        # Outside session: 09:10 IST or 15:35 IST -> None
        dt_out1 = datetime(2026, 7, 1, 9, 10, tzinfo=INDIA_TZ)
        self.assertIsNone(get_tod_bucket_index(dt_out1))

    def test_assign_rvol_bin(self):
        self.assertEqual(assign_rvol_bin(0.50), 1)  # < 0.75
        self.assertEqual(assign_rvol_bin(0.75), 2)  # 0.75 <= x < 1.00
        self.assertEqual(assign_rvol_bin(1.10), 3)  # 1.00 <= x < 1.25
        self.assertEqual(assign_rvol_bin(1.30), 4)  # 1.25 <= x < 1.50
        self.assertEqual(assign_rvol_bin(1.80), 5)  # 1.50 <= x < 2.00
        self.assertEqual(assign_rvol_bin(2.50), 6)  # >= 2.00
        self.assertIsNone(assign_rvol_bin(np.nan))

    def test_jonckheere_terpstra_statistic(self):
        # Monotonically increasing group data
        group1 = np.array([1.0, 2.0, 3.0])
        group2 = np.array([4.0, 5.0, 6.0])
        group3 = np.array([7.0, 8.0, 9.0])
        
        j_stat = jonckheere_terpstra_statistic([group1, group2, group3])
        # Every pair between group1 and group2 (3x3=9), group1 and group3 (9), group2 and group3 (9) = 27
        self.assertEqual(j_stat, 27.0)

    def test_whole_day_label_vector_permutation(self):
        # Synthetic 5 days of 75 buckets
        rng = np.random.default_rng(42)
        daily_bins = {}
        daily_rets = {}
        dates = [date(2026, 7, d) for d in range(1, 6)]

        for d in dates:
            daily_bins[d] = rng.integers(1, 7, size=75)
            daily_rets[d] = rng.normal(10.0, 2.0, size=75)

        obs_j, p_val, perm_stats = whole_day_label_vector_permutation(
            daily_bins, daily_rets, num_permutations=100, random_state=42
        )
        self.assertIsInstance(obs_j, float)
        self.assertGreaterEqual(p_val, 0.0)
        self.assertLessEqual(p_val, 1.0)
        self.assertEqual(len(perm_stats), 100)

    def test_day_level_paired_bootstrap(self):
        d1, d2, d3 = date(2026, 7, 1), date(2026, 7, 2), date(2026, 7, 3)
        daily_control = {d1: [1.0, 0.5], d2: [-0.5], d3: [2.0]}
        daily_gate = {d1: [1.5], d2: [0.0], d3: [2.5]}

        delta_exp, c_exp, g_exp, ci_l, ci_u = day_level_paired_bootstrap(
            daily_control, daily_gate, num_bootstraps=100, random_state=42
        )
        self.assertGreater(g_exp, c_exp)
        self.assertGreater(delta_exp, 0.0)
        self.assertLessEqual(ci_l, ci_u)


if __name__ == "__main__":
    unittest.main()
