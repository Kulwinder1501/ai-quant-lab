"""OFVP Phase-2 baseline + cost-floor gate (research only; no trading).

Loads paired futures-volume / index-price 1m bars, builds prior-session
frvp-rows48-v2 profiles, labels OFVP-H1/H2-style probe outcomes, and applies
the sealed ~9.7 bps cost-floor gate before any trading backtest.

Usage (from apps/ml, with DATABASE_URL set or loadable from apps/api/.env):
  python run_ofvp_phase2_baseline.py

Outputs:
  logs/ofvp-phase2-baseline.json
  docs/research/orderflow-volume-profile/OFVP_PHASE2_BASELINE_COST_FLOOR_V1.md
"""

from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

import psycopg

from ai_quant_lab_ml.fixed_row_volume_profile import VOLUME_PROFILE_ALGORITHM_VERSION
from ai_quant_lab_ml.ofvp_baseline_events import (
    ACCEPTANCE_MINUTES,
    COST_FLOOR_BPS,
    RETURN_BUDGET_MINUTES,
    TimedBar,
    events_to_dicts,
    label_session_probes,
    summarize_cost_floor,
)

EXPERIMENT_ID = "OFVP-PHASE2-BASELINE-2026-10-13"
MINIMUM_PROFILE_MINUTES = 300
UNDERLYINGS = ("BANKNIFTY", "NIFTY50")

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
OUT_JSON = REPO_ROOT / "logs" / "ofvp-phase2-baseline.json"
OUT_MD = REPO_ROOT / "docs" / "research" / "orderflow-volume-profile" / "OFVP_PHASE2_BASELINE_COST_FLOOR_V1.md"


def _load_database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    env_path = REPO_ROOT / "apps" / "api" / ".env"
    if env_path.is_file():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("DATABASE_URL=") and not line.startswith("#"):
                value = line.split("=", 1)[1].strip().strip('"').strip("'")
                if value:
                    return value
    raise RuntimeError("DATABASE_URL is not set; refusing to fall back to a built-in credential.")


