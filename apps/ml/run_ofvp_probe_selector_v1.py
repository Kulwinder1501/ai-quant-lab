"""OFVP probe-time selector v1 — interim extract and sample-rule check.

Normative: docs/research/orderflow-volume-profile/OFVP_PROBE_SELECTOR_V1.md

Frozen primary rule S1 (do not retune here):
  d1.st == OK AND d1.open is True AND lvnA_dist <= initial_risk_distance

Until the sample rule is met, prints INCONCLUSIVE interim counts only.
Research only — tradingExecutionAuthorized remains false.

Usage (from repo root, with DATABASE_URL or apps/api/.env):
  python apps/ml/run_ofvp_probe_selector_v1.py
  python apps/ml/run_ofvp_probe_selector_v1.py --write-json
"""

from __future__ import annotations

import argparse
import json
import os
import re
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import psycopg

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_JSON = REPO_ROOT / "logs" / "ofvp-probe-selector-v1-interim.json"
IST = ZoneInfo("Asia/Kolkata")
FRESH_START = date(2026, 10, 14)
PROTOCOL_ID = "OFVP-PROBE-SELECTOR-V1"
SAMPLE_OK = 100
SAMPLE_S1 = 25
COVERAGE_MIN = 0.70
FRVP_RE = re.compile(r"FRVP_OBS (\{.*\})$")


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


def _parse_frvp(notes: str | None) -> dict[str, Any] | None:
    if not notes:
        return None
    match = FRVP_RE.search(notes.strip())
    if not match:
        return None
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError:
        return None


def _level_dist(level: Any) -> float | None:
    if not isinstance(level, list) or len(level) < 2:
        return None
    try:
        return float(level[1])
    except (TypeError, ValueError):
        return None


def _ist_date(ts: datetime) -> date:
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(IST).date()


def _row_features(row: dict[str, Any]) -> dict[str, Any] | None:
    frvp = _parse_frvp(row.get("notes"))
    if not frvp or frvp.get("v") != "frvp-rows48-v2":
        return None
    d1 = frvp.get("d1") if isinstance(frvp.get("d1"), dict) else {}
    d0 = frvp.get("d0") if isinstance(frvp.get("d0"), dict) else {}
    risk = float(row["initial_risk_distance"] or 0)
    qty = float(row["quantity"] or 0)
    fees = float(row["fees"] or 0)
    pnl = row.get("realized_pnl")
    net = None if pnl is None else float(pnl) - fees
    lvn_dist = _level_dist(d1.get("lvnA"))
    hvn_dist = _level_dist(d1.get("hvnA"))
    open_flag = d1.get("open")
    s1 = (
        d1.get("st") == "OK"
        and open_flag is True
        and lvn_dist is not None
        and risk > 0
        and lvn_dist <= risk
    )
    planned_risk = risk * qty if risk > 0 and qty > 0 else None
    net_r = (net / planned_risk) if net is not None and planned_risk and planned_risk > 0 else None
    opened = row["opened_at"]
    if opened.tzinfo is None:
        opened = opened.replace(tzinfo=timezone.utc)
    return {
        "id": row["id"],
        "bot": row["bot"],
        "underlying": row["underlying_symbol"],
        "session_ist": _ist_date(opened).isoformat(),
        "tod_bucket": opened.astimezone(IST).hour,
        "d1_st": d1.get("st"),
        "d1_pos": d1.get("pos"),
        "d1_open": open_flag,
        "d1_sh": d1.get("sh"),
        "d1_stb": d1.get("stb"),
        "d1_pp": d1.get("pp"),
        "d1_cp": d1.get("cp"),
        "d1_rw": d1.get("rw"),
        "d1_lvnA_dist": lvn_dist,
        "d1_hvnA_dist": hvn_dist,
        "d1_lvnA_dist_R": (lvn_dist / risk) if lvn_dist is not None and risk > 0 else None,
        "d0_st": d0.get("st"),
        "d0_pos": d0.get("pos"),
        "d0_open": d0.get("open"),
        "d0_sh": d0.get("sh"),
        "s1": s1,
        "net_pnl": net,
        "net_r": net_r,
        "win": (net > 0) if net is not None else None,
    }


