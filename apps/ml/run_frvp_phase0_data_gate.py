"""FRVP-MSP Phase 0 data gate.

Confirmatory replay is refused until G-FUT-VOL (and related checks) pass.
Does not implement trading signals. Normative:
docs/2026-10-12-frvp-momentum-scalp-phase0-preregistration.md
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import psycopg

from ai_quant_lab_ml.estimated_fixed_range_volume_profile import inventory_has_index_futures_volume

EXPERIMENT_ID = "FRVP-MSP-P0-2026-10-12"
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
OUT = REPO_ROOT / "logs" / "frvp-msp-phase0-data-gate.json"
ROLL_WORKED_EXAMPLE = REPO_ROOT / "docs" / "2026-10-12-index-futures-roll-worked-example.md"


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set; refusing to fall back to a built-in credential.")
    return url


def audit() -> dict:
    conn = psycopg.connect(_database_url())
    try:
        with conn.cursor() as cur:
            cur.execute("SET TRANSACTION READ ONLY")
            cur.execute(
                """
                SELECT i.symbol, i.instrument_type, i.exchange,
                       count(c.id) AS bars,
                       count(*) FILTER (WHERE c.volume IS NOT NULL AND c.volume > 0) AS vol_pos,
                       count(*) FILTER (WHERE c.timeframe = '1m') AS m1
                FROM instruments i
                LEFT JOIN candles c ON c.instrument_id = i.id
                GROUP BY 1, 2, 3
                ORDER BY bars DESC NULLS LAST
                """
            )
            cols = [d[0] for d in cur.description]
            inventory = [dict(zip(cols, row)) for row in cur.fetchall()]

            cur.execute(
                """
                SELECT count(*) FROM instruments WHERE instrument_type = 'FUTURE'
                """
            )
            future_instruments = int(cur.fetchone()[0])

            cur.execute(
                """
                SELECT count(DISTINCT provider_symbol)
                FROM depth_frames
                WHERE provider_symbol LIKE '%FUT'
                """
            )
            depth_fut_symbols = int(cur.fetchone()[0])

            cur.execute(
                """
                SELECT i.symbol, i.underlying_symbol, i.expiry_date::text,
                       count(c.id) FILTER (WHERE c.timeframe = '1m') AS m1,
                       count(*) FILTER (
                         WHERE c.timeframe = '1m'
                           AND c.volume IS NOT NULL AND c.volume > 0
                       ) AS vol_pos,
                       min(c.open_time) FILTER (WHERE c.timeframe = '1m') AS first_open,
                       max(c.open_time) FILTER (WHERE c.timeframe = '1m') AS last_open
                FROM instruments i
                LEFT JOIN candles c ON c.instrument_id = i.id
                WHERE i.instrument_type = 'FUTURE'
                GROUP BY 1, 2, 3
                ORDER BY 1
                """
            )
            fut_cols = [d[0] for d in cur.description]
            future_contract_summary = [dict(zip(fut_cols, row)) for row in cur.fetchall()]

            cur.execute(
                """
                SELECT fi.symbol AS fut_symbol,
                       xi.symbol AS index_symbol,
                       count(*) AS synced_1m,
                       min(f.open_time) AS first_sync,
                       max(f.open_time) AS last_sync
                FROM candles f
                JOIN instruments fi
                  ON fi.id = f.instrument_id
                 AND fi.instrument_type = 'FUTURE'
                 AND f.timeframe = '1m'
                 AND f.volume > 0
                JOIN instruments xi
                  ON xi.symbol = fi.underlying_symbol
                JOIN candles x
                  ON x.instrument_id = xi.id
                 AND x.timeframe = '1m'
                 AND x.open_time = f.open_time
                GROUP BY 1, 2
                ORDER BY 1
                """
            )
            basis_cols = [d[0] for d in cur.description]
            basis_sync = [dict(zip(basis_cols, row)) for row in cur.fetchall()]
    finally:
        conn.close()

    has_fut_vol = inventory_has_index_futures_volume(inventory)
    index_rows = [r for r in inventory if r["symbol"] in ("NIFTY50", "BANKNIFTY")]
    contracts_with_vol = [
        r for r in future_contract_summary if int(r.get("vol_pos") or 0) > 0 and r.get("expiry_date")
    ]
    roll_doc_ok = ROLL_WORKED_EXAMPLE.is_file()
    basis_ok = any(int(r.get("synced_1m") or 0) >= 100 for r in basis_sync)
    total_synced = sum(int(r.get("synced_1m") or 0) for r in basis_sync)

    gates = {
        "G-FUT-VOL": {
            "pass": has_fut_vol,
            "detail": (
                "Index-futures OHLCV with positive traded volume present"
                if has_fut_vol
                else "No FUTURE instruments / no FUTIDX candle volume in DB; depth_frames FUT symbols are not traded volume"
            ),
            "future_instruments": future_instruments,
            "depth_fut_symbols": depth_fut_symbols,
            "contracts_with_volume": [
                {
                    "symbol": r["symbol"],
                    "underlying_symbol": r["underlying_symbol"],
                    "expiry_date": r["expiry_date"],
                    "vol_pos": int(r["vol_pos"] or 0),
                    "first_open": r["first_open"].isoformat() if r.get("first_open") else None,
                    "last_open": r["last_open"].isoformat() if r.get("last_open") else None,
                }
                for r in contracts_with_vol
            ],
        },
        "G-BASIS": {
            "pass": bool(has_fut_vol and basis_ok),
            "detail": (
                f"Synchronized futures/index 1m closes present (synced_1m={total_synced})"
                if has_fut_vol and basis_ok
                else (
                    "Deferred until G-FUT-VOL passes (needs synchronized futures+index 1m closes)"
                    if not has_fut_vol
                    else "Insufficient synchronized futures/index 1m closes for basis mapping"
                )
            ),
            "pairs": [
                {
                    "fut_symbol": r["fut_symbol"],
                    "index_symbol": r["index_symbol"],
                    "synced_1m": int(r["synced_1m"] or 0),
                    "first_sync": r["first_sync"].isoformat() if r.get("first_sync") else None,
                    "last_sync": r["last_sync"].isoformat() if r.get("last_sync") else None,
                }
                for r in basis_sync
            ],
        },
        "G-ROLL": {
            "pass": bool(has_fut_vol and contracts_with_vol and roll_doc_ok),
            "detail": (
                "Causal roll rule archived with FUTURE expiry metadata + worked example"
                if has_fut_vol and contracts_with_vol and roll_doc_ok
                else (
                    "Deferred until futures contract master + prior-session volumes exist"
                    if not has_fut_vol
                    else (
                        f"Missing roll worked example at {ROLL_WORKED_EXAMPLE.name}"
                        if not roll_doc_ok
                        else "FUTURE rows lack expiry metadata for causal roll"
                    )
                )
            ),
            "worked_example": str(ROLL_WORKED_EXAMPLE.relative_to(REPO_ROOT)) if roll_doc_ok else None,
            "contracts_with_expiry_and_volume": len(contracts_with_vol),
            "limitation": (
                "AUG/SEP Fyers history unavailable (HTTP 422); OCT-only volume window until "
                "licensed archive or NOV+ live collect"
            ),
        },
        "G-BASELINE": {
            "pass": None,
            "detail": "Baseline export not run in this gate; separate check after G-FUT-VOL",
        },
        "G-PIT": {
            "pass": True,
            "detail": "Protocol freezes prior-session-only profiles and decision-time event codes",
        },
    }
    blocking = [
        name
        for name in ("G-FUT-VOL", "G-BASIS", "G-ROLL")
        if not gates[name]["pass"]
    ]
    blocking_fail = bool(blocking)
    return {
        "experiment_id": EXPERIMENT_ID,
        "audited_at": datetime.now(timezone.utc).isoformat(),
        "decision": "DATA_GATE_FAIL" if blocking_fail else "DATA_GATE_PASS",
        "confirmatory_replay_authorized": False if blocking_fail else True,
        "blocking_gates": blocking,
        "gates": gates,
        "future_contract_summary": [
            {
                **{k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in r.items()},
                "vol_pos": int(r.get("vol_pos") or 0),
                "m1": int(r.get("m1") or 0),
            }
            for r in future_contract_summary
        ],
        "index_candle_summary": index_rows,
        "note": (
            "Do not substitute NIFTY50/BANKNIFTY index or ETF volume for futures FRVP. "
            "Evaluation window limited to sessions with available futures volume (OCT series)."
        ),
    }


def main() -> int:
    report = audit()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    print(json.dumps(report, indent=2, default=str))
    print(f"Wrote {OUT}", file=sys.stderr)
    return 0 if report["decision"] == "DATA_GATE_PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
