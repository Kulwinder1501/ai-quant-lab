"""
Does book-depletion trade inference (depletion_trade_inference.py) say anything DIFFERENT from
touch-level OFI (cks_ofi_touch.py), or is it a quieter restatement of the same signal?

Background: the literal tick rule needs real trade prints, which no vendor integrated in this
system provides (confirmed directly against the installed Fyers SDK's own protobuf schema -- no
trade message type exists at all -- and against Fyers/Kite/TrueData's own user communities, who
report the identical gap). Depletion-at-unchanged-price is the nearest honest proxy buildable from
real captured depth_frames alone. Whether it adds anything beyond OFI is the question this script
exists to answer -- not assumed either way going in.

Run against the SAME three real captured BANKNIFTY futures contracts cks_ofi_touch.py already
uses, never blended across a roll. For each contract, both series are built from
split_into_valid_frame_pairs over the SAME frames (identical chain-validity rule), so the two
series share a timestamp index exactly -- a direct correlation between them isolates the metric
difference, not a difference in which pairs each one happened to keep.

Forward-return methodology mirrors the validated TypeScript reference
(apps/api/.../ofi-signal-observations.ts): touch mid-price (NOT the TS's qty-weighted microprice --
a known, documented simplification already present throughout this Python port's candle
construction) at the decision frame vs. the first frame strictly later than decision+horizon,
within a tolerance; horizons of 1s/5s/30s matching Phase 28's own validated test ladder
(evaluate-ofi-signal.ts's default --horizons). The feature window (5000ms) never crosses a chain
break; the forward-return lookup is NOT segment-restricted (a gap between the two endpoints means
the path wasn't observed, but both endpoints are still real prices) -- matching the TS docstring's
own stated rule for exactly this asymmetry.

This script creates no model version, no prediction, no paper trade, and no order. It only reads.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
from scipy import stats

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

from ai_quant_lab_ml.cks_ofi_touch import (
    BANKNIFTY_DEPTH_CONTRACTS,
    DepthFrameRow,
    compute_windowed_ofi_series,
    split_into_valid_frame_pairs,
)
from ai_quant_lab_ml.depletion_trade_inference import (
    classify_depletion_trade,
    compute_windowed_depletion_flow_series,
)
from run_phase_c_pipeline import build_depth_frame_rows

HORIZONS_MS: Tuple[int, ...] = (1_000, 5_000, 30_000)
MANIFEST_OUTPUT_PATH = BASE_DIR / "depletion_vs_ofi_results.json"


def touch_mid(frame: DepthFrameRow) -> Optional[float]:
    if frame.bid_price_0 <= 0 or frame.ask_price_0 <= 0:
        return None
    return (frame.bid_price_0 + frame.ask_price_0) / 2.0


def find_forward_index(
    frames: Sequence[DepthFrameRow], start_index: int, from_ms: int, horizon_ms: int, tolerance_ms: int,
) -> Optional[int]:
    """Port of ofi-signal-observations.ts's findForwardFrame: first frame strictly later than
    `from_ms`, at or after `from_ms + horizon_ms`, within tolerance. None if the next frame in
    tolerance range doesn't exist -- never stretched to a frame beyond it."""
    target = from_ms + horizon_ms
    for index in range(start_index + 1, len(frames)):
        at = int(frames[index].received_at.timestamp() * 1000)
        if at <= from_ms:
            continue
        if at < target:
            continue
        return index if (at - target) <= tolerance_ms else None
    return None


@dataclass(frozen=True)
class ContractResult:
    symbol: str
    framesExamined: int
    validPairs: int
    inferredTradeCount: int
    inferredTradeFraction: float
    ofiVsDepletionPearsonR: Optional[float]
    ofiVsDepletionSpearmanRho: Optional[float]
    icByHorizon: Dict[int, Dict[str, Optional[float]]]  # horizon_ms -> {"ofi": ic, "depletion": ic, "nObs": n}


