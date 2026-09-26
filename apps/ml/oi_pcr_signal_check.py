"""Step 1 of the open-interest / PCR gap analysis: does it carry any signal at all.

This is deliberately the cheap first pass, not a production feature. It builds
labeled examples the normal way (so labels stay causal and correctly purged),
then replaces each example's feature vector with a *minimal*, standalone set of
option-chain features -- put/call ratio and each side's OI-change ratio -- and
runs that through the existing leakage-audit machinery. If this minimal set has
no usable signal on its own, there is no reason to invest in the full ablation
(adding it to the production feature schema and re-running promotion).

Every feature here is built only from `option_chain_snapshots` rows with
``observed_at <= candle.close_time`` (an as-of join, never a future snapshot),
using the collector's own `open_interest_change` field -- already a "since the
previous poll" delta, so it carries no look-ahead by construction. The nearest
un-expired expiry as of each snapshot is used for the whole-chain aggregate,
which is the standard definition of PCR (not an ATM-window version).

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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from ai_quant_lab_ml.contracts import ALGORITHM_CHOICES, LABEL_SCHEME_FIXED_HORIZON, CandleEvidence, DatasetRequest, LabeledExample
from ai_quant_lab_ml.features import label_from_future_close
from ai_quant_lab_ml.leakage import RANDOM_BASELINE_MACRO_F1, run_leakage_audit
from ai_quant_lab_ml.postgres_repository import PostgresMlRepository
from train import non_negative_float, non_blank, parse_timestamp, positive_int, strict_unit_interval


ROOT_DIRECTORY = Path(__file__).resolve().parents[2]

# How stale the most recent option-chain snapshot may be and still count as
# "known at decision time" -- wide enough to survive the collector's own ~7-8
# minute polling cadence, narrow enough that a multi-hour outage correctly
# leaves a candle unlabeled rather than reusing a morning snapshot all day.
MAXIMUM_SNAPSHOT_AGE_MINUTES = 60.0

_CHAIN_AGGREGATE_SQL = """
    WITH nearest_expiry AS (
        SELECT underlying_symbol, observed_at, MIN(expiry_date) AS expiry_date
        FROM option_chain_snapshots
        WHERE underlying_symbol = %s AND expiry_date >= observed_at::date
        GROUP BY underlying_symbol, observed_at
    )
    SELECT
        s.observed_at,
        SUM(CASE WHEN s.option_type = 'CE' THEN s.open_interest ELSE 0 END) AS call_oi,
        SUM(CASE WHEN s.option_type = 'PE' THEN s.open_interest ELSE 0 END) AS put_oi,
        SUM(CASE WHEN s.option_type = 'CE' THEN s.open_interest_change ELSE 0 END) AS call_oi_change,
        SUM(CASE WHEN s.option_type = 'PE' THEN s.open_interest_change ELSE 0 END) AS put_oi_change
    FROM option_chain_snapshots s
    INNER JOIN nearest_expiry ne
      ON ne.underlying_symbol = s.underlying_symbol
     AND ne.observed_at = s.observed_at
     AND ne.expiry_date = s.expiry_date
    WHERE s.underlying_symbol = %s
    GROUP BY s.observed_at
    ORDER BY s.observed_at ASC
