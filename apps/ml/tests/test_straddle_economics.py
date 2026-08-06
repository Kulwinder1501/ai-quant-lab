"""The pieces that decide the breakeven, especially the ones that can flatter it."""
import math
import unittest

from ai_quant_lab_ml.straddle_economics import (
    StraddleEntry,
    black_scholes_straddle,
    breakeven_precision,
    build_entries,
    realised_volatility,
)


class BlackScholesStraddleTests(unittest.TestCase):
    def test_atm_straddle_is_positive_and_grows_with_tenor(self) -> None:
        short = black_scholes_straddle(spot=1000, strike=1000, time_to_expiry_years=7 / 365, volatility=0.25)
        long = black_scholes_straddle(spot=1000, strike=1000, time_to_expiry_years=30 / 365, volatility=0.25)

        self.assertGreater(short, 0)
        self.assertGreater(long, short)

    def test_grows_with_volatility(self) -> None:
        low = black_scholes_straddle(spot=1000, strike=1000, time_to_expiry_years=30 / 365, volatility=0.15)
        high = black_scholes_straddle(spot=1000, strike=1000, time_to_expiry_years=30 / 365, volatility=0.35)

        self.assertGreater(high, low)

    def test_collapses_to_intrinsic_at_expiry(self) -> None:
        self.assertAlmostEqual(
            black_scholes_straddle(spot=1080, strike=1000, time_to_expiry_years=0, volatility=0.25), 80, places=6
        )

    def test_put_call_parity_holds_at_the_money(self) -> None:
        # An ATM straddle is worth roughly 0.8 * spot * sigma * sqrt(T); a gross departure
        # would mean the pricing is wrong in a way the aggregate would hide.
        spot, sigma, years = 1000.0, 0.20, 30 / 365
        approx = 0.8 * spot * sigma * math.sqrt(years)
        actual = black_scholes_straddle(spot=spot, strike=spot, time_to_expiry_years=years, volatility=sigma)

        self.assertLess(abs(actual - approx) / approx, 0.15)


class RealisedVolatilityTests(unittest.TestCase):
    def test_flat_series_has_no_volatility(self) -> None:
        self.assertIsNone(realised_volatility([100.0] * 10))

    def test_refuses_a_window_too_short_to_measure(self) -> None:
        self.assertIsNone(realised_volatility([100.0, 101.0]))

    def test_annualises(self) -> None:
        closes = [100.0 * (1.01 if i % 2 else 0.99) ** 1 for i in range(30)]
        vol = realised_volatility(closes)

        self.assertIsNotNone(vol)
        assert vol is not None
        self.assertGreater(vol, 0.05)


def entry(pnl_fraction: float, expanded: bool) -> StraddleEntry:
    """An entry whose flat-IV P&L is exactly `pnl_fraction` of spot."""
    spot = 1000.0
    return StraddleEntry(
        symbol="TEST", observed_at="2026-01-01", spot=spot, implied_volatility=0.2,
        entry_premium=50.0, exit_premium_flat_iv=50.0 + pnl_fraction * spot,
        exit_premium_reverted_iv=50.0 + pnl_fraction * spot, expanded=expanded,
    )


class BreakevenPrecisionTests(unittest.TestCase):
    def test_solves_the_precision_that_makes_the_strategy_flat(self) -> None:
        # +2% when it expands, -1% when it does not -> breakeven at one third.
        entries = [entry(0.02, True)] * 30 + [entry(-0.01, False)] * 70

        result = breakeven_precision(entries, reverted=False)

        self.assertAlmostEqual(float(result["breakevenPrecision"]), 1 / 3, places=6)
        self.assertAlmostEqual(float(result["baseRate"]), 0.30, places=6)

    def test_returns_none_when_expansion_entries_also_lose(self) -> None:
        # No precision rescues a strategy that loses in both states, and printing a number
        # would imply one exists.
        entries = [entry(-0.005, True)] * 30 + [entry(-0.01, False)] * 70

        self.assertIsNone(breakeven_precision(entries, reverted=False)["breakevenPrecision"])

    def test_returns_none_without_both_populations(self) -> None:
        self.assertIsNone(breakeven_precision([entry(0.02, True)], reverted=False)["breakevenPrecision"])
        self.assertEqual(breakeven_precision([], reverted=False)["entries"], 0)


class BuildEntriesTests(unittest.TestCase):
    def _bars(self, count: int = 40) -> list[dict[str, object]]:
        bars: list[dict[str, object]] = []
        price = 1000.0
        for i in range(count):
            price *= 1.004 if i % 3 else 0.997
            bars.append({
                "date": f"2026-01-{i + 1:02d}", "close": price,
                "high": price * 1.01, "low": price * 0.99,
            })
        return bars

    def test_prices_an_entry_per_eligible_bar(self) -> None:
        bars = self._bars()
        iv = {str(b["date"]): 0.14 for b in bars}
        rv = {str(b["date"]): 0.11 for b in bars}

        entries = build_entries(
            symbol="TEST", bars=bars, index_iv_by_date=iv, index_rv_by_date=rv, days_to_expiry=30
        )

        self.assertGreater(len(entries), 0)
        for e in entries:
            self.assertGreater(e.entry_premium, 0)
            # The variance risk premium must survive: index IV/RV is 1.27 here, so the
            # proxy has to exceed the stock's own realised vol.
            self.assertGreater(e.implied_volatility, 0)

    def test_reverted_iv_never_values_the_exit_above_flat_iv(self) -> None:
        # Reversion moves IV toward realised, which is lower whenever a premium exists.
        # If this ever inverted, the "conservative" case would be the flattering one.
        bars = self._bars()
        iv = {str(b["date"]): 0.20 for b in bars}
        rv = {str(b["date"]): 0.12 for b in bars}

        entries = build_entries(
            symbol="TEST", bars=bars, index_iv_by_date=iv, index_rv_by_date=rv, days_to_expiry=30
        )

        self.assertGreater(len(entries), 0)
        for e in entries:
            self.assertLessEqual(e.exit_premium_reverted_iv, e.exit_premium_flat_iv + 1e-9)

    def test_skips_bars_with_no_index_reading(self) -> None:
        bars = self._bars()
        entries = build_entries(
            symbol="TEST", bars=bars, index_iv_by_date={}, index_rv_by_date={}, days_to_expiry=30
        )

        self.assertEqual(entries, [])

    def test_a_longer_tenor_costs_more_to_enter(self) -> None:
        bars = self._bars()
        iv = {str(b["date"]): 0.14 for b in bars}
        rv = {str(b["date"]): 0.11 for b in bars}
        short = build_entries(symbol="T", bars=bars, index_iv_by_date=iv, index_rv_by_date=rv, days_to_expiry=7)
        long = build_entries(symbol="T", bars=bars, index_iv_by_date=iv, index_rv_by_date=rv, days_to_expiry=30)

        self.assertEqual(len(short), len(long))
        self.assertGreater(long[0].entry_premium, short[0].entry_premium)


if __name__ == "__main__":
    unittest.main()
