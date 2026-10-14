"""Phase 27 Step 2 — premium-space measurement (S_premium_1m).

Normative: docs/2026-10-14-phase27-step2-premium-measurement-preregistration.md

Research only. tradingExecutionAuthorized remains false.

Usage:
  python apps/ml/run_phase27_step2_premium_measure.py
  python apps/ml/run_phase27_step2_premium_measure.py --write-json
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import psycopg

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_JSON = REPO_ROOT / "logs" / "phase27-step2-premium-measure-interim.json"
IST = ZoneInfo("Asia/Kolkata")
PROTOCOL_ID = "PHASE27-STEP2-PREMIUM-MEASURE-V1"

EVAL_START = date(2026, 9, 1)
EVAL_END = date(2026, 10, 13)
SESSION_START = time(9, 20)
SESSION_END = time(15, 20)
MIN_TICK_MINUTES = 200
LOT_COUNTS = 5
LOT_SIZE = {"NIFTY50": 75, "BANKNIFTY": 30}
STRIKE_STEP = {"NIFTY50": 50.0, "BANKNIFTY": 100.0}
UNDERLYINGS = ("NIFTY50", "BANKNIFTY")
OPTION_TICK = 0.05
HORIZON_MIN = 3
STOP_FRAC = 0.015
TARGET_FRAC = 0.025
QUOTE_LAG_SEC = 60
SMA_LEN = 20
MIN_SESSIONS = 10
MIN_TRADES = 200
PERM_DRAWS = 5_000
ALPHA = 0.05

OPTIONS_BROKERAGE_PER_ORDER = 20.0
OPTION_SALE_STT_RATE = 0.001
EXCHANGE_TXN_RATE = 0.0003503
GST_RATE = 0.18
SEBI_PER_CRORE = 10.0
ONE_CRORE = 1e7
STAMP_DUTY_RATE = 0.00003


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    env_path = REPO_ROOT / "apps" / "api" / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("DATABASE_URL=") and not line.startswith("#"):
                value = line.split("=", 1)[1].strip().strip('"').strip("'")
                if value:
                    return value
    raise RuntimeError("DATABASE_URL is not set")


def _round_inr(value: float) -> float:
    return round(value + 1e-12, 2)


def breakdown_fees(premium: float, quantity: int, side: str) -> float:
    if quantity <= 0:
        raise ValueError("quantity must be positive")
    turnover = premium * quantity
    if turnover == 0:
        return 0.0
    brokerage = OPTIONS_BROKERAGE_PER_ORDER
    stt = _round_inr(turnover * OPTION_SALE_STT_RATE) if side == "SELL" else 0.0
    exchange = _round_inr(turnover * EXCHANGE_TXN_RATE)
    sebi = _round_inr((turnover / ONE_CRORE) * SEBI_PER_CRORE)
    gst = _round_inr((brokerage + exchange + sebi) * GST_RATE)
    stamp = _round_inr(turnover * STAMP_DUTY_RATE) if side == "BUY" else 0.0
    return _round_inr(brokerage + stt + exchange + sebi + gst + stamp)


def total_fees(entry: float, exit_: float, quantity: int) -> float:
    return _round_inr(breakdown_fees(entry, quantity, "BUY") + breakdown_fees(exit_, quantity, "SELL"))


def atm_strike(underlying_value: float, step: float) -> float:
    return round(underlying_value / step) * step


@dataclass
class MinuteBar:
    minute: datetime
    provider_symbol: str
    expiry_date: date
    strike: float
    option_type: str
    bid: float
    ask: float
    underlying_value: float
    n_ticks: int


@dataclass
class TradeResult:
    underlying: str
    session: str
    side: str
    scenario: str
    net: float
    net_return: float
    gross: float
    fees: float


def fetch_session_inventory(conn: psycopg.Connection) -> list[tuple[str, date, int]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT underlying_symbol,
                   (observed_at AT TIME ZONE 'Asia/Kolkata')::date AS session_ist,
                   COUNT(DISTINCT date_trunc('minute', observed_at AT TIME ZONE 'Asia/Kolkata'))::int AS mins
              FROM option_premium_ticks
             WHERE underlying_symbol = ANY(%s)
               AND (observed_at AT TIME ZONE 'Asia/Kolkata')::date >= %s
               AND (observed_at AT TIME ZONE 'Asia/Kolkata')::date <= %s
               AND bid IS NOT NULL AND ask IS NOT NULL AND underlying_value IS NOT NULL
               AND bid > 0 AND ask > 0
             GROUP BY 1, 2
             HAVING COUNT(DISTINCT date_trunc('minute', observed_at AT TIME ZONE 'Asia/Kolkata')) >= %s
             ORDER BY 2, 1
            """,
            [list(UNDERLYINGS), EVAL_START, EVAL_END, MIN_TICK_MINUTES],
        )
        return [(r[0], r[1], int(r[2])) for r in cur.fetchall()]


