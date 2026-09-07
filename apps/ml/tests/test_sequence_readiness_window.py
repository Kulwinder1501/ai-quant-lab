"""The zero-volume refusal must name the fix, because the fix is not more data."""
import unittest

from ai_quant_lab_ml.sequence_readiness import (
    assess_training_window,
    earliest_reliable_volume_year,
)


class EarliestReliableVolumeYearTests(unittest.TestCase):
    def test_returns_the_first_year_after_which_everything_is_clean(self) -> None:
        # BANKBEES 5m as measured 2026-08-05: 20% zero-volume in its launch year, then clean.
        measured = {2019: 0.200, 2020: 0.0043, 2021: 0.0, 2022: 0.0}

        self.assertEqual(
            earliest_reliable_volume_year(measured, maximum_zero_volume_fraction=0.01),
            2020,
        )

    def test_a_bad_later_year_cannot_be_hidden_by_clean_early_ones(self) -> None:
        # Walking forwards would answer 2019 and send the operator to a window that still
        # fails, because 2021 is dirty.
        measured = {2019: 0.0, 2020: 0.0, 2021: 0.5}

        self.assertIsNone(
            earliest_reliable_volume_year(measured, maximum_zero_volume_fraction=0.01)
        )

    def test_returns_none_when_no_year_clears(self) -> None:
        self.assertIsNone(
            earliest_reliable_volume_year({2019: 0.9, 2020: 0.8}, maximum_zero_volume_fraction=0.01)
        )

    def test_returns_none_without_measurements(self) -> None:
        self.assertIsNone(earliest_reliable_volume_year({}, maximum_zero_volume_fraction=0.01))

    def test_a_single_clean_year_qualifies(self) -> None:
        self.assertEqual(
            earliest_reliable_volume_year({2026: 0.0}, maximum_zero_volume_fraction=0.01),
            2026,
        )


class ZeroVolumeFindingTests(unittest.TestCase):
    def _measurements(self, **overrides: object) -> dict[str, object]:
        base: dict[str, object] = {
            "barCount": 140_517,
            "sessionCount": 1_882,
            "zeroVolumeFraction": 0.026,
            "zeroVolumeFractionByYear": {2019: 0.200, 2020: 0.0043, 2021: 0.0},
            "providers": ["fyers-api-v3"],
            "instrumentSemantics": "ETF_PROXY",
        }
        base.update(overrides)
        return base

    def test_names_the_year_to_start_from(self) -> None:
        result = assess_training_window(self._measurements(), candidate="tcn-5m")

        self.assertEqual(result["verdict"], "FAIL")
        detail = next(
            f["detail"] for f in result["findings"] if f["code"] == "WINDOW_ZERO_VOLUME"
        )
        self.assertIn("2020-01-01", detail)
        self.assertIn("rather than fetching more history", detail)

    def test_says_so_when_no_start_would_help(self) -> None:
        result = assess_training_window(
            self._measurements(zeroVolumeFractionByYear={2019: 0.9, 2020: 0.8}),
            candidate="tcn-5m",
        )

        detail = next(
            f["detail"] for f in result["findings"] if f["code"] == "WINDOW_ZERO_VOLUME"
        )
        self.assertIn("the problem is not the window start", detail)

    def test_a_clean_window_still_passes(self) -> None:
        result = assess_training_window(
            self._measurements(
                zeroVolumeFraction=0.0007,
                zeroVolumeFractionByYear={2020: 0.0007, 2021: 0.0},
            ),
            candidate="tcn-5m",
        )

        self.assertEqual(result["verdict"], "PASS")


if __name__ == "__main__":
    unittest.main()