def fetch_rows(conn: psycopg.Connection) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT t.id::text AS id,
                   a.name AS bot,
                   t.underlying_symbol,
                   t.notes,
                   t.initial_risk_distance::float8,
                   t.quantity::float8,
                   t.fees::float8,
                   t.realized_pnl::float8,
                   t.opened_at,
                   t.status
              FROM paper_trades t
              JOIN paper_accounts a ON a.id = t.account_id
             WHERE t.status = 'CLOSED'
               AND t.excluded_from_evidence = FALSE
               AND (t.opened_at AT TIME ZONE 'Asia/Kolkata')::date >= %s
            """,
            [FRESH_START],
        )
        cols = [d.name for d in cur.description]
        all_closed = [dict(zip(cols, r)) for r in cur.fetchall()]

    stamped: list[dict[str, Any]] = []
    for row in all_closed:
        feats = _row_features(row)
        if feats is not None:
            stamped.append(feats)
    return stamped, all_closed


def summarize(stamped: list[dict[str, Any]], all_closed: list[dict[str, Any]]) -> dict[str, Any]:
    sniper = [r for r in stamped if r["bot"] == "AutoBot-Sniper"]
    sniper_ok = [r for r in sniper if r["d1_st"] == "OK"]
    sniper_s1 = [r for r in sniper_ok if r["s1"]]
    sniper_comp = [r for r in sniper_ok if not r["s1"]]
    sniper_closes = [r for r in all_closed if r["bot"] == "AutoBot-Sniper"]
    coverage = (len(sniper_ok) / len(sniper_closes)) if sniper_closes else 0.0

    def arm_stats(rows: list[dict[str, Any]]) -> dict[str, Any]:
        nets = [r["net_pnl"] for r in rows if r["net_pnl"] is not None]
        rs = [r["net_r"] for r in rows if r["net_r"] is not None]
        wins = [r for r in rows if r["win"] is True]
        return {
            "n": len(rows),
            "wins": len(wins),
            "win_rate": (len(wins) / len(rows)) if rows else None,
            "mean_net_pnl": (sum(nets) / len(nets)) if nets else None,
            "mean_net_r": (sum(rs) / len(rs)) if rs else None,
            "sum_net_pnl": sum(nets) if nets else None,
        }

    sample_met = (
        len(sniper_ok) >= SAMPLE_OK
        and len(sniper_s1) >= SAMPLE_S1
        and coverage >= COVERAGE_MIN
    )
    return {
        "protocol": PROTOCOL_ID,
        "tradingExecutionAuthorized": False,
        "fresh_window_start_ist": FRESH_START.isoformat(),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "inventory": {
            "closed_in_window": len(all_closed),
            "stamped_frvp_v2": len(stamped),
            "sniper_closes": len(sniper_closes),
            "sniper_d1_ok": len(sniper_ok),
            "sniper_s1": len(sniper_s1),
            "ok_coverage": round(coverage, 4),
            "by_bot": {
                bot: sum(1 for r in stamped if r["bot"] == bot)
                for bot in sorted({r["bot"] for r in stamped})
            },
        },
        "sample_rule": {
            "closed_d1_ok": SAMPLE_OK,
            "s1": SAMPLE_S1,
            "coverage_min": COVERAGE_MIN,
            "met": sample_met,
        },
        "s1_selected": arm_stats(sniper_s1),
        "s1_complement": arm_stats(sniper_comp),
        "verdict": (
            "SAMPLE_MET_RUN_PERMUTATION_OFFLINE"
            if sample_met
            else "INCONCLUSIVE_INTERIM_COUNTS_ONLY"
        ),
        "note": (
            "Sample rule met: run day-clustered permutation offline before any paper protocol."
            if sample_met
            else "Keep stamping FRVP_OBS; do not promote S1; do not retune."
        ),
        "rows": sniper,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--write-json",
        action="store_true",
        help=f"Write interim JSON to {OUT_JSON}",
    )
    args = parser.parse_args()

    with psycopg.connect(_database_url()) as conn:
        stamped, all_closed = fetch_rows(conn)
    report = summarize(stamped, all_closed)

    console = {k: v for k, v in report.items() if k != "rows"}
    print(json.dumps(console, indent=2, default=str))

    if args.write_json:
        OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
        OUT_JSON.write_text(json.dumps(report, indent=2, default=str) + "\n", encoding="utf-8")
        print(f"Wrote {OUT_JSON}", flush=True)


if __name__ == "__main__":
    main()
