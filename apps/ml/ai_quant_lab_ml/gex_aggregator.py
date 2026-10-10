"""
Dealer gamma exposure (GEX) from captured option-chain snapshots.

No GEX model existed anywhere in this repository before this file. The scanner's
`GEXContext` / `OptionsContext` (fibonacci_pit_engine.py) only ever carried a snapshot
FRESHNESS state -- its own docstring says so: "This is NOT gamma exposure (GEX). No GEX
model exists in this repository: gamma exposure needs per-strike gamma x open interest x
contract multiplier aggregated by dealer-positioning assumptions, and nothing here
computes it." `pcrRatio` was carried on that struct but never read by anything.

This computes the aggregate from data the system already captures (`option_chain_snapshots`:
strike, OI, bid/ask, expiry) plus a Black-Scholes gamma solved per contract -- the exact
approach `apps/api/src/modules/market-data/domain/chain-greeks.ts` already uses for
single-contract screening (an entry gate solving one strike's delta), generalized here to
every strike in a snapshot and summed.

Faithfully ports the TypeScript math in `packages/pricing/src/index.ts` so a gamma computed
here agrees with what the API's own per-contract screening would compute for the same quote:
  - `priceEuropeanOption` -> `price_european_option` (Black-Scholes-Merton, closed form)
  - `impliedVolatilityFromPremium` -> `implied_volatility_from_premium` (Newton, bisection
    fallback, same refusal taxonomy and numeric tolerances)
  - `impliedForwardFromParity` -> `implied_forward_from_parity` (median put-call-parity
    forward across paired strikes at one expiry, so index dividend carry does not bias delta)
  - `effectiveSpotForForward` -> `effective_spot_for_forward`

ASSUMPTION THIS MODULE DOES NOT VALIDATE: aggregating signed "dealer" gamma exposure
requires assuming which side of each trade the dealer is on. The convention used here
(matching common public GEX writeups) is dealers net long gamma from calls and net short
gamma from puts, so call open interest adds to the total and put open interest subtracts.
No empirical test of that assumption exists anywhere in this codebase. `netDealerGammaExposure`
is a hypothesis input for F1-F4 testing, exactly like a Fibonacci zone is before it clears
a matched-pair gate -- not a validated signal. `putCallOiRatio` carries no such assumption
and is reported alongside it for that reason.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Literal, Optional, Sequence, Tuple

OptionType = Literal["CE", "PE"]

RISK_FREE_RATE = 0.065
DAYS_PER_YEAR = 365.0
SQRT_2PI = math.sqrt(2 * math.pi)

MINIMUM_VOLATILITY = 0.0001
MAXIMUM_VOLATILITY = 5.0
PRICE_TOLERANCE = 1e-6
MAXIMUM_ITERATIONS = 100
# See packages/pricing/src/index.ts's MINIMUM_EXTRINSIC_FOR_IV docstring: a premium whose
# extrinsic part sits below one real price tick resolves the rounding, not the market.
MINIMUM_EXTRINSIC_FOR_IV = 0.05

# "Dollar gamma per 1% underlying move" convention: gamma * OI * multiplier * spot^2 * 0.01.
GEX_SPOT_MOVE_FRACTION = 0.01

ImpliedVolatilityRefusal = Literal[
    "EXPIRED_OR_ZERO_TIME",
    "NO_PREMIUM",
    "BELOW_INTRINSIC",
    "ABOVE_UPPER_BOUND",
    "EXTRINSIC_BELOW_PRICE_RESOLUTION",
    "DID_NOT_CONVERGE",
]

# Reasons a contract row never reached an IV refusal at all (upstream of the solver).
ContractSkipReason = Literal[
    "NO_TWO_SIDED_QUOTE",
    "NO_OPEN_INTEREST",
    "EXPIRED_OR_ZERO_TIME",
    "INVALID_SPOT",
]


def _norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / SQRT_2PI


def _norm_cdf(x: float) -> float:
    """Abramowitz & Stegun 26.2.17. Matches packages/pricing/src/index.ts's normCdf exactly."""
    abs_x = abs(x)
    t = 1 / (1 + 0.2316419 * abs_x)
    poly = t * (0.319381530
                + t * (-0.356563782
                       + t * (1.781477937
                              + t * (-1.821255978
                                     + t * 1.330274429))))
    approx = 1 - _norm_pdf(abs_x) * poly
    return approx if x >= 0 else 1 - approx


