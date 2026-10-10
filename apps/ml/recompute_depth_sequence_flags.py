"""READ-ONLY audit: recompute depth_frames sequence flags and compare them with the stored ones.

Background (docs/2026-10-10-orderbook-liquidity-audit-fixes.md): before the capture fix, the
`is_regression` marker in capture-depth-frames.ts never moved down after a sequence reset without a
snapshot, so EVERY later frame of that stream was stored as is_regression = TRUE (e.g. 29,954 frames
on 2026-09-11) with gap_before NULL. Research that filters `is_regression = FALSE` silently dropped
whole sessions. The stored rows are NOT corrected and this script does NOT correct them:

  * it opens the connection READ ONLY and only issues SELECTs;
  * it prints, per (provider_symbol, capture_session_id, IST day), the stored flag counts next to the
    counts recomputed from `sequence_no` with cks_ofi_touch.recompute_sequence_flags (the same rule
    the fixed capture code applies going forward);
  * the research scripts (run_orderbook01_*.py, run_phase_c_pipeline.py, run_cost_stack_validation.py)
    already recompute from sequence_no instead of trusting the stored columns.

A set-based equivalent for ad-hoc inspection is in the docs (window functions, SELECT only).

Usage (not run as part of the audit fix):
    python recompute_depth_sequence_flags.py --from 2026-08-21 --to 2026-10-09
"""

from __future__ import annotations

import argparse
import sys
import zoneinfo
from datetime import date, datetime, timedelta
from pathlib import Path

script_dir = Path(__file__).resolve().parent
if str(script_dir) not in sys.path:
    sys.path.insert(0, str(script_dir))

import psycopg

from ai_quant_lab_ml.cks_ofi_touch import recompute_sequence_flags
from ai_quant_lab_ml.structure_intelligence import get_db_connection_string

INDIA_TZ = zoneinfo.ZoneInfo("Asia/Kolkata")


def summarise_chain(rows) -> dict:
    """rows: [(sequence_no, is_snapshot, stored_is_duplicate, stored_is_regression)] in received order.
    Pure -- returns stored vs recomputed duplicate / regression counts."""
    flags = recompute_sequence_flags(
        [(None if r[0] is None else int(r[0]), bool(r[1])) for r in rows]
    )
    return {
        "frames": len(rows),
        "stored_duplicate": sum(1 for r in rows if r[2]),
        "recomputed_duplicate": sum(1 for f in flags if f[1]),
        "stored_regression": sum(1 for r in rows if r[3]),
        "recomputed_regression": sum(1 for f in flags if f[2]),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only recompute of depth_frames sequence flags")
    parser.add_argument("--from", dest="start", required=True, help="first IST day (YYYY-MM-DD)")
    parser.add_argument("--to", dest="end", required=True, help="last IST day (YYYY-MM-DD)")
    args = parser.parse_args()
    first, last = date.fromisoformat(args.start), date.fromisoformat(args.end)

    header = (
        f"{'day':<12} {'provider_symbol':<26} {'session':<10} {'frames':>8} "
        f"{'dup(stored)':>11} {'dup(recomp)':>11} {'reg(stored)':>11} {'reg(recomp)':>11}"
    )
    print(header)
    print("-" * len(header))

    with psycopg.connect(get_db_connection_string()) as conn:
        conn.read_only = True  # belt and braces: this script must never write
        day = first
        while day <= last:
            start = datetime.combine(day, datetime.min.time(), tzinfo=INDIA_TZ)
            end = start + timedelta(days=1)
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT provider_symbol, capture_session_id::text, sequence_no, is_snapshot,
                           is_duplicate, is_regression
                    FROM depth_frames
                    WHERE received_at >= %s AND received_at < %s
                    ORDER BY provider_symbol, capture_session_id, received_at ASC, sequence_no ASC NULLS LAST
                    """,
                    (start, end),
                )
                chains: dict[tuple, list] = {}
                for sym, sess, seq, snap, dup, reg in cur.fetchall():
                    chains.setdefault((sym, sess), []).append((seq, snap, dup, reg))
            # capture_session_id is NULL for some frames; None and str are not orderable in
            # Python 3, so sorting the raw tuples throws. Treat a missing session as the empty
            # string for ordering purposes only -- this is a print-order choice, not a data change.
            for (sym, sess), rows in sorted(chains.items(), key=lambda item: (item[0][0], item[0][1] or "")):
                s = summarise_chain(rows)
                flag = "  <-- stored regression flags differ" if s["stored_regression"] != s["recomputed_regression"] else ""
                print(
                    f"{day.isoformat():<12} {sym:<26} {str(sess)[:8]:<10} {s['frames']:>8} "
                    f"{s['stored_duplicate']:>11} {s['recomputed_duplicate']:>11} "
                    f"{s['stored_regression']:>11} {s['recomputed_regression']:>11}{flag}"
                )
            day += timedelta(days=1)


if __name__ == "__main__":
    main()
