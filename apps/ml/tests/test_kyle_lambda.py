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
        # The circular default (volume * sign(dP)) is now opt-in only.
        s_vol = compute_signed_volume(
            self.df, price_col="close", volume_col="volume", allow_circular_tick_rule=True
        )
        self.assertEqual(len(s_vol), len(self.df))
        self.assertTrue((s_vol.values[1:] != 0).any())
        # The first bar has no dP: NaN, not a fabricated 0.
        self.assertTrue(np.isnan(s_vol.iloc[0]))

    def test_signed_volume_requires_caller_supplied_flow(self):
        with self.assertRaises(ValueError):
            compute_signed_volume(self.df, price_col="close", volume_col="volume")
        with self.assertRaises(ValueError):
            compute_signed_volume(self.df, signed_flow_col="no_such_column")
        with self.assertRaises(ValueError):
            estimate_kyle_lambda_rolling(self.df, window=20)
        with self.assertRaises(ValueError):
            estimate_kyle_lambda_summary(self.df)

    def test_default_tick_rule_is_circular_and_manufactures_significance(self):
        # Pure noise: prices are a random walk and the "flow" is independent of them.
        rng = np.random.RandomState(11)
        n = 600
        prices = 100.0 + np.cumsum(rng.randn(n))
        independent_flow = rng.randn(n) * 100
        df = pd.DataFrame({"close": prices, "volume": np.abs(rng.randn(n)) * 100 + 1, "ofi": independent_flow})
        honest = estimate_kyle_lambda_summary(df, signed_flow_col="ofi")
        circular = estimate_kyle_lambda_summary(df, allow_circular_tick_rule=True)
        self.assertLess(abs(honest["t_stat"]), 4.0)
        # volume*sign(dP) is built from dP itself: guaranteed "impact" with a huge t-stat.
        self.assertGreater(circular["t_stat"], 8.0)

    def test_rolling_propagates_nan_instead_of_zero(self):
        df = self.df.copy()
        df["flat_flow"] = 5.0  # zero variance -> lambda undefined
        rolling = estimate_kyle_lambda_rolling(df, window=20, signed_flow_col="flat_flow")
        self.assertTrue(rolling.isna().all())
        self.assertFalse((rolling == 0.0).any())
        # Warm-up rows are NaN as well.
        ok = estimate_kyle_lambda_rolling(self.df, window=20, signed_flow_col="signed_volume")
        self.assertTrue(ok.iloc[:5].isna().all())

    def test_summary_drops_nan_pairs_and_marks_degenerate_as_nan(self):
        df = self.df.copy()
        df.loc[10:12, "signed_volume"] = np.nan
        summary = estimate_kyle_lambda_summary(df, signed_flow_col="signed_volume")
        self.assertTrue(np.isfinite(summary["kyle_lambda"]))
        self.assertEqual(summary["n_obs"], len(self.df) - 1 - 3)
        degenerate = estimate_kyle_lambda_summary(
            pd.DataFrame({"close": [1.0, 2.0, 3.0], "s": [1.0, 1.0, 1.0]}), signed_flow_col="s"
        )
        self.assertTrue(np.isnan(degenerate["kyle_lambda"]))
        self.assertTrue(np.isnan(degenerate["t_stat"]))

    def test_signed_volume_explicit_col(self):
        s_vol = compute_signed_volume(
            self.df, signed_flow_col="signed_volume"
        )
        np.testing.assert_array_almost_equal(s_vol.values, self.df["signed_volume"].values)

    def test_estimate_kyle_lambda_rolling(self):
        rolling_lambda = estimate_kyle_lambda_rolling(
            self.df, window=20, price_col="close", volume_col="volume", signed_flow_col="signed_volume"
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
            estimate_kyle_lambda_rolling(self.df, window=1, signed_flow_col="signed_volume")

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