def _intrinsic_value(spot: float, strike: float, option_type: OptionType) -> float:
    return max(0.0, spot - strike) if option_type == "CE" else max(0.0, strike - spot)


@dataclass(frozen=True)
class OptionGreeks:
    premium: float
    delta: float
    gamma: float
    theta: float
    vega: float
    intrinsic_value: float
    time_value: float


def price_european_option(
    spot: float,
    strike: float,
    time_to_expiry_years: float,
    risk_free_rate: float,
    volatility: float,
    option_type: OptionType,
) -> OptionGreeks:
    """Port of priceEuropeanOption. T<=0 or sigma<=0 returns intrinsic value, zero greeks."""
    if not (math.isfinite(spot) and spot > 0):
        raise ValueError("Spot must be a positive finite number.")
    if not (math.isfinite(strike) and strike > 0):
        raise ValueError("Strike must be a positive finite number.")

    intrinsic = _intrinsic_value(spot, strike, option_type)
    t = time_to_expiry_years
    sigma = volatility

    if not (math.isfinite(t) and t > 0 and math.isfinite(sigma) and sigma > 0):
        return OptionGreeks(
            premium=round(intrinsic, 2), delta=0.0, gamma=0.0, theta=0.0, vega=0.0,
            intrinsic_value=round(intrinsic, 2), time_value=0.0,
        )

    # Numerical floor matching the TS port: sub-minute expiries blow up 1/sqrt(T).
    time = max(t, 1 / (DAYS_PER_YEAR * 24 * 60))
    sqrt_t = math.sqrt(time)
    s, k, r = spot, strike, risk_free_rate

    d1 = (math.log(s / k) + (r + 0.5 * sigma * sigma) * time) / (sigma * sqrt_t)
    d2 = d1 - sigma * sqrt_t

    discount = math.exp(-r * time)
    nd1 = _norm_cdf(d1)
    nd2 = _norm_cdf(d2)
    n_minus_d1 = _norm_cdf(-d1)
    n_minus_d2 = _norm_cdf(-d2)
    pdf_d1 = _norm_pdf(d1)

    if option_type == "CE":
        premium = s * nd1 - k * discount * nd2
        delta = nd1
        theta_annual = -(s * pdf_d1 * sigma) / (2 * sqrt_t) - r * k * discount * nd2
    else:
        premium = k * discount * n_minus_d2 - s * n_minus_d1
        delta = nd1 - 1
        theta_annual = -(s * pdf_d1 * sigma) / (2 * sqrt_t) + r * k * discount * n_minus_d2

    gamma = pdf_d1 / (s * sigma * sqrt_t)
    vega_per_percent = (s * pdf_d1 * sqrt_t) / 100
    theta_per_day = theta_annual / DAYS_PER_YEAR
    rounded_premium = round(max(0.0, premium), 2)
    rounded_intrinsic = round(intrinsic, 2)

    return OptionGreeks(
        premium=rounded_premium,
        delta=round(delta, 6),
        gamma=round(gamma, 6),
        theta=round(theta_per_day, 6),
        vega=round(vega_per_percent, 6),
        intrinsic_value=rounded_intrinsic,
        time_value=round(max(0.0, rounded_premium - rounded_intrinsic), 2),
    )


def years_to_expiry(now: datetime, expiry_date: datetime) -> float:
    seconds = (expiry_date - now).total_seconds()
    if not math.isfinite(seconds) or seconds <= 0:
        return 0.0
    return seconds / (DAYS_PER_YEAR * 24 * 60 * 60)


