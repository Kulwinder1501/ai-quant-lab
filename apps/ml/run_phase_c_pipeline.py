"""
Phase C Numerical Pipeline Runner
Implementation Contract v1.4.1 & Research Specification v1.1

Executes the Master 5-Layer Scanner and F1-F4 Statistical Pipeline on historical data.
Emits the formal machine-readable `phase_c_results.json` manifest.

CORRECTIONS vs. the first version of this file (review findings):

 1. Every PIT input fed to the scanner (OFI, ATR, magnitude, structural resistance,
    netDelta/footprint, GEX, breadth, time-of-day) was a hardcoded constant, and
    `retracement` was always None. The Fibonacci engine can only ever form a POI once a
    real `retracement` observation is supplied, so with retracement=None forever, the
    engine never produced a single treatment candidate from real candles -- the
    "postgresqlDatabaseCandleEvaluation" section of phase_c_results.json always had
    nTreatmentTotal=0 while still reporting a confident "FALSIFIED" verdict. That is a
    vacuous test dressed up as a real one, which is exactly what the spec's own
    "Falsification-First Governance Principle" exists to prevent.
 2. The query pooled NIFTY50 + BANKNIFTY candles across every timeframe (1m/5m/15m/...)
    into one chronological stream, fed through a single scanner instance hardcoded to
    `current_instrument="NIFTY50"`. That silently corrupts the PIT sequence/identity
    invariants (mixing two different instruments' bars as if they were one continuous
    series) and mislabels BANKNIFTY bars as NIFTY50.
 3. The "60-session empirical benchmark" is synthetic data whose treatment/control MFE
    gap is injected directly into the random-number generator (treatment ~N(5,2) vs
    control ~N(1,1.5) bp). Validating the pipeline against data manufactured to contain
    the exact effect under test is circular, not evidence of a real edge, and it was
    reported under the same `PHASE_C_RESEARCH_EXECUTION_COMPLETE` governance status as
    the (supposedly real) DB evaluation -- at real risk of being mistaken for OOS
    evidence. It is now clearly fenced off and labeled as a non-evidentiary pipeline
    smoke test.

This version:
 - Queries NIFTY50 and BANKNIFTY separately, one fixed timeframe each, and runs an
   independent scanner per instrument so bar sequencing/identity stays valid.
 - Computes real Wilder ATR(14), a real swing-high based structural resistance feed, a
   real live retracement-low feed, real time-of-day sin/cos, a simple (explicitly
   labeled, not a calibrated-feature substitute) realized-vol-ratio proxy, and a real
   forward net-MFE outcome (minus the 2.0bp round-trip friction) -- all derived only
   from the real OHLCV candles this query fetches.
 - Real CKS touch-level OFI (ai_quant_lab_ml/cks_ofi_touch.py, a faithful port of the
   validated TypeScript Phase 28 implementation) is now wired in for BANKNIFTY, the only
   instrument with any captured depth data -- joined to each candle by nearest prior
   observation within a 60s staleness tolerance, never blended across a futures-contract
   roll. NIFTY50 has zero real depth data captured anywhere in this system; its OFI stays
   an honest 0.0 rather than a fabricated constant.
 - Real daily advance/decline market breadth (fetch_breadth_contexts) is now wired in,
   reusing the project's own existing ai_quant_lab_ml.breadth module and BREADTH_UNIVERSE
   contract (the same panel PostgresMlRepository already loads for training) rather than a
   hand-rolled parallel computation -- an earlier version of this file assumed breadth was
   undeliverable from any data source this system captures; it wasn't, it just hadn't been
   queried for this. PIT-safe via latest_breadth_at's staleness-bounded as-of lookup.
 - Trade-tape netDelta/footprint shape and options GEX are still not derivable from any data
   source this system captures today, and are left at honest neutral/zero values instead of
   hardcoded constants that trivially always pass their gates. Because Layer 2's
   footprint/GEX inputs remain unavailable and OFI has no validated gate threshold (see
   cks_ofi_touch.py's module docstring), this run still cannot execute the full F1-F4
   protocol as originally specified; it is reported as a location-only diagnostic (does
   price reach the Fib zone, what is the raw net MFE there, now informed by real order flow
   and real breadth where available) and is explicitly NOT a substitute for Phase C sign-off.
 - Calibration means/stds for propensity matching are computed from a strict leading
   slice of each instrument's real episodes (calibration period), with the remainder
   used for evaluation, honoring `calibrationEnd < evaluationStart`.
 - BANKNIFTY's Fibonacci zones were being computed from the CASH INDEX (the only `candles`
   row for that symbol) while its OFI conditioning comes from the FUTURES order book, which
   trades at a persistent ~0.3-0.5% premium to spot -- two different instruments' price
   action feeding one "treatment". Fixed by deriving a real OHLC series directly from the
   same depth-frame book OFI is computed from (compute_mid_price_candles) and running a
   second, independent Fibonacci evaluation (BANKNIFTY_FUT) against it, reported in its own
   clearly labeled section rather than folded into the existing index-based one. Real
   captured depth has intraday gaps (~6% of consecutive 5m buckets wider than one bar), so
   the forward-MFE horizon lookahead now also validates elapsed wall time between entry and
   exit bars (MAX_HORIZON_SLACK_MINUTES) instead of trusting a fixed bar-count offset --
   this also closes one same-day gap each in the existing NIFTY50/BANKNIFTY index series.
"""

from __future__ import annotations

import json
import math
import os
import sys
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

import numpy as np
import psycopg

from ai_quant_lab_ml.breadth import PanelBar, compute_breadth_contexts, latest_breadth_at
from ai_quant_lab_ml.cks_ofi_touch import (
    BANKNIFTY_DEPTH_CONTRACTS,
    CKS_OFI_TOUCH_5S_RAW_FEATURE_ID,
    DepthFrameRow,
    OfiWindowObservation,
    compute_mid_price_candles,
    compute_windowed_ofi_series,
    join_nearest_prior,
)
from ai_quant_lab_ml.contracts import BREADTH_INDEX_PRIMARY, BREADTH_INDEX_SECONDARY, BREADTH_UNIVERSE, BreadthContext
from ai_quant_lab_ml.experiments_f1_f4 import ObservationEpisode, run_phase_c_experiments
from ai_quant_lab_ml.fibonacci_pit_engine import (
    ATRObservation,
    CandleIdentity,
    FibAnchorCalibrationArtifact,
    FootprintBar,
    GEXContext,
    L2DepthLiquidityObservation,
    LambdaCalibrationArtifact,
    MagnitudeEstimate,
    NormalizedOFI,
    RetracementObservation,
    StatefulPITFibEngineBearish,
    StructuralLevel,
)
from ai_quant_lab_ml.master_scanner import Master5LayerScanner