def fetch_minute_bars(
    conn: psycopg.Connection, underlying: str, session: date
) -> list[MinuteBar]:
    start = datetime.combine(session, SESSION_START, tzinfo=IST)
    end = datetime.combine(session, SESSION_END, tzinfo=IST)
    with conn.cursor() as cur:
        cur.execute(
            """
            WITH ticks AS (
              SELECT provider_symbol,
                     expiry_date::date AS expiry_date,
                     strike_price::float8 AS strike,
                     option_type,
                     date_trunc('minute', observed_at AT TIME ZONE 'Asia/Kolkata') AS minute,
                     observed_at,
                     bid::float8 AS bid,
                     ask::float8 AS ask,
                     underlying_value::float8 AS underlying_value
                FROM option_premium_ticks
               WHERE underlying_symbol = %s
                 AND observed_at >= %s
                 AND observed_at < %s
                 AND bid IS NOT NULL AND ask IS NOT NULL AND underlying_value IS NOT NULL
                 AND bid > 0 AND ask > 0
                 AND ask >= bid
            ),
            ranked AS (
              SELECT *,
                     row_number() OVER (
                       PARTITION BY provider_symbol, minute
                       ORDER BY observed_at DESC
                     ) AS rn,
                     COUNT(*) OVER (PARTITION BY provider_symbol, minute) AS n_ticks
                FROM ticks
            )
            SELECT provider_symbol, expiry_date, strike, option_type, minute,
                   bid, ask, underlying_value, n_ticks
              FROM ranked
             WHERE rn = 1
               AND (ask - bid) / ((ask + bid) / 2.0) <= 0.05
             ORDER BY minute, option_type, strike
            """,
            [underlying, start, end],
        )
        rows = cur.fetchall()
    out: list[MinuteBar] = []
    for r in rows:
        minute = r[4]
        if minute.tzinfo is None:
            minute = minute.replace(tzinfo=IST)
        else:
            minute = minute.astimezone(IST)
        out.append(
            MinuteBar(
                minute=minute,
                provider_symbol=str(r[0]),
                expiry_date=r[1],
                strike=float(r[2]),
                option_type=str(r[3]),
                bid=float(r[5]),
                ask=float(r[6]),
                underlying_value=float(r[7]),
                n_ticks=int(r[8]),
            )
        )
    return out


def pick_tradable_expiry(bars: list[MinuteBar], session: date) -> date | None:
    """Nearest expiry with >= 2 calendar days to expiry (parent MINIMUM_DAYS_TO_EXPIRY)."""
    expiries = sorted({b.expiry_date for b in bars})
    for exp in expiries:
        if (exp - session).days >= 2:
            return exp
    return None


def fill_at_or_after(
    series: list[tuple[datetime, float, float]],
    when: datetime,
    side: str,
    adverse_ticks: int,
) -> float | None:
    """side entry->ask, exit->bid. series items are (ts, bid, ask)."""
    deadline = when + timedelta(seconds=QUOTE_LAG_SEC)
    for ts, bid, ask in series:
        if ts < when:
            continue
        if ts > deadline:
            break
        if side == "ask":
            px = ask + adverse_ticks * OPTION_TICK
            return px if px > 0 else None
        px = bid - adverse_ticks * OPTION_TICK
        return px if px > 0 else None
    # timeout path for exit: last bid in horizon window already handled by caller
    return None


