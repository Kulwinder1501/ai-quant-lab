"""
Unit tests for Kyle's Lambda price impact estimator.
"""

import unittest
import numpy as np
import pandas as pd

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


if __name__ == "__main__":
    unittest.main()