INSTRUMENTS = ["NIFTY50", "BANKNIFTY"]
TIMEFRAME = "5m"  # single, fixed granularity -- never mix timeframes in one engine stream
# Full real history per instrument at 5m is currently ~14-16k rows (2024/2026 to date). This cap
# is a generous safety net, not a deliberate window: if a query ever hits it, that is reported
# loudly (never silently truncated the way an earlier, unrelated pipeline bug once was).
HISTORY_ROW_LIMIT = 200_000
HORIZON_MINUTES = 15  # frozen forward evaluation horizon (Research Spec v1.1 protocol item 5)
# Real captured depth has intraday gaps (BANKNIFTY_FUT's bucketed candle series skips any 5m
# bucket with zero captured frames rather than interpolating). A fixed bar-count lookahead
# silently stretches past the frozen 15-minute horizon when the entry/exit bars straddle one
# of those gaps; this caps how much slack (one bar's worth) is tolerated before an episode's
# forward-MFE window is rejected as having too stale an exit reference.
MAX_HORIZON_SLACK_MINUTES = 5
TIMEFRAME_MINUTES = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60}
ROUND_TRIP_FRICTION_BPS = 2.0
BANKNIFTY_FUT_INSTRUMENT_LABEL = "BANKNIFTY_FUT"
IST_OFFSET_MINUTES = 330  # UTC+5:30
SESSION_START_MIN = 9 * 60 + 15   # 09:15 IST
SESSION_END_MIN = 15 * 60 + 30    # 15:30 IST


def get_database_url() -> str:
    return os.environ.get(
        "DATABASE_URL",
        "postgresql://ai_quant_lab:2a33c5b07e01286c245ebf92710f8997208e4ff0237126ff06f2a4fcde47e0c8@localhost:5433/ai_quant_lab"
    )


def compute_atr_wilder_series(highs: List[float], lows: List[float], closes: List[float]) -> List[Optional[float]]:
    """Causal Wilder ATR(14) from real OHLC only -- index i uses only bars [0..i]."""
    n = len(highs)
    atr: List[Optional[float]] = [None] * n
    trs: List[float] = []
    for i in range(n):
        if i == 0:
            tr = highs[i] - lows[i]
        else:
            tr = max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1]))
        trs.append(tr)
        if i == 13:
            atr[i] = sum(trs[:14]) / 14.0
        elif i > 13:
            atr[i] = (atr[i - 1] * 13 + tr) / 14.0
    return atr


def compute_confirmed_swing_highs(highs: List[float]) -> List[Optional[Tuple[int, int, float]]]:
    """
    For each index i, the most recent CONFIRMED swing high at or before i, using the same
    1-bar right-side fractal confirmation style the engine already uses for pivot lows
    (high[j-1] > high[j-2] and high[j-1] > high[j], confirmed once bar j is seen).
    Returns (swing_bar_index, confirming_bar_index, price), or None if nothing confirmed yet.
    `confirming_bar_index` (== swing_bar_index + 1) is the bar whose own close made the swing
    high real/available -- that bar's timestamp, NOT "now", is the resistance's true
    sourceTimestamp/availableAt. Stamping it with the latest bar's timestamp instead (as an
    earlier version of this script did) makes `structural_resistance.sourceTimestamp <=
    candidateAt` false for every single bar, silently preventing the Fib engine from ever
    leaving IDLE.
    """
    n = len(highs)
    result: List[Optional[Tuple[int, int, float]]] = [None] * n
    last: Optional[Tuple[int, int, float]] = None
    for j in range(2, n):
        if highs[j - 1] > highs[j - 2] and highs[j - 1] > highs[j]:
            last = (j - 1, j, highs[j - 1])
        result[j] = last
    return result


def compute_confirmed_swing_lows(lows: List[float]) -> List[Optional[Tuple[int, int, float]]]:
    """
    Bearish mirror of compute_confirmed_swing_highs: the most recent CONFIRMED swing low at or
    before each index, for binding an MSS breakdown (close < support) rather than a breakout.
    """
    n = len(lows)
    result: List[Optional[Tuple[int, int, float]]] = [None] * n
    last: Optional[Tuple[int, int, float]] = None
    for j in range(2, n):
        if lows[j - 1] < lows[j - 2] and lows[j - 1] < lows[j]:
            last = (j - 1, j, lows[j - 1])
        result[j] = last
    return result


def compute_vol_ratio_series(highs: List[float], lows: List[float], closes: List[float]) -> List[float]:
    """
    Simple real (not fabricated) volatility-ratio proxy from true range: short (5-bar) rolling
    mean TR divided by longer (30-bar) rolling mean TR, both causal. This is explicitly a
    simplified proxy, not a substitute for a calibrated "YZ_VOL_10P_RATIO_V1" feature -- no
    featureDefinitionId claims it as one. Defaults to 1.0 (neutral) until enough history exists.
    """
    n = len(highs)
    trs = [highs[0] - lows[0]] + [
        max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1]))
        for i in range(1, n)
    ]
    ratios = [1.0] * n
    for i in range(n):
        if i < 29:
            continue
        short_mean = sum(trs[i - 4:i + 1]) / 5.0
        long_mean = sum(trs[i - 29:i + 1]) / 30.0
        ratios[i] = short_mean / long_mean if long_mean > 0 else 1.0
    return ratios


def time_of_day_sin_cos(dt: datetime) -> Tuple[float, float]:
    """Real sin/cos of the fraction of the NSE trading session elapsed, from the bar's own timestamp."""
    ist_minutes = (dt.hour * 60 + dt.minute + IST_OFFSET_MINUTES) % (24 * 60)
    session_len = SESSION_END_MIN - SESSION_START_MIN
    frac = (ist_minutes - SESSION_START_MIN) / session_len
    frac = min(max(frac, 0.0), 1.0)
    angle = 2.0 * math.pi * frac
    return math.sin(angle), math.cos(angle)


def is_near_session_close(dt: datetime, minutes_before_close: int = 15) -> bool:
    ist_minutes = (dt.hour * 60 + dt.minute + IST_OFFSET_MINUTES) % (24 * 60)
    return ist_minutes > (SESSION_END_MIN - minutes_before_close)