def simulate_session(
    underlying: str,
    session: date,
    bars: list[MinuteBar],
) -> list[TradeResult]:
    expiry = pick_tradable_expiry(bars, session)
    if expiry is None:
        return []
    step = STRIKE_STEP[underlying]
    qty = LOT_COUNTS * LOT_SIZE[underlying]

    # Index bars by minute -> list of contracts
    by_minute: dict[datetime, list[MinuteBar]] = defaultdict(list)
    for b in bars:
        if b.expiry_date != expiry:
            continue
        by_minute[b.minute].append(b)

    minutes = sorted(by_minute.keys())
    # Mid history per provider_symbol
    mids: dict[str, list[float]] = defaultdict(list)
    # Tick path for fills: list of (ts, bid, ask) per symbol — use minute bars as proxy path
    paths: dict[str, list[tuple[datetime, float, float]]] = defaultdict(list)

    results: list[TradeResult] = []
    open_until: datetime | None = None
    open_trade: dict[str, Any] | None = None

    def close_trade(exit_minute: datetime, exit_bid: float, reason: str) -> None:
        nonlocal open_trade, open_until
        assert open_trade is not None
        for scenario, adverse in (("observed-book", 0), ("primary-one-tick", 1)):
            entry_fill = open_trade["entry_ask"] + adverse * OPTION_TICK
            exit_fill = max(exit_bid - adverse * OPTION_TICK, OPTION_TICK)
            gross = (exit_fill - entry_fill) * qty
            fees = total_fees(entry_fill, exit_fill, qty)
            net = gross - fees
            net_ret = net / (entry_fill * qty) if entry_fill * qty > 0 else 0.0
            results.append(
                TradeResult(
                    underlying=underlying,
                    session=session.isoformat(),
                    side=open_trade["option_type"],
                    scenario=scenario,
                    net=net,
                    net_return=net_ret,
                    gross=gross,
                    fees=fees,
                )
            )
        open_trade = None
        open_until = None

    for minute in minutes:
        contracts = by_minute[minute]
        # Update histories
        for c in contracts:
            mid = (c.bid + c.ask) / 2.0
            mids[c.provider_symbol].append(mid)
            paths[c.provider_symbol].append((minute, c.bid, c.ask))

        # Manage open position exits on this minute
        if open_trade is not None:
            sym = open_trade["provider_symbol"]
            # find this minute's bar for held contract
            held = next((c for c in contracts if c.provider_symbol == sym), None)
            if held is not None:
                entry_ask = open_trade["entry_ask"]
                if held.bid <= entry_ask * (1 - STOP_FRAC) or held.bid >= entry_ask * (1 + TARGET_FRAC):
                    close_trade(minute, held.bid, "stop_or_target")
                    continue
            if open_until is not None and minute >= open_until:
                # timeout: use held bid if present else last known bid
                if held is not None:
                    close_trade(minute, held.bid, "timeout")
                else:
                    path = paths.get(sym, [])
                    if path:
                        close_trade(minute, path[-1][1], "timeout")
                    else:
                        open_trade = None
                        open_until = None
                continue

        if open_trade is not None:
            continue

        # Spot ATM from any contract's underlying_value this minute
        und = contracts[0].underlying_value
        strike = atm_strike(und, step)
        # Prefer exact ATM; else nearest strike present
        strikes = sorted({c.strike for c in contracts})
        if strike not in strikes and strikes:
            strike = min(strikes, key=lambda s: abs(s - strike))

        for option_type, want_up in (("CE", True), ("PE", False)):
            cand = [
                c
                for c in contracts
                if c.option_type == option_type and abs(c.strike - strike) < 1e-6
            ]
            if not cand:
                continue
            # densest in this minute among ATM band (exact ATM here)
            c = max(cand, key=lambda x: x.n_ticks)
            hist = mids[c.provider_symbol]
            if len(hist) < SMA_LEN + 1:
                continue
            mid_t = hist[-1]
            mid_prev = hist[-2]
            sma = sum(hist[-SMA_LEN:]) / SMA_LEN
            if want_up:
                signal = mid_t > mid_prev and mid_t > sma
            else:
                signal = mid_t < mid_prev and mid_t < sma
            if not signal:
                continue
            # Enter at this minute's ask (decision at minute close)
            open_trade = {
                "provider_symbol": c.provider_symbol,
                "option_type": option_type,
                "entry_ask": c.ask,
                "entry_minute": minute,
            }
            open_until = minute + timedelta(minutes=HORIZON_MIN)
            break

    # Force-close if still open at session end
    if open_trade is not None:
        sym = open_trade["provider_symbol"]
        path = paths.get(sym, [])
        if path:
            close_trade(path[-1][0], path[-1][1], "session_end")

    return results


def day_clustered_pvalue(nets_by_day: dict[str, list[float]], draws: int = PERM_DRAWS) -> float:
    """One-sided: observed mean > 0 under day-shuffle of signs / day means."""
    days = list(nets_by_day.keys())
    if not days:
        return 1.0
    day_means = [sum(nets_by_day[d]) / len(nets_by_day[d]) for d in days if nets_by_day[d]]
    if not day_means:
        return 1.0
    observed = sum(day_means) / len(day_means)
    if observed <= 0:
        return 1.0
    rng = random.Random(42)
    # Permute by flipping each day's contribution sign (conservative day-block null)
    exceed = 0
    for _ in range(draws):
        sim = sum((1 if rng.random() < 0.5 else -1) * m for m in day_means) / len(day_means)
        if sim >= observed:
            exceed += 1
    return (exceed + 1) / (draws + 1)


