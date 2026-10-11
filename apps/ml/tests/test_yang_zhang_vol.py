"""
Unit tests for Yang-Zhang volatility estimator.
"""

import unittest
import numpy as np
import pandas as pd

from apps.ml.yang_zhang_vol import compute_yang_zhang_volatility


class TestYangZhangVol(unittest.TestCase):
    def setUp(self):
        np.random.seed(42)
        n = 100
        # Generate synthetic OHLC data
        close_prices = 100.0 * np.exp(np.cumsum(np.random.randn(n) * 0.01))
        open_prices = close_prices * (1.0 + np.random.randn(n) * 0.002)
        high_prices = np.maximum(open_prices, close_prices) * (1.0 + np.abs(np.random.randn(n)) * 0.005)
        low_prices = np.minimum(open_prices, close_prices) * (1.0 - np.abs(np.random.randn(n)) * 0.005)

        self.df = pd.DataFrame(
            {
                "open": open_prices,
                "high": high_prices,
                "low": low_prices,
                "close": close_prices,
            }
        )

    def test_compute_yang_zhang_volatility(self):
        yz_vol = compute_yang_zhang_volatility(
            self.df, window=20, trading_periods=252
        )
        self.assertEqual(len(yz_vol), len(self.df))
        valid_vols = yz_vol.iloc[20:].values
        self.assertTrue(np.all(np.isfinite(valid_vols)))
        # Annualized volatility should be in a reasonable quantitative range (~0.10 to 0.40)
        self.assertTrue((valid_vols > 0.05).all())
        self.assertTrue((valid_vols < 0.60).all())

    def test_invalid_window(self):
        with self.assertRaises(ValueError):
            compute_yang_zhang_volatility(self.df, window=1)


if __name__ == "__main__":
    unittest.main()