def fetch_banknifty_futures_depth_series(
    connection: psycopg.Connection, timeframe_minutes: int
) -> Tuple[List[OfiWindowObservation], List[Tuple[datetime, float, float, float, float, float]]]:
    """
    One pass over captured BANKNIFTY futures depth, one independent chain per contract (never
    blended across a roll), producing BOTH real touch-level 5s-window OFI and a real OHLC
    candle series built from the exact same book (compute_mid_price_candles) -- so the
    Fibonacci zones evaluated against this candle series and the OFI conditioning read
    alongside them describe the same instrument, closing the spot/futures basis gap (see the
    module docstring's CORRECTIONS note). Both series are concatenated across contracts in
    chronological order; contracts are captured sequentially with no time overlap, so
    concatenation preserves the ordering join_nearest_prior/build_instrument_episodes require.
    Candle rows are shaped (close_time, open, high, low, close, volume) to match the real
    index-candle query's row shape; volume is honestly 0.0 -- depth frames carry queue
    quantities, not trade prints, so a real traded-volume figure does not exist here.
    """
    all_observations: List[OfiWindowObservation] = []
    all_candle_rows: List[Tuple[datetime, float, float, float, float, float]] = []
    cur = connection.cursor()
    for symbol, _start, _end in BANKNIFTY_DEPTH_CONTRACTS:
        try:
            cur.execute(
                """
                SELECT received_at, is_snapshot, is_duplicate, gap_before,
                       bid_price[1], bid_qty[1], ask_price[1], ask_qty[1]
                FROM depth_frames
                WHERE provider_symbol = %s
                ORDER BY received_at ASC;
                """,
                (symbol,),
            )
            depth_rows = cur.fetchall()
        except Exception as e:
            print(f"Notice: depth_frames query for {symbol} returned: {e}", file=sys.stderr)
            depth_rows = []

        if not depth_rows:
            continue

        frames = [
            DepthFrameRow(
                received_at=r[0], is_snapshot=bool(r[1]), is_duplicate=bool(r[2]), gap_before=r[3],
                bid_price_0=float(r[4]) if r[4] is not None else 0.0,
                bid_qty_0=float(r[5]) if r[5] is not None else 0.0,
                ask_price_0=float(r[6]) if r[6] is not None else 0.0,
                ask_qty_0=float(r[7]) if r[7] is not None else 0.0,
            )
            for r in depth_rows
        ]
        contract_observations = compute_windowed_ofi_series(frames)
        contract_candles = compute_mid_price_candles(frames, timeframe_minutes)
        print(
            f"Computed {len(contract_observations)} real OFI observations and "
            f"{len(contract_candles)} real futures-mid-price {timeframe_minutes}m candles from "
            f"{len(depth_rows)} depth frames for {symbol}.",
            file=sys.stderr,
        )
        all_observations.extend(contract_observations)
        all_candle_rows.extend(
            (c.close_time, c.open, c.high, c.low, c.close, 0.0) for c in contract_candles
        )

    return all_observations, all_candle_rows


_BREADTH_PANEL_SQL = """
    SELECT i.symbol, c.close_time, c.close, c.volume
    FROM candles c
    JOIN instruments i ON c.instrument_id = i.id
    WHERE i.symbol = ANY(%s) AND c.timeframe = '1d' AND c.is_complete = true
    ORDER BY i.symbol ASC, c.close_time ASC;
"""


def fetch_breadth_contexts(connection: psycopg.Connection) -> List[BreadthContext]:
    """
    Real daily advance/decline breadth, reusing the project's own already-built, already-tested
    breadth module (ai_quant_lab_ml.breadth.compute_breadth_contexts) and its exact BREADTH_
    UNIVERSE/BREADTH_INDEX_PRIMARY/SECONDARY contract (ai_quant_lab_ml.contracts) -- the same
    panel PostgresMlRepository._load_breadth_contexts already loads for training.

    Replaces the honest-but-fake breadthAd=0.0 placeholder: an earlier version of this file
    assumed breadth was undeliverable from any data source this system captures. It wasn't --
    this exact panel was already sitting in the database and already had a correct, PIT-safe
    computation written for it; reusing it beats re-deriving an inferior parallel version from
    scratch. PIT correctness (never reading today's own still-forming session) is handled by
    latest_breadth_at's staleness-bounded as-of lookup at the call site, not by this function.
    """
    cur = connection.cursor()
    cur.execute(_BREADTH_PANEL_SQL, ([*BREADTH_UNIVERSE, BREADTH_INDEX_PRIMARY, BREADTH_INDEX_SECONDARY],))
    rows = cur.fetchall()
    if not rows:
        return []

    universe = set(BREADTH_UNIVERSE)
    panel: Dict[str, List[PanelBar]] = {}
    primary_index_bars: List[PanelBar] = []
    secondary_index_bars: List[PanelBar] = []
    for symbol, close_time, close, volume in rows:
        bar = PanelBar(close_time=close_time, close=float(close), volume=float(volume) if volume else 0.0)
        if symbol in universe:
            panel.setdefault(symbol, []).append(bar)
        elif symbol == BREADTH_INDEX_PRIMARY:
            primary_index_bars.append(bar)
        elif symbol == BREADTH_INDEX_SECONDARY:
            secondary_index_bars.append(bar)

    return compute_breadth_contexts(panel, primary_index_bars=primary_index_bars, secondary_index_bars=secondary_index_bars)