def mid_price_for_iv(bid: Optional[float], ask: Optional[float]) -> Optional[float]:
    """Mid of a two-sided quote. None for a one-sided/crossed/non-positive market."""
    if bid is None or ask is None:
        return None
    if not (math.isfinite(bid) and math.isfinite(ask)):
        return None
    if bid <= 0 or ask <= 0 or ask < bid:
        return None
    return (bid + ask) / 2


@dataclass(frozen=True)
class ImpliedVolatilityResult:
    measurable: bool
    implied_volatility: Optional[float] = None
    iterations: Optional[int] = None
    reason: Optional[ImpliedVolatilityRefusal] = None
    explanation: Optional[str] = None


def _refuse(reason: ImpliedVolatilityRefusal, explanation: str) -> ImpliedVolatilityResult:
    return ImpliedVolatilityResult(measurable=False, reason=reason, explanation=explanation)


def _price_bounds(
    strike: float, risk_free_rate: float, time_to_expiry_years: float, spot: float, option_type: OptionType,
) -> Tuple[float, float]:
    discounted_strike = strike * math.exp(-risk_free_rate * time_to_expiry_years)
    if option_type == "CE":
        return max(0.0, spot - discounted_strike), spot
    return max(0.0, discounted_strike - spot), discounted_strike


def implied_volatility_from_premium(
    spot: float,
    strike: float,
    time_to_expiry_years: float,
    risk_free_rate: float,
    option_type: OptionType,
    premium: float,
) -> ImpliedVolatilityResult:
    """Port of impliedVolatilityFromPremium: Newton-Raphson on vega, bisection fallback."""
    if not (math.isfinite(spot) and spot > 0 and math.isfinite(strike) and strike > 0):
        return _refuse("NO_PREMIUM", "Spot and strike must both be positive to invert a premium.")
    if not (math.isfinite(time_to_expiry_years) and time_to_expiry_years > 0):
        return _refuse(
            "EXPIRED_OR_ZERO_TIME",
            "The contract has expired or has no time left, so its premium is intrinsic value and no "
            "volatility can be recovered from it.",
        )
    if not (math.isfinite(premium) and premium > 0):
        return _refuse("NO_PREMIUM", "No positive premium was observed, so there is nothing to invert.")

    lower, upper = _price_bounds(strike, risk_free_rate, time_to_expiry_years, spot, option_type)
    if premium < lower - PRICE_TOLERANCE:
        return _refuse(
            "BELOW_INTRINSIC",
            f"The premium {premium:.4f} is below the no-arbitrage floor {lower:.4f}, which no "
            "volatility can produce. Usually a stale or crossed quote rather than arbitrage.",
        )
    if premium > upper + PRICE_TOLERANCE:
        return _refuse(
            "ABOVE_UPPER_BOUND",
            f"The premium {premium:.4f} exceeds the no-arbitrage ceiling {upper:.4f}.",
        )

    extrinsic = premium - lower
    if extrinsic < MINIMUM_EXTRINSIC_FOR_IV:
        return _refuse(
            "EXTRINSIC_BELOW_PRICE_RESOLUTION",
            f"Only {extrinsic:.4f} of this {premium:.2f} premium is extrinsic, below the "
            f"{MINIMUM_EXTRINSIC_FOR_IV} floor one price tick allows.",
        )

    def price_at(volatility: float) -> float:
        return price_european_option(
            spot, strike, time_to_expiry_years, risk_free_rate, volatility, option_type,
        ).premium

    low_price = price_at(MINIMUM_VOLATILITY)
    high_price = price_at(MAXIMUM_VOLATILITY)
    if premium < low_price - PRICE_TOLERANCE:
        return _refuse(
            "BELOW_INTRINSIC",
            f"The premium implies a volatility under {MINIMUM_VOLATILITY * 100:.2f}%, below the "
            "search band. Treated as unmeasurable rather than reported as the floor.",
        )
    if premium > high_price + PRICE_TOLERANCE:
        return _refuse(
            "ABOVE_UPPER_BOUND",
            f"The premium implies a volatility over {MAXIMUM_VOLATILITY * 100:.0f}%, above the "
            "search band. Treated as unmeasurable rather than reported as the ceiling.",
        )

    volatility = min(
        MAXIMUM_VOLATILITY,
        max(MINIMUM_VOLATILITY, (premium / spot) * math.sqrt((2 * math.pi) / time_to_expiry_years)),
    )
    for iteration in range(1, MAXIMUM_ITERATIONS + 1):
        greeks = price_european_option(
            spot, strike, time_to_expiry_years, risk_free_rate, volatility, option_type,
        )
        difference = greeks.premium - premium
        if abs(difference) < PRICE_TOLERANCE:
            return ImpliedVolatilityResult(measurable=True, implied_volatility=volatility, iterations=iteration)
        vega_per_unit = greeks.vega * 100
        if not math.isfinite(vega_per_unit) or abs(vega_per_unit) < 1e-10:
            break
        next_volatility = volatility - difference / vega_per_unit
        if not math.isfinite(next_volatility) or next_volatility <= MINIMUM_VOLATILITY or next_volatility >= MAXIMUM_VOLATILITY:
            break
        if abs(next_volatility - volatility) < 1e-12:
            return ImpliedVolatilityResult(measurable=True, implied_volatility=next_volatility, iterations=iteration)
        volatility = next_volatility

    low, high = MINIMUM_VOLATILITY, MAXIMUM_VOLATILITY
    for iteration in range(1, MAXIMUM_ITERATIONS + 1):
        middle = (low + high) / 2
        difference = price_at(middle) - premium
        if abs(difference) < PRICE_TOLERANCE or high - low < 1e-9:
            return ImpliedVolatilityResult(
                measurable=True, implied_volatility=middle, iterations=MAXIMUM_ITERATIONS + iteration,
            )
        if difference > 0:
            high = middle
        else:
            low = middle

    return _refuse(
        "DID_NOT_CONVERGE",
        "Neither Newton-Raphson nor bisection reached the premium within the iteration budget.",
    )


