"""Compute dealer gamma exposure (GEX) from captured `option_chain_snapshots` rows.

Read-only: this command never writes a model version, prediction, or paper trade, and
never places an order. See ai_quant_lab_ml/gex_aggregator.py's module docstring for the
math this ports and the dealer-positioning assumption `netDealerGammaExposure` relies on
and does not validate.
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional

from ai_quant_lab_ml.gex_aggregator import GEXObservation, OptionChainRow, aggregate_gex

ROOT_DIRECTORY = Path(__file__).resolve().parents[2]

# DISTINCT ON picks each contract's latest row at-or-before `as_of` -- PIT-safe, matching
# how depth frames / OFI are joined elsewhere in this pipeline (nearest prior observation).
_LATEST_CHAIN_SQL = """
    SELECT DISTINCT ON (expiry_date, strike_price, option_type)
        expiry_date, strike_price, option_type, bid, ask, open_interest, underlying_value, observed_at
    FROM option_chain_snapshots
    WHERE underlying_symbol = %(underlying_symbol)s AND observed_at <= %(as_of)s
    ORDER BY expiry_date, strike_price, option_type, observed_at DESC
"""

_LOT_SIZE_SQL = "SELECT lot_size FROM instruments WHERE symbol = %(symbol)s"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Aggregate dealer gamma exposure (GEX) from the latest captured option chain.",
    )
    parser.add_argument("underlying_symbol", help="e.g. NIFTY50, BANKNIFTY.")
    parser.add_argument("--database-url", help="PostgreSQL URL; defaults to DATABASE_URL in the root .env/environment.")
    parser.add_argument(
        "--as-of",
        help="ISO-8601 UTC timestamp; use only snapshots observed at or before this moment (default: now).",
    )
    parser.add_argument(
        "--contract-multiplier",
        type=int,
        help="Shares per lot. Defaults to the instruments table's lot_size for this symbol.",
    )
    return parser


def _parse_as_of(value: Optional[str]) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def to_json(observation: GEXObservation, freshest_batch_observed_at: datetime) -> Mapping[str, Any]:
    return {
        "underlyingSymbol": observation.underlying_symbol,
        # The decision timestamp every expiry's time-to-expiry was measured against.
        "asOf": observation.observed_at.isoformat(),
        # Separately: when the chain data actually feeding this computation was last refreshed
        # (a staleness diagnostic, not the expiry-math reference time -- see gex_aggregator.py).
        "freshestBatchObservedAt": freshest_batch_observed_at.isoformat(),
        "spot": observation.spot,
        "contractMultiplier": observation.contract_multiplier,
        "totalCallGammaExposure": observation.total_call_gamma_exposure,
        "totalPutGammaExposure": observation.total_put_gamma_exposure,
        "netDealerGammaExposure": observation.net_dealer_gamma_exposure,
        "putCallOiRatio": observation.put_call_oi_ratio,
        "contractsPriced": observation.contracts_priced,
        "contractsSkipped": observation.contracts_skipped,
        "byExpiry": [
            {
                "expiryDate": e.expiry_date.date().isoformat(),
                "forward": e.forward,
                "totalCallGammaExposure": e.total_call_gamma_exposure,
                "totalPutGammaExposure": e.total_put_gamma_exposure,
                "netDealerGammaExposure": e.net_dealer_gamma_exposure,
                "callOpenInterest": e.call_open_interest,
                "putOpenInterest": e.put_open_interest,
                "contractsPriced": e.contracts_priced,
                "contractsSkipped": e.contracts_skipped,
                "skipReasons": e.skip_reasons,
            }
            for e in observation.by_expiry
        ],
    }


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        from dotenv import load_dotenv
    except ImportError as error:
        parser.error("python-dotenv is required. Install apps/ml/requirements.txt first.")
        raise AssertionError("parser.error exits") from error  # pragma: no cover - helps type checkers only
    load_dotenv(ROOT_DIRECTORY / ".env")

    database_url = args.database_url or os.environ.get("DATABASE_URL")
    if not database_url:
        parser.error("DATABASE_URL is required (pass --database-url or define it in .env/environment).")

    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as error:
        parser.error("psycopg is required. Install apps/ml/requirements.txt first.")
        raise AssertionError("parser.error exits") from error  # pragma: no cover - helps type checkers only

    as_of = _parse_as_of(args.as_of)

    with psycopg.connect(database_url, autocommit=True) as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(_LATEST_CHAIN_SQL, {"underlying_symbol": args.underlying_symbol, "as_of": as_of})
            chain_rows = cursor.fetchall()

            contract_multiplier = args.contract_multiplier
            if contract_multiplier is None:
                cursor.execute(_LOT_SIZE_SQL, {"symbol": args.underlying_symbol})
                lot_row = cursor.fetchone()
                if lot_row is None:
                    parser.error(f"No lot_size found for symbol {args.underlying_symbol!r} in instruments.")
                contract_multiplier = int(lot_row["lot_size"])

    if not chain_rows:
        print(json.dumps({
            "level": "error",
            "message": "No option_chain_snapshots rows found at or before as-of.",
            "underlyingSymbol": args.underlying_symbol,
            "asOf": as_of.isoformat(),
        }, sort_keys=True))
        return 1

    freshest_batch_observed_at = max(row["observed_at"] for row in chain_rows)
    spot_candidates = [
        float(row["underlying_value"]) for row in chain_rows
        if row["observed_at"] == freshest_batch_observed_at and row["underlying_value"] is not None
    ]
    if not spot_candidates:
        print(json.dumps({
            "level": "error",
            "message": "Latest snapshot batch carries no underlying_value; cannot price.",
            "underlyingSymbol": args.underlying_symbol,
            "freshestBatchObservedAt": freshest_batch_observed_at.isoformat(),
        }, sort_keys=True))
        return 1
    spot = spot_candidates[0]

    rows = [
        OptionChainRow(
            expiry_date=datetime.combine(row["expiry_date"], datetime.min.time(), tzinfo=timezone.utc),
            strike_price=float(row["strike_price"]),
            option_type=row["option_type"],
            bid=float(row["bid"]) if row["bid"] is not None else None,
            ask=float(row["ask"]) if row["ask"] is not None else None,
            open_interest=int(row["open_interest"]) if row["open_interest"] is not None else None,
            observed_at=row["observed_at"],
        )
        for row in chain_rows
    ]

    observation = aggregate_gex(
        rows=rows,
        underlying_symbol=args.underlying_symbol,
        spot=spot,
        contract_multiplier=contract_multiplier,
        as_of=as_of,
    )
    print(json.dumps(to_json(observation, freshest_batch_observed_at), sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