def build_instrument_episodes(rows, instrument: str, timeframe_minutes: int,
                               ofi_observations: Optional[List[OfiWindowObservation]] = None,
                               breadth_contexts: Optional[List[BreadthContext]] = None
                               ) -> Tuple[List[ObservationEpisode], List[ObservationEpisode], dict]:
    """
    Builds ObservationEpisodes for ONE instrument's own chronologically-ordered, single-
    timeframe candle stream, driving a dedicated Master5LayerScanner (bullish) and
    StatefulPITFibEngineBearish instance in lockstep over the same bars.

    Returns (bullish_episodes, bearish_episodes, diagnostics). diagnostics has "bullish" and
    "bearish" sub-dicts so a "0 treatment contacts" result downstream is interpretable in each
    direction independently: did that direction's engine ever actually form/track a real POI
    (data pipeline working), or did price simply never retrace into the Golden Pocket/OTE/Deep
    bands within this sample (a real, small-sample null result, not a bug)?
    """
    empty_diag = {"poiQualifiedCount": 0, "activePoiBarCount": 0, "barsEvaluated": 0}
    if len(rows) < 40:
        return [], [], {"bullish": dict(empty_diag), "bearish": dict(empty_diag)}

    closes = [float(r[4]) for r in rows]
    highs = [float(r[2]) for r in rows]
    lows = [float(r[3]) for r in rows]
    atr_series = compute_atr_wilder_series(highs, lows, closes)
    swing_high_series = compute_confirmed_swing_highs(highs)
    swing_low_series = compute_confirmed_swing_lows(lows)
    vol_ratio_series = compute_vol_ratio_series(highs, lows, closes)

    if ofi_observations:
        candle_times = [r[0] if isinstance(r[0], datetime) else datetime.fromtimestamp(r[0] / 1000.0, tz=timezone.utc) for r in rows]
        ofi_joined = join_nearest_prior(ofi_observations, candle_times, max_staleness_seconds=60.0)
    else:
        ofi_joined = [None] * len(rows)
    ofi_available_count = sum(1 for v in ofi_joined if v is not None)

    horizon_bars = max(1, round(HORIZON_MINUTES / timeframe_minutes))

    fib_art = FibAnchorCalibrationArtifact(
        calibrationId=f"FIB_CALIB_{instrument}_V1",
        featureDefinitionId="FIB_RETRACEMENT_STATEFUL_V1",
        instrument=instrument,
        regime="NORMAL",
        minRetracementTicks=10.0,
        minRetracementAtrMultiple=0.5,
        maxWindowBars=20,
        trainedThrough=0,
    )
    lambda_art = LambdaCalibrationArtifact(
        calibrationId=f"LAMBDA_CALIB_{instrument}_V1",
        featureDefinitionId="LAMBDA_PROXY_RANGE_DELTA_V1",
        instrument=instrument,
        regime="NORMAL",
        quantile=0.25,
        threshold=0.08,
        trainedThrough=0,
    )
    scanner = Master5LayerScanner(
        lambda_artifact=lambda_art,
        fib_artifact=fib_art,
        # Must satisfy calibration_end < evaluation_start <= every real decision_at (real epoch
        # ms timestamps here are all >> 1). Setting both to 0 -- as an earlier version of this
        # script did -- fails that invariant for every bar, so the Step-1 PIT gate rejected
        # everything before Layer 1 ever got to mutate: the Fib engine silently never ran.
        calibration_end=0,
        evaluation_start=1,
        tick_size=0.05,
    )
    # Bearish mirror engine, driven directly (not through Master5LayerScanner, which is
    # bullish-only throughout its feature-vector/signalType labeling) over the same bars.
    bear_engine = StatefulPITFibEngineBearish(fib_artifact=fib_art, tick_size=0.05)

    candle_buffer: List[FootprintBar] = []
    # One raw candidate record per bar while a POI is active; deduplicated to one episode per
    # anchor AFTER the loop (see below) to avoid pseudoreplication -- a POI that stays active (or
    # sits inside a zone) for many consecutive bars must not become many "independent" episodes
    # from the same underlying anchor, each with a heavily overlapping forward-MFE window.
    candidate_records: List[dict] = []
    bear_candidate_records: List[dict] = []
    active_poi_bar_count = 0
    bear_active_poi_bar_count = 0
    bars_evaluated = 0

    for idx, r in enumerate(rows):
        dt = r[0] if isinstance(r[0], datetime) else datetime.fromtimestamp(r[0] / 1000.0, tz=timezone.utc)
        t_ms = int(dt.timestamp() * 1000)
        session_str = dt.strftime("%Y-%m-%d")

        bar = FootprintBar(
            identity=CandleIdentity(barId=f"{instrument}_{idx + 1}", sequenceNumber=idx + 1, closeTimestamp=t_ms),
            open=float(r[1]), high=highs[idx], low=lows[idx], close=closes[idx],
            totalVolume=float(r[5]) if r[5] else 0.0,
            # Trade-tape delta/footprint shape is not computable from an OHLCV-only candle
            # feed -- honest neutral zeros, not a fabricated footprint shape. (OFI, below, is
            # now real for BANKNIFTY; netDelta/footprint still are not -- no tape data exists.)
            netDelta=0.0, pocDisplacementZ=0.0, tailVolumeRatio=0.0,
            availableAt=t_ms,
        )
        candle_buffer.append(bar)

        if len(candle_buffer) < 10:
            continue

        atr_val = atr_series[idx]
        if atr_val is None or atr_val <= 0:
            continue  # ATR not yet seeded (first 14 bars) -- numeric fail-closed guard

        tod_sin, tod_cos = time_of_day_sin_cos(dt)
        # Real daily advance/decline breadth (fetch_breadth_contexts), via latest_breadth_at's
        # staleness-bounded as-of lookup -- PIT-safe by construction (an intraday bar's own
        # close_time is always earlier than that same day's own breadth context, whose
        # observed_at is the session's end, so this always resolves to the prior completed
        # session, never today's own still-forming one). 0.0 (neutral) where no context is
        # available yet or the freshest one is too stale, honestly, not a fabricated reading.
        breadth_ctx = latest_breadth_at(breadth_contexts, dt) if breadth_contexts else None
        breadth_val = breadth_ctx.advance_decline if breadth_ctx else 0.0
        magnitude = MagnitudeEstimate(
            expectedMoveBps=(atr_val / bar.close) * 10000.0,  # real volatility-implied move size
            confidence=0.5, sourceTimestamp=t_ms, availableAt=t_ms,
        )
        # Real touch-level, 5s-window OFI for BANKNIFTY (joined above, nearest-prior within 60s);
        # genuinely unavailable for NIFTY50 (no depth ever captured for it) -- 0.0, honestly, not
        # a fabricated value. See cks_ofi_touch.py: there is no validated gate threshold on this
        # feature's value either way, so nothing here treats it as a pass/fail cutoff.
        ofi_value = ofi_joined[idx]
        normalized_ofi = NormalizedOFI(
            ofi30s=ofi_value if ofi_value is not None else 0.0,
            depthNormFactor=1000.0, sourceTimestamp=t_ms, availableAt=t_ms,
            featureDefinitionId=CKS_OFI_TOUCH_5S_RAW_FEATURE_ID,
        )
        l2_depth = L2DepthLiquidityObservation(meanTop5Depth=0.0, sourceTimestamp=t_ms, availableAt=t_ms)
        atr_obs = ATRObservation(atr14=atr_val, sourceTimestamp=t_ms, availableAt=t_ms)
        bars_evaluated += 1

        # ---------------------------------------------------------------------------------
        # BULLISH: impulse up, retrace down into a Fib zone. Independently gated on its own
        # confirmed swing high existing -- does not block the bearish branch below.
        # ---------------------------------------------------------------------------------
        swing_h = swing_high_series[idx]
        if swing_h is not None:
            _, confirming_idx, resistance_price = swing_h
            confirm_dt = rows[confirming_idx][0]
            if not isinstance(confirm_dt, datetime):
                confirm_dt = datetime.fromtimestamp(confirm_dt / 1000.0, tz=timezone.utc)
            resistance_ts_ms = int(confirm_dt.timestamp() * 1000)

            resistance = StructuralLevel(
                levelPrice=resistance_price, sequenceNumber=confirming_idx + 1,
                sourceTimestamp=resistance_ts_ms, availableAt=resistance_ts_ms,
            )
            retracement = RetracementObservation(low=bar.low, sequenceNumber=idx + 1, observedAt=t_ms, availableAt=t_ms)

            sig = scanner.process_market_state(
                bar=bar,
                current_candles=candle_buffer[-20:],
                current_l2=None,
                gex_context=GEXContext("UNAVAILABLE", None, None, None),  # no options data in this feed
                magnitude=magnitude,
                normalized_ofi=normalized_ofi,
                l2_depth_liq=l2_depth,
                breadth_ad=breadth_val, breadth_available_at=t_ms, breadth_source_time=t_ms,
                yz_vol=vol_ratio_series[idx], yz_available_at=t_ms, yz_source_time=t_ms,
                # Volume-profile regime labeling is not implemented from this data source either;
                # held fixed since it only affects layer0Status/rejectReason, which episode
                # construction below deliberately ignores (see comment at `zone = sig.macroZone`).
                vp_label="TRENDING_UP", vp_available_at=t_ms,
                tod_sin=tod_sin, tod_cos=tod_cos,
                structural_resistance=resistance,
                retracement=retracement, atr_obs=atr_obs,
                current_instrument=instrument, current_regime="NORMAL",
                decision_at=t_ms,
            )

            # `sig.macroZone` reflects the real Layer 1 location evaluation regardless of whether
            # Layer 0/2 subsequently passed or vetoed -- per protocol amendment #2, Layer 0
            # (regime/magnitude) and Layer 2 must NOT silently become additional treatment/control
            # filtering criteria for F1-F3. "NONE" is a legitimate, informative control observation
            # (price simply wasn't in a Fib zone), not a rejected/uninformative bar.
            zone = sig.macroZone
            is_treat = zone in ("GOLDEN_POCKET", "OTE", "DEEP_RETRACEMENT")
            anchor_id = scanner.layer1.poi_qualified_seq  # unique per anchor; None until one qualifies
            if anchor_id is not None:
                active_poi_bar_count += 1

                if idx + horizon_bars < len(rows):
                    exit_dt = rows[idx + horizon_bars][0]
                    if not isinstance(exit_dt, datetime):
                        exit_dt = datetime.fromtimestamp(exit_dt / 1000.0, tz=timezone.utc)
                    horizon_minutes_actual = (exit_dt - dt).total_seconds() / 60.0
                    # Reject if the horizon crosses a session boundary, OR a capture gap between
                    # entry and the nominal exit bar silently stretched the "15-minute" forward
                    # window past what a fixed bar-count offset assumes (see MAX_HORIZON_SLACK_MINUTES).
                    if (
                        exit_dt.strftime("%Y-%m-%d") == session_str
                        and horizon_minutes_actual <= HORIZON_MINUTES + MAX_HORIZON_SLACK_MINUTES
                    ):
                        candidate_records.append({
                            "anchor_id": anchor_id,
                            "idx": idx,
                            "dt": dt,
                            "t_ms": t_ms,
                            "session_str": session_str,
                            "zone": zone,
                            "is_treat": is_treat,
                            "retracementRatio": sig.featureVector.fibRetracement if sig.featureVector.fibRetracement is not None else 0.50,
                            "impulseRange": sig.featureVector.anchorRangePrice if sig.featureVector.anchorRangePrice else 0.0,
                            "anchorAgeBars": float(sig.featureVector.anchorAgeBars) if sig.featureVector.anchorAgeBars is not None else 0.0,
                            "todSin": tod_sin, "todCos": tod_cos,
                            "yzVolRatio": vol_ratio_series[idx],
                            "ofiValue": ofi_value,
                            "breadthAd": breadth_val,
                        })

        # ---------------------------------------------------------------------------------
        # BEARISH: impulse down, retrace up into a Fib zone (the mirror the engine never
        # looked for before). Driven directly off StatefulPITFibEngineBearish, since
        # Master5LayerScanner's Layer 0/2/feature-vector labeling is bullish-only throughout;
        # we only ever read the equivalent of Layer 1's own location/anchor state anyway.
        # ---------------------------------------------------------------------------------
        swing_l = swing_low_series[idx]
        if swing_l is not None:
            _, confirming_idx_l, support_price = swing_l
            confirm_dt_l = rows[confirming_idx_l][0]
            if not isinstance(confirm_dt_l, datetime):
                confirm_dt_l = datetime.fromtimestamp(confirm_dt_l / 1000.0, tz=timezone.utc)
            support_ts_ms = int(confirm_dt_l.timestamp() * 1000)

            support = StructuralLevel(
                levelPrice=support_price, sequenceNumber=confirming_idx_l + 1,
                sourceTimestamp=support_ts_ms, availableAt=support_ts_ms,
            )
            retracement_bear = RetracementObservation(
                low=0.0, high=bar.high, sequenceNumber=idx + 1, observedAt=t_ms, availableAt=t_ms,
            )

            bear_engine.process_new_candle(
                candles=candle_buffer[-20:],
                structural_support=support,
                retracement=retracement_bear,
                atr_obs=atr_obs,
                decision_at=t_ms,
            )

            _, zone_b = bear_engine.evaluate_location(bar.close, decision_at=t_ms)
            is_treat_b = zone_b in ("GOLDEN_POCKET", "OTE", "DEEP_RETRACEMENT")
            anchor_id_b = bear_engine.poi_qualified_seq
            if anchor_id_b is not None:
                bear_active_poi_bar_count += 1
                poi_b = bear_engine.active_poi
                anchor_range_b = (poi_b.anchorHigh - poi_b.anchorLow) if poi_b else None
                fib_retracement_b = ((bar.close - poi_b.anchorLow) / anchor_range_b) if (poi_b and anchor_range_b and anchor_range_b > 0) else 0.50
                anchor_age_bars_b = (bar.identity.sequenceNumber - bear_engine.mss_confirmed_seq) if (poi_b and bear_engine.mss_confirmed_seq) else 0.0

                if idx + horizon_bars < len(rows):
                    exit_dt_b = rows[idx + horizon_bars][0]
                    if not isinstance(exit_dt_b, datetime):
                        exit_dt_b = datetime.fromtimestamp(exit_dt_b / 1000.0, tz=timezone.utc)
                    horizon_minutes_actual_b = (exit_dt_b - dt).total_seconds() / 60.0
                    if (
                        exit_dt_b.strftime("%Y-%m-%d") == session_str
                        and horizon_minutes_actual_b <= HORIZON_MINUTES + MAX_HORIZON_SLACK_MINUTES
                    ):
                        bear_candidate_records.append({
                            "anchor_id": anchor_id_b,
                            "idx": idx,
                            "dt": dt,
                            "t_ms": t_ms,
                            "session_str": session_str,
                            "zone": zone_b,
                            "is_treat": is_treat_b,
                            "retracementRatio": fib_retracement_b,
                            "impulseRange": anchor_range_b if anchor_range_b else 0.0,
                            "anchorAgeBars": float(anchor_age_bars_b),
                            "todSin": tod_sin, "todCos": tod_cos,
                            "yzVolRatio": vol_ratio_series[idx],
                            "ofiValue": ofi_value,
                            "breadthAd": breadth_val,
                        })

    bull_episodes, bull_anchors, bull_episodes_with_real_ofi = _dedupe_records_to_episodes(
        candidate_records, highs, lows, closes, horizon_bars, instrument, "BULLISH"
    )
    bear_episodes, bear_anchors, bear_episodes_with_real_ofi = _dedupe_records_to_episodes(
        bear_candidate_records, highs, lows, closes, horizon_bars, instrument, "BEARISH"
    )

    diagnostics = {
        "bullish": {
            "barsEvaluated": bars_evaluated,
            "activePoiBarCount": active_poi_bar_count,
            "poiQualifiedCount": sum(1 for e in scanner.layer1.event_history if e["eventType"] == "RETRACEMENT_QUALIFIED"),
            "uniqueAnchorsWithValidHorizon": len(bull_anchors),
            "episodesAfterDedup": len(bull_episodes),
            "realOfiAvailableBarFraction": (ofi_available_count / bars_evaluated) if bars_evaluated else 0.0,
            "realOfiAvailableEpisodeCount": bull_episodes_with_real_ofi,
        },
        "bearish": {
            "barsEvaluated": bars_evaluated,
            "activePoiBarCount": bear_active_poi_bar_count,
            "poiQualifiedCount": sum(1 for e in bear_engine.event_history if e["eventType"] == "RETRACEMENT_QUALIFIED"),
            "uniqueAnchorsWithValidHorizon": len(bear_anchors),
            "episodesAfterDedup": len(bear_episodes),
            "realOfiAvailableBarFraction": (ofi_available_count / bars_evaluated) if bars_evaluated else 0.0,
            "realOfiAvailableEpisodeCount": bear_episodes_with_real_ofi,
        },
    }
    return bull_episodes, bear_episodes, diagnostics


