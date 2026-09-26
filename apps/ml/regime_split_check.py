"""Regime-switching gap analysis, step 1: is there anything here worth building.

Before building any regime detector (HMM or otherwise), this checks the cheap
question first: does a crude trend/chop proxy, split against *already settled*
trade outcomes, show a real difference in adverse excursion? If trending vs.
choppy periods don't differ, a fancier detector won't manufacture a difference
that isn't there, and steps 2-3 (build the HMM, wire it into
VolatilityRiskControl.stopMultiplier) are not worth doing.

The proxy is Kaufman's Efficiency Ratio over the trailing N bars before each
trade idea's own source candle: |net price change| / sum(|each bar's change|),
in [0, 1]. Near 1 means the market moved directionally (trending); near 0
means it round-tripped through a lot of back-and-forth (choppy). Computed only
from candles at or before the source candle's close_time -- causal by
construction, and using only settled trade ideas means every outcome compared
here already happened.

Read-only: this only reads existing settlement history. Nothing is created.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
from pathlib import Path
from typing import Any, Mapping

from train import non_blank, positive_int


ROOT_DIRECTORY = Path(__file__).resolve().parents[2]

_SETTLEMENTS_SQL = """
    SELECT
        i.symbol,
        c.timeframe,
        c.close_time AS entry_close_time,
        cs.mae_r,
        cs.mfe_r,
        cs.r_multiple,
        cs.outcome
    FROM candidate_settlements cs
    JOIN trade_ideas ti ON ti.id = cs.trade_idea_id
    JOIN candles c ON c.id = ti.source_candle_id
    JOIN instruments i ON i.id = ti.instrument_id
    -- UNRESOLVED rows carry a still-evolving excursion, not a final one, and
    -- UNSETTLEABLE means the data itself is untrustworthy -- neither belongs
    -- in a comparison of *completed* outcomes.
    WHERE cs.mae_r IS NOT NULL AND cs.outcome IN ('STOP', 'TARGET')
    ORDER BY i.symbol, c.timeframe, c.close_time
"""

_CANDLES_SQL = """
    SELECT c.close_time, c.close
    FROM candles c
    JOIN instruments i ON i.id = c.instrument_id
    WHERE i.symbol = %s AND c.timeframe = %s AND c.is_complete = TRUE
    ORDER BY c.close_time ASC
"""


def efficiency_ratio(closes: list[float]) -> float | None:
    """Kaufman's Efficiency Ratio over a trailing close-price window.

    ``closes`` must already be in chronological order, oldest first, ending at
    (and including) the decision bar. Returns None if the window has zero net
    movement to compare against (a dead market, not a meaningful chop reading).
    """

    if len(closes) < 3:
        return None
    net_change = abs(closes[-1] - closes[0])
    path_length = sum(abs(closes[i] - closes[i - 1]) for i in range(1, len(closes)))
    if path_length == 0:
        return None
    return net_change / path_length


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Regime-switching step 1: split settled trade outcomes by trend/chop proxy, look for a real difference.",
    )
    parser.add_argument("--lookback-bars", type=positive_int, default=10, help="Bars before entry used for the efficiency ratio (default: 10).")
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
    from bisect import bisect_right

    with psycopg.connect(database_url, autocommit=True) as connection:
        with connection.cursor() as cursor:
            cursor.execute(_SETTLEMENTS_SQL)
            settlements = cursor.fetchall()

        candle_cache: dict[tuple[str, str], tuple[list, list]] = {}

        def candles_for(symbol: str, timeframe: str) -> tuple[list, list]:
            key = (symbol, timeframe)
            if key not in candle_cache:
                with connection.cursor() as cursor:
                    cursor.execute(_CANDLES_SQL, (symbol, timeframe))
                    rows = cursor.fetchall()
                candle_cache[key] = ([row[0] for row in rows], [float(row[1]) for row in rows])
            return candle_cache[key]

        rows: list[dict[str, Any]] = []
        for symbol, timeframe, entry_close_time, mae_r, mfe_r, r_multiple, outcome in settlements:
            close_times, closes = candles_for(symbol, timeframe)
            index = bisect_right(close_times, entry_close_time) - 1
            if index < args.lookback_bars:
                continue
            window = closes[index - args.lookback_bars + 1 : index + 1]
            er = efficiency_ratio(window)
            if er is None:
                continue
            rows.append({
                "symbol": symbol,
                "timeframe": timeframe,
                "efficiencyRatio": er,
                "maeR": float(mae_r),
                "mfeR": float(mfe_r) if mfe_r is not None else None,
                "rMultiple": float(r_multiple) if r_multiple is not None else None,
                "outcome": outcome,
            })

    if len(rows) < 100:
        json_output({"level": "error", "message": f"Only {len(rows)} settlements with a computable regime proxy; too few."})
        return 1

    sorted_by_er = sorted(rows, key=lambda row: row["efficiencyRatio"])
    midpoint = len(sorted_by_er) // 2
    choppy, trending = sorted_by_er[:midpoint], sorted_by_er[midpoint:]

    def summarize(group: list[dict[str, Any]], label: str) -> dict[str, Any]:
        mae_values = [row["maeR"] for row in group]
        stopped_out = sum(1 for row in group if row["outcome"] == "STOP")
        return {
            "label": label,
            "count": len(group),
            "efficiencyRatioRange": [group[0]["efficiencyRatio"], group[-1]["efficiencyRatio"]],
            "meanMaeR": statistics.fmean(mae_values),
            "medianMaeR": statistics.median(mae_values),
            "stdevMaeR": statistics.pstdev(mae_values) if len(mae_values) > 1 else None,
            "stopOutRate": stopped_out / len(group),
        }

    choppy_summary = summarize(choppy, "choppy (low efficiency ratio)")
    trending_summary = summarize(trending, "trending (high efficiency ratio)")

    # A crude two-sample check, not a full significance test -- enough to tell
    # whether the gap is worth a real test or clearly within noise.
    pooled_stdev = statistics.pstdev([row["maeR"] for row in rows])
    mae_gap = trending_summary["meanMaeR"] - choppy_summary["meanMaeR"]
    effect_size = mae_gap / pooled_stdev if pooled_stdev > 0 else None

    json_output({
        "level": "info",
        "message": "Regime-split (trend/chop) check on settled trade outcomes complete",
        "totalSettlementsConsidered": len(settlements),
        "usableRows": len(rows),
        "lookbackBars": args.lookback_bars,
        "choppy": choppy_summary,
        "trending": trending_summary,
        "maeRGap": mae_gap,
        "roughEffectSize": effect_size,
        "interpretation": (
            "roughEffectSize is (trending mean MAE - choppy mean MAE) / pooled stdev. "
            "Under ~0.2 is negligible; worth a real test only well above that."
        ),
        "predictionCreated": False,
        "paperTradeCreated": False,
        "realOrderPlaced": False,
    })
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        json_output({"level": "error", "message": "Interrupted before completion."})
        raise SystemExit(130)
    except Exception as error:  # noqa: BLE001
        json_output({"level": "error", "message": str(error), "errorType": type(error).__name__})
        raise SystemExit(1)
