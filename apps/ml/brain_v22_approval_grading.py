"""One-off check: grade Brain V2.2's native-pipeline (P5-P10) approvals against real subsequent
price action. Every prior status update on this pipeline covered whether it runs, not whether its
approvals are any good -- this is the first real economics check.

Reads differential_observations (producer_id='native-pipeline', v2_outcome starting 'APPROVED') and
walks forward real 5m candles from the decision instant to see whether target or stop was touched
first, same-day only, same-bar-stop-first convention matching the rest of this project's backtests.

Caveat, stated plainly: entry/stop/target here are underlying index/futures points (NIFTY50/BANKNIFTY),
not option premiums -- P10's execution simulator has no premium repricing yet, so this grades the
pipeline's own price geometry, not what a real options trade would have realized after cost/spread/IV.
Writes nothing back.
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import pandas as pd
import psycopg

ROOT_DIRECTORY = Path(__file__).resolve().parents[2]

APPROVAL_PATTERN = re.compile(
    r"APPROVED (?P<side>LONG|SHORT) entry=(?P<entry>[\d.]+) stop=(?P<stop>[\d.]+) target=(?P<target>[\d.]+)"
)


def load_database_url() -> str:
    from dotenv import load_dotenv

    load_dotenv(ROOT_DIRECTORY / ".env")
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        sys.exit("DATABASE_URL is required (define it in .env or the environment).")
    return database_url


QUERY = """
SELECT comparison_key, v2_outcome
FROM differential_observations
WHERE producer_id = 'native-pipeline' AND v2_outcome LIKE 'APPROVED%'
ORDER BY comparison_key;
"""

CANDLE_QUERY = """
SELECT c.open_time, c.high, c.low, c.close
FROM candles c
JOIN instruments i ON i.id = c.instrument_id
WHERE i.symbol = %(symbol)s AND c.timeframe = '5m'
  AND c.open_time > %(decision_at)s
  AND (c.open_time AT TIME ZONE 'Asia/Kolkata')::date = (%(decision_at)s AT TIME ZONE 'Asia/Kolkata')::date
ORDER BY c.open_time ASC;
"""


def parse_approvals(comparison_key: str, v2_outcome: str) -> list[dict]:
    parts = comparison_key.split("@")
    instrument, timeframe, decision_at = parts[0], parts[1], parts[2]
    approvals = []
    for match in APPROVAL_PATTERN.finditer(v2_outcome):
        approvals.append({
            "instrument": instrument,
            "timeframe": timeframe,
            "decision_at": decision_at,
            "side": match.group("side"),
            "entry": float(match.group("entry")),
            "stop": float(match.group("stop")),
            "target": float(match.group("target")),
        })
    return approvals


def grade(connection, approval: dict) -> dict:
    with connection.cursor() as cursor:
        cursor.execute(CANDLE_QUERY, {"symbol": approval["instrument"], "decision_at": approval["decision_at"]})
        candles = cursor.fetchall()

    side, entry, stop, target = approval["side"], approval["entry"], approval["stop"], approval["target"]
    for open_time, high, low, close in candles:
        high, low = float(high), float(low)
        if side == "LONG":
            hit_stop = low <= stop
            hit_target = high >= target
        else:
            hit_stop = high >= stop
            hit_target = low <= target
        if hit_stop:  # conservative: same-bar ambiguity resolves stop-first, matching backtest convention
            return {**approval, "outcome": "STOP", "points": (stop - entry) if side == "LONG" else (entry - stop),
                     "resolved_at": open_time}
        if hit_target:
            return {**approval, "outcome": "TARGET", "points": (target - entry) if side == "LONG" else (entry - target),
                     "resolved_at": open_time}
    last_close = float(candles[-1][3]) if candles else entry
    points = (last_close - entry) if side == "LONG" else (entry - last_close)
    return {**approval, "outcome": "TIMEOUT", "points": points, "resolved_at": None}


def main() -> None:
    database_url = load_database_url()
    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            cursor.execute(QUERY)
            rows = cursor.fetchall()

        approvals = []
        for comparison_key, v2_outcome in rows:
            approvals.extend(parse_approvals(comparison_key, v2_outcome))

        print(f"Parsed {len(approvals)} individual side-approvals from {len(rows)} decision rows "
              f"({sum(1 for _, o in rows if 'BOTH_SIDES' in o)} dual-sided).")

        graded = [grade(connection, approval) for approval in approvals]

    frame = pd.DataFrame(graded)
    print("\nOutcome distribution:")
    print(frame["outcome"].value_counts())
    print(f"\nTarget-hit rate (of resolved, excluding TIMEOUT): "
          f"{(frame['outcome'] == 'TARGET').sum() / (frame['outcome'] != 'TIMEOUT').sum():.4f}")
    print(f"\nMean points per approval (all, index/futures points, no cost/premium model): {frame['points'].mean():.2f}")
    print("\nBy instrument:")
    print(frame.groupby("instrument")["points"].agg(["count", "mean", "sum"]))
    print("\nBy outcome:")
    print(frame.groupby("outcome")["points"].agg(["count", "mean"]))

    dual_keys = frame.groupby(["instrument", "decision_at"]).filter(lambda g: len(g) > 1)
    if not dual_keys.empty:
        print("\nDual-sided approvals (both LONG and SHORT approved on the same candle):")
        print(dual_keys[["instrument", "decision_at", "side", "outcome", "points"]].to_string(index=False))


if __name__ == "__main__":
    main()