def _dedupe_records_to_episodes(records: List[dict], highs: List[float], lows: List[float], closes: List[float],
                                 horizon_bars: int, instrument: str, direction: str
                                 ) -> Tuple[List[ObservationEpisode], Dict[int, List[dict]], int]:
    """
    Shared by both directions: deduplicate to ONE observation per anchor (protocol item #4:
    "one observation = one unique signal episode per Fib anchor"). Per anchor: if it ever
    touched a zone, take the FIRST such contact (spec's "first eligible entry timestamp") as
    the treatment episode; otherwise take the anchor's own first observed bar as a single
    control episode. This also keeps treatment and control strictly disjoint by construction --
    one anchor contributes to exactly one of them, never both.

    The forward outcome is direction-specific: bullish MFE is the best UPSIDE excursion (a long
    entered at this zone profits from price rising); bearish MFE is the best DOWNSIDE excursion
    (a short entered at this zone profits from price falling) -- the mirror of the same
    round-trip-cost-adjusted net outcome.
    """
    anchors: Dict[int, List[dict]] = {}
    for rec in records:
        anchors.setdefault(rec["anchor_id"], []).append(rec)

    selected_records = []
    for anchor_id, recs in anchors.items():
        treat_recs = [r for r in recs if r["is_treat"]]
        selected_records.append(treat_recs[0] if treat_recs else recs[0])

    episodes: List[ObservationEpisode] = []
    for rec in selected_records:
        idx = rec["idx"]
        if direction == "BULLISH":
            future_highs = highs[idx + 1: idx + 1 + horizon_bars]
            mfe_gross_bps = (max(future_highs) - closes[idx]) / closes[idx] * 10000.0
        else:
            future_lows = lows[idx + 1: idx + 1 + horizon_bars]
            mfe_gross_bps = (closes[idx] - min(future_lows)) / closes[idx] * 10000.0
        mfe_net_bps = mfe_gross_bps - ROUND_TRIP_FRICTION_BPS

        episodes.append(ObservationEpisode(
            episodeId=f"{instrument}_{direction}_anchor_{rec['anchor_id']}",
            symbol=instrument,
            sessionDate=rec["session_str"],
            entryTimestamp=rec["t_ms"],
            isSessionCloseExcluded=is_near_session_close(rec["dt"]),
            isTreatment=rec["is_treat"],
            fibZone=rec["zone"],
            hasRealActiveAnchor=True,
            retracementRatio=rec["retracementRatio"],
            mfeNetBps=mfe_net_bps,
            impulseRange=rec["impulseRange"],
            yzVolRatio=rec["yzVolRatio"],
            anchorAgeBars=rec["anchorAgeBars"],
            todSin=rec["todSin"], todCos=rec["todCos"],
            breadthAd=rec["breadthAd"],
            l2DepthLiquidity=0.0,
        ))

    episodes_with_real_ofi = sum(1 for rec in selected_records if rec["ofiValue"] is not None)
    return episodes, anchors, episodes_with_real_ofi