@dataclass(frozen=True)
class ParityPair:
    strike: float
    call_mid: float
    put_mid: float


def implied_forward_from_parity(
    pairs: Sequence[ParityPair], risk_free_rate: float, time_to_expiry_years: float,
) -> Optional[float]:
    """Median put-call-parity-implied forward across paired strikes at one expiry."""
    if time_to_expiry_years <= 0 or not math.isfinite(time_to_expiry_years):
        return None
    discount = math.exp(-risk_free_rate * time_to_expiry_years)
    forwards: List[float] = []
    for pair in pairs:
        if not (math.isfinite(pair.strike) and pair.strike > 0):
            continue
        if not (math.isfinite(pair.call_mid) and math.isfinite(pair.put_mid)):
            continue
        if pair.call_mid <= 0 or pair.put_mid <= 0:
            continue
        forward = (pair.call_mid - pair.put_mid) / discount + pair.strike
        if math.isfinite(forward) and forward > 0:
            forwards.append(forward)
    if not forwards:
        return None
    forwards.sort()
    n = len(forwards)
    middle = n // 2
    if n % 2 == 1:
        return forwards[middle]
    return (forwards[middle - 1] + forwards[middle]) / 2


def effective_spot_for_forward(forward: float, risk_free_rate: float, time_to_expiry_years: float) -> float:
    return forward * math.exp(-risk_free_rate * time_to_expiry_years)


# ------------------------------------------------------------------- GEX aggregation


@dataclass(frozen=True)
class OptionChainRow:
    expiry_date: datetime
    strike_price: float
    option_type: OptionType
    bid: Optional[float]
    ask: Optional[float]
    open_interest: Optional[int]
    observed_at: datetime


