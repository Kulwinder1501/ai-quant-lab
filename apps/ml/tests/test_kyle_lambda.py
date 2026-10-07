"""
Unit tests for Kyle's Lambda price impact estimator.
"""

import unittest
import numpy as np
import pandas as pd
from scipy import stats

from apps.ml.kyle_lambda import (
    compute_signed_volume,
    estimate_kyle_lambda_rolling,
    estimate_kyle_lambda_summary,
)


class TestKyleLambda(unittest.TestCase):
    def setUp(self):
        np.random.seed(42)
        n = 100
        # Synthetic price series driven by signed volume: P_t = P_{t-1} + 0.05 * S_t + noise
        s_vol = np.random.randn(n) * 100
        price_changes = 0.05 * s_vol + np.random.randn(n) * 0.1
        prices = 100.0 + np.cumsum(price_changes)

        self.df = pd.DataFrame(
            {
                "close": prices,
                "volume": np.abs(s_vol),
                "signed_volume": s_vol,
            }
        )

    def test_signed_volume_computation(self):
        s_vol = compute_signed_volume(self.df, price_col="close", volume_col="volume")
        self.assertEqual(len(s_vol), len(self.df))
        self.assertTrue((s_vol.values[1:] != 0).any())

    def test_signed_volume_explicit_col(self):
        s_vol = compute_signed_volume(
            self.df, signed_flow_col="signed_volume"
        )
        np.testing.assert_array_almost_equal(s_vol.values, self.df["signed_volume"].values)

    def test_estimate_kyle_lambda_rolling(self):
        rolling_lambda = estimate_kyle_lambda_rolling(
            self.df, window=20, price_col="close", volume_col="volume"
        )
        self.assertEqual(len(rolling_lambda), len(self.df))
        # After min_periods, rolling lambda should be positive close to ~0.05
        valid_lambdas = rolling_lambda.iloc[20:].values
        self.assertTrue(np.all(np.isfinite(valid_lambdas)))

    def test_estimate_kyle_lambda_summary(self):
        summary = estimate_kyle_lambda_summary(
            self.df, price_col="close", signed_flow_col="signed_volume"
        )
        self.assertIn("kyle_lambda", summary)
        self.assertIn("t_stat", summary)
        self.assertIn("r_squared", summary)
        # Empirical lambda should be close to 0.05
        self.assertAlmostEqual(summary["kyle_lambda"], 0.05, delta=0.02)
        self.assertGreater(summary["t_stat"], 5.0)

    def test_invalid_window(self):
        with self.assertRaises(ValueError):
            estimate_kyle_lambda_rolling(self.df, window=1)

    def test_summary_diagnostics_match_ols_with_nonzero_means(self):
        # Regression test: the model this module's own docstring specifies has an intercept
        # (Delta_P = alpha + lambda*SignedVolume + eps). The original implementation computed
        # residuals as delta_p - lambda*s_vol with no alpha term, and divided by n instead of
        # (n - 1) in the standard-error denominator -- both errors are invisible on data whose
        # sample means happen to be near zero (this file's setUp fixture), which is exactly why
        # this needs its own case with real, nonzero means: signed volume with a nonzero mean
        # (e.g. a session with net buying pressure) and a real price drift (alpha != 0).
        rng = np.random.RandomState(7)
        n = 200
        s_vol = rng.randn(n) * 50 + 30
        price_changes = 2.0 + 0.05 * s_vol + rng.randn(n) * 5
        prices = 100.0 + np.cumsum(price_changes)
        df = pd.DataFrame({"close": prices, "signed_volume": s_vol})

        summary = estimate_kyle_lambda_summary(df, price_col="close", signed_flow_col="signed_volume")

        delta_p = df["close"].diff().dropna()
        s_vol_aligned = df["signed_volume"].loc[delta_p.index]
        reference = stats.linregress(s_vol_aligned, delta_p)

        self.assertAlmostEqual(summary["kyle_lambda"], reference.slope, places=9)
        self.assertAlmostEqual(summary["r_squared"], reference.rvalue ** 2, places=9)
        self.assertAlmostEqual(summary["std_err"], reference.stderr, places=9)
        self.assertAlmostEqual(summary["t_stat"], reference.slope / reference.stderr, places=9)


if __name__ == "__main__":
    unittest.main()