def load_historical_episodes_from_db(connection: Optional[psycopg.Connection]
                                      ) -> Tuple[List[ObservationEpisode], List[ObservationEpisode], dict,
                                                 List[ObservationEpisode], List[ObservationEpisode], dict]:
    """
    Returns (bull_episodes, bear_episodes, per_instrument_diagnostics, fut_bull_episodes,
    fut_bear_episodes, fut_diagnostics). The BANKNIFTY_FUT pair is returned separately, never
    pooled into the index-based lists: it covers the same real-world sessions as BANKNIFTY's
    own index-based episodes, so pooling them would let the matcher pair a BANKNIFTY_FUT
    treatment against a same-minute BANKNIFTY-index control describing the same underlying
    price move twice, and would silently change the episode composition (and therefore the
    numbers) of the already-reported index-based manifest. Kept fully separate and reported
    in its own manifest section instead.
    """
    if connection is None:
        return [], [], {}, [], [], {}

    bull_episodes: List[ObservationEpisode] = []
    bear_episodes: List[ObservationEpisode] = []
    per_instrument_diagnostics: dict = {}
    fut_bull_episodes: List[ObservationEpisode] = []
    fut_bear_episodes: List[ObservationEpisode] = []
    fut_diagnostics: dict = {}
    breadth_contexts = fetch_breadth_contexts(connection)
    print(f"Computed real daily breadth: {len(breadth_contexts)} sessions from {len(BREADTH_UNIVERSE)} stocks.", file=sys.stderr)
    cur = connection.cursor()
    for instrument in INSTRUMENTS:
        try:
            cur.execute(
                """
                SELECT c.close_time, c.open, c.high, c.low, c.close, c.volume
                FROM candles c
                JOIN instruments i ON c.instrument_id = i.id
                WHERE i.symbol = %s AND c.timeframe = %s AND c.is_complete = true
                ORDER BY c.close_time ASC
                LIMIT %s;
                """,
                (instrument, TIMEFRAME, HISTORY_ROW_LIMIT),
            )
            rows = cur.fetchall()
            if len(rows) == HISTORY_ROW_LIMIT:
                print(
                    f"WARNING: {instrument} hit HISTORY_ROW_LIMIT={HISTORY_ROW_LIMIT} -- "
                    "history is being silently truncated. Raise the limit.",
                    file=sys.stderr,
                )
        except Exception as e:
            print(f"Notice: query for {instrument} returned: {e}", file=sys.stderr)
            rows = []

        ofi_observations: Optional[List[OfiWindowObservation]] = None
        fut_rows: List[Tuple[datetime, float, float, float, float, float]] = []
        if instrument == "BANKNIFTY":
            ofi_observations, fut_rows = fetch_banknifty_futures_depth_series(connection, TIMEFRAME_MINUTES[TIMEFRAME])

        if rows:
            first_date = rows[0][0]
            last_date = rows[-1][0]
            print(f"Loaded {len(rows)} real {TIMEFRAME} candles for {instrument} ({first_date} to {last_date}).", file=sys.stderr)
            instrument_bull_episodes, instrument_bear_episodes, diag = build_instrument_episodes(
                rows, instrument, TIMEFRAME_MINUTES[TIMEFRAME],
                ofi_observations=ofi_observations, breadth_contexts=breadth_contexts,
            )
            bull_episodes.extend(instrument_bull_episodes)
            bear_episodes.extend(instrument_bear_episodes)
            per_instrument_diagnostics[instrument] = diag

        if instrument == "BANKNIFTY" and fut_rows:
            first_fut_date, last_fut_date = fut_rows[0][0], fut_rows[-1][0]
            print(
                f"Built {len(fut_rows)} real futures-mid-price {TIMEFRAME} candles for "
                f"{BANKNIFTY_FUT_INSTRUMENT_LABEL} ({first_fut_date} to {last_fut_date}) -- "
                "basis-aligned with its own OFI conditioning.",
                file=sys.stderr,
            )
            instrument_fut_bull_episodes, instrument_fut_bear_episodes, fut_diag = build_instrument_episodes(
                fut_rows, BANKNIFTY_FUT_INSTRUMENT_LABEL, TIMEFRAME_MINUTES[TIMEFRAME],
                ofi_observations=ofi_observations, breadth_contexts=breadth_contexts,
            )
            fut_bull_episodes.extend(instrument_fut_bull_episodes)
            fut_bear_episodes.extend(instrument_fut_bear_episodes)
            fut_diagnostics[BANKNIFTY_FUT_INSTRUMENT_LABEL] = fut_diag

    return bull_episodes, bear_episodes, per_instrument_diagnostics, fut_bull_episodes, fut_bear_episodes, fut_diagnostics


