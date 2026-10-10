"""Analytic and contract tests for the Yang-Zhang estimator (NaN, validation, annualisation)."""

import math
import unittest

import numpy as np
import pandas as pd

from apps.ml.yang_zhang_vol import compute_yang_zhang_volatility

WINDOW = 20
K = 0.34 / (1.34 + (WINDOW + 1.0) / (WINDOW - 1.0))


def _flat_bars(prices: list[float]) -> pd.DataFrame:
    """Every bar open == high == low == close: only overnight returns carry variance."""
    return pd.DataFrame({"open": prices, "high": prices, "low": prices, "close": prices})


def _range_bars(count: int, up: float, down: float) -> pd.DataFrame:
    """Open == close == 100 every bar, high/low a fixed log distance away: only the RS term is non-zero."""
    return pd.DataFrame(
        {
            "open": [100.0] * count,
            "close": [100.0] * count,
            "high": [100.0 * math.exp(up)] * count,
            "low": [100.0 * math.exp(-down)] * count,
        }
    )


class AnalyticTests(unittest.TestCase):
    def test_overnight_term_alone(self) -> None:
        # Close-to-close log returns alternate +a, -a: a 20-return window has mean 0 and
        # sample variance 20 a^2 / 19. With o=c, var_c = 0 and RS = 0, so
        # YZ vol = sqrt(20 a^2 / 19 * 252).
        a = 0.01
        prices = [100.0]
        for index in range(60):
            prices.append(prices[-1] * math.exp(a if index % 2 == 0 else -a))
        vol = compute_yang_zhang_volatility(_flat_bars(prices), window=WINDOW)

        expected = math.sqrt(20 * a * a / 19 * 252)
        self.assertAlmostEqual(float(vol.iloc[40]), expected, places=12)

    def test_rogers_satchell_term_alone(self) -> None:
        # o = c = 100 every bar -> var_o = var_c = 0; RS = u^2 + d^2 for a fixed range, so
        # YZ vol = sqrt((1 - k) (u^2 + d^2) * 252).
        up, down = 0.012, 0.008
        vol = compute_yang_zhang_volatility(_range_bars(60, up, down), window=WINDOW)

        expected = math.sqrt((1 - K) * (up * up + down * down) * 252)
        self.assertAlmostEqual(float(vol.iloc[40]), expected, places=12)

    def test_intraday_annualisation_scales_by_sqrt_of_bars_per_session(self) -> None:
        frame = _range_bars(60, 0.004, 0.003)
        daily = compute_yang_zhang_volatility(frame, window=WINDOW)
        intraday = compute_yang_zhang_volatility(frame, window=WINDOW, bars_per_session=25)

        self.assertAlmostEqual(float(intraday.iloc[40]) / float(daily.iloc[40]), 5.0, places=12)


class NanContractTests(unittest.TestCase):
    def test_warm_up_is_nan_not_zero(self) -> None:
        vol = compute_yang_zhang_volatility(_range_bars(40, 0.01, 0.01), window=WINDOW, min_periods=10)

        # log_oc[0] is NaN, so the first estimate needs 10 usable returns: index 10.
        self.assertTrue(vol.iloc[:10].isna().all())
        self.assertTrue(vol.iloc[10:].notna().all())
        self.assertFalse((vol.dropna() == 0.0).any())

    def test_an_inconsistent_bar_poisons_every_window_that_touches_it(self) -> None:
        frame = _range_bars(100, 0.01, 0.01)
        frame.loc[30, "high"] = 99.0  # high below open/close: not a real bar
        vol = compute_yang_zhang_volatility(frame, window=WINDOW)

        # Row 30 is invalid and row 31's overnight return reads its close: windows ending 30..50.
        self.assertTrue(np.isfinite(vol.iloc[29]))
        self.assertTrue(vol.iloc[30:51].isna().all())
        self.assertTrue(np.isfinite(vol.iloc[51]))

    def test_non_positive_and_non_finite_prices_are_nan_without_raising(self) -> None:
        frame = _range_bars(100, 0.01, 0.01)
        frame.loc[40, "close"] = 0.0
        frame.loc[60, "open"] = float("nan")
        with np.errstate(all="raise"):  # a leaked log(0) / divide would raise here
            vol = compute_yang_zhang_volatility(frame, window=WINDOW)

        self.assertTrue(vol.iloc[40:61].isna().all())
        self.assertTrue(vol.iloc[60:81].isna().all())
        self.assertFalse(np.isinf(vol.dropna()).any())

    def test_a_clean_series_has_no_nan_after_warm_up(self) -> None:
        vol = compute_yang_zhang_volatility(_range_bars(60, 0.01, 0.01), window=WINDOW)
        self.assertTrue(vol.iloc[10:].notna().all())


class ArgumentValidationTests(unittest.TestCase):
    def test_rejects_bad_arguments(self) -> None:
        frame = _range_bars(30, 0.01, 0.01)
        with self.assertRaises(ValueError):
            compute_yang_zhang_volatility(frame, bars_per_session=0)
        with self.assertRaises(ValueError):
            compute_yang_zhang_volatility(frame, trading_periods=0)
        with self.assertRaises(ValueError):
            compute_yang_zhang_volatility(frame, window=10, min_periods=11)
        with self.assertRaises(ValueError):
            compute_yang_zhang_volatility(frame.drop(columns=["high"]))


if __name__ == "__main__":
    unittest.main()
