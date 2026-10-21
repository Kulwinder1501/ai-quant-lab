"""
Pre-Registration ID: PREREG-2026-10-21-BINANCE-DEPLETION-VALIDATION-V1
Execution Runner: Offline Classifier Validation of Book-Depletion Trade Inference

================================================================================
PRE-REGISTRATION SPECIFICATION (FROZEN PRIOR TO REAL-DATA EVALUATION):
1. Target Heuristic:
   apps/ml/ai_quant_lab_ml/depletion_trade_inference.py:classify_depletion_trade
   Reused 100% UNMODIFIED via DepthFrameRow adapter.
2. Ground-Truth Data Source:
   Binance public Spot WebSocket streams:
   - <symbol>@depth@100ms: L2 order book diffs with U/u sequence maintenance
   - <symbol>@trade: raw individual trade prints (with isBuyerMaker sign convention)
3. Evaluated Symbols:
   BTCUSDT and ETHUSDT.
4. Matching Tolerance:
   Tight +/- 250ms window centered at the book update timestamp (|t_trade - t_frame| <= 250ms),
   matching the 100ms order-book sampling cadence, at the exact touch price level.
5. Minimum Capture Duration Floor:
   >= 2.0 hours of continuous active trading per symbol.
6. Success Bar (Pass/Fail Thresholds):
   - Precision >= 0.70 (70% of touch depletions at unchanged price are real trade prints)
   - Recall >= 0.50 (at least 50% of real trade prints are captured by touch depletions)
   Both symbols must meet or exceed both thresholds to declare heuristic SUPPORTED.
7. Scope Notice & Non-Authorization:
   Classifier validation only. Does not prove transferability to Indian equity derivatives
   (NSE BANKNIFTY options/futures) with different microstructure, tick sizes, and lot conventions.
   No trading execution authorized (tradingExecutionAuthorized: False).
================================================================================
"""

from __future__ import annotations

import argparse
import json
import logging
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

from ai_quant_lab_ml.binance_book_adapter import (
    TradeRecord,
    ValidationMetrics,
    evaluate_depletion_classifier,
)
from ai_quant_lab_ml.cks_ofi_touch import DepthFrameRow, split_into_valid_frame_pairs

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("depletion_validator")

DEFAULT_DB_PATH = BASE_DIR / "data" / "binance_l2_trades.db"
DEFAULT_MANIFEST_PATH = BASE_DIR / "binance_depletion_validation_results.json"

PRE_REG_ID = "PREREG-2026-10-21-BINANCE-DEPLETION-VALIDATION-V1"
MATCHING_TOLERANCE_MS = 250
MIN_CAPTURE_HOURS_FLOOR = 2.0
TARGET_PRECISION_BAR = 0.70
TARGET_RECALL_BAR = 0.50


def load_captured_depth_frames(conn: sqlite3.Connection, symbol: str) -> List[DepthFrameRow]:
    """Loads captured depth_updates for symbol and converts to DepthFrameRow."""
    cur = conn.cursor()
    cur.execute("""
        SELECT received_at_ms, is_snapshot, is_duplicate, is_regression, gap_before,
               bid_price_0, bid_qty_0, ask_price_0, ask_qty_0
        FROM depth_updates
        WHERE symbol = ?
        ORDER BY received_at_ms ASC, id ASC;
    """, (symbol.upper(),))
    rows = cur.fetchall()

    frames: List[DepthFrameRow] = []
    for r in rows:
        rx_ms, is_snap, is_dup, is_reg, gap_b, bp0, bq0, ap0, aq0 = r
        dt_utc = datetime.fromtimestamp(rx_ms / 1000.0, tz=timezone.utc)
        frames.append(
            DepthFrameRow(
                received_at=dt_utc,
                is_snapshot=bool(is_snap),
                is_duplicate=bool(is_dup),
                gap_before=gap_b,
                bid_price_0=float(bp0),
                bid_qty_0=float(bq0),
                ask_price_0=float(ap0),
                ask_qty_0=float(aq0),
                is_regression=bool(is_reg),
            )
        )
    return frames