"""

OI_FEATURE_SCHEMA: tuple[str, ...] = (
    "oi.pcr_total",
    "oi.pcr_change_bps",
    "oi.call_oi_change_ratio",
    "oi.put_oi_change_ratio",
)


@dataclasses.dataclass(frozen=True)
class ChainSnapshot:
    observed_at: datetime
    call_oi: float
    put_oi: float
    call_oi_change: float
    put_oi_change: float


def build_minimal_labels(records: Sequence[CandleEvidence], request: DatasetRequest) -> list[LabeledExample]:
    """Label every candle with a known future close, skipping the full feature pipeline.

    The production ``build_labeled_examples`` also requires the full indicator/
    pattern/price-action evidence set to be complete before it labels a candle,
    which is the right rule for a model that consumes all of it -- but it drops
    candles that are otherwise perfectly labelable, for evidence this minimal
    OI-only feature set never uses. Labeling directly from the candle's own
    close/future_close keeps every candle that legitimately has one.
    """

    examples: list[LabeledExample] = []
    for candle in sorted(records, key=lambda c: c.close_time):
        result = label_from_future_close(
            source_close=candle.close,
            future_close=candle.future_close,
            neutral_threshold_bps=request.neutral_threshold_bps,
        )
        if result is None or candle.future_close_time is None:
            continue
        examples.append(
            LabeledExample(
                candle_id=candle.candle_id,
                instrument_id=candle.instrument_id,
                symbol=candle.symbol,
                timeframe=candle.timeframe,
                observed_at=candle.close_time,
                label_available_at=candle.future_close_time,
                forward_return=result.forward_return,
                label=result.label,
                features={},
            )
        )
    return examples


def _safe_ratio(numerator: float, denominator: float) -> float:
    if not math.isfinite(numerator) or not math.isfinite(denominator) or denominator == 0:
        return float("nan")
    return numerator / denominator


def load_chain_snapshots(repository: PostgresMlRepository, underlying_symbol: str) -> list[ChainSnapshot]:
    with repository._connection.cursor() as cursor:  # noqa: SLF001 - read-only ad hoc aggregate, not a repository method.
        cursor.execute(_CHAIN_AGGREGATE_SQL, (underlying_symbol, underlying_symbol))
        rows = cursor.fetchall()
    return [
        ChainSnapshot(
            observed_at=row[0] if row[0].tzinfo else row[0].replace(tzinfo=timezone.utc),
            call_oi=float(row[1] or 0),
            put_oi=float(row[2] or 0),
            call_oi_change=float(row[3] or 0),
            put_oi_change=float(row[4] or 0),
        )
        for row in rows
    ]


def oi_features_as_of(
    snapshots: Sequence[ChainSnapshot],
    snapshot_times: Sequence[datetime],
    as_of: datetime,
) -> dict[str, float] | None:
    """Return the minimal OI feature set known at ``as_of``, or None if too stale.

    ``snapshot_times`` is the same order as ``snapshots``, precomputed once by
    the caller so this as-of lookup is a binary search rather than a per-call
    linear scan across ~900 rows per instrument.
    """

    index = bisect_right(snapshot_times, as_of) - 1
    if index < 0:
        return None
    current = snapshots[index]
    age_minutes = (as_of - current.observed_at).total_seconds() / 60.0
    if age_minutes > MAXIMUM_SNAPSHOT_AGE_MINUTES:
        return None

    pcr_total = _safe_ratio(current.put_oi, current.call_oi)
    if index > 0:
        prior = snapshots[index - 1]
        prior_pcr = _safe_ratio(prior.put_oi, prior.call_oi)
        pcr_change_bps = (pcr_total - prior_pcr) * 10_000.0 if math.isfinite(prior_pcr) else float("nan")
    else:
        pcr_change_bps = float("nan")

    return {
        "oi.pcr_total": pcr_total,
        "oi.pcr_change_bps": pcr_change_bps,
        "oi.call_oi_change_ratio": _safe_ratio(current.call_oi_change, current.call_oi),
        "oi.put_oi_change_ratio": _safe_ratio(current.put_oi_change, current.put_oi),
    }


def replace_with_oi_features(
    examples: Sequence[LabeledExample],
    snapshots: Sequence[ChainSnapshot],
) -> list[LabeledExample]:
    snapshot_times = [snapshot.observed_at for snapshot in snapshots]
    rebuilt: list[LabeledExample] = []
    for example in examples:
        oi_features = oi_features_as_of(snapshots, snapshot_times, example.observed_at)
        if oi_features is None or any(not math.isfinite(value) for value in oi_features.values()):
            continue
        rebuilt.append(dataclasses.replace(example, features=oi_features))
    return rebuilt


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Step 1 gap-analysis check: does whole-chain PCR / OI-change carry any "
            "leakage-audit-surviving signal on its own, before investing in a full ablation."
        ),
    )
    parser.add_argument("--instrument", required=True, type=non_blank, help="e.g. NIFTY50 or BANKNIFTY.")
    parser.add_argument("--timeframe", required=True, type=non_blank, help="e.g. 60m.")
    parser.add_argument("--from", dest="data_window_start", required=True, help="YYYY-MM-DD or ISO-8601.")
    parser.add_argument("--to", dest="data_window_end", required=True, help="YYYY-MM-DD or ISO-8601.")
    parser.add_argument("--algorithm", choices=ALGORITHM_CHOICES, default="logistic")
    parser.add_argument("--horizon-bars", type=positive_int, default=5)
    parser.add_argument("--neutral-threshold-bps", type=non_negative_float, default=20.0)
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
        label_scheme=LABEL_SCHEME_FIXED_HORIZON,
    )

    with psycopg.connect(database_url, autocommit=True) as connection:
        repository = PostgresMlRepository(connection)
        records = repository.load_candle_evidence(request)
        labeled = build_minimal_labels(records, request)
        snapshots = load_chain_snapshots(repository, request.instrument_symbol)
        examples = replace_with_oi_features(labeled, snapshots)

        print(
            f"{len(labeled)} labeled candles, {len(snapshots)} chain snapshots, "
            f"{len(examples)} examples with usable OI features (age <= {MAXIMUM_SNAPSHOT_AGE_MINUTES:.0f}min).",
            file=sys.stderr,
        )
        if len(examples) < 100:
            json_output({
                "level": "error",
                "message": f"Only {len(examples)} examples have usable OI coverage; too few for a meaningful audit.",
            })
            return 1

        # A 4-column schema is far narrower than the ~150-column production schema
        # the default shuffle ceiling assumes (per leakage.py's own documented
        # caveat), so a wider ceiling is used here rather than silently reusing a
        # threshold calibrated for a much higher-dimensional feature space.
        audit = run_leakage_audit(
            examples,
            algorithm=args.algorithm,
            horizon_bars=args.horizon_bars,
            schema=OI_FEATURE_SCHEMA,
            random_state=args.random_state,
            validation_fraction=args.validation_fraction,
            shuffle_ceiling=RANDOM_BASELINE_MACRO_F1 + 0.15,
            # Not persistence-dominated: this labels with label_from_future_close, a transient
            # direction target, exactly the case FEATURE_LAG is meant to catch real leakage on
            # (per leakage.py's own docstring). persistence_dominated=True is reserved for a
            # target like volatility where the signal genuinely persists bar-to-bar.
        )

    json_output({
        "level": "info",
        "message": "OI/PCR minimal-feature leakage audit complete",
        "dataset": {
            "instrument": request.instrument_symbol,
            "timeframe": request.timeframe,
            "dataWindowStart": request.data_window_start.isoformat(),
            "dataWindowEnd": request.data_window_end.isoformat(),
            "horizonBars": request.horizon_bars,
            "neutralThresholdBps": request.neutral_threshold_bps,
            "labeledCandles": len(labeled),
            "chainSnapshots": len(snapshots),
            "usableExamples": len(examples),
        },
        "featureSchema": list(OI_FEATURE_SCHEMA),
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
