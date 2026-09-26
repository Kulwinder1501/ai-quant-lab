"""Gap-analysis check: does isolated FII/DII cash flow carry signal on its own.

``fii_cash_net_cr`` and ``dii_cash_net_cr`` already ride along inside the full
production feature vector (as ``market.fii_net_flow_ratio`` /
``market.dii_net_flow_ratio``), but their marginal contribution has never been
isolated and tested the way ICT/patterns/chop-filters were. This is that
isolation test, with the same minimal-feature leakage-audit approach as
``oi_pcr_signal_check.py``.

Note going in: ``fii_index_futures_net_cr`` / ``fii_index_options_net_cr`` (the
actual derivative-positioning fields, the more interesting institutional
signal) turned out to be 100% NULL in every row collected so far -- that data
was never actually populated, so only cash flow is testable here. Also,
``institutional_flows`` is daily and only 98 rows deep (2026-03-30 to
2026-09-18), so this test runs on 1d candles and is well below the sample size
of the OI/PCR check -- a low-powered first look, not a conclusive one.

Causality: joined on ``published_at <= candle.close_time``, not ``date <=
candle.close_time`` -- the flow figure for a session is published same-day
after market close, so using the calendar date alone would leak same-day flow
into a same-day decision.

Read-only: no model version, prediction, paper trade, or order is created.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import math
import os
import sys
from bisect import bisect_right
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from ai_quant_lab_ml.contracts import ALGORITHM_CHOICES, DatasetRequest, LabeledExample
from ai_quant_lab_ml.leakage import RANDOM_BASELINE_MACRO_F1, run_leakage_audit
from ai_quant_lab_ml.postgres_repository import PostgresMlRepository
from oi_pcr_signal_check import build_minimal_labels
from train import non_negative_float, non_blank, parse_timestamp, positive_int, strict_unit_interval


ROOT_DIRECTORY = Path(__file__).resolve().parents[2]

# A daily figure only needs to survive to the next session; wide enough that a
# weekend/holiday gap does not strand every Monday candle, narrow enough that a
# genuine multi-day collector outage correctly leaves candles unlabeled.
MAXIMUM_FLOW_AGE_DAYS = 4.0

_FLOW_SQL = """
    SELECT date, published_at, fii_cash_net_cr, dii_cash_net_cr
    FROM institutional_flows
    WHERE published_at IS NOT NULL
    ORDER BY published_at ASC
"""

FLOW_FEATURE_SCHEMA: tuple[str, ...] = (
    "flow.fii_cash_net_cr_scaled",
    "flow.dii_cash_net_cr_scaled",
    "flow.fii_dii_agreement",
)

# Scales the raw crore figure into a roughly comparable, dimensionless range
# without peeking at any statistic computed over the test window itself --
# a fixed constant, not a rolling normalization fit on the data being audited.
FLOW_SCALE_CR = 3000.0


@dataclasses.dataclass(frozen=True)
class FlowRow:
    published_at: datetime
    fii_cash_net_cr: float
    dii_cash_net_cr: float


def load_flow_rows(repository: PostgresMlRepository) -> list[FlowRow]:
    with repository._connection.cursor() as cursor:  # noqa: SLF001 - read-only ad hoc query, not a repository method.
        cursor.execute(_FLOW_SQL)
        rows = cursor.fetchall()
    return [
        FlowRow(
            published_at=row[1] if row[1].tzinfo else row[1].replace(tzinfo=timezone.utc),
            fii_cash_net_cr=float(row[2] or 0),
            dii_cash_net_cr=float(row[3] or 0),
        )
        for row in rows
    ]


def flow_features_as_of(
    flows: Sequence[FlowRow], published_times: Sequence[datetime], as_of: datetime,
) -> dict[str, float] | None:
    index = bisect_right(published_times, as_of) - 1
    if index < 0:
        return None
    current = flows[index]
    age_days = (as_of - current.published_at).total_seconds() / 86_400.0
    if age_days > MAXIMUM_FLOW_AGE_DAYS:
        return None
    fii_scaled = current.fii_cash_net_cr / FLOW_SCALE_CR
    dii_scaled = current.dii_cash_net_cr / FLOW_SCALE_CR
    return {
        "flow.fii_cash_net_cr_scaled": fii_scaled,
        "flow.dii_cash_net_cr_scaled": dii_scaled,
        # FII/DII flows are structurally opposed most sessions (DII often
        # absorbs FII selling); a day they agree in sign is the less common,
        # arguably more informative case, so it gets its own feature rather
        # than being left for a linear model to rediscover from the other two.
        "flow.fii_dii_agreement": 1.0 if (fii_scaled > 0) == (dii_scaled > 0) else 0.0,
    }


def replace_with_flow_features(
    examples: Sequence[LabeledExample], flows: Sequence[FlowRow],
) -> list[LabeledExample]:
    published_times = [flow.published_at for flow in flows]
    rebuilt: list[LabeledExample] = []
    for example in examples:
        features = flow_features_as_of(flows, published_times, example.observed_at)
        if features is None or any(not math.isfinite(value) for value in features.values()):
            continue
        rebuilt.append(dataclasses.replace(example, features=features))
    return rebuilt


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Gap-analysis check: isolated FII/DII cash-flow signal, standalone leakage audit.",
    )
    parser.add_argument("--instrument", required=True, type=non_blank)
    parser.add_argument("--timeframe", required=True, type=non_blank, help="Use 1d -- institutional_flows is daily.")
    parser.add_argument("--from", dest="data_window_start", required=True)
    parser.add_argument("--to", dest="data_window_end", required=True)
    parser.add_argument("--algorithm", choices=ALGORITHM_CHOICES, default="logistic")
    parser.add_argument("--horizon-bars", type=positive_int, default=5)
    parser.add_argument("--neutral-threshold-bps", type=non_negative_float, default=50.0)
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
        flows = load_flow_rows(repository)
        examples = replace_with_flow_features(labeled, flows)

        print(
            f"{len(labeled)} labeled candles, {len(flows)} flow rows, "
            f"{len(examples)} examples with usable flow features (age <= {MAXIMUM_FLOW_AGE_DAYS:.0f}d).",
            file=sys.stderr,
        )
        if len(examples) < 60:
            json_output({
                "level": "error",
                "message": f"Only {len(examples)} examples have usable flow coverage; too few for a meaningful audit.",
            })
            return 1

        audit = run_leakage_audit(
            examples,
            algorithm=args.algorithm,
            horizon_bars=args.horizon_bars,
            schema=FLOW_FEATURE_SCHEMA,
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
        "message": "FII/DII isolated cash-flow leakage audit complete",
        "dataset": {
            "instrument": request.instrument_symbol,
            "timeframe": request.timeframe,
            "labeledCandles": len(labeled),
            "flowRows": len(flows),
            "usableExamples": len(examples),
        },
        "featureSchema": list(FLOW_FEATURE_SCHEMA),
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