def load_captured_trades(conn: sqlite3.Connection, symbol: str) -> List[TradeRecord]:
    """Loads captured trades for symbol and converts to TradeRecord."""
    cur = conn.cursor()
    cur.execute("""
        SELECT symbol, trade_id, price, qty, trade_time_ms, is_buyer_maker
        FROM trades
        WHERE symbol = ?
        ORDER BY trade_time_ms ASC, id ASC;
    """, (symbol.upper(),))
    rows = cur.fetchall()

    trades: List[TradeRecord] = []
    for r in rows:
        sym, t_id, p, q, t_ms, is_bm = r
        trades.append(
            TradeRecord(
                symbol=sym,
                trade_id=int(t_id),
                price=float(p),
                qty=float(q),
                trade_time_ms=int(t_ms),
                is_buyer_maker=bool(is_bm),
            )
        )
    return trades


def run_validation(
    db_path: Path,
    symbols: List[str],
    matching_tolerance_ms: int = MATCHING_TOLERANCE_MS,
    target_precision_bar: float = TARGET_PRECISION_BAR,
    target_recall_bar: float = TARGET_RECALL_BAR,
    min_capture_hours: float = MIN_CAPTURE_HOURS_FLOOR,
    force: bool = False,
) -> Dict[str, Any]:
    if not db_path.exists():
        raise FileNotFoundError(f"Captured SQLite database not found at {db_path}")

    conn = sqlite3.connect(str(db_path))
    results_by_symbol: Dict[str, Any] = {}
    all_symbols_supported = True
    any_symbol_floor_failed = False

    for symbol in symbols:
        symbol = symbol.upper()
        logger.info(f"Loading captured data for {symbol} from {db_path.name}...")
        frames = load_captured_depth_frames(conn, symbol)
        trades = load_captured_trades(conn, symbol)

        if not frames:
            logger.warning(f"[{symbol}] No depth frames found in database.")
            results_by_symbol[symbol] = {
                "status": "NO_DATA",
                "verdict": "INSUFFICIENT_DATA",
            }
            all_symbols_supported = False
            continue

        start_dt = frames[0].received_at
        end_dt = frames[-1].received_at
        wall_clock_hours = (end_dt - start_dt).total_seconds() / 3600.0

        # Compute synchronized active time across valid segments (accounting for mid-capture gaps/drops)
        segments = split_into_valid_frame_pairs(frames)
        total_sync_seconds = sum(
            (seg[-1][1].received_at - seg[0][0].received_at).total_seconds()
            for seg in segments if seg
        )
        sync_hours = total_sync_seconds / 3600.0
        coverage_ratio = (sync_hours / wall_clock_hours) if wall_clock_hours > 0 else 0.0

        # Strict synchronized active duration floor
        duration_passed = sync_hours >= min_capture_hours

        if not duration_passed:
            any_symbol_floor_failed = True
            logger.warning(
                f"[{symbol}] Capture duration floor violated: {sync_hours:.2f}h synchronized "
                f"({wall_clock_hours:.2f}h wall-clock, coverage={coverage_ratio*100:.1f}%) < {min_capture_hours:.1f}h"
            )

        metrics = evaluate_depletion_classifier(
            frames=frames,
            trades=trades,
            symbol=symbol,
            matching_tolerance_ms=matching_tolerance_ms,
            target_precision_bar=target_precision_bar,
            target_recall_bar=target_recall_bar,
        )

        if not duration_passed and not force:
            verdict = "INSUFFICIENT_CAPTURE_DURATION"
            all_symbols_supported = False
        elif metrics.overall_passed:
            verdict = "SUPPORTED"
        else:
            verdict = "FALSIFIED"
            all_symbols_supported = False

        results_by_symbol[symbol] = {
            "verdict": verdict,
            "captureDurationHours": sync_hours,
            "synchronizedDurationHours": sync_hours,
            "wallClockDurationHours": wall_clock_hours,
            "coverageRatio": coverage_ratio,
            "durationFloorPassed": duration_passed,
            "minCaptureHoursFloor": min_capture_hours,
            "sampleCounts": {
                "totalFrames": metrics.total_frames,
                "validPairs": metrics.valid_pairs,
                "brokenChains": metrics.broken_chain_count,
                "inferredTrades": metrics.inferred_buy_count + metrics.inferred_sell_count,
                "inferredBuy": metrics.inferred_buy_count,
                "inferredSell": metrics.inferred_sell_count,
                "inferredNone": metrics.inferred_none_count,
                "totalRealTrades": metrics.total_real_trades,
                "caughtRealTrades": metrics.caught_real_trades,
            },
            "precision": {
                "pooled": metrics.precision_pooled,
                "pooledCi95": list(metrics.precision_pooled_ci95),
                "buy": metrics.precision_buy,
                "buyCi95": list(metrics.precision_buy_ci95),
                "sell": metrics.precision_sell,
                "sellCi95": list(metrics.precision_sell_ci95),
                "barThreshold": target_precision_bar,
                "barPassed": metrics.precision_bar_passed,
            },
            "recall": {
                "pointEstimate": metrics.recall,
                "ci95": list(metrics.recall_ci95),
                "barThreshold": target_recall_bar,
                "barPassed": metrics.recall_bar_passed,
            },
            "silentMiss": {
                "count": metrics.silent_miss_count,
                "silentMissRate": metrics.silent_miss_rate,
                "ci95": list(metrics.silent_miss_rate_ci95),
                "trueNegativeCount": metrics.tn_count,
            },
            "confusionMatrix": {
                "tpBuy": metrics.tp_buy,
                "fpBuyCancellation": metrics.fp_buy_cancellation,
                "fpBuyWrongSide": metrics.fp_buy_wrong_side,
                "tpSell": metrics.tp_sell,
                "fpSellCancellation": metrics.fp_sell_cancellation,
                "fpSellWrongSide": metrics.fp_sell_wrong_side,
                "silentMissNone": metrics.silent_miss_count,
                "trueNegativeNone": metrics.tn_count,
            },
        }

    conn.close()

    if any_symbol_floor_failed and not force:
        overall_governance = "INSUFFICIENT_CAPTURE_DURATION"
        final_verdict = "INCONCLUSIVE_INSUFFICIENT_DURATION"
    elif all_symbols_supported:
        overall_governance = "RESEARCH_EXECUTION_COMPLETE"
        final_verdict = "SUPPORTED"
    else:
        overall_governance = "RESEARCH_EXECUTION_COMPLETE"
        final_verdict = "FALSIFIED"

    manifest = {
        "protocolVersion": "BINANCE_DEPLETION_CLASSIFIER_VALIDATION_V1.0",
        "preRegistrationId": PRE_REG_ID,
        "governanceStatus": overall_governance,
        "tradingExecutionAuthorized": False,
        "exploratoryNotice": (
            "EXPLORATORY RESEARCH ONLY -- NOT A TRADING SIGNAL. This validation evaluates the geometric validity "
            "of L2 order-book depletion as a trade execution proxy against Binance Spot ground-truth trade prints. "
            "Even a positive result does NOT prove transferability to NSE BANKNIFTY options or futures, which "
            "operate under different market microstructure (discrete tick sizes, lot multipliers, vendor snapshot "
            "throttling, and periodic batch call auctions). This test verifies classifier mechanics when ground truth "
            "is observable."
        ),
        "preRegisteredParameters": {
            "matchingToleranceMs": matching_tolerance_ms,
            "minCaptureHoursFloor": min_capture_hours,
            "targetPrecisionBar": target_precision_bar,
            "targetRecallBar": target_recall_bar,
        },
        "overallVerdict": final_verdict,
        "bySymbol": results_by_symbol,
    }
    return manifest


