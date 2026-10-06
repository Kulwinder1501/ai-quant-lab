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
 - Features this data source cannot supply at all -- L2-based CKS OFI, trade-tape
   netDelta/footprint shape, options GEX, cross-sectional market breadth -- are left at
   honest neutral/zero values instead of hardcoded constants that trivially always pass
   their gates. Because real OFI is unavailable, this run cannot execute the full
   OFI-conditioned F1-F4 protocol; it is reported as a location-only diagnostic
   (does price even reach the Fib zones, and what is the raw, unconditioned net MFE
   there) and is explicitly NOT a substitute for Phase C sign-off.
 - Calibration means/stds for propensity matching are computed from a strict leading
   slice of each instrument's real episodes (calibration period), with the remainder
   used for evaluation, honoring `calibrationEnd < evaluationStart`.
"""

from __future__ import annotations

import json
import math
import os
import sys
from datetime import datetime, timezone
from typing import List, Optional, Tuple

import numpy as np
import psycopg

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
TIMEFRAME_MINUTES = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60}
ROUND_TRIP_FRICTION_BPS = 2.0
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


def build_instrument_episodes(rows, instrument: str, timeframe_minutes: int) -> Tuple[List[ObservationEpisode], dict]:
    """
    Builds ObservationEpisodes for ONE instrument's own chronologically-ordered, single-
    timeframe candle stream, driving a dedicated Master5LayerScanner / Fib engine instance.

    Also returns a small diagnostics dict so a "0 treatment contacts" result downstream is
    interpretable: did the Fib engine ever actually form/track a real POI (data pipeline
    working), or did price simply never retrace into the Golden Pocket/OTE/Deep bands within
    this sample (a real, small-sample null result, not a bug)?
    """
    if len(rows) < 40:
        return [], {"poiQualifiedCount": 0, "activePoiBarCount": 0, "barsEvaluated": 0}

    closes = [float(r[4]) for r in rows]
    highs = [float(r[2]) for r in rows]
    lows = [float(r[3]) for r in rows]
    atr_series = compute_atr_wilder_series(highs, lows, closes)
    swing_high_series = compute_confirmed_swing_highs(highs)
    vol_ratio_series = compute_vol_ratio_series(highs, lows, closes)

    horizon_bars = max(1, round(HORIZON_MINUTES / timeframe_minutes))

    fib_art = FibAnchorCalibrationArtifact(
        calibrationId=f"FIB_CALIB_{instrument}_V1",
        featureDefinitionId="FIB_RETRACEMENT_STATEFUL_V1",
        instrument=instrument,
        regime="NORMAL",
        minRetracementTicks=10.0,
        minRetracementAtrMultiple=0.5,
        maxWindowBars=20,
        # Empirically grounded (2026-10-06): the max observed lifetime across all 31 naturally
        # (non-stuck) invalidated POIs in NIFTY50+BANKNIFTY 5m history was 1,734 bars. 2,000 covers
        # that with headroom while bounding the two pathological "never invalidated" POIs that had
        # otherwise occupied 92% (NIFTY50) and 68% (BANKNIFTY) of the dataset.
        maxQualifiedLifetimeBars=2000,
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

    candle_buffer: List[FootprintBar] = []
    episodes: List[ObservationEpisode] = []
    active_poi_bar_count = 0
    bars_evaluated = 0

    for idx, r in enumerate(rows):
        dt = r[0] if isinstance(r[0], datetime) else datetime.fromtimestamp(r[0] / 1000.0, tz=timezone.utc)
        t_ms = int(dt.timestamp() * 1000)
        session_str = dt.strftime("%Y-%m-%d")

        bar = FootprintBar(
            identity=CandleIdentity(barId=f"{instrument}_{idx + 1}", sequenceNumber=idx + 1, closeTimestamp=t_ms),
            open=float(r[1]), high=highs[idx], low=lows[idx], close=closes[idx],
            totalVolume=float(r[5]) if r[5] else 0.0,
            # Not computable from an OHLCV-only candle feed -- honest neutral zeros, not a
            # fabricated footprint shape. Layer 2 (Lambda Proxy / footprint shape / CKS OFI)
            # genuinely cannot be evaluated from this data source; see module docstring.
            netDelta=0.0, pocDisplacementZ=0.0, tailVolumeRatio=0.0,
            availableAt=t_ms,
        )
        candle_buffer.append(bar)

        if len(candle_buffer) < 10:
            continue

        atr_val = atr_series[idx]
        if atr_val is None or atr_val <= 0:
            continue  # ATR not yet seeded (first 14 bars) -- numeric fail-closed guard

        swing = swing_high_series[idx]
        if swing is None:
            continue  # no confirmed resistance level exists yet to bind an MSS breakout to
        _, confirming_idx, resistance_price = swing
        confirm_dt = rows[confirming_idx][0]
        if not isinstance(confirm_dt, datetime):
            confirm_dt = datetime.fromtimestamp(confirm_dt / 1000.0, tz=timezone.utc)
        resistance_ts_ms = int(confirm_dt.timestamp() * 1000)

        tod_sin, tod_cos = time_of_day_sin_cos(dt)
        magnitude = MagnitudeEstimate(
            expectedMoveBps=(atr_val / bar.close) * 10000.0,  # real volatility-implied move size
            confidence=0.5, sourceTimestamp=t_ms, availableAt=t_ms,
        )
        # Real OFI is unavailable from an OHLCV-only feed. 0.0 fails the >0.032 baseline gate
        # honestly, rather than a fabricated constant that always passes it.
        normalized_ofi = NormalizedOFI(ofi30s=0.0, depthNormFactor=1000.0, sourceTimestamp=t_ms, availableAt=t_ms)
        l2_depth = L2DepthLiquidityObservation(meanTop5Depth=0.0, sourceTimestamp=t_ms, availableAt=t_ms)
        resistance = StructuralLevel(
            levelPrice=resistance_price, sequenceNumber=confirming_idx + 1,
            sourceTimestamp=resistance_ts_ms, availableAt=resistance_ts_ms,
        )
        atr_obs = ATRObservation(atr14=atr_val, sourceTimestamp=t_ms, availableAt=t_ms)
        retracement = RetracementObservation(low=bar.low, sequenceNumber=idx + 1, observedAt=t_ms, availableAt=t_ms)

        sig = scanner.process_market_state(
            bar=bar,
            current_candles=candle_buffer[-20:],
            current_l2=None,
            gex_context=GEXContext("UNAVAILABLE", None, None, None),  # no options data in this feed
            magnitude=magnitude,
            normalized_ofi=normalized_ofi,
            l2_depth_liq=l2_depth,
            breadth_ad=0.0, breadth_available_at=t_ms, breadth_source_time=t_ms,  # no breadth feed -- neutral
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
        bars_evaluated += 1
        if scanner.layer1.active_poi is not None:
            active_poi_bar_count += 1

        if idx + horizon_bars >= len(rows):
            continue  # not enough real forward bars left to compute the outcome horizon
        exit_dt = rows[idx + horizon_bars][0]
        if not isinstance(exit_dt, datetime):
            exit_dt = datetime.fromtimestamp(exit_dt / 1000.0, tz=timezone.utc)
        if exit_dt.strftime("%Y-%m-%d") != session_str:
            continue  # horizon would cross a session boundary -- exclude per protocol item 5

        future_highs = highs[idx + 1: idx + 1 + horizon_bars]
        mfe_gross_bps = (max(future_highs) - bar.close) / bar.close * 10000.0
        mfe_net_bps = mfe_gross_bps - ROUND_TRIP_FRICTION_BPS

        episodes.append(ObservationEpisode(
            episodeId=f"{instrument}_ep_{idx + 1}",
            symbol=instrument,
            sessionDate=session_str,
            entryTimestamp=t_ms,
            isSessionCloseExcluded=is_near_session_close(dt),
            isTreatment=is_treat,
            fibZone=zone,
            hasRealActiveAnchor=(scanner.layer1.active_poi is not None),
            retracementRatio=sig.featureVector.fibRetracement if sig.featureVector.fibRetracement is not None else 0.50,
            mfeNetBps=mfe_net_bps,
            impulseRange=sig.featureVector.anchorRangePrice if sig.featureVector.anchorRangePrice else 0.0,
            yzVolRatio=vol_ratio_series[idx],
            anchorAgeBars=float(sig.featureVector.anchorAgeBars) if sig.featureVector.anchorAgeBars is not None else 0.0,
            todSin=tod_sin, todCos=tod_cos,
            breadthAd=0.0,
            l2DepthLiquidity=0.0,
        ))

    diagnostics = {
        "barsEvaluated": bars_evaluated,
        "activePoiBarCount": active_poi_bar_count,
        "poiQualifiedCount": sum(1 for e in engine_event_history(scanner) if e["eventType"] == "RETRACEMENT_QUALIFIED"),
    }
    return episodes, diagnostics


def engine_event_history(scanner: Master5LayerScanner):
    return scanner.layer1.event_history


def load_historical_episodes_from_db(connection: Optional[psycopg.Connection]) -> Tuple[List[ObservationEpisode], dict]:
    if connection is None:
        return [], {}

    episodes: List[ObservationEpisode] = []
    per_instrument_diagnostics: dict = {}
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

        if rows:
            first_date = rows[0][0]
            last_date = rows[-1][0]
            print(f"Loaded {len(rows)} real {TIMEFRAME} candles for {instrument} ({first_date} to {last_date}).", file=sys.stderr)
            instrument_episodes, diag = build_instrument_episodes(rows, instrument, TIMEFRAME_MINUTES[TIMEFRAME])
            episodes.extend(instrument_episodes)
            per_instrument_diagnostics[instrument] = diag

    return episodes, per_instrument_diagnostics


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


def main():
    print("=== Phase C Numerical Pipeline Execution ===", file=sys.stderr)
    db_url = get_database_url()

    episodes_db: List[ObservationEpisode] = []
    poi_diagnostics: dict = {}
    try:
        with psycopg.connect(db_url, connect_timeout=5) as conn:
            episodes_db, poi_diagnostics = load_historical_episodes_from_db(conn)
    except Exception as e:
        print(f"Notice: Connecting to DB failed ({e}). No real-data evaluation will run.", file=sys.stderr)

    if episodes_db:
        eval_episodes, means, stds = split_calibration_and_evaluation(episodes_db)
        n_treat = sum(1 for ep in eval_episodes if ep.isTreatment)
        print(f"Real-data evaluation: {len(eval_episodes)} episodes ({n_treat} Fib-zone treatment contacts).", file=sys.stderr)
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
        real_section_label = "realDataLocationOnlyDiagnostic_NOT_PHASE_C_F1_F4"
    else:
        manifest_real = None
        real_section_label = "realDataLocationOnlyDiagnostic_NOT_PHASE_C_F1_F4"
        print("Notice: no real episodes available; skipping real-data evaluation.", file=sys.stderr)

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
        "governanceStatus": "PHASE_C_PARTIAL_EXECUTION_LOCATION_ONLY" if manifest_real else "PHASE_C_NO_REAL_DATA_AVAILABLE",
        "tradingExecutionAuthorized": False,  # Sole authority behind Phase E!
        real_section_label: manifest_real,
        "syntheticPipelineSmokeTest_NOT_EVIDENCE": manifest_synthetic,
    }

    out_file = "phase_c_results.json"
    with open(out_file, "w") as f:
        json.dump(final_output, f, indent=2)

    print(f"SUCCESS: Emitted Phase C execution manifest to {out_file}", file=sys.stderr)
    print(json.dumps(final_output, indent=2))


if __name__ == "__main__":
    main()
