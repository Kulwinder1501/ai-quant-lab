"""Re-run the equity-panel straddle breakeven at tradable tenors.

The 2026-08-04 study priced a 5-trading-day equity straddle. NSE single-stock options are
monthly-only, so that contract never existed. This prices the monthly and closes the position
after the signal's 5-day horizon instead of holding to expiry, and sweeps days-to-expiry
rather than pinning an expiry calendar this repository cannot verify for 2023-2025.

    python -m straddle_study --tenors 7,14,21,30
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import psycopg  # noqa: E402

from ai_quant_lab_ml.straddle_economics import realised_volatility, sweep_tenors  # noqa: E402

BAR_QUERY = """
    SELECT i.symbol, i.instrument_type,
           (c.open_time AT TIME ZONE 'Asia/Kolkata')::date::text AS date,
           c.high::float8, c.low::float8, c.close::float8
    FROM candles c
    JOIN instruments i ON i.id = c.instrument_id
    WHERE c.timeframe = '1d' AND c.is_complete = TRUE
      AND i.instrument_type IN ('EQUITY', 'INDEX')
      AND i.symbol <> 'INDIAVIX'
    ORDER BY i.symbol, c.open_time
"""

VIX_QUERY = """
    SELECT (c.open_time AT TIME ZONE 'Asia/Kolkata')::date::text AS date, c.close::float8
    FROM candles c JOIN instruments i ON i.id = c.instrument_id
    WHERE i.symbol = 'INDIAVIX' AND c.timeframe = '1d' AND c.is_complete = TRUE
    ORDER BY c.open_time
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-url", default=os.environ.get("DATABASE_URL"))
    parser.add_argument("--tenors", default="7,14,21,30", help="Comma-separated days to expiry.")
    parser.add_argument("--index-symbol", default="NIFTY50")
    args = parser.parse_args()
    if not args.database_url:
        parser.error("DATABASE_URL is required.")

    tenors = [int(t.strip()) for t in args.tenors.split(",") if t.strip()]

    with psycopg.connect(args.database_url) as connection:
        with connection.cursor() as cursor:
            cursor.execute(BAR_QUERY)
            rows = cursor.fetchall()
            cursor.execute(VIX_QUERY)
            vix_rows = cursor.fetchall()

    by_symbol: dict[str, list[dict[str, object]]] = defaultdict(list)
    types: dict[str, str] = {}
    for symbol, instrument_type, date, high, low, close in rows:
        types[symbol] = instrument_type
        by_symbol[symbol].append({"date": date, "high": high, "low": low, "close": close})

    index_iv_by_date = {date: close / 100.0 for date, close in vix_rows}

    # Index realised volatility on the same 20-day window the stock proxy uses, so the
    # implied/realised ratio is like-for-like.
    index_bars = by_symbol.get(args.index_symbol, [])
    index_rv_by_date: dict[str, float] = {}
    for i in range(20, len(index_bars)):
        window = [float(b["close"]) for b in index_bars[i - 20 : i + 1]]
        rv = realised_volatility(window)
        if rv:
            index_rv_by_date[str(index_bars[i]["date"])] = rv

    equities = [(s, bars) for s, bars in by_symbol.items() if types.get(s) == "EQUITY"]
    ratios = [
        index_iv_by_date[d] / index_rv_by_date[d]
        for d in index_rv_by_date
        if d in index_iv_by_date and index_rv_by_date[d] > 0
    ]

    results = sweep_tenors(
        panels=equities,
        index_iv_by_date=index_iv_by_date,
        index_rv_by_date=index_rv_by_date,
        tenors=tenors,
    )

    print(json.dumps({
        "equities": len(equities),
        "indexSymbol": args.index_symbol,
        "sessionsWithIvAndRv": len(ratios),
        "meanImpliedRealisedRatio": sum(ratios) / len(ratios) if ratios else None,
        "results": results,
    }, indent=2, default=float))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