def _fetch_session_inventory(conn: psycopg.Connection) -> list[dict]:
    """Per underlying × IST session: densest FUTURE contract with paired index minutes."""
    with conn.cursor() as cur:
        cur.execute(
            """
            WITH fut_sessions AS (
              SELECT f.underlying_symbol,
                     f.id AS instrument_id,
                     f.symbol AS contract,
                     (c.open_time AT TIME ZONE 'Asia/Kolkata')::date AS session_date,
                     COUNT(*)::int AS fut_bars,
                     SUM(c.volume)::float8 AS fut_volume
                FROM instruments f
                JOIN candles c
                  ON c.instrument_id = f.id
                 AND c.timeframe = '1m'
                 AND c.is_complete
                 AND c.volume > 0
               WHERE f.instrument_type = 'FUTURE'
                 AND f.underlying_symbol = ANY(%s)
               GROUP BY 1, 2, 3, 4
              HAVING COUNT(*) >= %s
            ),
            ranked AS (
              SELECT *,
                     ROW_NUMBER() OVER (
                       PARTITION BY underlying_symbol, session_date
                       ORDER BY fut_volume DESC, fut_bars DESC
                     ) AS rn
                FROM fut_sessions
            )
            SELECT underlying_symbol, instrument_id::text, contract,
                   session_date::text, fut_bars, fut_volume
              FROM ranked
             WHERE rn = 1
             ORDER BY underlying_symbol, session_date
            """,
            [list(UNDERLYINGS), MINIMUM_PROFILE_MINUTES],
        )
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def _fetch_paired_bars(
    conn: psycopg.Connection,
    instrument_id: str,
    underlying: str,
    session_date: str,
) -> list[TimedBar]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT fc.open_time,
                   ic.high::float8, ic.low::float8, ic.close::float8,
                   fc.volume::float8
              FROM candles fc
              JOIN instruments ix
                ON ix.symbol = %s AND ix.instrument_type = 'INDEX'
              JOIN candles ic
                ON ic.instrument_id = ix.id
               AND ic.timeframe = '1m'
               AND ic.is_complete
               AND ic.open_time = fc.open_time
             WHERE fc.instrument_id = %s::uuid
               AND fc.timeframe = '1m'
               AND fc.is_complete
               AND fc.volume > 0
               AND (fc.open_time AT TIME ZONE 'Asia/Kolkata')::date = %s::date
             ORDER BY fc.open_time
            """,
            [underlying, instrument_id, session_date],
        )
        out: list[TimedBar] = []
        for open_time, high, low, close, volume in cur.fetchall():
            out.append(
                TimedBar(
                    open_time=open_time,
                    high=float(high),
                    low=float(low),
                    close=float(close),
                    volume=float(volume),
                )
            )
        return out


def run() -> dict:
    url = _load_database_url()
    all_events = []
    session_rows = []

    with psycopg.connect(url) as conn:
        with conn.cursor() as cur:
            cur.execute("SET TRANSACTION READ ONLY")
        inventory = _fetch_session_inventory(conn)

        by_underlying: dict[str, list[dict]] = defaultdict(list)
        for row in inventory:
            by_underlying[row["underlying_symbol"]].append(row)

        for underlying, sessions in by_underlying.items():
            sessions = sorted(sessions, key=lambda r: r["session_date"])
            for idx in range(1, len(sessions)):
                prior = sessions[idx - 1]
                today = sessions[idx]
                # Use today's densest contract for pairing; prior profile uses prior contract day.
                prior_bars = _fetch_paired_bars(
                    conn, prior["instrument_id"], underlying, prior["session_date"]
                )
                today_bars = _fetch_paired_bars(
                    conn, today["instrument_id"], underlying, today["session_date"]
                )
                if len(prior_bars) < MINIMUM_PROFILE_MINUTES:
                    session_rows.append(
                        {
                            "underlying": underlying,
                            "session_date": today["session_date"],
                            "prior_session_date": prior["session_date"],
                            "status": "THIN_PRIOR",
                            "prior_n": len(prior_bars),
                            "today_n": len(today_bars),
                        }
                    )
                    continue
                if len(today_bars) < 60:
                    session_rows.append(
                        {
                            "underlying": underlying,
                            "session_date": today["session_date"],
                            "prior_session_date": prior["session_date"],
                            "status": "THIN_TODAY",
                            "prior_n": len(prior_bars),
                            "today_n": len(today_bars),
                        }
                    )
                    continue

                events = label_session_probes(
                    underlying=underlying,
                    session_date=today["session_date"],
                    prior_session_date=prior["session_date"],
                    contract=today["contract"],
                    prior_bars=prior_bars,
                    today_bars=today_bars,
                )
                all_events.extend(events)
                session_rows.append(
                    {
                        "underlying": underlying,
                        "session_date": today["session_date"],
                        "prior_session_date": prior["session_date"],
                        "contract": today["contract"],
                        "status": "OK",
                        "prior_n": len(prior_bars),
                        "today_n": len(today_bars),
                        "n_probes": len(events),
                        "outcomes": {
                            o: sum(1 for e in events if e.outcome == o)
                            for o in ("RETURNED", "HELD_OUTSIDE", "AMBIGUOUS", "TIMEOUT_STILL_OUT")
                        },
                    }
                )

    ok_sessions = [s for s in session_rows if s["status"] == "OK"]
    distinct_sessions = sorted({s["session_date"] for s in ok_sessions})

    overall = summarize_cost_floor(all_events)
    by_u = {u: summarize_cost_floor(all_events, u) for u in UNDERLYINGS}

    # Go/no-go: both H1 and H2 must clear on at least one liquid underlier with events,
    # else REJECT. Sample remains insufficient for edge regardless.
    sample_note = (
        f"{len(distinct_sessions)} OK evaluation sessions "
        f"(need ~60 for provisional stability per plan §9.6); "
        f"INCONCLUSIVE on edge regardless of cost floor."
    )

    def go_no_go(summary: dict) -> str:
        if summary["n_events"] == 0:
            return "NO_EVENTS"
        h1 = summary["h1_cost_floor"]
        h2 = summary["h2_cost_floor"]
        if h1 == "REJECT_UNECONOMIC" and h2 == "REJECT_UNECONOMIC":
            return "STOP_BOTH_UNECONOMIC"
        if h1 == "REJECT_UNECONOMIC":
            return "H1_REJECT_H2_REVIEW"
        if h2 == "REJECT_UNECONOMIC":
            return "H2_REJECT_H1_REVIEW"
        return "CLEARS_COST_FLOOR_CONTINUE_BASE_RATES_ONLY"

    result = {
        "experimentId": EXPERIMENT_ID,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "modelStatus": "RESEARCH_ONLY",
        "tradingExecutionAuthorized": False,
        "dataScope": "VP_PRICE_VOLUME_ONLY",
        "profileAlgorithm": VOLUME_PROFILE_ALGORITHM_VERSION,
        "eventParams": {
            "returnBudgetMinutes": RETURN_BUDGET_MINUTES,
            "acceptanceMinutes": ACCEPTANCE_MINUTES,
            "probeBufferRows": 1.0,
            "minimumProfileMinutes": MINIMUM_PROFILE_MINUTES,
        },
        "costFloorBps": COST_FLOOR_BPS,
        "costFloorSource": "docs/2026-10-09-cost-stack-validation-record.md",
        "sampleNote": sample_note,
        "nOkSessions": len(ok_sessions),
        "nDistinctSessionDates": len(distinct_sessions),
        "sessionDates": distinct_sessions,
        "nProbeEvents": len(all_events),
        "overall": overall,
        "byUnderlying": by_u,
        "goNoGo": {
            "overall": go_no_go(overall),
            **{u: go_no_go(by_u[u]) for u in UNDERLYINGS},
        },
        "sessions": session_rows,
        "events": events_to_dicts(all_events),
    }
    return result


def _write_markdown(result: dict) -> None:
    overall = result["overall"]
    lines = [
        "# OFVP Phase-2 baseline + cost-floor gate",
        "",
        f"**Document ID:** `{result['experimentId']}`  ",
        f"**Generated:** `{result['generatedAt']}`  ",
        f"**Status:** Research only — `tradingExecutionAuthorized: false`  ",
        f"**Data scope:** `{result['dataScope']}` (bar-volume allocation; no aggressor / Delta / CVD)  ",
        f"**Profile:** `{result['profileAlgorithm']}`  ",
        "",
        "## Verdict",
        "",
        f"- **Overall go/no-go:** `{result['goNoGo']['overall']}`",
        f"- **BANKNIFTY:** `{result['goNoGo']['BANKNIFTY']}`",
        f"- **NIFTY50:** `{result['goNoGo']['NIFTY50']}`",
        f"- **Sample:** {result['sampleNote']}",
        "",
        "This is a **cost-floor and base-rate** report. It is **not** an edge verdict and does not",
        "authorize a trading backtest unless a setup clears the cost floor.",
        "",
        "## Cost floor (sealed)",
        "",
        f"Round-trip friction ≈ **{result['costFloorBps']} bps** from `{result['costFloorSource']}`",
        "(statutory/brokerage 6.23 + spread 2.45 + slippage 1.00).",
        "",
        "| Universe | Events | H1 median target (bps) | H1 gate | H2 median target (bps) | H2 gate | Cost pts @ mean mid |",
        "|---|---:|---:|---|---:|---|---:|",
    ]

    def row(name: str, s: dict) -> str:
        return (
            f"| {name} | {s.get('n_events', 0)} | "
            f"{_fmt(s.get('h1_median_target_bps'))} | `{s.get('h1_cost_floor')}` | "
            f"{_fmt(s.get('h2_median_target_bps'))} | `{s.get('h2_cost_floor')}` | "
            f"{_fmt(s.get('cost_floor_points_at_mean_mid'))} |"
        )

    lines.append(row("All", overall))
    for u in UNDERLYINGS:
        lines.append(row(u, result["byUnderlying"][u]))

    lines.extend(
        [
            "",
            "## Event definition (frozen for this run)",
            "",
            f"- Prior session: completed IST day with ≥{MINIMUM_PROFILE_MINUTES} paired minutes;",
            "  densest FUTURE contract that day; futures volume on index high-low (same as live FRVP).",
            f"- Probe: minute close beyond prior VAH/VAL by ≥ 1× row width.",
            f"- **OFVP-H1-like RETURNED:** re-enter inside value within {RETURN_BUDGET_MINUTES} minutes.",
            f"- **OFVP-H2-like HELD_OUTSIDE:** stay outside for {ACCEPTANCE_MINUTES} consecutive minutes",
            "  without reclaim (within the scan window).",
            "- H1 target distance for the gate: |VA boundary − POC|.",
            "- H2 target distance: |boundary − nearest HVN outside|, else 25% of prior session range.",
            "",
            "## Outcome base rates",
            "",
            f"- OK evaluation sessions: **{result['nOkSessions']}** "
            f"({result['nDistinctSessionDates']} distinct dates)",
            f"- Probe events: **{result['nProbeEvents']}**",
            f"- Outcomes (all): `{json.dumps(overall.get('outcome_counts') or {})}`",
            "",
            "## What not to do next",
            "",
            "- Do not build Delta/CVD/footprint until a trade-print feed exists.",
            "- Do not run a trading backtest for a setup that is `REJECT_UNECONOMIC`.",
            "- Do not treat a cost-floor clear on ~29 sessions as an OOS PASS.",
            "",
            f"Machine-readable: `logs/ofvp-phase2-baseline.json`",
            "",
        ]
    )
    OUT_MD.parent.mkdir(parents=True, exist_ok=True)
    OUT_MD.write_text("\n".join(lines), encoding="utf-8")


def _fmt(value: float | None) -> str:
    if value is None:
        return "—"
    return f"{value:.2f}"


def main() -> int:
    result = run()
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(result, indent=2, default=str), encoding="utf-8")
    _write_markdown(result)
    print(
        json.dumps(
            {
                "wrote": [str(OUT_JSON), str(OUT_MD)],
                "goNoGo": result["goNoGo"],
                "nOkSessions": result["nOkSessions"],
                "nProbeEvents": result["nProbeEvents"],
                "overall": {
                    "h1": result["overall"].get("h1_cost_floor"),
                    "h2": result["overall"].get("h2_cost_floor"),
                    "h1_median_bps": result["overall"].get("h1_median_target_bps"),
                    "h2_median_bps": result["overall"].get("h2_median_target_bps"),
                },
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
