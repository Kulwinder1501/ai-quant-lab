"""One-off: does adding ICT structural covariates to v9 change directional skill?

The "ICT as a feature source, not a strategy" proposal (see
ict-implementation-vs-source-doctrine / ict-no-stable-edge-sign-flips memory) claims HTF bias,
premium/discount zone, order-block proximity, and BOS/CHoCH presence are structural market-state
variables a directional model never sees. `ml-feature-v-ict` (v9 + 11 ICT columns) is the schema
built to test that, following the same "extract the behavior, register a new schema, run the
existing leakage audit" pattern as `ml-feature-v7-nopattern`.

A three-way comparison, not two: `ml-feature-v-ict`'s order-block distance is the NAIVE,
same-timeframe construction, checked against the source transcripts and found not to be what the
doctrine actually describes (lecture 4's "Refined Order Block", lecture 3's structure-mapping
section -- both read top-down, anchored to a higher timeframe, never independently per timeframe).
`ml-feature-v-ict-refined` adds the doctrine-faithful cross-timeframe construction on top. Comparing
all three on identical data answers two separate questions at once: does ICT help at all, and if the
naive version doesn't, does building the real thing change that.

This runs `run_leakage_audit` -- the same base/shuffle/lag/era harness used for every other
directional feature measured in this project -- under all three schemas, on both NIFTY50 and
BANKNIFTY 15m, because a result that does not replicate across both indices has closed every prior
ICT candidate here. The comparison is on the *same* horizon/threshold/window/split throughout, not
an attempt to reproduce any other script's exact historical number.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone

import psycopg

from ai_quant_lab_ml.contracts import (
    FEATURE_SCHEMA_VERSION_V9,
    FEATURE_SCHEMA_VERSION_V_ICT,
    FEATURE_SCHEMA_VERSION_V_ICT_REFINED,
    DatasetRequest,
)
from ai_quant_lab_ml.features import (
    FEATURE_SCHEMA_V9,
    FEATURE_SCHEMA_V_ICT,
    FEATURE_SCHEMA_V_ICT_REFINED,
    build_labeled_examples,
)
from ai_quant_lab_ml.leakage import LeakageAuditError, run_leakage_audit
from ai_quant_lab_ml.postgres_repository import PostgresMlRepository

HORIZON_BARS = 4  # 1 hour ahead on 15m bars
NEUTRAL_THRESHOLD_BPS = 15.0
ALGORITHM = "lightgbm"
SERIES = [("NIFTY50", "15m"), ("BANKNIFTY", "15m")]


def database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    raise SystemExit("Set DATABASE_URL before running this script.")


def run_one(connection: psycopg.Connection, symbol: str, timeframe: str, schema_version: str, schema: tuple[str, ...]) -> dict:
    repo = PostgresMlRepository(connection)
    now = datetime.now(timezone.utc)
    request = DatasetRequest(
        instrument_symbol=symbol,
        timeframe=timeframe,
        data_window_start=datetime(2023, 1, 1, tzinfo=timezone.utc),
        # Leave a comfortable margin before "now" so every candle in the window has both a resolved
        # horizon-ahead label and a `received_at` safely under the cutoff below.
        data_window_end=now - timedelta(days=7),
        data_cutoff_at=now,
        horizon_bars=HORIZON_BARS,
        neutral_threshold_bps=NEUTRAL_THRESHOLD_BPS,
    )
    candles = repo.load_candle_evidence(request)
    with_ict = sum(1 for c in candles if c.ict is not None)
    # Explicit override: build_labeled_examples defaults to schema_version_for(request.timeframe)
    # (the production v7 contract for a 15m swing series), which would silently ignore the schema
    # this experiment is actually comparing -- both v9 and v-ict would fit on identical NaN-padded
    # v7 vectors and produce byte-identical results. Caught exactly that way on the first run.
    examples = build_labeled_examples(candles, request, schema_version=schema_version)

    try:
        audit = run_leakage_audit(
            examples,
            algorithm=ALGORITHM,
            horizon_bars=HORIZON_BARS,
            schema=schema,
        )
    except LeakageAuditError as error:
        return {"symbol": symbol, "timeframe": timeframe, "schemaVersion": schema_version, "error": str(error)}

    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "schemaVersion": schema_version,
        "candles": len(candles),
        "candlesWithIct": with_ict,
        "examples": len(examples),
        "verdict": audit["verdict"],
        "summary": audit["summary"],
        "baseline": audit["baseline"],
        "metrics": audit["metrics"],
        "checks": {c["check"]: {"status": c["status"], "detail": c["detail"]} for c in audit["checks"]},
    }


def main() -> None:
    results = []
    with psycopg.connect(database_url(), connect_timeout=10) as connection:
        for symbol, timeframe in SERIES:
            for schema_version, schema in (
                (FEATURE_SCHEMA_VERSION_V9, FEATURE_SCHEMA_V9),
                (FEATURE_SCHEMA_VERSION_V_ICT, FEATURE_SCHEMA_V_ICT),
                (FEATURE_SCHEMA_VERSION_V_ICT_REFINED, FEATURE_SCHEMA_V_ICT_REFINED),
            ):
                print(f"--- {symbol} {timeframe} {schema_version} ---", file=sys.stderr)
                result = run_one(connection, symbol, timeframe, schema_version, schema)
                results.append(result)
                print(json.dumps(result, indent=2), file=sys.stderr)

    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