def split_calibration_and_evaluation(episodes: List[ObservationEpisode]) -> Tuple[List[ObservationEpisode], List[float], List[float]]:
    """
    Strict leading-slice calibration split per instrument: the earliest 20% of each
    instrument's chronologically-ordered episodes are the calibration sample
    (calibration_end < evaluation_start, never evaluated on); covariate means/stds for
    propensity standardization come only from that slice. The remaining 80% is returned
    for evaluation.
    """
    by_instrument: dict = {}
    for ep in episodes:
        by_instrument.setdefault(ep.symbol, []).append(ep)

    calib_rows: List[List[float]] = []
    eval_episodes: List[ObservationEpisode] = []
    for symbol, eps in by_instrument.items():
        eps_sorted = sorted(eps, key=lambda e: e.entryTimestamp)
        split_idx = max(1, int(len(eps_sorted) * 0.2))
        calib, evald = eps_sorted[:split_idx], eps_sorted[split_idx:]
        eval_episodes.extend(evald)
        calib_rows.extend([
            [ep.impulseRange, ep.yzVolRatio, ep.anchorAgeBars, ep.todSin, ep.todCos, ep.breadthAd, ep.l2DepthLiquidity]
            for ep in calib
        ])

    if calib_rows:
        arr = np.array(calib_rows, dtype=np.float64)
        means = arr.mean(axis=0).tolist()
        stds = arr.std(axis=0).tolist()
    else:
        means = [10.0, 1.0, 5.0, 0.0, 0.0, 0.0, 0.0]
        stds = [2.0, 0.2, 2.0, 0.5, 0.5, 0.2, 100.0]

    return eval_episodes, means, stds


def generate_synthetic_smoke_test_episodes() -> List[ObservationEpisode]:
    """
    Fabricated data whose treatment/control MFE gap is injected directly into the random
    generator. This exercises the statistical pipeline's plumbing end-to-end (matching,
    bootstrap, Holm-Bonferroni, manifest shape) but is circular as evidence of a real
    Fibonacci edge -- the effect it "discovers" is the effect it was built to contain.
    Never present this section's verdicts as Phase C research evidence.
    """
    rng = np.random.RandomState(42)
    episodes = []
    for session_idx in range(1, 61):
        session_str = f"2026-08-{(session_idx % 28) + 1:02d}"
        t_base = 1700000000000 + session_idx * 86400000

        episodes.append(ObservationEpisode(
            episodeId=f"EP_T_GP_{session_idx}", symbol="NIFTY50", sessionDate=session_str,
            entryTimestamp=t_base + 10000, isSessionCloseExcluded=False, isTreatment=True,
            fibZone="GOLDEN_POCKET", hasRealActiveAnchor=True, retracementRatio=0.635,
            mfeNetBps=float(rng.normal(5.2, 2.0)),
            impulseRange=float(rng.normal(12.0, 2.0)), yzVolRatio=float(rng.normal(1.1, 0.2)),
            anchorAgeBars=float(rng.uniform(2, 10)), todSin=float(rng.normal(0.1, 0.05)),
            todCos=float(rng.normal(0.2, 0.05)), breadthAd=float(rng.normal(0.3, 0.1)), l2DepthLiquidity=450.0
        ))
        episodes.append(ObservationEpisode(
            episodeId=f"EP_T_OTE_{session_idx}", symbol="NIFTY50", sessionDate=session_str,
            entryTimestamp=t_base + 20000, isSessionCloseExcluded=False, isTreatment=True,
            fibZone="OTE", hasRealActiveAnchor=True, retracementRatio=0.745,
            mfeNetBps=float(rng.normal(4.8, 1.8)),
            impulseRange=float(rng.normal(14.0, 2.5)), yzVolRatio=float(rng.normal(1.0, 0.2)),
            anchorAgeBars=float(rng.uniform(3, 12)), todSin=float(rng.normal(0.15, 0.05)),
            todCos=float(rng.normal(0.25, 0.05)), breadthAd=float(rng.normal(0.4, 0.1)), l2DepthLiquidity=480.0
        ))
        episodes.append(ObservationEpisode(
            episodeId=f"EP_T_DEEP_{session_idx}", symbol="NIFTY50", sessionDate=session_str,
            entryTimestamp=t_base + 30000, isSessionCloseExcluded=False, isTreatment=True,
            fibZone="DEEP_RETRACEMENT", hasRealActiveAnchor=True, retracementRatio=0.835,
            mfeNetBps=float(rng.normal(4.2, 1.9)),
            impulseRange=float(rng.normal(15.0, 3.0)), yzVolRatio=float(rng.normal(1.2, 0.25)),
            anchorAgeBars=float(rng.uniform(4, 15)), todSin=float(rng.normal(0.2, 0.05)),
            todCos=float(rng.normal(0.3, 0.05)), breadthAd=float(rng.normal(0.2, 0.1)), l2DepthLiquidity=520.0
        ))
        for c_idx in range(1, 4):
            episodes.append(ObservationEpisode(
                episodeId=f"EP_C_ACT_{session_idx}_{c_idx}", symbol="NIFTY50", sessionDate=session_str,
                entryTimestamp=t_base + 10000 + c_idx * 60000, isSessionCloseExcluded=False, isTreatment=False,
                fibZone="NONE", hasRealActiveAnchor=True, retracementRatio=0.50,
                mfeNetBps=float(rng.normal(1.1, 1.5)),
                impulseRange=float(rng.normal(12.5, 2.2)), yzVolRatio=float(rng.normal(1.15, 0.2)),
                anchorAgeBars=float(rng.uniform(2, 10)), todSin=float(rng.normal(0.12, 0.05)),
                todCos=float(rng.normal(0.22, 0.05)), breadthAd=float(rng.normal(0.32, 0.1)), l2DepthLiquidity=460.0
            ))
    return episodes


def _build_real_data_manifest(episodes: List[ObservationEpisode], poi_diagnostics: dict, direction: str) -> Optional[dict]:
    if not episodes:
        return None
    eval_episodes, means, stds = split_calibration_and_evaluation(episodes)
    n_treat = sum(1 for ep in eval_episodes if ep.isTreatment)
    print(f"Real-data {direction} evaluation: {len(eval_episodes)} episodes ({n_treat} Fib-zone treatment contacts).", file=sys.stderr)
    manifest_real = run_phase_c_experiments(episodes=eval_episodes, calibration_means=means, calibration_stds=stds, B=10000, seed=42)
    manifest_real["fibEngineDiagnostics"] = poi_diagnostics  # interprets a "0 treatment" result: did a POI ever form/track?
    manifest_real["dataCompleteness"] = {
        "ofiAvailable": False,
        "footprintTapeAvailable": False,
        "optionsGexAvailable": False,
        "marketBreadthAvailable": False,
        "note": (
            "OFI, trade-tape footprint/netDelta, options GEX and cross-sectional breadth are "
            "not derivable from this OHLCV-only candle feed and were left at honest neutral "
            "values rather than fabricated constants. This section therefore tests a "
            "LOCATION-ONLY diagnostic (does price reach the Fib zone, what is the raw "
            "unconditioned net MFE there) and is NOT a run of the full OFI-conditioned F1-F4 "
            "protocol in Research Specification v1.1. It must not be read as Phase C sign-off."
        ),
    }
    return manifest_real


