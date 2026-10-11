"""Step 1 gap analysis: does an IV-percentile compression feature carry any signal
for the already-established volatility-expansion target.

Context (2026-09-29): a status-report pitch proposed "IV compression before a
breakout" as a new strategy idea for option buying. This project already has a
validated, non-directional volatility-expansion classifier (see
``ai_quant_lab_ml.volatility_expansion``) built purely from price range, with no
options-chain input at all. The genuinely new part of the pitch is whether an
implied-volatility percentile -- not currently fed to that model, and not
currently used anywhere as a *predictive* feature (the one IV-percentile
consumer in this codebase, ``iv-percentile.ts``, is a pre-trade ceiling check
that screens OUT high IV before buying, the opposite direction from "IV
compression predicts a breakout") -- adds anything on top.

This script is deliberately the cheap first pass, in the same spirit as
``oi_pcr_signal_check.py``: it builds the real volatility-expansion labels the
normal way, then replaces each example's feature vector with a *minimal*,
standalone IV-percentile feature set and runs that through the existing
leakage-audit machinery. If this minimal set has no usable signal on its own,
there is no reason to invest in a full ablation or a new strategy class.

**No raw IV is stored anywhere in this database.** ``option_chain_snapshots``
holds bid/ask/last_price/underlying_value per contract (see migration
037-option-chain-snapshots.ts); implied volatility has to be solved from the
quoted premium via Black-Scholes inversion, the same as
``chain-greeks.ts``/``iv-percentile.ts`` do in TypeScript for the live pre-trade
checklist. This module is a minimal, from-scratch Python port of that solver
(``packages/pricing/src/index.ts``) -- Newton-Raphson on vega with a bisection
fallback, the same no-arbitrage bounds, the same minimum-extrinsic-value floor
that keeps a rounded, near-zero-extrinsic premium from producing a plausible
but meaningless IV. It deliberately skips the put-call-parity forward
correction ``chain-greeks.ts`` applies (spot is used directly as the pricing
input): that refinement matters for a live delta a trade decision reads, not
for a first-pass screen of whether a percentile of *some* reasonable IV
estimate carries any signal at all.

Every feature here is built only from snapshots with ``observed_at <=
candle.close_time`` (an as-of join, exactly as the OI/PCR check requires), and
the percentile is ranked only against **calendar days strictly before** the
candle's own day -- never same-day snapshots -- so it can never see a same-day
data point, mirroring ``iv-percentile.ts``'s own documented reasoning that
one day is one unit of information, not one point per fifteen-minute poll.

This script creates no model version, no prediction, no paper trade, and no
order. It only reads.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import math
import os
import sys
from bisect import bisect_right
from collections import defaultdict
from datetime import date, datetime, time, timezone
from pathlib import Path
from typing import Any, Literal, Mapping, Sequence

from ai_quant_lab_ml.contracts import ALGORITHM_CHOICES, LABEL_SCHEME_VOLATILITY_EXPANSION, DatasetRequest
from ai_quant_lab_ml.features import build_volatility_expansion_examples
from ai_quant_lab_ml.leakage import run_leakage_audit
from ai_quant_lab_ml.option_chain_pcr import MAX_SNAPSHOT_AGE_MINUTES
from ai_quant_lab_ml.postgres_repository import PostgresMlRepository
from ai_quant_lab_ml.volatility_expansion import VOLATILITY_ALPHABET
from train import non_blank, non_negative_float, parse_timestamp, positive_int, strict_unit_interval


ROOT_DIRECTORY = Path(__file__).resolve().parents[2]

OptionType = Literal["CE", "PE"]

# Same constant as packages/pricing/src/index.ts's RISK_FREE_RATE.
RISK_FREE_RATE = 0.065

# NSE cash-market close, in UTC. expiry_date is a bare DATE with no time of day;
# the contract expires at the close of that trading day, not at midnight.
EXPIRY_CLOSE_UTC = time(10, 0)

# Same widest search band, tolerance and iteration budget as the TS solver.
MINIMUM_VOLATILITY = 0.0001
MAXIMUM_VOLATILITY = 5.0
PRICE_TOLERANCE = 1e-6
MAXIMUM_ITERATIONS = 100
# One tick's worth of premium (see index.ts's MINIMUM_EXTRINSIC_FOR_IV docstring):
# below this, a solved IV describes price rounding, not the market.
MINIMUM_EXTRINSIC_FOR_IV = 0.05

# How stale the latest option-chain snapshot may be and still count as "known at
# decision time": the shared 20-minute ceiling (one 15-minute poll cycle plus jitter; a
# snapshot that has missed a poll is >= ~24 minutes old and is refused). It is imported, not
# restated, so this script, oi_pcr_signal_check.py, the hybrid backtest and the live
# TypeScript `OPTION_CHAIN_MAX_SNAPSHOT_AGE_MINUTES` cannot drift apart again -- this file
# previously used 15 while its write-up (docs/2026-09-29-...) said 60.
MAXIMUM_SNAPSHOT_AGE_MINUTES = MAX_SNAPSHOT_AGE_MINUTES

# A two-sided quote only yields a usable mid when it is tight. Measured on the stored chain
# (near-ATM, |K - S| / S < 0.3%, unexpired): relative spread (ask - bid) / mid has p99 of
# 2.6% (BANKNIFTY) and 2.2% (NIFTY50), so 5% sits well outside normal index quoting while
# still refusing a book that is effectively one-sided. A wider quote makes the mid -- and any
# IV solved from it -- noise. This is a judgement threshold, not a calibrated one.
MAXIMUM_RELATIVE_SPREAD = 0.05

# A percentile over a handful of days is arithmetically fine and analytically
# worthless (see market-data/domain/iv-percentile.ts's own docstring). Same
# threshold, so this check and the live product feature agree on what "enough
# history" means.
MINIMUM_DISTINCT_DAYS = 20

IV_FEATURE_SCHEMA: tuple[str, ...] = (
    "iv.percentile",
    "iv.level",
    "iv.change_vs_prior_day_bps",
)


def _normal_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _normal_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)


def _bs_price(spot: float, strike: float, t: float, r: float, sigma: float, option_type: OptionType) -> float:
    if t <= 0 or sigma <= 0:
        return max(0.0, spot - strike) if option_type == "CE" else max(0.0, strike - spot)
    sqrt_t = math.sqrt(t)
    d1 = (math.log(spot / strike) + (r + 0.5 * sigma * sigma) * t) / (sigma * sqrt_t)
    d2 = d1 - sigma * sqrt_t
    discount = math.exp(-r * t)
    if option_type == "CE":
        return spot * _normal_cdf(d1) - strike * discount * _normal_cdf(d2)
    return strike * discount * _normal_cdf(-d2) - spot * _normal_cdf(-d1)


def _bs_vega_per_unit(spot: float, strike: float, t: float, r: float, sigma: float) -> float:
    if t <= 0 or sigma <= 0:
        return 0.0
    sqrt_t = math.sqrt(t)
    d1 = (math.log(spot / strike) + (r + 0.5 * sigma * sigma) * t) / (sigma * sqrt_t)
    return spot * _normal_pdf(d1) * sqrt_t


def solve_implied_volatility(
    *, premium: float, spot: float, strike: float, time_to_expiry_years: float, option_type: OptionType,
) -> float | None:
    """Newton-Raphson on vega, bisection fallback. Returns None rather than a fabricated number.

    A minimal Python port of ``impliedVolatilityFromPremium`` in
    ``packages/pricing/src/index.ts``. Every refusal that solver names as a
    distinct reason collapses to ``None`` here -- this script only needs a
    measurable/unmeasurable distinction, not the diagnostic detail a live
    pre-trade screen reports to a person.
    """

    if not (math.isfinite(spot) and spot > 0 and math.isfinite(strike) and strike > 0):
        return None
    if not (math.isfinite(time_to_expiry_years) and time_to_expiry_years > 0):
        return None
    if not (math.isfinite(premium) and premium > 0):
        return None

    discount = math.exp(-RISK_FREE_RATE * time_to_expiry_years)
    if option_type == "CE":
        lower, upper = max(0.0, spot - strike * discount), spot
    else:
        lower, upper = max(0.0, strike * discount - spot), strike * discount
    if premium < lower - PRICE_TOLERANCE or premium > upper + PRICE_TOLERANCE:
        return None
    if (premium - lower) < MINIMUM_EXTRINSIC_FOR_IV:
        return None

    def price_at(sigma: float) -> float:
        return _bs_price(spot, strike, time_to_expiry_years, RISK_FREE_RATE, sigma, option_type)

    low_price = price_at(MINIMUM_VOLATILITY)
    high_price = price_at(MAXIMUM_VOLATILITY)
    if premium < low_price - PRICE_TOLERANCE or premium > high_price + PRICE_TOLERANCE:
        return None

    volatility = min(
        MAXIMUM_VOLATILITY,
        max(MINIMUM_VOLATILITY, (premium / spot) * math.sqrt((2 * math.pi) / time_to_expiry_years)),
    )
    for _ in range(MAXIMUM_ITERATIONS):
        price = price_at(volatility)
        difference = price - premium
        if abs(difference) < PRICE_TOLERANCE:
            return volatility
        vega = _bs_vega_per_unit(spot, strike, time_to_expiry_years, RISK_FREE_RATE, volatility)
        if not math.isfinite(vega) or abs(vega) < 1e-10:
            break
        next_volatility = volatility - difference / vega
        if not math.isfinite(next_volatility) or next_volatility <= MINIMUM_VOLATILITY or next_volatility >= MAXIMUM_VOLATILITY:
            break
        if abs(next_volatility - volatility) < 1e-12:
            return next_volatility
        volatility = next_volatility

    low, high = MINIMUM_VOLATILITY, MAXIMUM_VOLATILITY
    for _ in range(MAXIMUM_ITERATIONS):
        middle = (low + high) / 2
        difference = price_at(middle) - premium
        if abs(difference) < PRICE_TOLERANCE or (high - low) < 1e-9:
            return middle
        if difference > 0:
            high = middle
        else:
            low = middle
    return None


def _mid(
    bid: float | None,
    ask: float | None,
    max_relative_spread: float | None = None,
) -> float | None:
    """Mid of a two-sided quote, or None. A one-sided market cannot be solved honestly.

    With ``max_relative_spread`` set, a quote whose ``(ask - bid) / mid`` exceeds it is also
    refused: a wide book has no meaningful mid (see ``MAXIMUM_RELATIVE_SPREAD``).
    """
    if bid is None or ask is None:
        return None
    if not (math.isfinite(bid) and math.isfinite(ask)):
        return None
    if bid <= 0 or ask <= 0 or ask < bid:
        return None
    mid = (bid + ask) / 2.0
    if max_relative_spread is not None and (ask - bid) / mid > max_relative_spread:
        return None
    return mid


@dataclasses.dataclass(frozen=True)
class ChainRow:
    observed_at: datetime
    expiry_date: date
    strike_price: float
    option_type: OptionType
    bid: float | None
    ask: float | None
    underlying_value: float | None


_RAW_CHAIN_SQL = """
    SELECT observed_at, expiry_date, strike_price, option_type, bid, ask, underlying_value
    FROM option_chain_snapshots
    WHERE underlying_symbol = %s
    ORDER BY observed_at ASC
