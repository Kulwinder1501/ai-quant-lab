"""Overlapping intraday entries must not shrink the promotion standard error."""
import math
import unittest
from datetime import date, timedelta

from ai_quant_lab_ml.straddle_economics import (
    clustered_mean_and_standard_error,
    cost_aware_promotion_verdict,
)

DAYS = 40
START = date(2026, 6, 1)


def _daily_pnls() -> list[float]:
    # Alternating small winners/losers per day with a slight positive drift.
    return [0.0020 if day % 2 == 0 else -0.0004 for day in range(DAYS)]


def _verdict(pnls: list[float], clusters: list[date] | None, **overrides: object) -> dict[str, object]:
    return cost_aware_promotion_verdict(
        gated_pnls=pnls,
        always_enter_pnls=[p - 0.0005 for p in pnls],
        fee_bps=5.0,
        minimum_scored=1,
        minimum_gated=1,
        gated_clusters=clusters,
        **overrides,  # type: ignore[arg-type]
    )


class ClusteredStandardErrorTests(unittest.TestCase):
    def test_one_entry_per_cluster_reduces_to_the_iid_standard_error(self) -> None:
        values = [0.01, -0.02, 0.03, 0.0, 0.015]
        _, se, count = clustered_mean_and_standard_error(values, list(range(len(values))))

        mean = sum(values) / len(values)
        sd = math.sqrt(sum((v - mean) ** 2 for v in values) / (len(values) - 1))
        self.assertEqual(count, 5)
        self.assertAlmostEqual(se or 0.0, sd / math.sqrt(len(values)), places=12)

    def test_duplicated_overlapping_entries_do_not_shrink_it(self) -> None:
        unique = _daily_pnls()
        days = [START + timedelta(days=i) for i in range(DAYS)]
        _, unique_se, _ = clustered_mean_and_standard_error(unique, days)

        for copies in (2, 5, 20):
            duplicated = [p for p in unique for _ in range(copies)]
            duplicated_days = [d for d in days for _ in range(copies)]
            _, clustered_se, count = clustered_mean_and_standard_error(duplicated, duplicated_days)
            self.assertEqual(count, DAYS)
            self.assertAlmostEqual(clustered_se or 0.0, unique_se or 0.0, places=12)

    def test_the_iid_standard_error_does_shrink_on_the_same_duplicates(self) -> None:
        # The defect: without clusters, duplicating each day's entry k times divides the SE by ~sqrt(k).
        unique = _daily_pnls()
        iid_unique = _verdict(unique, None)["gatedNetLowerBoundBps"]
        iid_duplicated = _verdict([p for p in unique for _ in range(20)], None)["gatedNetLowerBoundBps"]

        self.assertGreater(float(iid_duplicated), float(iid_unique))  # a tighter, i.e. falsely better, bound

    def test_verdict_lower_bound_is_unchanged_by_duplication_when_clustered(self) -> None:
        unique = _daily_pnls()
        days = [START + timedelta(days=i) for i in range(DAYS)]
        base = _verdict(unique, days)
        duplicated = _verdict(
            [p for p in unique for _ in range(20)], [d for d in days for _ in range(20)]
        )

        self.assertEqual(base["standardErrorBasis"], "CLUSTERED_BY_TRADING_DAY")
        self.assertAlmostEqual(
            float(base["gatedNetLowerBoundBps"]), float(duplicated["gatedNetLowerBoundBps"]), places=9
        )
        self.assertEqual(duplicated["gatedClusterCount"], DAYS)

    def test_a_single_day_has_no_measurable_spread_and_fails_closed(self) -> None:
        pnls = [0.01] * 30
        verdict = _verdict(pnls, [START] * 30)

        self.assertIsNone(verdict["gatedNetLowerBoundBps"])
        self.assertEqual(verdict["decision"], "DO_NOT_PROMOTE")
        self.assertIn("positiveNetLowerBound", verdict["failedChecks"])

    def test_without_clusters_the_basis_is_labelled_iid(self) -> None:
        self.assertEqual(_verdict(_daily_pnls(), None)["standardErrorBasis"], "IID_ENTRIES")

    def test_mismatched_lengths_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            clustered_mean_and_standard_error([0.1, 0.2], [START])


if __name__ == "__main__":
    unittest.main()
