"""
GEX Numerical Pipeline Runner: Standalone Signal Check (Track 1) & Conditioned Golden Pocket Test (Track 2)
Implementation Contract v1.4.1 & Pre-Registration PREREG-2026-10-20-GEX-FIB-INTERACTION-V1
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from dotenv import load_dotenv
import numpy as np
import psycopg

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

import run_phase_c_pipeline as rpc
from ai_quant_lab_ml.experiments_f1_f4 import (
    ObservationEpisode,
    PropensityMatcher,
)
from ai_quant_lab_ml.gex_experiment import (
    evaluate_gex_conditioned_golden_pocket,
    evaluate_gex_standalone_bars,
    MIN_MATCHED_PAIRS_PER_GEX_BUCKET,
)
from ai_quant_lab_ml.fibonacci_pit_engine import GEXContext
from ai_quant_lab_ml.gex_resolver import resolve_options_context

MANIFEST_OUTPUT_PATH = BASE_DIR / "gex_experiment_results.json"


def extract_track1_bars_and_episodes(
    connection: psycopg.Connection,
    instrument: str,
    timeframe_minutes: int,
    breadth_contexts: list,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[ObservationEpisode], List[ObservationEpisode]]:
    """
    Extracts:
    - track1_bullish_bars: All valid post-Aug-5 bars with FRESH GEX and forward 15m return (long)
    - track1_bearish_bars: All valid post-Aug-5 bars with FRESH GEX and forward 15m return (short)
    - bull_episodes: Full ObservationEpisode list from build_instrument_episodes
    - bear_episodes: Full ObservationEpisode list from build_instrument_episodes
    """
    cur = connection.cursor()
    cur.execute("""
        SELECT c.close_time, c.open, c.high, c.low, c.close, c.volume
        FROM candles c
        JOIN instruments i ON c.instrument_id = i.id
        WHERE i.symbol = %s AND c.timeframe = %s AND c.is_complete = true
        ORDER BY c.close_time ASC
        LIMIT %s;
    """, (instrument, rpc.TIMEFRAME, rpc.HISTORY_ROW_LIMIT))
    rows = cur.fetchall()
    if not rows:
        return [], [], [], []

    highs = [float(r[2]) for r in rows]
    lows = [float(r[3]) for r in rows]
    opens = [float(r[1]) for r in rows]
    closes = [float(r[4]) for r in rows]

    horizon_bars = max(1, round(rpc.HORIZON_MINUTES / timeframe_minutes))

    ofi_observations = None
    if instrument == "BANKNIFTY":
        ofi_observations, _ = rpc.fetch_banknifty_futures_depth_series(connection, timeframe_minutes)

    options_books = rpc.load_option_chain_books(connection, instrument)
    options_contract_multiplier = rpc.fetch_lot_size(connection, instrument)
    options_gex_cache: dict = {}

    # Extract Track 1 bars across all completed bars
    track1_bullish_bars = []
    track1_bearish_bars = []

    print(f"Extracting Track 1 standalone bars for {instrument}...", file=sys.stderr)
    for idx, r in enumerate(rows):
        dt = r[0] if isinstance(r[0], datetime) else datetime.fromtimestamp(r[0] / 1000.0, tz=timezone.utc)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        session_str = dt.strftime("%Y-%m-%d")

        # Session boundaries: 09:15-15:30 IST, not near close
        ist_minutes = (dt.hour * 60 + dt.minute + rpc.IST_OFFSET_MINUTES) % (24 * 60)
        if not (rpc.SESSION_START_MIN <= ist_minutes <= rpc.SESSION_END_MIN):
            continue
        if rpc.is_near_session_close(dt):
            continue

        # Horizon check
        if idx + horizon_bars >= len(rows):
            continue
        exit_dt = rows[idx + horizon_bars][0]
        if not isinstance(exit_dt, datetime):
            exit_dt = datetime.fromtimestamp(exit_dt / 1000.0, tz=timezone.utc)
        elif exit_dt.tzinfo is None:
            exit_dt = exit_dt.replace(tzinfo=timezone.utc)

        horizon_minutes_actual = (exit_dt - dt).total_seconds() / 60.0
        if not (exit_dt.strftime("%Y-%m-%d") == session_str
                and horizon_minutes_actual <= rpc.HORIZON_MINUTES + rpc.MAX_HORIZON_SLACK_MINUTES):
            continue

        # GEX resolution
        res = resolve_options_context(
            connection, options_books, instrument, spot=float(r[4]),
            contract_multiplier=options_contract_multiplier or 1, as_of=dt,
            gex_cache=options_gex_cache,
        )

        # Check FRESH status (snapshot age <= 15 min)
        if res.state != "FRESH" or res.net_dealer_gamma_exposure is None or res.observed_at is None:
            continue
        age_ms = (dt - res.observed_at).total_seconds() * 1000.0
        if age_ms > 15 * 60 * 1000.0 or age_ms < 0:
            continue

        gex_val = res.net_dealer_gamma_exposure

        # Compute tradeable net returns
        ret_bull = rpc.compute_net_return_bps(opens, closes, idx, horizon_bars, "BULLISH")
        ret_bear = rpc.compute_net_return_bps(opens, closes, idx, horizon_bars, "BEARISH")

        bar_base = {
            "symbol": instrument,
            "sessionDate": session_str,
            "timestampMs": int(dt.timestamp() * 1000),
            "gex": gex_val,
        }
        track1_bullish_bars.append({**bar_base, "direction": "BULLISH", "netReturnBps": ret_bull})
        track1_bearish_bars.append({**bar_base, "direction": "BEARISH", "netReturnBps": ret_bear})

    print(f"  {instrument}: {len(track1_bullish_bars)} valid post-Aug-5 bars with FRESH GEX.", file=sys.stderr)

    # Extract Track 2 episodes via build_instrument_episodes
    print(f"Building Track 2 episodes for {instrument}...", file=sys.stderr)
    bull_episodes, bear_episodes, diag = rpc.build_instrument_episodes(
        rows, instrument, timeframe_minutes,
        ofi_observations=ofi_observations, breadth_contexts=breadth_contexts,
        connection=connection, options_underlying_symbol=instrument,
    )

    return track1_bullish_bars, track1_bearish_bars, bull_episodes, bear_episodes


def run_gex_pipeline():
    print("=== GEX Empirical Pipeline Execution ===", file=sys.stderr)
    env_file = BASE_DIR.parent.parent / ".env"
    load_dotenv(str(env_file))
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        raise RuntimeError("DATABASE_URL environment variable is required.")

    with psycopg.connect(db_url, connect_timeout=10) as conn:
        breadth_contexts = rpc.fetch_breadth_contexts(conn)
        print(f"Loaded {len(breadth_contexts)} breadth contexts.", file=sys.stderr)

        all_t1_bullish_bars = []
        all_t1_bearish_bars = []
        all_bull_episodes = []
        all_bear_episodes = []

        per_instrument_t1 = {}

        for inst in rpc.INSTRUMENTS:
            t1_bull, t1_bear, bull_eps, bear_eps = extract_track1_bars_and_episodes(
                conn, inst, rpc.TIMEFRAME_MINUTES[rpc.TIMEFRAME], breadth_contexts
            )
            all_t1_bullish_bars.extend(t1_bull)
            all_t1_bearish_bars.extend(t1_bear)
            all_bull_episodes.extend(bull_eps)
            all_bear_episodes.extend(bear_eps)

            # Evaluate per-instrument Track 1
            print(f"Evaluating Track 1 for {inst} Bullish & Bearish...", file=sys.stderr)
            res_bull = evaluate_gex_standalone_bars(t1_bull, B=2000, seed=42)
            res_bear = evaluate_gex_standalone_bars(t1_bear, B=2000, seed=42)
            per_instrument_t1[inst] = {
                "bullish": res_bull,
                "bearish": res_bear,
            }

    # Evaluate Pooled Track 1
    print("Evaluating Pooled Track 1 (NIFTY50 + BANKNIFTY)...", file=sys.stderr)
    pooled_t1_bull = evaluate_gex_standalone_bars(all_t1_bullish_bars, B=2000, seed=42)
    pooled_t1_bear = evaluate_gex_standalone_bars(all_t1_bearish_bars, B=2000, seed=42)

    # Track 2: Conditioned Golden Pocket Test (Bullish)
    print("Evaluating Track 2: Conditioned Golden Pocket (Bullish)...", file=sys.stderr)
    eval_bull_episodes, calib_means_bull, calib_stds_bull = rpc.split_calibration_and_evaluation(all_bull_episodes)
    gp_bull_treatments = [e for e in eval_bull_episodes if e.isTreatment and e.fibZone == "GOLDEN_POCKET" and not e.isSessionCloseExcluded]
    bull_controls = [e for e in eval_bull_episodes if not e.isTreatment and not e.isSessionCloseExcluded]

    matcher_bull = PropensityMatcher(calib_means_bull, calib_stds_bull)
    matched_pairs_bull, _, _, _, _, _ = matcher_bull.match_1to1_deterministic(gp_bull_treatments, bull_controls)
    treat_map_bull = {e.episodeId: e for e in gp_bull_treatments}
    track2_bullish_res = evaluate_gex_conditioned_golden_pocket(matched_pairs_bull, treat_map_bull, B=2000, seed=42)

    # Track 2: Conditioned Golden Pocket Test (Bearish)
    print("Evaluating Track 2: Conditioned Golden Pocket (Bearish)...", file=sys.stderr)
    eval_bear_episodes, calib_means_bear, calib_stds_bear = rpc.split_calibration_and_evaluation(all_bear_episodes)
    gp_bear_treatments = [e for e in eval_bear_episodes if e.isTreatment and e.fibZone == "GOLDEN_POCKET" and not e.isSessionCloseExcluded]
    bear_controls = [e for e in eval_bear_episodes if not e.isTreatment and not e.isSessionCloseExcluded]

    matcher_bear = PropensityMatcher(calib_means_bear, calib_stds_bear)
    matched_pairs_bear, _, _, _, _, _ = matcher_bear.match_1to1_deterministic(gp_bear_treatments, bear_controls)
    treat_map_bear = {e.episodeId: e for e in gp_bear_treatments}
    track2_bearish_res = evaluate_gex_conditioned_golden_pocket(matched_pairs_bear, treat_map_bear, B=2000, seed=42)

    # Build manifest
    manifest = {
        "protocolVersion": "RESEARCH_SPECIFICATION_V1.1_CONTRACT_V1.4.1",
        "preRegistrationId": "PREREG-2026-10-20-GEX-FIB-INTERACTION-V1",
        "preRegistrationCommits": ["b80b522b", "71c614fb", "8e8d985c"],
        "pipelineRevision": "2026-10-20_GEX_TRACK1_TRACK2_EXECUTION",
        "governanceStatus": "RESEARCH_EXECUTION_COMPLETE",
        "tradingExecutionAuthorized": False,
        "exploratoryNotice": (
            "EXPLORATORY RESEARCH ONLY — NOT A TRADING SIGNAL. This manifest records both Track 1 (standalone continuous "
            "GEX predictability) and Track 2 (conditioned Golden Pocket interaction test). Track 2 strictly enforces a "
            f"minimum sample floor of {MIN_MATCHED_PAIRS_PER_GEX_BUCKET} matched pairs per GEX-sign bucket; failure to clear "
            "the floor mandates INCONCLUSIVE_INSUFFICIENT_DATA and refuses to emit an ungrounded point estimate. Track 1 "
            "evaluates 15-minute continuous forward net returns (minus 2 bps friction) and designates the session-block bootstrap "
            "difference in means as the sole primary decision-bearing test to avoid overlapping-window variance deflations."
        ),
        "track1_standalone_continuous_test": {
            "population": "All completed 5m candle bars in the post-2026-08-05 window where gexState == 'FRESH' and entry <= 15:15 IST",
            "horizon": "15 minutes (3 bars at 5m)",
            "frictionBps": rpc.ROUND_TRIP_FRICTION_BPS,
            "pooled": {
                "bullish": pooled_t1_bull,
                "bearish": pooled_t1_bear,
            },
            "byInstrument": per_instrument_t1,
        },
        "track2_conditioned_golden_pocket_interaction_test": {
            "hypothesis": (
                "Dealers net short gamma (negative) -> dealers hedge with the move -> trending/continuation. "
                "Dealers net long gamma (positive) -> dealers hedge against the move -> pinning/reversal. "
                "Prediction: Golden Pocket continuation causal delta is higher in short gamma than in long gamma."
            ),
            "floorRule": f"Minimum {MIN_MATCHED_PAIRS_PER_GEX_BUCKET} matched pairs per bucket required to estimate interaction",
            "metric": "Matched pair deltaNetReturnBps (treatment minus matched control)",
            "bullishGoldenPocket": {
                "verdict": track2_bullish_res.verdict,
                "nTotalMatchedPairs": track2_bullish_res.nTotalMatchedPairs,
                "nShortGammaMatched": track2_bullish_res.nShortGammaMatched,
                "nLongGammaMatched": track2_bullish_res.nLongGammaMatched,
                "floorThreshold": track2_bullish_res.floorThreshold,
                "floorPassed": track2_bullish_res.floorPassed,
                "estimateHatDeltaBps": track2_bullish_res.estimateHatDeltaBps,
                "lowerCi95Bps": track2_bullish_res.lowerCi95Bps,
                "upperCi95Bps": track2_bullish_res.upperCi95Bps,
                "bootstrapSeBps": track2_bullish_res.bootstrapSeBps,
                "minDetectableEffectBps": track2_bullish_res.minDetectableEffectBps,
                "pValRaw": track2_bullish_res.pValRaw,
                "meanShortGammaDeltaBps": track2_bullish_res.meanShortGammaDeltaBps,
                "meanLongGammaDeltaBps": track2_bullish_res.meanLongGammaDeltaBps,
                "details": track2_bullish_res.details,
            },
            "bearishGoldenPocket": {
                "verdict": track2_bearish_res.verdict,
                "nTotalMatchedPairs": track2_bearish_res.nTotalMatchedPairs,
                "nShortGammaMatched": track2_bearish_res.nShortGammaMatched,
                "nLongGammaMatched": track2_bearish_res.nLongGammaMatched,
                "floorThreshold": track2_bearish_res.floorThreshold,
                "floorPassed": track2_bearish_res.floorPassed,
                "estimateHatDeltaBps": track2_bearish_res.estimateHatDeltaBps,
                "lowerCi95Bps": track2_bearish_res.lowerCi95Bps,
                "upperCi95Bps": track2_bearish_res.upperCi95Bps,
                "bootstrapSeBps": track2_bearish_res.bootstrapSeBps,
                "minDetectableEffectBps": track2_bearish_res.minDetectableEffectBps,
                "pValRaw": track2_bearish_res.pValRaw,
                "meanShortGammaDeltaBps": track2_bearish_res.meanShortGammaDeltaBps,
                "meanLongGammaDeltaBps": track2_bearish_res.meanLongGammaDeltaBps,
                "details": track2_bearish_res.details,
            },
        },
    }

    with open(MANIFEST_OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    print(f"\nManifest successfully written to {MANIFEST_OUTPUT_PATH}", file=sys.stderr)
    return manifest


if __name__ == "__main__":
    manifest = run_gex_pipeline()
    print("\n" + "=" * 60)
    print("GEX EXPERIMENTAL PIPELINE RESULTS")
    print("=" * 60)
    print("\n[Track 1: Standalone Continuous Test - Pooled]")
    bull_t1 = manifest["track1_standalone_continuous_test"]["pooled"]["bullish"]
    bear_t1 = manifest["track1_standalone_continuous_test"]["pooled"]["bearish"]
    print(f"  Bullish Bars Evaluated: {bull_t1['nBars']} (Short: {bull_t1['nShortGammaBars']}, Long: {bull_t1['nLongGammaBars']})")
    print(f"    Primary Test (Session-Block Bootstrap Diff): {bull_t1['primaryDecisionBearingTest']['estimateBps']:.2f} bps "
          f"[{bull_t1['primaryDecisionBearingTest']['lowerCi95Bps']:.2f}, {bull_t1['primaryDecisionBearingTest']['upperCi95Bps']:.2f}], "
          f"SE={bull_t1['primaryDecisionBearingTest']['bootstrapSeBps']:.2f}, p={bull_t1['primaryDecisionBearingTest']['pValTwoSided']:.4f}")
    print(f"    Verdict: {bull_t1['primaryDecisionBearingTest']['verdict']}")
    print(f"    Directional Acc: {bull_t1['classificationPerformance']['directionalAccuracy']*100:.2f}% vs Baseline {bull_t1['classificationPerformance']['trivialMajorityBaselineAccuracy']*100:.2f}% (Macro-F1: {bull_t1['classificationPerformance']['macroF1']:.3f})")

    print(f"\n  Bearish Bars Evaluated: {bear_t1['nBars']} (Short: {bear_t1['nShortGammaBars']}, Long: {bear_t1['nLongGammaBars']})")
    print(f"    Primary Test (Session-Block Bootstrap Diff): {bear_t1['primaryDecisionBearingTest']['estimateBps']:.2f} bps "
          f"[{bear_t1['primaryDecisionBearingTest']['lowerCi95Bps']:.2f}, {bear_t1['primaryDecisionBearingTest']['upperCi95Bps']:.2f}], "
          f"SE={bear_t1['primaryDecisionBearingTest']['bootstrapSeBps']:.2f}, p={bear_t1['primaryDecisionBearingTest']['pValTwoSided']:.4f}")
    print(f"    Verdict: {bear_t1['primaryDecisionBearingTest']['verdict']}")
    print(f"    Directional Acc: {bear_t1['classificationPerformance']['directionalAccuracy']*100:.2f}% vs Baseline {bear_t1['classificationPerformance']['trivialMajorityBaselineAccuracy']*100:.2f}% (Macro-F1: {bear_t1['classificationPerformance']['macroF1']:.3f})")

    print("\n[Track 2: Conditioned Golden Pocket Interaction Test]")
    gp_bull = manifest["track2_conditioned_golden_pocket_interaction_test"]["bullishGoldenPocket"]
    gp_bear = manifest["track2_conditioned_golden_pocket_interaction_test"]["bearishGoldenPocket"]
    print(f"  Bullish Golden Pocket: Matched={gp_bull['nTotalMatchedPairs']}, Short={gp_bull['nShortGammaMatched']}, Long={gp_bull['nLongGammaMatched']}, Floor={gp_bull['floorThreshold']}")
    print(f"    Verdict: {gp_bull['verdict']}")
    print(f"    Point Estimate: {gp_bull['estimateHatDeltaBps']}")
    print(f"    Reason: {gp_bull['details'].get('reason')}")

    print(f"\n  Bearish Golden Pocket: Matched={gp_bear['nTotalMatchedPairs']}, Short={gp_bear['nShortGammaMatched']}, Long={gp_bear['nLongGammaMatched']}, Floor={gp_bear['floorThreshold']}")
    print(f"    Verdict: {gp_bear['verdict']}")
    print(f"    Point Estimate: {gp_bear['estimateHatDeltaBps']}")
    print(f"    Reason: {gp_bear['details'].get('reason')}")