def main():
    parser = argparse.ArgumentParser(description="Offline Binance Depletion Classifier Validation Runner")
    parser.add_argument("--db-path", type=str, default=str(DEFAULT_DB_PATH), help="Path to SQLite database")
    parser.add_argument("--output-manifest", type=str, default=str(DEFAULT_MANIFEST_PATH), help="Manifest output path")
    parser.add_argument("--symbols", type=str, default="BTCUSDT,ETHUSDT", help="Comma-separated symbols")
    parser.add_argument("--matching-tolerance-ms", type=int, default=MATCHING_TOLERANCE_MS, help="Tolerance in ms")
    parser.add_argument("--min-capture-hours", type=float, default=MIN_CAPTURE_HOURS_FLOOR, help="Min hours floor")
    parser.add_argument("--force", action="store_true", help="Force evaluation even if capture duration floor binds")

    args = parser.parse_args()
    symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    db_path = Path(args.db_path)
    output_path = Path(args.output_manifest)

    logger.info(f"Executing depletion validation against {db_path}...")
    manifest = run_validation(
        db_path=db_path,
        symbols=symbols,
        matching_tolerance_ms=args.matching_tolerance_ms,
        target_precision_bar=TARGET_PRECISION_BAR,
        target_recall_bar=TARGET_RECALL_BAR,
        min_capture_hours=args.min_capture_hours,
        force=args.force,
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    logger.info(f"Manifest written to {output_path}")

    # Print summary table
    print("\n" + "=" * 90)
    print("BINANCE DEPLETION CLASSIFIER EMPIRICAL VALIDATION RESULTS")
    print(f"Pre-Registration: {manifest['preRegistrationId']}")
    print(f"Governance Status: {manifest['governanceStatus']} | Overall Verdict: {manifest['overallVerdict']}")
    print("=" * 90)

    for sym, res in manifest["bySymbol"].items():
        if res.get("status") == "NO_DATA":
            print(f"\n[{sym}] NO DATA CAPTURED")
            continue
        sc = res["sampleCounts"]
        pr = res["precision"]
        rec = res["recall"]
        sm = res["silentMiss"]
        dur = res["captureDurationHours"]
        fl_pass = res["durationFloorPassed"]

        dur_sync = res.get("synchronizedDurationHours", res["captureDurationHours"])
        dur_wall = res.get("wallClockDurationHours", dur_sync)
        cov = res.get("coverageRatio", 1.0)
        print(f"\nSymbol: {sym} | Verdict: {res['verdict']} | Synchronized Duration: {dur_sync:.2f}h (Wall-clock: {dur_wall:.2f}h, Coverage: {cov*100:.1f}%) | Floor >= {res['minCaptureHoursFloor']}h: {fl_pass}")
        print(f"  Total Frames: {sc['totalFrames']:,} | Valid Pairs: {sc['validPairs']:,} | Broken Chains: {sc['brokenChains']:,}")
        print(f"  Real Trades: {sc['totalRealTrades']:,} | Caught Trades: {sc['caughtRealTrades']:,}")
        print(f"  Inferred Trades: {sc['inferredTrades']:,} (BUY: {sc['inferredBuy']:,}, SELL: {sc['inferredSell']:,}, None: {sc['inferredNone']:,})")
        print(f"  Precision (Pooled): {pr['pooled']*100:.2f}% (95% CI: [{pr['pooledCi95'][0]*100:.2f}%, {pr['pooledCi95'][1]*100:.2f}%]) (Bar >= {pr['barThreshold']*100:.1f}%: {pr['barPassed']})")
        print(f"    - BUY Precision:  {pr['buy']*100:.2f}% (95% CI: [{pr['buyCi95'][0]*100:.2f}%, {pr['buyCi95'][1]*100:.2f}%])")
        print(f"    - SELL Precision: {pr['sell']*100:.2f}% (95% CI: [{pr['sellCi95'][0]*100:.2f}%, {pr['sellCi95'][1]*100:.2f}%])")
        print(f"  Recall:             {rec['pointEstimate']*100:.2f}% (95% CI: [{rec['ci95'][0]*100:.2f}%, {rec['ci95'][1]*100:.2f}%]) (Bar >= {rec['barThreshold']*100:.1f}%: {rec['barPassed']})")
        print(f"  Silent-Miss Rate:   {sm['silentMissRate']*100:.2f}% (95% CI: [{sm['ci95'][0]*100:.2f}%, {sm['ci95'][1]*100:.2f}%])")
        cm = res["confusionMatrix"]
        print(f"  Confusion Matrix: TP_BUY={cm['tpBuy']:,}, FP_BUY_CANC={cm['fpBuyCancellation']:,}, FP_BUY_WRONG_SIDE={cm['fpBuyWrongSide']:,}")
        print(f"                    TP_SELL={cm['tpSell']:,}, FP_SELL_CANC={cm['fpSellCancellation']:,}, FP_SELL_WRONG_SIDE={cm['fpSellWrongSide']:,}")
        print(f"                    SILENT_MISS={cm['silentMissNone']:,}, TRUE_NEGATIVE={cm['trueNegativeNone']:,}")
    print("\n" + "=" * 90)


if __name__ == "__main__":
    main()
