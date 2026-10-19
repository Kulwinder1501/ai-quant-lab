"""Generate shared golden parity fixtures for Gate R4 (Python & TypeScript)."""

import json
from pathlib import Path
from apps.ml.equity_stance_r0.levels import Bar, compute_levels, load_rules

RAW_DIR = Path("apps/ml/research_data/raw")
OUT_FILE = Path("apps/ml/tests/fixtures/r0_parity_fixtures.json")


def parse_raw_bars(symbol: str) -> list[Bar]:
    raw_path = RAW_DIR / f"{symbol}.json"
    with open(raw_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    res = data["chart"]["result"][0]
    ts = res.get("timestamp", [])
    quotes = res["indicators"]["quote"][0]
    opens = quotes.get("open", [])
    highs = quotes.get("high", [])
    lows = quotes.get("low", [])
    closes = quotes.get("close", [])
    volumes = quotes.get("volume", [])

    from datetime import datetime, timezone
    bars: list[Bar] = []
    for i in range(len(ts)):
        d_str = datetime.fromtimestamp(ts[i], tz=timezone.utc).strftime("%Y-%m-%d")
        o, h, l, c = opens[i], highs[i], lows[i], closes[i]
        v = volumes[i] if i < len(volumes) and volumes[i] is not None else 0
        if o and h and l and c and o > 0 and h > 0 and l > 0 and c > 0:
            bars.append(Bar(bar_date=d_str, open=float(o), high=float(h), low=float(l), close=float(c), volume=int(v)))
    bars.sort(key=lambda b: b.bar_date)
    return bars


def generate_synthetic_bars(count: int, start_date: str, base_close: float = 100.0, step: float = 0.2) -> list[Bar]:
    from datetime import datetime, timedelta
    dt = datetime.strptime(start_date, "%Y-%m-%d")
    bars: list[Bar] = []
    c = base_close
    for _ in range(count):
        d_str = dt.strftime("%Y-%m-%d")
        bars.append(Bar(
            bar_date=d_str,
            open=c - 0.2,
            high=c + 1.5,
            low=c - 1.5,
            close=c,
            volume=10000,
        ))
        c += step
        dt += timedelta(days=1)
    return bars


def build_fixture_dict(name: str, description: str, bars: list[Bar]) -> dict:
    res = compute_levels(bars)
    return {
        "name": name,
        "description": description,
        "bars": [
            {
                "bar_date": b.bar_date,
                "open": b.open,
                "high": b.high,
                "low": b.low,
                "close": b.close,
                "volume": b.volume,
            }
            for b in bars
        ],
        "expected": {
            "as_of_date": res.as_of_date,
            "state": res.state,
            "atr14": res.atr14,
            "atr_percent": res.atr_percent,
            "nearest_support": (
                {
                    "price": res.nearest_support.price,
                    "touches": res.nearest_support.touches,
                    "strength": res.nearest_support.strength,
                    "state": res.nearest_support.state,
                }
                if res.nearest_support
                else None
            ),
            "nearest_resistance": (
                {
                    "price": res.nearest_resistance.price,
                    "touches": res.nearest_resistance.touches,
                    "strength": res.nearest_resistance.strength,
                    "state": res.nearest_resistance.state,
                }
                if res.nearest_resistance
                else None
            ),
            "risk_distance_atr": res.risk_distance_atr,
            "levels_count": len(res.levels),
            "levels": [
                {
                    "id": l.id,
                    "price": l.price,
                    "kind": l.kind,
                    "source": l.source,
                    "side": l.side,
                    "touches": l.touches,
                    "strength": l.strength,
                    "state": l.state,
                }
                for l in res.levels
            ],
        },
    }


def main():
    fixtures = []

    # 1. Synthetic Fixture 1: ATR Hand Check (15 bars)
    b1_raw = [
        (105, 95, 100), (104, 98, 102), (108, 101, 106), (107, 103, 104), (110, 99, 101),
        (103, 97, 98), (100, 95, 99), (102, 96, 101), (105, 100, 104), (109, 103, 108),
        (111, 105, 107), (108, 102, 103), (106, 98, 100), (104, 99, 102), (107, 101, 105),
    ]
    b1 = [
        Bar(bar_date=f"2026-01-{i+1:02d}", open=c-1, high=h, low=l, close=c, volume=1000)
        for i, (h, l, c) in enumerate(b1_raw)
    ]
    fixtures.append(build_fixture_dict("synthetic_atr_15bars", "Hand-crafted 15-bar series verifying ATR14 exact ratio", b1))

    # 2. Synthetic Fixture 2: Swing Pivots Low & High (k=5)
    b2_raw = [
        (50, 55), (48, 54), (46, 53), (44, 52), (42, 51),
        (40, 50), # 5: SWING LOW
        (43, 52), (45, 56), (47, 70), # 8: SWING HIGH
        (46, 65), (45, 62), (44, 60), (43, 58), (42, 55), (41, 54),
    ]
    b2 = [
        Bar(bar_date=f"2026-01-{i+1:02d}", open=l+1, high=h, low=l, close=l+2, volume=5000)
        for i, (l, h) in enumerate(b2_raw)
    ]
    fixtures.append(build_fixture_dict("synthetic_pivots_15bars", "15 bars with k=5 swing low and high", b2))

    # 3. Synthetic Fixture 3: Volume Profile (60 bins)
    b3 = generate_synthetic_bars(50, "2026-01-01", base_close=100.0, step=0.5)
    fixtures.append(build_fixture_dict("synthetic_vp_50bars", "50 bars testing 60-bin Volume Profile POC and Value Area", b3))

    # 4. Synthetic Fixture 4: Round Numbers Across Boundary (100)
    b4 = generate_synthetic_bars(30, "2026-01-01", base_close=99.0, step=0.1)
    fixtures.append(build_fixture_dict("synthetic_round_numbers", "30 bars spanning 99 to 102 crossing power of 10", b4))

    # 5. Synthetic Fixture 5: Full Swing Levels with Break & Flip (280 bars)
    b5 = generate_synthetic_bars(280, "2025-01-01", base_close=100.0, step=0.0)
    # Plant two swing lows around 100.0 to create a cluster
    for i in range(95, 106):
        b5[i].low = 100.0 if i == 100 else 103.0
        b5[i].high = 110.0
        b5[i].close = 106.0
    for i in range(145, 156):
        b5[i].low = 100.2 if i == 150 else 103.0
        b5[i].high = 110.0
        b5[i].close = 106.0
    # Plant a close breaking support near the end
    b5[278].close = 95.0
    b5[278].low = 94.0
    b5[279].close = 96.0
    fixtures.append(build_fixture_dict("synthetic_full_swing_280bars", "280 bars testing swing cluster, touches, break & flip", b5))

    # Real Stocks: RELIANCE, SUZLON, TMPV at 3 dates each
    real_targets = [
        ("RELIANCE", ["2026-10-16", "2025-12-31", "2024-06-28"]),
        ("SUZLON", ["2026-10-16", "2025-12-31", "2024-06-28"]),
        ("TMPV", ["2026-10-16", "2025-12-24", "2024-06-28"]),
    ]

    for sym, dates in real_targets:
        all_bars = parse_raw_bars(sym)
        for dt_str in dates:
            # Cut at dt_str and take 600-bar window (matching service)
            cut_bars = [b for b in all_bars if b.bar_date <= dt_str]
            window_bars = cut_bars[-600:] if len(cut_bars) >= 600 else cut_bars
            fixtures.append(build_fixture_dict(
                f"real_{sym}_{dt_str}",
                f"Real stock {sym} cut at {dt_str} ({len(window_bars)} bars in 600-bar window)",
                window_bars,
            ))

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump({"version": "r0-parity-v1", "fixtures": fixtures}, f, indent=2)

    print(f"Generated {len(fixtures)} golden fixtures into {OUT_FILE}")


if __name__ == "__main__":
    main()
