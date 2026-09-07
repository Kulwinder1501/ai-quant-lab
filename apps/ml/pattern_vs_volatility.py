"""One-off: do candlestick patterns carry information about volatility expansion?

Patterns have only ever been measured against the *directional* target here, which is measured
dead. This asks the untested question instead: bars that fire a pattern versus bars that do not,
scored on the volatility-expansion label the live models actually use.

The label is imported, not reimplemented — testing an approximation of it would prove nothing.
"""

from __future__ import annotations

import collections
import math
import os
import re
import sys
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from ai_quant_lab_ml.contracts import ForwardBar
from ai_quant_lab_ml.volatility_expansion import trailing_range_of, volatility_expansion_label

WINDOW = 5          # horizon_bars, the production default
BAND = 0.25         # DEFAULT_EXPANSION_BAND, what every stored model was fitted with
SERIES = [("NIFTY50", "1d"), ("BANKNIFTY", "1d"), ("NIFTY50", "15m"), ("BANKNIFTY", "15m")]


def database_url() -> str:
    env = (Path(__file__).resolve().parents[2] / ".env").read_text(encoding="utf-8")
    match = re.search(r"^DATABASE_URL=(.*)$", env, re.MULTILINE)
    if not match:
        raise SystemExit("DATABASE_URL not found in .env")
    return match.group(1).strip()


def two_proportion_z(hits_a: int, n_a: int, hits_b: int, n_b: int) -> float:
    """Standard two-proportion z. Reported so a difference is read against its own noise."""
    if n_a == 0 or n_b == 0:
        return float("nan")
    p_a, p_b = hits_a / n_a, hits_b / n_b
    pooled = (hits_a + hits_b) / (n_a + n_b)
    denominator = math.sqrt(pooled * (1 - pooled) * (1 / n_a + 1 / n_b))
    return (p_a - p_b) / denominator if denominator > 0 else float("nan")


def main() -> None:
    with psycopg.connect(database_url(), row_factory=dict_row) as connection:
        for symbol, timeframe in SERIES:
            candles = connection.execute(
                """
                SELECT c.id, c.high, c.low, c.close_time
                FROM candles c JOIN instruments i ON i.id = c.instrument_id
                WHERE i.symbol = %s AND c.timeframe = %s AND c.is_complete
                ORDER BY c.close_time
                """,
                (symbol, timeframe),
            ).fetchall()

            # Candle ids carrying a candlestick detection, and the doji subset separately:
            # a doji is a small-range indecision bar, which is the only pattern with a
            # mechanical reason to precede a range change rather than a direction.
            patterned = {
                row["candle_id"]
                for row in connection.execute(
                    """
                    SELECT DISTINCT pd.candle_id FROM pattern_detections pd
                    JOIN candles c ON c.id = pd.candle_id
                    JOIN instruments i ON i.id = c.instrument_id
                    WHERE i.symbol = %s AND c.timeframe = %s
                    """,
                    (symbol, timeframe),
                ).fetchall()
            }
            dojis = {
                row["candle_id"]
                for row in connection.execute(
                    """
                    SELECT DISTINCT pd.candle_id FROM pattern_detections pd
                    JOIN candles c ON c.id = pd.candle_id
                    JOIN instruments i ON i.id = c.instrument_id
                    JOIN pattern_definitions pdef ON pdef.id = pd.pattern_definition_id
                    WHERE i.symbol = %s AND c.timeframe = %s AND pdef.pattern_code = 'DOJI'
                    """,
                    (symbol, timeframe),
                ).fetchall()
            }

            highs = [float(c["high"]) for c in candles]
            lows = [float(c["low"]) for c in candles]
            trailing_highs: collections.deque[float] = collections.deque(maxlen=WINDOW)
            trailing_lows: collections.deque[float] = collections.deque(maxlen=WINDOW)

            # group -> {label: count}. Groups: with a pattern, without, and doji-only.
            counts = {
                "pattern": collections.Counter(),
                "no-pattern": collections.Counter(),
                "doji": collections.Counter(),
            }
            own_share: dict[str, list[float]] = {"pattern": [], "no-pattern": [], "doji": []}

            for index, candle in enumerate(candles):
                # The trailing window includes the source bar, matching `features.py`:
                # it appends before calling the labeller.
                trailing_highs.append(highs[index])
                trailing_lows.append(lows[index])
                if len(trailing_highs) < WINDOW:
                    continue
                forward = candles[index + 1: index + 1 + WINDOW]
                if len(forward) < WINDOW:
                    continue

                result = volatility_expansion_label(
                    trailing_range=trailing_range_of(list(trailing_highs), list(trailing_lows)),
                    forward_path=[
                        ForwardBar(
                            high=float(bar["high"]),
                            low=float(bar["low"]),
                            close=float(bar["low"]),  # unused by this label
                            close_time=bar["close_time"],
                        )
                        for bar in forward
                    ],
                    expected_forward_bars=WINDOW,
                    band=BAND,
                )
                if result is None:
                    continue

                group = "pattern" if candle["id"] in patterned else "no-pattern"
                counts[group][result.label] += 1
                if candle["id"] in dojis:
                    counts["doji"][result.label] += 1

                # The confound this test exists to survive. A detection is a function of the
                # source bar's own shape, and that bar sits inside the trailing window, so a
                # narrow bar shrinks the denominator and inflates forward/trailing without
                # predicting anything. If patterned bars carry a systematically different own
                # range, the separation above is arithmetic rather than signal.
                own = highs[index] - lows[index]
                share = own / result.trailing_range if result.trailing_range > 0 else float("nan")
                if math.isfinite(share):
                    own_share[group].append(share)
                    if candle["id"] in dojis:
                        own_share["doji"].append(share)

            print(f"\n=== {symbol} {timeframe} (window {WINDOW}, band {BAND}) ===")
            for group in ("pattern", "no-pattern", "doji"):
                total = sum(counts[group].values())
                if total == 0:
                    print(f"  {group:<11} no labelled bars")
                    continue
                parts = " ".join(
                    f"{label[:4]} {counts[group][label] / total * 100:5.1f}%"
                    for label in ("EXPANSION", "STABLE", "CONTRACTION")
                )
                print(f"  {group:<11} n={total:<6} {parts}")

            n_pattern = sum(counts["pattern"].values())
            n_plain = sum(counts["no-pattern"].values())
            for label in ("EXPANSION", "CONTRACTION"):
                z = two_proportion_z(
                    counts["pattern"][label], n_pattern, counts["no-pattern"][label], n_plain
                )
                delta = (
                    counts["pattern"][label] / n_pattern - counts["no-pattern"][label] / n_plain
                ) * 100 if n_pattern and n_plain else float("nan")
                verdict = "separates" if abs(z) >= 2 else "noise"
                print(f"  {label:<12} pattern-minus-plain {delta:+5.2f} pts   z={z:+5.2f}  -> {verdict}")

            for group in ("pattern", "no-pattern", "doji"):
                shares = own_share[group]
                if shares:
                    mean = sum(shares) / len(shares)
                    print(f"  own-range/trailing  {group:<11} mean {mean:.3f}")


if __name__ == "__main__":
    sys.exit(main())