def _spearman_ic(feature: List[float], forward_return: List[float]) -> Tuple[Optional[float], int]:
    if len(feature) < 30:
        return None, len(feature)
    rho, _ = stats.spearmanr(feature, forward_return)
    if not np.isfinite(rho):
        return None, len(feature)
    return float(rho), len(feature)


def evaluate_contract(symbol: str, frames: List[DepthFrameRow]) -> ContractResult:
    ofi_obs = compute_windowed_ofi_series(frames)
    depletion_obs = compute_windowed_depletion_flow_series(frames)
    assert len(ofi_obs) == len(depletion_obs), (
        f"{symbol}: OFI and depletion series misaligned ({len(ofi_obs)} vs {len(depletion_obs)}) "
        "-- both must iterate the identical valid-pair chain."
    )

    # inferred_trade_count on each observation is a TRAILING-WINDOW count, not a running total, so
    # it can't be summed across observations; recompute the true total directly instead.
    valid_pairs = 0
    inferred_trades = 0
    for segment in split_into_valid_frame_pairs(frames):
        valid_pairs += len(segment)
        for previous, current in segment:
            if classify_depletion_trade(previous, current) is not None:
                inferred_trades += 1

    ofi_vals = [o.window_sum for o in ofi_obs]
    depletion_vals = [o.window_sum for o in depletion_obs]
    if len(ofi_vals) >= 2 and len(set(ofi_vals)) > 1 and len(set(depletion_vals)) > 1:
        pearson_r = float(np.corrcoef(ofi_vals, depletion_vals)[0, 1])
        spearman_rho, _ = stats.spearmanr(ofi_vals, depletion_vals)
        spearman_rho = float(spearman_rho) if np.isfinite(spearman_rho) else None
    else:
        pearson_r, spearman_rho = None, None

    # received_at -> frame index, for the forward-return lookup (duplicates/gaps already excluded
    # from valid pairs, so any collision here is on a timestamp no observation actually cites).
    index_by_time = {frame.received_at: idx for idx, frame in enumerate(frames)}
    mids = [touch_mid(f) for f in frames]

    ic_by_horizon: Dict[int, Dict[str, Optional[float]]] = {}
    for horizon_ms in HORIZONS_MS:
        tolerance_ms = max(1_000, horizon_ms // 2)
        ofi_feat: List[float] = []
        depletion_feat: List[float] = []
        fwd_returns: List[float] = []

        for ofi_point, depletion_point in zip(ofi_obs, depletion_obs):
            idx = index_by_time.get(ofi_point.at)
            if idx is None:
                continue
            base_mid = mids[idx]
            if base_mid is None or base_mid <= 0:
                continue
            decided_at_ms = int(ofi_point.at.timestamp() * 1000)
            forward_idx = find_forward_index(frames, idx, decided_at_ms, horizon_ms, tolerance_ms)
            if forward_idx is None:
                continue
            forward_mid = mids[forward_idx]
            if forward_mid is None or forward_mid <= 0:
                continue
            ofi_feat.append(ofi_point.window_sum)
            depletion_feat.append(depletion_point.window_sum)
            fwd_returns.append((forward_mid - base_mid) / base_mid)

        ofi_ic, n_ofi = _spearman_ic(ofi_feat, fwd_returns)
        depletion_ic, n_dep = _spearman_ic(depletion_feat, fwd_returns)
        ic_by_horizon[horizon_ms] = {"ofi": ofi_ic, "depletion": depletion_ic, "nObs": n_ofi}

    return ContractResult(
        symbol=symbol,
        framesExamined=len(frames),
        validPairs=valid_pairs,
        inferredTradeCount=inferred_trades,
        inferredTradeFraction=(inferred_trades / valid_pairs) if valid_pairs else 0.0,
        ofiVsDepletionPearsonR=pearson_r,
        ofiVsDepletionSpearmanRho=spearman_rho,
        icByHorizon=ic_by_horizon,
    )


def main() -> int:
    from dotenv import load_dotenv
    load_dotenv(BASE_DIR.parent.parent / ".env")
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is not set; refusing to fall back to a built-in credential.")

    import psycopg

    results: List[ContractResult] = []
    with psycopg.connect(database_url, connect_timeout=10) as connection:
        cur = connection.cursor()
        for symbol, _start, _end in BANKNIFTY_DEPTH_CONTRACTS:
            cur.execute(
                """
                SELECT received_at, capture_session_id, sequence_no, is_snapshot,
                       bid_price[1], bid_qty[1], ask_price[1], ask_qty[1]
                FROM depth_frames
                WHERE provider_symbol = %s
                ORDER BY received_at ASC, sequence_no ASC NULLS LAST;
                """,
                (symbol,),
            )
            depth_rows = cur.fetchall()
            if not depth_rows:
                print(f"No depth frames for {symbol}; skipping.", file=sys.stderr)
                continue
            frames = build_depth_frame_rows(depth_rows)
            print(f"Evaluating {symbol}: {len(depth_rows)} real depth frames...", file=sys.stderr)
            results.append(evaluate_contract(symbol, frames))

    manifest = {
        "governanceStatus": "RESEARCH_EXECUTION_COMPLETE",
        "tradingExecutionAuthorized": False,
        "exploratoryNotice": (
            "EXPLORATORY RESEARCH ONLY -- NOT A TRADING SIGNAL. Depletion-at-unchanged-price is an "
            "L2-only proxy for an executed trade, built because no vendor integrated in this system "
            "(Fyers, Kite, TrueData) exposes real trade prints with or without aggressor-side "
            "classification -- confirmed directly against the installed Fyers SDK's protobuf schema. "
            "It is NOT the tick rule (no trade price exists to classify). Compared head-to-head "
            "against touch-level OFI (cks_ofi_touch.py), which Phase 28 already found unstable "
            "(sign does not replicate across time windows)."
        ),
        "methodology": {
            "windowMs": 5000,
            "horizonsMs": list(HORIZONS_MS),
            "priceUsed": "touch mid ((bid+ask)/2) -- not the TS reference's qty-weighted microprice",
            "icDefinition": "Spearman rank correlation, feature vs forward touch-mid return",
        },
        "byContract": [
            {
                "symbol": r.symbol,
                "framesExamined": r.framesExamined,
                "validPairs": r.validPairs,
                "inferredTradeCount": r.inferredTradeCount,
                "inferredTradeFraction": r.inferredTradeFraction,
                "ofiVsDepletionPearsonR": r.ofiVsDepletionPearsonR,
                "ofiVsDepletionSpearmanRho": r.ofiVsDepletionSpearmanRho,
                "icByHorizon": {str(h): v for h, v in r.icByHorizon.items()},
            }
            for r in results
        ],
    }

    with open(MANIFEST_OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"\nManifest written to {MANIFEST_OUTPUT_PATH}", file=sys.stderr)

    print("\n" + "=" * 70)
    print("DEPLETION-INFERRED TRADE FLOW vs TOUCH-LEVEL OFI")
    print("=" * 70)
    for r in results:
        print(f"\n[{r.symbol}]")
        print(f"  Valid pairs: {r.validPairs}, inferred trades: {r.inferredTradeCount} "
              f"({r.inferredTradeFraction * 100:.2f}% of valid pairs)")
        print(f"  OFI vs Depletion series: Pearson r={r.ofiVsDepletionPearsonR}, "
              f"Spearman rho={r.ofiVsDepletionSpearmanRho}")
        for horizon_ms, vals in r.icByHorizon.items():
            print(f"  Horizon {horizon_ms}ms (n={vals['nObs']}): "
                  f"OFI IC={vals['ofi']}, Depletion IC={vals['depletion']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
