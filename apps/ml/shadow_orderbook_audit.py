#!/usr/bin/env python3
"""ORDERBOOK-01 Shadow Trade Logging & PnL Attribution Audit.

Analyzes persisted trade_ideas and paper_trades records carrying the
evidence->'orderbookGate' shadow metadata.

Metrics Computed:
1. Shadow Gate Verdict Breakdown (ALLOWED vs BLOCKED vs NEUTRAL count).
2. Per-Strategy Gating Distribution.
3. Paper Trade Attribution (trade count, win rate, average and total realized PnL per shadow verdict).
4. Counterfactual "net protection" for BLOCKED verdicts: -sum(realized PnL of the BLOCKED paper trades
   that actually executed). This is the PnL change IF those trades had been skipped.

HONEST LIMITS -- read before quoting any number from this report:
  - It is a counterfactual, not realised protection: ORDERBOOK-01 is shadow-only (the verdict is
    recorded in `evidence.orderbookGate` but, with ORDERBOOK01_LIVE_GATE_ENABLED off, never blocks),
    so BLOCKED trades DID execute and their PnL is observed. If the gate is ever switched on, BLOCKED
    ideas stop becoming paper trades and their PnL becomes unobservable here.
  - No drawdown, no ungated-vs-gated equity comparison and no significance test are computed.
    (Earlier docstring text promised "Drawdown" and "Points saved"; neither was ever implemented.)
  - ORDERBOOK-01 was falsified out of sample (docs/2026-10-05-orderbook01-bug-fixes-and-honest-verdict.md);
    a positive counterfactual here is not evidence of an edge.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path
import zoneinfo

import psycopg
from ai_quant_lab_ml.structure_intelligence import get_db_connection_string

INDIA_TZ = zoneinfo.ZoneInfo("Asia/Kolkata")
LOG_FILE = Path(__file__).resolve().parent.parent.parent / "logs" / "shadow-orderbook-audit.log"

def log_output(msg: str):
    timestamp = datetime.now(INDIA_TZ).strftime("%Y-%m-%d %H:%M:%S %Z")
    formatted = f"[{timestamp}] {msg}"
    print(msg, flush=True)
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(formatted + "\n")

def format_net_protection_line(pt_rows) -> str:
    """Counterfactual net protection from (verdict, trades, wins, avg_pnl, total_pnl) rows.

    = -(total realized PnL of BLOCKED paper trades). Returns an explicit "not computable" message
    when there are no executed BLOCKED trades or their PnL is missing -- never a fabricated 0.
    """
    blocked = [r for r in pt_rows if r[0] == "BLOCKED"]
    if not blocked or blocked[0][1] == 0 or blocked[0][4] is None:
        return "  * Net protection (counterfactual): not computable -- no executed BLOCKED paper trades with PnL."
    total_blocked_pnl = float(blocked[0][4])
    return (
        f"  * Net protection (counterfactual, observed BLOCKED trades only): {-total_blocked_pnl:+.2f} "
        f"(= minus the {total_blocked_pnl:+.2f} realized PnL of {blocked[0][1]} BLOCKED trades, had they been skipped; "
        "shadow-only gate, not a realised saving, not evidence of an edge)"
    )


def run_shadow_audit():
    log_output("==========================================================================")
    log_output("ORDERBOOK-01 Shadow Trade & PnL Attribution Audit")
    log_output("==========================================================================")

    conn = psycopg.connect(get_db_connection_string())
    with conn.cursor() as cur:
        log_output("Querying trade_ideas table...")
        cur.execute("SELECT count(*) FROM trade_ideas;")
        total_ideas = cur.fetchone()[0]

        cur.execute("""
            SELECT 
                count(*) as gated,
                count(*) FILTER (WHERE evidence->'orderbookGate'->>'shadowVerdict' = 'ALLOWED') as allowed,
                count(*) FILTER (WHERE evidence->'orderbookGate'->>'shadowVerdict' = 'BLOCKED') as blocked,
                count(*) FILTER (WHERE evidence->'orderbookGate'->>'shadowVerdict' = 'NEUTRAL') as neutral
            FROM trade_ideas
            WHERE evidence::text LIKE '%orderbookGate%';
        """)
        row = cur.fetchone()
        gated_ideas, allowed, blocked, neutral = row if row else (0, 0, 0, 0)

        log_output(f"Total Trade Ideas Scanned: {total_ideas}")
        log_output(f"Trade Ideas with Gate Metadata: {gated_ideas}")
        log_output(f"  - ALLOWED (Aligned Depth):    {allowed}")
        log_output(f"  - BLOCKED (Conflicting Depth): {blocked}")
        log_output(f"  - NEUTRAL (No Level / No DI):  {neutral}")

        # 2. Strategy Level Breakdown
        log_output("\n--- Breakdown by Strategy Version ---")
        cur.execute("""
            SELECT 
                coalesce(sv.strategy_id::text, 'UNASSIGNED') as strategy_key,
                count(*) as total,
                count(*) FILTER (WHERE ti.evidence->'orderbookGate'->>'shadowVerdict' = 'ALLOWED') as allowed,
                count(*) FILTER (WHERE ti.evidence->'orderbookGate'->>'shadowVerdict' = 'BLOCKED') as blocked,
                count(*) FILTER (WHERE ti.evidence->'orderbookGate'->>'shadowVerdict' = 'NEUTRAL') as neutral
            FROM trade_ideas ti
            LEFT JOIN strategy_versions sv ON sv.id = ti.strategy_version_id
            WHERE ti.evidence::text LIKE '%orderbookGate%'
            GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
        """)
        strat_rows = cur.fetchall()
        if not strat_rows:
            log_output("No strategy records found with orderbookGate metadata yet.")
        else:
            for s in strat_rows:
                log_output(f"  * {s[0]:30s} | Total: {s[1]:5d} | Allowed: {s[2]:4d} | Blocked: {s[3]:4d} | Neutral: {s[4]:4d}")

        # 3. Paper Trade Attribution
        log_output("\n--- Paper Trade PnL Attribution ---")
        try:
            cur.execute("""
                SELECT 
                    coalesce(ti.evidence->'orderbookGate'->>'shadowVerdict', 'UNSPECIFIED') as verdict,
                    count(*) as total_trades,
                    count(*) FILTER (WHERE pt.realized_pnl > 0) as winning_trades,
                    round(avg(pt.realized_pnl)::numeric, 2) as avg_pnl,
                    round(sum(pt.realized_pnl)::numeric, 2) as total_pnl
                FROM paper_trades pt
                JOIN trade_ideas ti ON ti.id = pt.trade_idea_id
                WHERE ti.evidence::text LIKE '%orderbookGate%'
                GROUP BY 1 ORDER BY 1;
            """)
            pt_rows = cur.fetchall()
            if not pt_rows:
                log_output("No linked paper trades with shadow gate verdicts recorded yet.")
            else:
                for pt in pt_rows:
                    win_rate = (pt[2] / pt[1] * 100) if pt[1] > 0 else 0.0
                    log_output(f"  * Verdict: {pt[0]:12s} | Trades: {pt[1]:4d} | Win Rate: {win_rate:5.1f}% | Avg PnL: {pt[3]} | Total PnL: {pt[4]}")
                log_output(format_net_protection_line(pt_rows))
        except Exception as e:
            log_output(f"Note: Paper trade join omitted ({e})")

    log_output("==========================================================================")
    log_output("Shadow Audit Execution Completed")
    log_output("==========================================================================")

if __name__ == "__main__":
    run_shadow_audit()