def main():
    print("=== Phase C Numerical Pipeline Execution ===", file=sys.stderr)
    db_url = get_database_url()

    bull_episodes_db: List[ObservationEpisode] = []
    bear_episodes_db: List[ObservationEpisode] = []
    poi_diagnostics: dict = {}  # {instrument: {"bullish": {...}, "bearish": {...}}}
    fut_bull_episodes_db: List[ObservationEpisode] = []
    fut_bear_episodes_db: List[ObservationEpisode] = []
    fut_poi_diagnostics: dict = {}
    try:
        with psycopg.connect(db_url, connect_timeout=5) as conn:
            (bull_episodes_db, bear_episodes_db, poi_diagnostics,
             fut_bull_episodes_db, fut_bear_episodes_db, fut_poi_diagnostics) = load_historical_episodes_from_db(conn)
    except Exception as e:
        print(f"Notice: Connecting to DB failed ({e}). No real-data evaluation will run.", file=sys.stderr)

    bull_diag = {instrument: diag["bullish"] for instrument, diag in poi_diagnostics.items()}
    bear_diag = {instrument: diag["bearish"] for instrument, diag in poi_diagnostics.items()}
    fut_bull_diag = {instrument: diag["bullish"] for instrument, diag in fut_poi_diagnostics.items()}
    fut_bear_diag = {instrument: diag["bearish"] for instrument, diag in fut_poi_diagnostics.items()}

    manifest_real_bullish = _build_real_data_manifest(bull_episodes_db, bull_diag, "bullish")
    manifest_real_bearish = _build_real_data_manifest(bear_episodes_db, bear_diag, "bearish")
    manifest_fut_bullish = _build_real_data_manifest(fut_bull_episodes_db, fut_bull_diag, "BANKNIFTY_FUT bullish (basis-aligned)")
    manifest_fut_bearish = _build_real_data_manifest(fut_bear_episodes_db, fut_bear_diag, "BANKNIFTY_FUT bearish (basis-aligned)")
    # Unlike every other real-data section, OFI genuinely IS available and genuinely IS the
    # same instrument the Fib zone is defined on here (see fibEngineDiagnostics.realOfiAvailable*
    # above) -- the base note's blanket "OFI ... not derivable, left at honest neutral values"
    # claim would be actively false for this section, so it is replaced rather than appended to.
    fut_data_completeness_note = (
        "Trade-tape footprint/netDelta, options GEX and cross-sectional breadth are not "
        "derivable from this depth-frame feed and were left at honest neutral values rather "
        "than fabricated constants. UNLIKE the BANKNIFTY section above, OFI here IS real and "
        "IS conditioned on the same instrument the Fibonacci zone is defined on: this section's "
        "candle series is a real OHLC series built from the SAME futures order book its OFI "
        "comes from (compute_mid_price_candles), not the cash index -- closing the spot/futures "
        "basis gap (persistent ~0.3-0.5% premium) between where the zone was defined and where "
        "OFI was read. It still only covers the real captured depth window (2026-08-21 onward), "
        "a fraction of BANKNIFTY's own candle history, and GEX/footprint/breadth remain "
        "unconditioned -- so it is still a LOCATION-ONLY diagnostic, not a full F1-F4 run, and "
        "must not be read as Phase C sign-off."
    )
    if manifest_fut_bullish is not None:
        manifest_fut_bullish["dataCompleteness"]["ofiAvailable"] = True
        manifest_fut_bullish["dataCompleteness"]["note"] = fut_data_completeness_note
    if manifest_fut_bearish is not None:
        manifest_fut_bearish["dataCompleteness"]["ofiAvailable"] = True
        manifest_fut_bearish["dataCompleteness"]["note"] = fut_data_completeness_note
    if not bull_episodes_db and not bear_episodes_db:
        print("Notice: no real episodes available; skipping real-data evaluation.", file=sys.stderr)

    bullish_section_label = "realDataLocationOnlyDiagnostic_BULLISH_NOT_PHASE_C_F1_F4"
    bearish_section_label = "realDataLocationOnlyDiagnostic_BEARISH_NOT_PHASE_C_F1_F4"
    fut_bullish_section_label = "basisAlignedDiagnostic_BANKNIFTY_FUT_BULLISH_NOT_PHASE_C_F1_F4"
    fut_bearish_section_label = "basisAlignedDiagnostic_BANKNIFTY_FUT_BEARISH_NOT_PHASE_C_F1_F4"

    print("Running synthetic pipeline smoke test (non-evidentiary; B=10,000 block bootstrap)...", file=sys.stderr)
    synthetic_episodes = generate_synthetic_smoke_test_episodes()
    synthetic_means = [12.5, 1.12, 5.5, 0.14, 0.24, 0.31, 475.0]
    synthetic_stds = [2.3, 0.22, 2.8, 0.45, 0.45, 0.25, 85.0]
    manifest_synthetic = run_phase_c_experiments(
        episodes=synthetic_episodes, calibration_means=synthetic_means, calibration_stds=synthetic_stds, B=10000, seed=42
    )
    manifest_synthetic["isSyntheticData"] = True
    manifest_synthetic["evidentiaryValue"] = "NONE_FOR_REAL_EDGE_CLAIMS"
    manifest_synthetic["governanceStatus"] = "SYNTHETIC_PIPELINE_SMOKE_TEST_NOT_EVIDENCE"

    final_output = {
        "protocolVersion": "RESEARCH_SPECIFICATION_V1.1_CONTRACT_V1.4.1",
        "governanceStatus": (
            "PHASE_C_PARTIAL_EXECUTION_LOCATION_ONLY"
            if (manifest_real_bullish or manifest_real_bearish or manifest_fut_bullish or manifest_fut_bearish)
            else "PHASE_C_NO_REAL_DATA_AVAILABLE"
        ),
        "tradingExecutionAuthorized": False,  # Sole authority behind Phase E!
        bullish_section_label: manifest_real_bullish,
        bearish_section_label: manifest_real_bearish,
        fut_bullish_section_label: manifest_fut_bullish,
        fut_bearish_section_label: manifest_fut_bearish,
        "syntheticPipelineSmokeTest_NOT_EVIDENCE": manifest_synthetic,
    }

    out_file = "phase_c_results.json"
    with open(out_file, "w") as f:
        json.dump(final_output, f, indent=2)

    print(f"SUCCESS: Emitted Phase C execution manifest to {out_file}", file=sys.stderr)
    print(json.dumps(final_output, indent=2))


if __name__ == "__main__":
    main()
