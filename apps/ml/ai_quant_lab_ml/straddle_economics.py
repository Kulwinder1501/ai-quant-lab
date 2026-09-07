"""Breakeven EXPANSION precision for a long ATM straddle, priced at a tradable tenor.

The 2026-08-04 equity-panel study priced a **5-trading-day** straddle held to expiry at
intrinsic, and reported a 43.7% breakeven across 14,374 entries. That contract does not
exist: NSE single-stock options are monthly-only, confirmed against the provider's own
expiry list on 2026-08-05. A five-day equity straddle was never purchasable, so the number
described a contract nobody could buy.

Two things change when the tenor is real:

* **The position is closed, not expired.** The signal forecasts a 5-day range, so a monthly
  contract is bought and sold five days later. The buyer no longer surrenders all extrinsic
  value; they pay five days of theta and keep the rest.
* **Exit implied volatility becomes an assumption**, and it is the assumption that decides
  the answer. Held flat it flatters the buyer, because volatility usually falls after the
  expansion the signal is predicting. Both cases are computed and reported.

Tenor is swept rather than pinned. NSE moved monthly expiry from the last Thursday to the
last Tuesday, and this repository cannot verify which applied on a given 2023 date -- pinning
one would repeat the phantom-contract error that put two paper trades on a BANKNIFTY weekly
that never traded. Days-to-expiry is a parameter, and the sweep shows how much the conclusion
depends on it, which is the more useful answer anyway.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, Mapping, Sequence

TRADING_DAYS_PER_YEAR = 252
CALENDAR_DAYS_PER_YEAR = 365.0


def _mean_and_standard_error(values: Sequence[float]) -> tuple[float | None, float | None]:
    if not values:
        return None, None
    mean = sum(values) / len(values)
    if len(values) < 2:
        return mean, None
    variance = sum((value - mean) ** 2 for value in values) / (len(values) - 1)
    return mean, math.sqrt(variance / len(values))


def cost_aware_promotion_verdict(
    *,
    gated_pnls: Sequence[float],
    always_enter_pnls: Sequence[float],
    fee_bps: float = 5.0,
    minimum_scored: int = 300,
    minimum_gated: int = 60,
    confidence_z: float = 1.96,
) -> dict[str, object]:
    """Fail-closed economic gate for a shadow volatility strategy.

    P&L values are fractions of spot. Passing requires enough observations, a
    positive fee-adjusted mean, a positive lower confidence bound, and an
    improvement over entering on every opportunity. Precision alone is not an
    economic verdict because the label and option payoff are different targets.
    """

    if not math.isfinite(fee_bps) or fee_bps < 0:
        raise ValueError("fee_bps must be a non-negative finite number.")
    if minimum_scored < 1 or minimum_gated < 1:
        raise ValueError("minimum sample sizes must be positive integers.")
    if not math.isfinite(confidence_z) or confidence_z <= 0:
        raise ValueError("confidence_z must be a positive finite number.")

    gated_mean, gated_se = _mean_and_standard_error(gated_pnls)
    always_mean, _ = _mean_and_standard_error(always_enter_pnls)
    fee_fraction = fee_bps / 10_000
    gated_net = None if gated_mean is None else gated_mean - fee_fraction
    always_net = None if always_mean is None else always_mean - fee_fraction
    lower_bound = (
        None if gated_net is None or gated_se is None
        else gated_net - confidence_z * gated_se
    )

    checks = {
        "minimumScored": len(always_enter_pnls) >= minimum_scored,
        "minimumGated": len(gated_pnls) >= minimum_gated,
        "positiveNetMean": gated_net is not None and gated_net > 0,
        "positiveNetLowerBound": lower_bound is not None and lower_bound > 0,
        "beatsAlwaysEnter": (
            gated_net is not None and always_net is not None and gated_net > always_net
        ),
    }
    failed = [name for name, passed in checks.items() if not passed]
    return {
        "decision": "COST_GATE_PASSED" if not failed else "DO_NOT_PROMOTE",
        "feeBps": fee_bps,
        "minimumScored": minimum_scored,
        "minimumGated": minimum_gated,
        "confidenceZ": confidence_z,
        "gatedNetMeanBps": None if gated_net is None else gated_net * 10_000,
        "alwaysEnterNetMeanBps": None if always_net is None else always_net * 10_000,
        "gatedNetLowerBoundBps": None if lower_bound is None else lower_bound * 10_000,
        "checks": checks,
        "failedChecks": failed,
    }


def _normal_cdf(value: float) -> float:
    return 0.5 * (1.0 + math.erf(value / math.sqrt(2.0)))


def black_scholes_straddle(
    *,
    spot: float,
    strike: float,
    time_to_expiry_years: float,
    volatility: float,
    risk_free_rate: float = 0.065,
) -> float:
    """Combined call+put premium. Intrinsic once time or volatility has gone."""

    if spot <= 0 or strike <= 0:
        raise ValueError("Spot and strike must be positive.")
    if time_to_expiry_years <= 0 or volatility <= 0:
        return abs(spot - strike)

    sqrt_t = math.sqrt(time_to_expiry_years)
    d1 = (math.log(spot / strike) + (risk_free_rate + 0.5 * volatility**2) * time_to_expiry_years) / (
        volatility * sqrt_t
    )
    d2 = d1 - volatility * sqrt_t
    discount = math.exp(-risk_free_rate * time_to_expiry_years)
    call = spot * _normal_cdf(d1) - strike * discount * _normal_cdf(d2)
    put = strike * discount * _normal_cdf(-d2) - spot * _normal_cdf(-d1)
    return call + put


def realised_volatility(closes: Sequence[float]) -> float | None:
    """Annualised close-to-close volatility. None when the window cannot support one."""

    if len(closes) < 3:
        return None
    returns = [
        math.log(closes[i] / closes[i - 1])
        for i in range(1, len(closes))
        if closes[i] > 0 and closes[i - 1] > 0
    ]
    if len(returns) < 2:
        return None
    mean = sum(returns) / len(returns)
    variance = sum((r - mean) ** 2 for r in returns) / (len(returns) - 1)
    if variance <= 0:
        return None
    return math.sqrt(variance * TRADING_DAYS_PER_YEAR)


@dataclass(frozen=True)
class StraddleEntry:
    """One priced entry and what the following horizon did to it."""

    symbol: str
    observed_at: str
    spot: float
    implied_volatility: float
    entry_premium: float
    exit_premium_flat_iv: float
    exit_premium_reverted_iv: float
    expanded: bool

    def pnl_fraction(self, *, reverted: bool) -> float:
        """P&L as a fraction of spot, so instruments at different price levels combine."""
        exit_premium = self.exit_premium_reverted_iv if reverted else self.exit_premium_flat_iv
        return (exit_premium - self.entry_premium) / self.spot


def breakeven_precision(entries: Sequence[StraddleEntry], *, reverted: bool) -> dict[str, float | int | None]:
    """The EXPANSION precision at which the strategy stops losing money.

    ``p * win + (1 - p) * loss = 0`` solved for ``p``. Returns None for the precision when
    the two populations do not straddle zero -- if expansion entries also lose on average
    there is no precision that rescues it, and reporting a number would imply one exists.
    """

    if not entries:
        return {"entries": 0, "breakevenPrecision": None, "meanWin": None, "meanLoss": None, "baseRate": None}

    wins = [e.pnl_fraction(reverted=reverted) for e in entries if e.expanded]
    losses = [e.pnl_fraction(reverted=reverted) for e in entries if not e.expanded]
    if not wins or not losses:
        return {"entries": len(entries), "breakevenPrecision": None, "meanWin": None, "meanLoss": None, "baseRate": None}

    mean_win = sum(wins) / len(wins)
    mean_loss = sum(losses) / len(losses)
    all_pnl = [e.pnl_fraction(reverted=reverted) for e in entries]

    breakeven: float | None = None
    if mean_win > 0 > mean_loss:
        breakeven = -mean_loss / (mean_win - mean_loss)

    return {
        "entries": len(entries),
        "baseRate": len(wins) / len(entries),
        "meanWin": mean_win,
        "meanLoss": mean_loss,
        "meanPnl": sum(all_pnl) / len(all_pnl),
        "winRate": sum(1 for p in all_pnl if p > 0) / len(all_pnl),
        "breakevenPrecision": breakeven,
    }


def build_entries(
    *,
    symbol: str,
    bars: Sequence[Mapping[str, object]],
    index_iv_by_date: Mapping[str, float],
    index_rv_by_date: Mapping[str, float],
    days_to_expiry: int,
    horizon_bars: int = 5,
    trailing_bars: int = 5,
    expansion_band: float = 0.25,
    volatility_window: int = 20,
    reversion_weight: float = 0.5,
) -> list[StraddleEntry]:
    """Price one straddle per eligible bar and grade it against the forward window.

    `bars` must be chronological and carry `date`, `high`, `low`, `close`.

    The IV proxy is the stock's own realised volatility scaled by the index
    implied/realised ratio for that session. India VIX applied directly to a single stock
    would understate its volatility and make straddles look cheap; the stock's raw realised
    volatility would delete the variance risk premium, which is the entire reason buying
    premium loses. Scaling keeps the premium and the stock's own level.
    """

    entries: list[StraddleEntry] = []
    first = max(volatility_window, trailing_bars)
    for index in range(first, len(bars) - horizon_bars):
        bar = bars[index]
        date = str(bar["date"])
        index_iv = index_iv_by_date.get(date)
        index_rv = index_rv_by_date.get(date)
        if index_iv is None or index_rv is None or index_rv <= 0:
            continue

        closes = [float(b["close"]) for b in bars[index - volatility_window : index + 1]]
        stock_rv = realised_volatility(closes)
        if stock_rv is None or stock_rv <= 0:
            continue

        # The variance risk premium, carried across from the index and applied to this
        # stock's own volatility level.
        implied = stock_rv * (index_iv / index_rv)
        if implied <= 0:
            continue

        spot = float(bar["close"])
        if spot <= 0:
            continue

        trailing = [float(b["high"]) for b in bars[index - trailing_bars + 1 : index + 1]]
        trailing_low = [float(b["low"]) for b in bars[index - trailing_bars + 1 : index + 1]]
        trailing_range = max(trailing) - min(trailing_low)
        forward = bars[index + 1 : index + 1 + horizon_bars]
        forward_range = max(float(b["high"]) for b in forward) - min(float(b["low"]) for b in forward)
        if trailing_range <= 0:
            continue
        expanded = forward_range > trailing_range * (1.0 + expansion_band)

        strike = spot  # At the money, as the label carries no directional view.
        entry_years = days_to_expiry / CALENDAR_DAYS_PER_YEAR
        # Five *trading* days later is about seven calendar days of decay.
        exit_days = max(0.0, days_to_expiry - horizon_bars * (CALENDAR_DAYS_PER_YEAR / TRADING_DAYS_PER_YEAR))
        exit_years = exit_days / CALENDAR_DAYS_PER_YEAR
        exit_spot = float(forward[-1]["close"])

        entry_premium = black_scholes_straddle(
            spot=spot, strike=strike, time_to_expiry_years=entry_years, volatility=implied
        )
        flat = black_scholes_straddle(
            spot=exit_spot, strike=strike, time_to_expiry_years=exit_years, volatility=implied
        )
        # Volatility usually falls after the expansion this signal predicts, so holding it
        # flat is an upper bound on the exit value. Reverting part-way toward realised is
        # the more representative case.
        reverted_iv = implied + (stock_rv - implied) * reversion_weight
        reverted = black_scholes_straddle(
            spot=exit_spot, strike=strike, time_to_expiry_years=exit_years, volatility=max(reverted_iv, 1e-6)
        )

        entries.append(
            StraddleEntry(
                symbol=symbol,
                observed_at=date,
                spot=spot,
                implied_volatility=implied,
                entry_premium=entry_premium,
                exit_premium_flat_iv=flat,
                exit_premium_reverted_iv=reverted,
                expanded=expanded,
            )
        )
    return entries


def sweep_tenors(
    *,
    panels: Iterable[tuple[str, Sequence[Mapping[str, object]]]],
    index_iv_by_date: Mapping[str, float],
    index_rv_by_date: Mapping[str, float],
    tenors: Sequence[int],
    **kwargs: object,
) -> list[dict[str, object]]:
    """Breakeven precision at each candidate days-to-expiry, flat and reverted IV."""

    rows: list[dict[str, object]] = []
    for days in tenors:
        entries: list[StraddleEntry] = []
        for symbol, bars in panels:
            entries.extend(
                build_entries(
                    symbol=symbol,
                    bars=bars,
                    index_iv_by_date=index_iv_by_date,
                    index_rv_by_date=index_rv_by_date,
                    days_to_expiry=days,
                    **kwargs,  # type: ignore[arg-type]
                )
            )
        rows.append(
            {
                "daysToExpiry": days,
                "flatIv": breakeven_precision(entries, reverted=False),
                "revertedIv": breakeven_precision(entries, reverted=True),
            }
        )
    return rows