@dataclass(frozen=True)
class ExpiryGEX:
    expiry_date: datetime
    forward: Optional[float]
    total_call_gamma_exposure: float
    total_put_gamma_exposure: float
    net_dealer_gamma_exposure: float
    call_open_interest: int
    put_open_interest: int
    contracts_priced: int
    contracts_skipped: int
    skip_reasons: Dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class GEXObservation:
    underlying_symbol: str
    # The decision timestamp this observation is evaluated AS OF -- not when any one row was
    # last captured. See compute_gex_for_expiry's docstring.
    observed_at: datetime
    spot: float
    contract_multiplier: int
    by_expiry: List[ExpiryGEX]
    total_call_gamma_exposure: float
    total_put_gamma_exposure: float
    net_dealer_gamma_exposure: float
    put_call_oi_ratio: Optional[float]
    contracts_priced: int
    contracts_skipped: int


def _skip(reasons: Dict[str, int], reason: str) -> None:
    reasons[reason] = reasons.get(reason, 0) + 1


def compute_gex_for_expiry(
    rows: Sequence[OptionChainRow],
    spot: float,
    contract_multiplier: int,
    as_of: datetime,
    risk_free_rate: float = RISK_FREE_RATE,
) -> ExpiryGEX:
    """
    GEX for every strike of ONE expiry, evaluated AS OF `as_of` -- not as of whenever each
    contract's row happens to have last been captured. This matters: a snapshot's `observed_at`
    is the time the row was last refreshed, which for an expiry that already elapsed is some
    moment while it was still alive, not "now". Measuring time-to-expiry from a row's own
    `observed_at` would therefore price long-dead contracts as if they still had time left
    (confirmed against the live NIFTY50 chain: an August expiry's rows were last captured in
    August, before it expired, so `years_to_expiry(row.observed_at, expiry)` was positive even
    though the expiry is now in the past). `as_of` is the single decision timestamp every
    strike's time-to-expiry is measured against; staleness of the underlying quote/OI data
    relative to `as_of` is a separate, PIT-staleness concern this function does not evaluate.

    Mirrors chain-greeks.ts's solveContractGreeksFromChain, generalized to all strikes instead
    of one: a single parity-implied forward is derived once per expiry from its paired strikes,
    then every strike's IV is solved against that forward (falling back to raw spot when no
    pair resolves, exactly as the TS does).
    """
    if not rows:
        raise ValueError("compute_gex_for_expiry requires at least one row.")
    expiry_date = rows[0].expiry_date
    time_to_expiry = years_to_expiry(as_of, expiry_date)

    if time_to_expiry <= 0:
        skip_reasons = {"EXPIRED_OR_ZERO_TIME": len(rows)}
        call_oi = sum(row.open_interest or 0 for row in rows if row.option_type == "CE" and row.open_interest)
        put_oi = sum(row.open_interest or 0 for row in rows if row.option_type == "PE" and row.open_interest)
        return ExpiryGEX(
            expiry_date=expiry_date, forward=None, total_call_gamma_exposure=0.0,
            total_put_gamma_exposure=0.0, net_dealer_gamma_exposure=0.0,
            call_open_interest=call_oi, put_open_interest=put_oi,
            contracts_priced=0, contracts_skipped=len(rows), skip_reasons=skip_reasons,
        )

    mids_by_strike: Dict[float, Dict[str, float]] = {}
    for row in rows:
        mid = mid_price_for_iv(row.bid, row.ask)
        if mid is None:
            continue
        slot = mids_by_strike.setdefault(row.strike_price, {})
        slot["call_mid" if row.option_type == "CE" else "put_mid"] = mid

    pairs = [
        ParityPair(strike=strike, call_mid=slot["call_mid"], put_mid=slot["put_mid"])
        for strike, slot in mids_by_strike.items()
        if "call_mid" in slot and "put_mid" in slot
    ]
    forward = implied_forward_from_parity(pairs, risk_free_rate, time_to_expiry)
    pricing_spot = (
        effective_spot_for_forward(forward, risk_free_rate, time_to_expiry) if forward is not None else spot
    )

    call_gamma_exposure = 0.0
    put_gamma_exposure = 0.0
    call_oi = 0
    put_oi = 0
    priced = 0
    skipped = 0
    skip_reasons: Dict[str, int] = {}

    for row in rows:
        if row.open_interest is None or row.open_interest <= 0:
            skipped += 1
            _skip(skip_reasons, "NO_OPEN_INTEREST")
            continue
        if row.option_type == "CE":
            call_oi += row.open_interest
        else:
            put_oi += row.open_interest

        if not (math.isfinite(pricing_spot) and pricing_spot > 0):
            skipped += 1
            _skip(skip_reasons, "INVALID_SPOT")
            continue
        mid = mid_price_for_iv(row.bid, row.ask)
        if mid is None:
            skipped += 1
            _skip(skip_reasons, "NO_TWO_SIDED_QUOTE")
            continue

        solved = implied_volatility_from_premium(
            pricing_spot, row.strike_price, time_to_expiry, risk_free_rate, row.option_type, mid,
        )
        if not solved.measurable:
            skipped += 1
            _skip(skip_reasons, solved.reason or "DID_NOT_CONVERGE")
            continue

        greeks = price_european_option(
            pricing_spot, row.strike_price, time_to_expiry, risk_free_rate,
            solved.implied_volatility, row.option_type,
        )
        contribution = greeks.gamma * row.open_interest * contract_multiplier * (spot ** 2) * GEX_SPOT_MOVE_FRACTION
        if row.option_type == "CE":
            call_gamma_exposure += contribution
        else:
            put_gamma_exposure += contribution
        priced += 1

    return ExpiryGEX(
        expiry_date=expiry_date,
        forward=forward,
        total_call_gamma_exposure=call_gamma_exposure,
        total_put_gamma_exposure=put_gamma_exposure,
        net_dealer_gamma_exposure=call_gamma_exposure - put_gamma_exposure,
        call_open_interest=call_oi,
        put_open_interest=put_oi,
        contracts_priced=priced,
        contracts_skipped=skipped,
        skip_reasons=skip_reasons,
    )


