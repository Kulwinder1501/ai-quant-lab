"""Gap-analysis check: does proximity to options expiry carry directional signal.

Expiry-week pinning/unwind behavior is a commonly cited effect in Indian index
options (dealer gamma hedging flows concentrate as expiry nears). This tests
the simplest version of that idea -- trading-days-to-nearest-expiry as a
standalone feature -- with the same minimal-feature leakage-audit approach as
the other gap-analysis checks.

Simplification made deliberately: expiry dates are exchange-fixed well in
advance and are not derived from price, so unlike OI or FII flow they carry no
real leakage risk from being read without reconstructing exactly which
snapshot of the calendar was known at each point in time. Every distinct
expiry_date on record for the underlying is used directly.

Read-only: no model version, prediction, paper trade, or order is created.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import math
import os
import sys
from bisect import bisect_left
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from ai_quant_lab_ml.contracts import ALGORITHM_CHOICES, DatasetRequest, LabeledExample
from ai_quant_lab_ml.leakage import RANDOM_BASELINE_MACRO_F1, run_leakage_audit
from ai_quant_lab_ml.postgres_repository import PostgresMlRepository
from oi_pcr_signal_check import build_minimal_labels
from train import non_negative_float, non_blank, parse_timestamp, positive_int, strict_unit_interval


ROOT_DIRECTORY = Path(__file__).resolve().parents[2]

_EXPIRY_DATES_SQL = """
    SELECT DISTINCT expiry_date
    FROM option_expiry_calendar
    WHERE underlying_symbol = %s
    ORDER BY expiry_date ASC
"""

EXPIRY_FEATURE_SCHEMA: tuple[str, ...] = (
    "expiry.days_to_nearest",
    "expiry.is_expiry_week",
)

# One trading week: close enough to expiry that dealer hedging flows are
# commonly cited as concentrating, without narrowing the window so far that
# the "expiry week" indicator loses almost all its positive examples.
EXPIRY_WEEK_TRADING_DAYS = 5


def load_expiry_dates(repository: PostgresMlRepository, underlying_symbol: str) -> list[date]:
    with repository._connection.cursor() as cursor:  # noqa: SLF001 - read-only ad hoc query, not a repository method.
        cursor.execute(_EXPIRY_DATES_SQL, (underlying_symbol,))
        return [row[0] for row in cursor.fetchall()]


def expiry_features_as_of(expiry_dates: Sequence[date], as_of: datetime) -> dict[str, float] | None:
    as_of_date = as_of.date()
    index = bisect_left(expiry_dates, as_of_date)
    if index >= len(expiry_dates):
        return None
    calendar_days = (expiry_dates[index] - as_of_date).days
    # A rough trading-day count (5/7) rather than the calendar gap directly,
    # so the "expiry week" cutoff means the same thing across a normal week
    # and one broken up by a holiday.
    trading_days = calendar_days * 5.0 / 7.0
    return {
        "expiry.days_to_nearest": trading_days,
        "expiry.is_expiry_week": 1.0 if trading_days <= EXPIRY_WEEK_TRADING_DAYS else 0.0,
    }


def replace_with_expiry_features(
    examples: Sequence[LabeledExample], expiry_dates: Sequence[date],
) -> list[LabeledExample]:
    rebuilt: list[LabeledExample] = []
    for example in examples:
        features = expiry_features_as_of(expiry_dates, example.observed_at)
        if features is None or any(not math.isfinite(value) for value in features.values()):
            continue
        rebuilt.append(dataclasses.replace(example, features=features))
    return rebuilt


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Gap-analysis check: days-to-expiry as a standalone directional signal.",
    )
    parser.add_argument("--instrument", required=True, type=non_blank)
    parser.add_argument("--timeframe", required=True, type=non_blank)
    parser.add_argument("--from", dest="data_window_start", required=True)
    parser.add_argument("--to", dest="data_window_end", required=True)
    parser.add_argument("--algorithm", choices=ALGORITHM_CHOICES, default="logistic")
    parser.add_argument("--horizon-bars", type=positive_int, default=5)
    parser.add_argument("--neutral-threshold-bps", type=non_negative_float, default=9.0)
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
        neutral_threshold_bps=args.neutral_threshold_bps,
    )

    with psycopg.connect(database_url, autocommit=True) as connection:
        repository = PostgresMlRepository(connection)
        records = repository.load_candle_evidence(request)
        labeled = build_minimal_labels(records, request)
        expiry_dates = load_expiry_dates(repository, request.instrument_symbol)
        examples = replace_with_expiry_features(labeled, expiry_dates)

        print(
            f"{len(labeled)} labeled candles, {len(expiry_dates)} known expiry dates, "
            f"{len(examples)} examples with usable expiry features.",
            file=sys.stderr,
        )
        if len(examples) < 100:
            json_output({
                "level": "error",
                "message": f"Only {len(examples)} examples have usable expiry coverage; too few for a meaningful audit.",
            })
            return 1

        audit = run_leakage_audit(
            examples,
            algorithm=args.algorithm,
            horizon_bars=args.horizon_bars,
            schema=EXPIRY_FEATURE_SCHEMA,
            random_state=args.random_state,
            validation_fraction=args.validation_fraction,
            shuffle_ceiling=RANDOM_BASELINE_MACRO_F1 + 0.15,
            # Not persistence-dominated: build_minimal_labels labels with label_from_future_close,
            # a transient direction target, exactly the case FEATURE_LAG is meant to catch real
            # leakage on. persistence_dominated=True is reserved for a target like volatility
            # where the signal genuinely persists bar-to-bar.
        )

    json_output({
        "level": "info",
        "message": "Expiry-proximity leakage audit complete",
        "dataset": {
            "instrument": request.instrument_symbol,
            "timeframe": request.timeframe,
            "labeledCandles": len(labeled),
            "expiryDatesKnown": len(expiry_dates),
            "usableExamples": len(examples),
        },
        "featureSchema": list(EXPIRY_FEATURE_SCHEMA),
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
    except Exception as error:  # noqa: BLE001
        json_output({"level": "error", "message": str(error), "errorType": type(error).__name__})
        raise SystemExit(1)
