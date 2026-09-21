"""Gap-analysis check: does the NIFTY50/BANKNIFTY relative-value ratio carry signal.

Everything else tested so far is single-instrument. This is the cross-sectional
case: build a ratio series from two already-fully-collected instruments, label
it exactly the way a single price series is labeled (``label_from_future_close``
works unchanged on a ratio -- it only needs a source value and a future value),
and test two standard pairs-trading hypotheses against it with the same
minimal-feature leakage-audit approach as the rest of this gap analysis:

* mean reversion -- a stretched ratio (high z-score vs its own trailing window)
  reverts, so the z-score should predict the *opposite*-signed forward move.
* momentum -- a ratio that has just moved should keep moving, so the recent
  ratio return should predict a *same*-signed forward move.

Both features are computed only from ratio values at or before the source
candle's own close -- no leakage across the join, since both legs already
respect their own instrument's causal boundary before the ratio is formed.

Read-only: no model version, prediction, paper trade, or order is created.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import math
import os
import statistics
import sys
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from ai_quant_lab_ml.contracts import ALGORITHM_CHOICES, CandleEvidence, DatasetRequest, LabeledExample
from ai_quant_lab_ml.features import label_from_future_close
from ai_quant_lab_ml.leakage import RANDOM_BASELINE_MACRO_F1, run_leakage_audit
from ai_quant_lab_ml.postgres_repository import PostgresMlRepository
from train import non_negative_float, non_blank, parse_timestamp, positive_int, strict_unit_interval


ROOT_DIRECTORY = Path(__file__).resolve().parents[2]

PAIR_FEATURE_SCHEMA: tuple[str, ...] = (
    "pair.ratio_zscore",
    "pair.ratio_return_bps",
)

ZSCORE_WINDOW_BARS = 20
MOMENTUM_WINDOW_BARS = 5


def _ratio_bps(numerator: float, denominator: float) -> float:
    if not math.isfinite(numerator) or not math.isfinite(denominator) or denominator == 0:
        return float("nan")
    return ((numerator - denominator) / denominator) * 10_000.0


def build_pair_examples(
    numerator_records: Sequence[CandleEvidence],
    denominator_records: Sequence[CandleEvidence],
    *,
    neutral_threshold_bps: float,
) -> list[LabeledExample]:
    """Join two instruments' candle evidence by close_time and label the ratio.

    Only bars present in both series are kept -- a collection gap in either
    instrument correctly drops that timestamp from the pair rather than
    guessing a value for the missing side.
    """

    by_close_time = {record.close_time: record for record in denominator_records}
    joined = sorted(
        (
            (numerator, by_close_time[numerator.close_time])
            for numerator in numerator_records
            if numerator.close_time in by_close_time
        ),
        key=lambda pair: pair[0].close_time,
    )

    ratio_window: deque[float] = deque(maxlen=ZSCORE_WINDOW_BARS)
    momentum_window: deque[float] = deque(maxlen=MOMENTUM_WINDOW_BARS + 1)
    examples: list[LabeledExample] = []
    for numerator, denominator in joined:
        if denominator.close <= 0:
            continue
        current_ratio = numerator.close / denominator.close

        zscore = float("nan")
        if len(ratio_window) >= ZSCORE_WINDOW_BARS:
            mean = statistics.fmean(ratio_window)
            stdev = statistics.pstdev(ratio_window)
            zscore = (current_ratio - mean) / stdev if stdev > 0 else float("nan")

        momentum_return_bps = float("nan")
        if len(momentum_window) >= MOMENTUM_WINDOW_BARS + 1:
            momentum_return_bps = _ratio_bps(current_ratio, momentum_window[0])

        ratio_window.append(current_ratio)
        momentum_window.append(current_ratio)

        if not math.isfinite(zscore) or not math.isfinite(momentum_return_bps):
            continue
        if numerator.future_close is None or denominator.future_close in (None, 0):
            continue

        future_ratio = numerator.future_close / denominator.future_close
        label_result = label_from_future_close(
            source_close=current_ratio,
            future_close=future_ratio,
            neutral_threshold_bps=neutral_threshold_bps,
        )
        if label_result is None or numerator.future_close_time is None:
            continue

        examples.append(
            LabeledExample(
                candle_id=numerator.candle_id,
                instrument_id=numerator.instrument_id,
                symbol=f"{numerator.symbol}/{denominator.symbol}",
                timeframe=numerator.timeframe,
                observed_at=numerator.close_time,
                label_available_at=numerator.future_close_time,
                forward_return=label_result.forward_return,
                label=label_result.label,
                features={
                    "pair.ratio_zscore": zscore,
                    "pair.ratio_return_bps": momentum_return_bps,
                },
            )
        )
    return sorted(examples, key=lambda example: example.observed_at)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Gap-analysis check: NIFTY50/BANKNIFTY relative-value ratio, standalone leakage audit.",
    )
    parser.add_argument("--numerator", default="BANKNIFTY", type=non_blank, help="Ratio numerator (default: BANKNIFTY).")
    parser.add_argument("--denominator", default="NIFTY50", type=non_blank, help="Ratio denominator (default: NIFTY50).")
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

    common = dict(
        timeframe=args.timeframe,
        data_window_start=parse_timestamp(args.data_window_start),
        data_window_end=parse_timestamp(args.data_window_end, end_of_day=True),
        data_cutoff_at=datetime.now(timezone.utc),
        horizon_bars=args.horizon_bars,
        neutral_threshold_bps=args.neutral_threshold_bps,
    )
    numerator_request = DatasetRequest(instrument_symbol=args.numerator.upper(), **common)
    denominator_request = DatasetRequest(instrument_symbol=args.denominator.upper(), **common)

    with psycopg.connect(database_url, autocommit=True) as connection:
        repository = PostgresMlRepository(connection)
        numerator_records = repository.load_candle_evidence(numerator_request)
        denominator_records = repository.load_candle_evidence(denominator_request)
        examples = build_pair_examples(
            numerator_records, denominator_records, neutral_threshold_bps=args.neutral_threshold_bps,
        )

        print(
            f"{len(numerator_records)} {args.numerator} candles, {len(denominator_records)} {args.denominator} candles, "
            f"{len(examples)} joined+labeled pair examples.",
            file=sys.stderr,
        )
        if len(examples) < 100:
            json_output({
                "level": "error",
                "message": f"Only {len(examples)} pair examples; too few for a meaningful audit.",
            })
            return 1

        audit = run_leakage_audit(
            examples,
            algorithm=args.algorithm,
            horizon_bars=args.horizon_bars,
            schema=PAIR_FEATURE_SCHEMA,
            random_state=args.random_state,
            validation_fraction=args.validation_fraction,
            shuffle_ceiling=RANDOM_BASELINE_MACRO_F1 + 0.15,
            persistence_dominated=True,
        )

    json_output({
        "level": "info",
        "message": "Cross-sectional pair leakage audit complete",
        "dataset": {
            "pair": f"{args.numerator}/{args.denominator}",
            "timeframe": args.timeframe,
            "usableExamples": len(examples),
        },
        "featureSchema": list(PAIR_FEATURE_SCHEMA),
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