def holm(pvalues: list[tuple[str, float]], alpha: float = ALPHA) -> dict[str, bool]:
    ordered = sorted(pvalues, key=lambda x: x[1])
    m = len(ordered)
    pass_flags = {k: False for k, _ in ordered}
    for i, (name, p) in enumerate(ordered):
        threshold = alpha / (m - i)
        if p <= threshold:
            pass_flags[name] = True
        else:
            break
    return pass_flags


def summarize(trades: list[TradeResult], sessions_used: dict[str, int]) -> dict[str, Any]:
    by_u: dict[str, Any] = {}
    pvals: list[tuple[str, float]] = []
    for und in UNDERLYINGS:
        primary = [t for t in trades if t.underlying == und and t.scenario == "primary-one-tick"]
        observed = [t for t in trades if t.underlying == und and t.scenario == "observed-book"]
        nets = [t.net for t in primary]
        by_day: dict[str, list[float]] = defaultdict(list)
        for t in primary:
            by_day[t.session].append(t.net)
        mean_net = (sum(nets) / len(nets)) if nets else None
        mean_ret = (
            sum(t.net_return for t in primary) / len(primary) if primary else None
        )
        p = day_clustered_pvalue(by_day) if len(primary) >= MIN_TRADES else None
        if p is not None:
            pvals.append((und, p))
        by_u[und] = {
            "sessions": sessions_used.get(und, 0),
            "trades_primary": len(primary),
            "trades_observed": len(observed),
            "mean_net_primary": mean_net,
            "mean_net_return_primary": mean_ret,
            "win_rate_primary": (
                sum(1 for t in primary if t.net > 0) / len(primary) if primary else None
            ),
            "sum_net_primary": sum(nets) if nets else None,
            "permutation_p_one_sided": p,
            "sample_met": sessions_used.get(und, 0) >= MIN_SESSIONS and len(primary) >= MIN_TRADES,
        }

    sample_met = all(by_u[u]["sample_met"] for u in UNDERLYINGS)
    holm_pass = holm(pvals) if sample_met and len(pvals) == 2 else {}
    both_positive = all(
        (by_u[u]["mean_net_primary"] is not None and by_u[u]["mean_net_primary"] > 0)
        for u in UNDERLYINGS
    )
    if not sample_met:
        verdict = "INCONCLUSIVE_INTERIM_COUNTS_ONLY"
    elif both_positive and all(holm_pass.get(u, False) for u in UNDERLYINGS):
        verdict = "PASS"
    else:
        verdict = "FAIL"

    return {
        "protocol": PROTOCOL_ID,
        "tradingExecutionAuthorized": False,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "eval_window": {"start": EVAL_START.isoformat(), "end": EVAL_END.isoformat()},
        "lot_counts": LOT_COUNTS,
        "lot_size": LOT_SIZE,
        "sample_rule": {"min_sessions": MIN_SESSIONS, "min_trades": MIN_TRADES, "met": sample_met},
        "by_underlying": by_u,
        "holm_pass": holm_pass,
        "verdict": verdict,
        "note": (
            "PASS authorises a Step-3 design prereg only — not live trading."
            if verdict == "PASS"
            else (
                "Sample rule unmet; keep collecting ticks / wait for denser session coverage."
                if verdict.startswith("INCONCLUSIVE")
                else "Frozen S_premium_1m does not clear premium-space costs under primary scenario."
            )
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write-json", action="store_true")
    parser.add_argument("--max-sessions", type=int, default=0, help="Debug cap (0 = all).")
    args = parser.parse_args()

    all_trades: list[TradeResult] = []
    sessions_used: dict[str, int] = {u: 0 for u in UNDERLYINGS}

    with psycopg.connect(_database_url()) as conn:
        inventory = fetch_session_inventory(conn)
        if args.max_sessions > 0:
            inventory = inventory[: args.max_sessions]
        print(
            json.dumps(
                {
                    "sessions_passing_coverage": len(inventory),
                    "by_underlying": {
                        u: sum(1 for x in inventory if x[0] == u) for u in UNDERLYINGS
                    },
                }
            ),
            flush=True,
        )
        for underlying, session, mins in inventory:
            bars = fetch_minute_bars(conn, underlying, session)
            trades = simulate_session(underlying, session, bars)
            if trades:
                sessions_used[underlying] += 1
                all_trades.extend(trades)
            print(
                f"{session} {underlying} mins={mins} bars={len(bars)} trades={len(trades)//2}",
                flush=True,
            )

    report = summarize(all_trades, sessions_used)
    print(json.dumps(report, indent=2, default=str))

    if args.write_json:
        OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
        payload = {**report, "n_trade_rows": len(all_trades)}
        OUT_JSON.write_text(json.dumps(payload, indent=2, default=str) + "\n", encoding="utf-8")
        print(f"Wrote {OUT_JSON}", flush=True)


if __name__ == "__main__":
    main()
