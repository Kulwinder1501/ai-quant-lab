"""Step 1 of the open-interest / PCR gap analysis: does it carry any signal at all.

This is deliberately the cheap first pass, not a production feature. It builds
labeled examples the normal way (so labels stay causal and correctly purged),
then replaces each example's feature vector with a *minimal*, standalone set of
option-chain features -- put/call ratio and each side's OI-change ratio -- and
runs that through the existing leakage-audit machinery. If this minimal set has
no usable signal on its own, there is no reason to invest in the full ablation
(adding it to the production feature schema and re-running promotion).

Every feature here is built only from `option_chain_snapshots` rows with
``observed_at <= candle.close_time`` (an as-of join, never a future snapshot).

What the features actually are (corrected 2026-10 after an audit):

* The PCR is a *windowed* PCR: the collector stores only the +/-``strikecount``
  strikes around spot at collection time, so put OI / call OI covers that
  window, not the whole exchange chain. It is named ``oi.pcr_windowed``.
* The vendor's ``open_interest_change`` is ``open_interest - previous_open_interest``,
  i.e. the change versus the PREVIOUS DAY's close -- NOT "since the previous
  poll" as an earlier version of this docstring claimed. Its ratio features are
  therefore named ``*_dod_change_ratio`` (day-over-day). The poll-to-poll PCR
  change (``oi.pcr_change_bps``) is computed from consecutive snapshots of the
  SAME expiry only.
* The expiry is chosen first from the stored calendar (nearest expiry whose
  15:30 IST settlement is still ahead of the candle close), then the latest
  in-session snapshot of that expiry at or before the close is used. See
  ``ai_quant_lab_ml/option_chain_pcr.py`` for the full rule, shared with the live
  gate and ``run_hybrid_confluence_backtest.py``.

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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from ai_quant_lab_ml.contracts import ALGORITHM_CHOICES, LABEL_SCHEME_FIXED_HORIZON, CandleEvidence, DatasetRequest, LabeledExample
from ai_quant_lab_ml.features import label_from_future_close
from ai_quant_lab_ml.leakage import RANDOM_BASELINE_MACRO_F1, run_leakage_audit
from ai_quant_lab_ml.option_chain_pcr import (
    MAX_SNAPSHOT_AGE_MINUTES,
    OptionChainBooks,
    load_option_chain_books,
    poll_to_poll_pcr_change,
    safe_ratio,
)
from ai_quant_lab_ml.postgres_repository import PostgresMlRepository
from train import non_negative_float, non_blank, parse_timestamp, positive_int, strict_unit_interval


ROOT_DIRECTORY = Path(__file__).resolve().parents[2]

# How stale the most recent option-chain snapshot may be and still count as
# "known at decision time". ONE ceiling shared with the live gate
# (OPTION_CHAIN_MAX_SNAPSHOT_AGE_MINUTES in option-chain-signal.ts) and
# run_hybrid_confluence_backtest.py: 20 minutes, which admits the collector's
# slowest healthy poll (12-minute median, 18-minute p90) plus jitter. It used to
# be 15 here, 15 live and 60 in the backtest. Cadence math in option_chain_pcr.py.
MAXIMUM_SNAPSHOT_AGE_MINUTES = MAX_SNAPSHOT_AGE_MINUTES

OI_FEATURE_SCHEMA: tuple[str, ...] = (
    # Windowed (+/-strikecount around spot), nearest un-settled expiry.
    "oi.pcr_windowed",
    # Poll-to-poll: change since the previous snapshot of the SAME expiry, in bps.
    "oi.pcr_change_bps",
    # Day-over-day: vendor open_interest_change (vs the previous day's close) / OI.
    "oi.call_oi_dod_change_ratio",
    "oi.put_oi_dod_change_ratio",
)


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


def load_chain_snapshots(repository: PostgresMlRepository, underlying_symbol: str) -> OptionChainBooks:
    # Read-only ad hoc aggregate, not a repository method.
    return load_option_chain_books(repository._connection, underlying_symbol)  # noqa: SLF001


def oi_features_as_of(books: OptionChainBooks, as_of: datetime) -> dict[str, float] | None:
    """Return the minimal OI feature set known at ``as_of``, or None when the PCR is unavailable.

    The expiry is selected first (nearest un-settled per the stored calendar), then the latest
    in-session snapshot of that expiry at or before ``as_of`` -- see ``option_chain_pcr.py``. A
    stale, incomplete or absent book yields None with an explicit reason available from
    ``books.resolve(as_of).reason`` rather than being reused silently.
    """
    resolution = books.resolve(as_of, MAXIMUM_SNAPSHOT_AGE_MINUTES)
    if resolution.book is None or resolution.pcr_windowed is None:
        return None
    current = resolution.book
    pcr_change = poll_to_poll_pcr_change(resolution)
    return {
        "oi.pcr_windowed": resolution.pcr_windowed,
        "oi.pcr_change_bps": pcr_change * 10_000.0,
        "oi.call_oi_dod_change_ratio": safe_ratio(current.call_oi_change_vs_prev_day, current.call_oi),
        "oi.put_oi_dod_change_ratio": safe_ratio(current.put_oi_change_vs_prev_day, current.put_oi),
    }


def replace_with_oi_features(
    examples: Sequence[LabeledExample],
    books: OptionChainBooks,
) -> list[LabeledExample]:
    rebuilt: list[LabeledExample] = []
    for example in examples:
        oi_features = oi_features_as_of(books, example.observed_at)
        if oi_features is None or any(not math.isfinite(value) for value in oi_features.values()):
            continue
        rebuilt.append(dataclasses.replace(example, features=oi_features))
    return rebuilt


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Step 1 gap-analysis check: does windowed PCR / day-over-day OI-change carry any "
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
        books = load_chain_snapshots(repository, request.instrument_symbol)
        snapshot_count = sum(len(series) for series in books.books_by_expiry.values())
        examples = replace_with_oi_features(labeled, books)

        print(
            f"{len(labeled)} labeled candles, {snapshot_count} in-session expiry books, "
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
            "chainSnapshots": snapshot_count,
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