def aggregate_gex(
    rows: Sequence[OptionChainRow],
    underlying_symbol: str,
    spot: float,
    contract_multiplier: int,
    as_of: datetime,
    risk_free_rate: float = RISK_FREE_RATE,
) -> GEXObservation:
    """
    GEX across every captured expiry of one underlying, evaluated AS OF `as_of` -- the single
    decision timestamp every expiry's time-to-expiry is measured against (see
    compute_gex_for_expiry's docstring for why this must not be each row's own `observed_at`).
    """
    by_expiry_date: Dict[datetime, List[OptionChainRow]] = {}
    for row in rows:
        by_expiry_date.setdefault(row.expiry_date, []).append(row)

    by_expiry = [
        compute_gex_for_expiry(expiry_rows, spot, contract_multiplier, as_of, risk_free_rate)
        for expiry_rows in by_expiry_date.values()
    ]
    by_expiry.sort(key=lambda e: e.expiry_date)

    total_call = sum(e.total_call_gamma_exposure for e in by_expiry)
    total_put = sum(e.total_put_gamma_exposure for e in by_expiry)
    total_call_oi = sum(e.call_open_interest for e in by_expiry)
    total_put_oi = sum(e.put_open_interest for e in by_expiry)

    return GEXObservation(
        underlying_symbol=underlying_symbol,
        observed_at=as_of,
        spot=spot,
        contract_multiplier=contract_multiplier,
        by_expiry=by_expiry,
        total_call_gamma_exposure=total_call,
        total_put_gamma_exposure=total_put,
        net_dealer_gamma_exposure=total_call - total_put,
        put_call_oi_ratio=(total_put_oi / total_call_oi) if total_call_oi > 0 else None,
        contracts_priced=sum(e.contracts_priced for e in by_expiry),
        contracts_skipped=sum(e.contracts_skipped for e in by_expiry),
    )