"""


def load_chain_rows(repository: PostgresMlRepository, underlying_symbol: str) -> list[ChainRow]:
    with repository._connection.cursor() as cursor:  # noqa: SLF001 - read-only ad hoc query, not a repository method.
        cursor.execute(_RAW_CHAIN_SQL, (underlying_symbol,))
        rows = cursor.fetchall()
    return [
        ChainRow(
            observed_at=row[0] if row[0].tzinfo else row[0].replace(tzinfo=timezone.utc),
            expiry_date=row[1],
            strike_price=float(row[2]),
            option_type=row[3],
            bid=float(row[4]) if row[4] is not None else None,
            ask=float(row[5]) if row[5] is not None else None,
            underlying_value=float(row[6]) if row[6] is not None else None,
        )
        for row in rows
    ]


@dataclasses.dataclass(frozen=True)
class AtmIvSnapshot:
    observed_at: datetime
    implied_volatility: float


def build_atm_iv_series(rows: Sequence[ChainRow]) -> list[AtmIvSnapshot]:
    """One ATM IV estimate per ``observed_at``, solved from the nearest-to-spot strike.

    Groups the raw chain rows by observation time, picks the nearest un-expired
    expiry (same rule as ``oi_pcr_signal_check.py``'s whole-chain aggregate),
    finds the strike closest to the observed underlying value, and averages the
    call and put IV solved at that strike when both are measurable (falls back
    to whichever side solved, when only one does).
    """

    by_observed_at: dict[datetime, list[ChainRow]] = defaultdict(list)
    for row in rows:
        by_observed_at[row.observed_at].append(row)

    series: list[AtmIvSnapshot] = []
    for observed_at, group in sorted(by_observed_at.items()):
        underlying_value = next((r.underlying_value for r in group if r.underlying_value), None)
        if underlying_value is None or underlying_value <= 0:
            continue

        unexpired = [r for r in group if r.expiry_date >= observed_at.date()]
        if not unexpired:
            continue
        nearest_expiry = min(r.expiry_date for r in unexpired)
        chain = [r for r in unexpired if r.expiry_date == nearest_expiry]

        atm_strike = min({r.strike_price for r in chain}, key=lambda strike: abs(strike - underlying_value))
        call = next((r for r in chain if r.strike_price == atm_strike and r.option_type == "CE"), None)
        put = next((r for r in chain if r.strike_price == atm_strike and r.option_type == "PE"), None)

        expiry_at = datetime.combine(nearest_expiry, EXPIRY_CLOSE_UTC, tzinfo=timezone.utc)
        time_to_expiry_years = (expiry_at - observed_at).total_seconds() / (365.0 * 86400.0)
        if time_to_expiry_years <= 0:
            continue

        ivs: list[float] = []
        for quote, option_type in ((call, "CE"), (put, "PE")):
            if quote is None:
                continue
            mid = _mid(quote.bid, quote.ask, MAXIMUM_RELATIVE_SPREAD)
            if mid is None:
                continue
            solved = solve_implied_volatility(
                premium=mid,
                spot=underlying_value,
                strike=atm_strike,
                time_to_expiry_years=time_to_expiry_years,
                option_type=option_type,  # type: ignore[arg-type]
            )
            if solved is not None:
                ivs.append(solved)

        if not ivs:
            continue
        series.append(AtmIvSnapshot(observed_at=observed_at, implied_volatility=sum(ivs) / len(ivs)))

    return series


def iv_features_as_of(
    series: Sequence[AtmIvSnapshot],
    series_times: Sequence[datetime],
    daily_representative: Mapping[date, float],
    sorted_days: Sequence[date],
    as_of: datetime,
) -> dict[str, float] | None:
    """The minimal IV feature set known at ``as_of``, or None if unmeasurable.

    ``daily_representative``/``sorted_days`` are the full day -> IV map and its
    sorted key list, precomputed once by the caller. The percentile only ever
    ranks against days strictly before ``as_of``'s own calendar day.
    """

    index = bisect_right(series_times, as_of) - 1
    if index < 0:
        return None
    current = series[index]
    age_minutes = (as_of - current.observed_at).total_seconds() / 60.0
    if age_minutes > MAXIMUM_SNAPSHOT_AGE_MINUTES:
        return None

    today = as_of.date()
    # Strictly-prior days only: today's own snapshots never enter its history.
    prior_days = [d for d in sorted_days if d < today]
    if len(prior_days) < MINIMUM_DISTINCT_DAYS:
        return None

    history_values = sorted(daily_representative[d] for d in prior_days)
    below = sum(1 for value in history_values if value < current.implied_volatility)
    percentile = (below / len(history_values)) * 100.0

    prior_day = prior_days[-1]
    prior_value = daily_representative[prior_day]
    change_bps = (current.implied_volatility - prior_value) * 10_000.0

    return {
        "iv.percentile": percentile,
        "iv.level": current.implied_volatility,
        "iv.change_vs_prior_day_bps": change_bps,
    }


def sample_size_limits(series: Sequence[AtmIvSnapshot], examples: Sequence[Any]) -> dict[str, Any]:
    """What the sample can and cannot support, reported with every result.

    The unit of independent information is the trading day (a percentile is ranked on one
    representative IV per day), not the 15-minute row. A leakage-audit PASS or FAIL on a few
    dozen days is an exploratory screen, not evidence of an edge, and the percentile is not
    tenor-matched (it ranks the nearest expiry's IV across days whose nearest expiry sits at
    different distances).
    """
    chain_days = {snapshot.observed_at.date() for snapshot in series}
    example_days = {example.observed_at.date() for example in examples}
    return {
        "distinctChainDays": len(chain_days),
        "distinctExampleDays": len(example_days),
        "minimumHistoryDaysForPercentile": MINIMUM_DISTINCT_DAYS,
        "maximumSnapshotAgeMinutes": MAXIMUM_SNAPSHOT_AGE_MINUTES,
        "maximumRelativeSpread": MAXIMUM_RELATIVE_SPREAD,
        "caveat": (
            f"Only {len(chain_days)} distinct option-chain trading days exist and "
            f"{len(example_days)} of them produce examples after the {MINIMUM_DISTINCT_DAYS}-day "
            "percentile warm-up; rows within a day are autocorrelated, so the effective sample is "
            "days, not rows. Treat the audit as an exploratory screen. The percentile is not "
            "tenor-matched (nearest expiry only)."
        ),
    }


def replace_with_iv_features(examples, series: Sequence[AtmIvSnapshot]):
    if not series:
        return []
    series_times = [snapshot.observed_at for snapshot in series]

    # One representative IV per day: the day's last snapshot. Fifteen-minute
    # snapshots within one session are heavily autocorrelated -- one day is one
    # unit of information, exactly iv-percentile.ts's own reasoning.
    daily_representative: dict[date, float] = {}
    for snapshot in series:
        daily_representative[snapshot.observed_at.date()] = snapshot.implied_volatility
    sorted_days = sorted(daily_representative)

    rebuilt = []
    for example in examples:
        features = iv_features_as_of(series, series_times, daily_representative, sorted_days, example.observed_at)
        if features is None or any(not math.isfinite(value) for value in features.values()):
            continue
        rebuilt.append(dataclasses.replace(example, features=features))
    return rebuilt


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Step 1 gap-analysis check: does an IV-percentile compression feature carry any "
            "leakage-audit-surviving signal for the volatility-expansion target, before investing "
            "in a full ablation or a new strategy."
        ),
    )
    parser.add_argument("--instrument", required=True, type=non_blank, help="e.g. NIFTY50 or BANKNIFTY.")
    parser.add_argument("--timeframe", required=True, type=non_blank, help="e.g. 15m.")
    parser.add_argument("--from", dest="data_window_start", required=True, help="YYYY-MM-DD or ISO-8601.")
    parser.add_argument("--to", dest="data_window_end", required=True, help="YYYY-MM-DD or ISO-8601.")
    parser.add_argument("--algorithm", choices=ALGORITHM_CHOICES, default="logistic")
    parser.add_argument("--horizon-bars", type=positive_int, default=5)
    parser.add_argument("--expansion-band", type=non_negative_float, default=0.25)
    parser.add_argument("--validation-fraction", type=strict_unit_interval, default=0.2)
    parser.add_argument("--random-state", type=int, default=42)
    parser.add_argument("--database-url")
    return parser


def json_output(value: Mapping[str, Any]) -> None:
    print(json.dumps(value, sort_keys=True, default=str))


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    from dotenv import load_dotenv
    load_dotenv(ROOT_DIRECTORY / ".env")

    database_url = args.database_url or os.environ.get("DATABASE_URL")
    if not database_url:
        parser.error("DATABASE_URL is required (pass --database-url or define it in .env/environment).")

    import psycopg

    request = DatasetRequest(
        instrument_symbol=args.instrument.upper(),
        timeframe=args.timeframe,
        data_window_start=parse_timestamp(args.data_window_start),
        data_window_end=parse_timestamp(args.data_window_end, end_of_day=True),
        data_cutoff_at=datetime.now(timezone.utc),
        horizon_bars=args.horizon_bars,
        neutral_threshold_bps=0.0,  # unused by the volatility-expansion scheme
        label_scheme=LABEL_SCHEME_VOLATILITY_EXPANSION,
        expansion_band=args.expansion_band,
    )

    with psycopg.connect(database_url, autocommit=True) as connection:
        repository = PostgresMlRepository(connection)
        records = repository.load_candle_evidence(request)
        labeled = build_volatility_expansion_examples(records, request)
        chain_rows = load_chain_rows(repository, request.instrument_symbol)
        iv_series = build_atm_iv_series(chain_rows)
        examples = replace_with_iv_features(labeled, iv_series)

        print(
            f"{len(labeled)} volatility-labeled candles, {len(chain_rows)} chain rows, "
            f"{len(iv_series)} solvable ATM IV snapshots, {len(examples)} examples with usable "
            f"IV percentile coverage (>= {MINIMUM_DISTINCT_DAYS} trailing days, age <= "
            f"{MAXIMUM_SNAPSHOT_AGE_MINUTES:.0f}min).",
            file=sys.stderr,
        )
        if len(examples) < 100:
            json_output({
                "level": "error",
                "message": f"Only {len(examples)} examples have usable IV-percentile coverage; too few for a meaningful audit.",
                "labeledCandles": len(labeled),
                "chainRows": len(chain_rows),
                "solvableIvSnapshots": len(iv_series),
            })
            return 1

        # A 3-column schema is far narrower than the production feature schema the
        # default shuffle ceiling assumes, so a wider ceiling is used here rather
        # than silently reusing a threshold calibrated for a much higher-dimensional
        # feature space -- same reasoning and same margin as oi_pcr_signal_check.py.
        audit = run_leakage_audit(
            examples,
            algorithm=args.algorithm,
            horizon_bars=args.horizon_bars,
            schema=IV_FEATURE_SCHEMA,
            random_state=args.random_state,
            validation_fraction=args.validation_fraction,
            shuffle_ceiling=VOLATILITY_ALPHABET.random_baseline_macro_f1 + 0.15,
            alphabet=VOLATILITY_ALPHABET,
            # Volatility genuinely persists bar-to-bar (it clusters), so a
            # near-zero feature-lag degradation is the expected signature of
            # persistence, not evidence of leakage -- exactly the case this flag
            # exists for (see leakage.py's own docstring, and the comment in
            # oi_pcr_signal_check.py explaining why its OWN target does NOT set it).
            persistence_dominated=True,
        )

    json_output({
        "level": "info",
        "message": "IV-percentile-compression minimal-feature leakage audit complete",
        "dataset": {
            "instrument": request.instrument_symbol,
            "timeframe": request.timeframe,
            "dataWindowStart": request.data_window_start.isoformat(),
            "dataWindowEnd": request.data_window_end.isoformat(),
            "horizonBars": request.horizon_bars,
            "expansionBand": request.expansion_band,
            "labeledCandles": len(labeled),
            "chainRows": len(chain_rows),
            "solvableIvSnapshots": len(iv_series),
            "usableExamples": len(examples),
            "usableExampleDays": len({example.observed_at.date() for example in examples}),
        },
        "featureSchema": list(IV_FEATURE_SCHEMA),
        "sampleLimits": sample_size_limits(iv_series, examples),
        "audit": audit,
        "modelVersionCreated": False,
        "predictionCreated": False,
        "paperTradeCreated": False,
        "realOrderPlaced": False,
    })
    return 0 if audit["verdict"] == "PASS" else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        json_output({"level": "error", "message": "Interrupted before completion."})
        raise SystemExit(130)
    except Exception as error:  # noqa: BLE001 - CLI boundary intentionally turns failures into a compact local log.
        json_output({"level": "error", "message": str(error), "errorType": type(error).__name__})
        raise SystemExit(1)
