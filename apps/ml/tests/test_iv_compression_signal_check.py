from __future__ import annotations

import unittest
from datetime import UTC, date, datetime, timedelta

from iv_compression_signal_check import (
    AtmIvSnapshot,
    MINIMUM_DISTINCT_DAYS,
    _bs_price,
    _mid,
    iv_features_as_of,
    solve_implied_volatility,
)


class SolveImpliedVolatilityTests(unittest.TestCase):
    """Round-trip the Python solver against its own pricer, the only test that
    really matters (mirrors implied-volatility.test.ts's own reasoning)."""

    def test_recovers_a_known_call_volatility(self) -> None:
        premium = _bs_price(24_000, 24_000, 21 / 365, 0.065, 0.18, "CE")
        solved = solve_implied_volatility(
            premium=premium, spot=24_000, strike=24_000, time_to_expiry_years=21 / 365, option_type="CE",
        )
        assert solved is not None
        self.assertAlmostEqual(solved, 0.18, places=5)

    def test_recovers_a_known_put_volatility(self) -> None:
        premium = _bs_price(24_000, 24_000, 21 / 365, 0.065, 0.25, "PE")
        solved = solve_implied_volatility(
            premium=premium, spot=24_000, strike=24_000, time_to_expiry_years=21 / 365, option_type="PE",
        )
        assert solved is not None
        self.assertAlmostEqual(solved, 0.25, places=5)

    def test_recovers_volatility_for_an_out_of_the_money_strike(self) -> None:
        premium = _bs_price(24_000, 26_000, 21 / 365, 0.065, 0.22, "CE")
        solved = solve_implied_volatility(
            premium=premium, spot=24_000, strike=26_000, time_to_expiry_years=21 / 365, option_type="CE",
        )
        assert solved is not None
        self.assertAlmostEqual(solved, 0.22, places=2)

    def test_refuses_an_expired_contract(self) -> None:
        self.assertIsNone(
            solve_implied_volatility(premium=120, spot=24_000, strike=24_000, time_to_expiry_years=0, option_type="CE")
        )

    def test_refuses_a_non_positive_premium(self) -> None:
        self.assertIsNone(
            solve_implied_volatility(premium=0, spot=24_000, strike=24_000, time_to_expiry_years=0.1, option_type="CE")
        )

    def test_refuses_a_premium_below_the_no_arbitrage_floor(self) -> None:
        # Intrinsic here is ~4,077; 100 cannot be produced by any volatility.
        self.assertIsNone(
            solve_implied_volatility(premium=100, spot=24_000, strike=20_000, time_to_expiry_years=21 / 365, option_type="CE")
        )

    def test_refuses_a_premium_with_extrinsic_below_the_price_resolution_floor(self) -> None:
        # Deep ITM: almost all premium is intrinsic value, so the tiny remainder
        # cannot honestly be inverted (mirrors index.ts's EXTRINSIC_BELOW_PRICE_RESOLUTION case).
        premium = _bs_price(24_000, 18_000, 21 / 365, 0.065, 0.22, "CE")
        solved = solve_implied_volatility(
            premium=premium, spot=24_000, strike=18_000, time_to_expiry_years=21 / 365, option_type="CE",
        )
        self.assertIsNone(solved)


class MidPriceTests(unittest.TestCase):
    def test_returns_the_mid_of_a_two_sided_quote(self) -> None:
        self.assertAlmostEqual(_mid(99, 101), 100.0)

    def test_returns_none_for_a_one_sided_or_crossed_market(self) -> None:
        self.assertIsNone(_mid(None, 101))
        self.assertIsNone(_mid(99, None))
        self.assertIsNone(_mid(0, 101))
        self.assertIsNone(_mid(101, 99))


class IvFeaturesAsOfTests(unittest.TestCase):
    """The causal guarantee that matters most here: no percentile before enough
    strictly-prior days exist, and never a same-day data point in that history."""

    def _series(self, days: int, iv_by_day: dict[int, float] | None = None) -> tuple[list[AtmIvSnapshot], dict, list]:
        base = datetime(2026, 8, 4, 9, 0, tzinfo=UTC)
        series = []
        daily_representative: dict[date, float] = {}
        for offset in range(days):
            observed_at = base + timedelta(days=offset)
            iv = (iv_by_day or {}).get(offset, 0.15)
            series.append(AtmIvSnapshot(observed_at=observed_at, implied_volatility=iv))
            daily_representative[observed_at.date()] = iv
        return series, daily_representative, sorted(daily_representative)

    def test_refuses_a_percentile_with_fewer_than_the_minimum_trailing_days(self) -> None:
        series, daily_representative, sorted_days = self._series(MINIMUM_DISTINCT_DAYS)  # exactly at threshold, 0 prior
        series_times = [s.observed_at for s in series]
        result = iv_features_as_of(series, series_times, daily_representative, sorted_days, series[0].observed_at)
        self.assertIsNone(result)

    def test_measures_a_percentile_once_enough_trailing_days_exist(self) -> None:
        days = MINIMUM_DISTINCT_DAYS + 5
        series, daily_representative, sorted_days = self._series(days)
        series_times = [s.observed_at for s in series]
        as_of = series[-1].observed_at
        result = iv_features_as_of(series, series_times, daily_representative, sorted_days, as_of)
        assert result is not None
        self.assertIn("iv.percentile", result)
        self.assertIn("iv.level", result)
        self.assertIn("iv.change_vs_prior_day_bps", result)

    def test_never_uses_a_same_day_snapshot_as_its_own_history(self) -> None:
        # All history at 0.15, today's own reading spikes to 0.90. If today's own
        # value leaked into its history the percentile could not read 100.
        days = MINIMUM_DISTINCT_DAYS + 1
        series, daily_representative, sorted_days = self._series(days, iv_by_day={days - 1: 0.90})
        series_times = [s.observed_at for s in series]
        result = iv_features_as_of(series, series_times, daily_representative, sorted_days, series[-1].observed_at)
        assert result is not None
        self.assertEqual(result["iv.percentile"], 100.0)

    def test_refuses_a_stale_snapshot(self) -> None:
        days = MINIMUM_DISTINCT_DAYS + 5
        series, daily_representative, sorted_days = self._series(days)
        series_times = [s.observed_at for s in series]
        far_future = series[-1].observed_at + timedelta(hours=2)
        result = iv_features_as_of(series, series_times, daily_representative, sorted_days, far_future)
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
