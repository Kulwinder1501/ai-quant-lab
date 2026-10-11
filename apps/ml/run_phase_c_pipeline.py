"""
Phase C Numerical Pipeline Runner
Implementation Contract v1.4.1 & Research Specification v1.1

Executes the Master 5-Layer Scanner and F1-F4 Statistical Pipeline on historical data.
Emits the formal machine-readable `phase_c_results.json` manifest.

CURRENT STATE (2026-10-10 realignment; docs/2026-10-10-fibonacci-order-flow-realignment.md).
Where the historical notes below describe a "forward net-MFE" outcome, a hard-coded database
default, one-bar fractals or a single bullish-only pass, they are superseded:
 - Outcome: signed net return (enter at the NEXT bar's open, exit at the close of the 15-minute
   horizon, long for BULLISH / short for BEARISH, minus 2 bps friction), not an excursion.
 - Both directions run through the same Master5LayerScanner (Layer 0 -> Layer 1 -> Layer 2).
 - Swings are 5-bar fractals (PIVOT_WIDTH = 2); the Fibonacci leg re-anchors on new extremes.
 - Controls are drawn from the SAME live anchors, before their first zone contact, at comparable
   ages (select_episode_records); matching uses the spec values (30 min, 0.20 SD caliper).
 - The database URL is read from DATABASE_URL only; there is no built-in credential.
 - Order flow is unmeasured (no tape in the feed): Layer 2 reports ORDER_FLOW_UNAVAILABLE.
 - `python run_phase_c_pipeline.py` first proves the statistical plumbing on synthetic data with a
   KNOWN effect (must reach SUPPORTED) and a KNOWN null (must reach FALSIFIED) before any real run.
The real-data section remains a location-only research diagnostic, never a trading signal.


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
 - PropensityMatcher.match_1to1_deterministic (experiments_f1_f4.py) matched purely on
   session/time window and never checked instrument: this file pools NIFTY50 + BANKNIFTY
   episodes into one treatment/control list for the index-based manifest, so a NIFTY50
   treatment anchor could be (and, confirmed against real data, was) matched to a same-minute
   BANKNIFTY control describing a different underlying's price action. Fixed by adding a
   same-symbol restriction to that match condition. No verdict in this file's existing
   manifests flips as a result (matched-pair counts were already below
   MIN_MATCHED_PAIRS_FOR_VERDICT, so every zone was already INCONCLUSIVE_INSUFFICIENT_DATA),
   but matched counts and ASMD balance numbers visibly change -- some of what little matched
   sample existed was cross-instrument contamination, not a real comparable counterfactual.
"""

from __future__ import annotations

import json
import math
import os
import sys
from datetime import datetime, timedelta, timezone
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
    recompute_sequence_flags,
)
from ai_quant_lab_ml.contracts import BREADTH_INDEX_PRIMARY, BREADTH_INDEX_SECONDARY, BREADTH_UNIVERSE, BreadthContext
from ai_quant_lab_ml.experiments_f1_f4 import (
    MIN_MATCHED_PAIRS_FOR_VERDICT,
    ObservationEpisode,
    run_phase_c_experiments,
)
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
from ai_quant_lab_ml.gex_resolver import resolve_options_context
from ai_quant_lab_ml.master_scanner import Master5LayerScanner
from ai_quant_lab_ml.option_chain_pcr import OptionChainBooks, load_option_chain_books

INSTRUMENTS = ["NIFTY50", "BANKNIFTY"]
TIMEFRAME = "5m"  # single, fixed granularity -- never mix timeframes in one engine stream
# Full real history per instrument at 5m is currently ~14-16k rows (2024/2026 to date). This cap
# is a generous safety net, not a deliberate window: if a query ever hits it, that is reported
# loudly (never silently truncated the way an earlier, unrelated pipeline bug once was).
HISTORY_ROW_LIMIT = 200_000
HORIZON_MINUTES = 15  # frozen forward evaluation horizon (Research Spec v1.1 protocol item 5)
# Fractal half-width for every swing/pivot in this study: a swing is a bar beyond the PIVOT_WIDTH
# bars on each side (2 = the standard 5-bar fractal). It was 1 (a 3-bar fractal), which made
# "structure" a one-bar wiggle and MSS a break of the last wiggle.
PIVOT_WIDTH = 2
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


EXPLORATORY_NOTICE = (
    "EXPLORATORY, LOCATION-ONLY, NOT A TRADING SIGNAL. Verdicts here come from a price-location study with no order-flow "
    "data (Layer 2 is unmeasured), no Layer 0 gating, no exit rule and tens of matched pairs; a cell marked SUPPORTED "
    "is a hypothesis, not a measured edge. There is no placebo-level control, so a pullback-then-bounce effect cannot "
    "be told apart from a Fibonacci effect. See docs/2026-10-10-fibonacci-order-flow-realignment.md sections 5 and 10."
)


def get_database_url() -> str:
    """
    The database URL comes from the environment only. An earlier revision of this function carried
    a full connection string, including the password, as the fallback default; a credential
    committed to source control is compromised regardless of whether it is still valid, so there
    is deliberately no default here any more.
    """
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set; refusing to fall back to a built-in credential.")
    return url


def fetch_lot_size(connection: psycopg.Connection, symbol: str) -> Optional[int]:
    """The instruments table's lot_size has drifted before (BANKNIFTY 15->30->15-bug->30) and an
    ON CONFLICT upsert once silently reset it -- read it live rather than hardcoding a value here
    that could go stale the same way. None (not a fabricated default) when the symbol has no row."""
    with connection.cursor() as cur:
        cur.execute("SELECT lot_size FROM instruments WHERE symbol = %s", (symbol,))
        row = cur.fetchone()
    return int(row[0]) if row else None


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


def compute_confirmed_swing_highs(highs: List[float], width: int = 1) -> List[Optional[Tuple[int, int, float]]]:
    """
    For each index i, the most recent CONFIRMED swing high at or before i: a bar whose high is
    strictly above the `width` bars on each side (width=1 is the original 3-bar fractal; the
    pipeline now uses width=PIVOT_WIDTH=2, the standard 5-bar fractal, so a swing is a swing and
    not a one-bar wiggle). The swing at bar s is confirmed once its whole right wing has closed,
    i.e. at bar s + width.
    Returns (swing_bar_index, confirming_bar_index, price), or None if nothing confirmed yet.
    `confirming_bar_index` is the bar whose own close made the swing high real/available -- that
    bar's timestamp, NOT "now", is the resistance's true sourceTimestamp/availableAt. Stamping it
    with the latest bar's timestamp instead (as an earlier version of this script did) makes
    `structural_resistance.sourceTimestamp <= candidateAt` false for every single bar, silently
    preventing the Fib engine from ever leaving IDLE.
    """
    n = len(highs)
    result: List[Optional[Tuple[int, int, float]]] = [None] * n
    last: Optional[Tuple[int, int, float]] = None
    for j in range(2 * width, n):
        s = j - width
        h = highs[s]
        if all(h > highs[k] for k in range(s - width, s)) and all(h > highs[k] for k in range(s + 1, j + 1)):
            last = (s, j, h)
        result[j] = last
    return result


def compute_confirmed_swing_lows(lows: List[float], width: int = 1) -> List[Optional[Tuple[int, int, float]]]:
    """
    Bearish mirror of compute_confirmed_swing_highs: the most recent CONFIRMED swing low at or
    before each index, for binding an MSS breakdown (close < support) rather than a breakout.
    """
    n = len(lows)
    result: List[Optional[Tuple[int, int, float]]] = [None] * n
    last: Optional[Tuple[int, int, float]] = None
    for j in range(2 * width, n):
        s = j - width
        v = lows[s]
        if all(v < lows[k] for k in range(s - width, s)) and all(v < lows[k] for k in range(s + 1, j + 1)):
            last = (s, j, v)
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


def build_depth_frame_rows(depth_rows) -> List[DepthFrameRow]:
    """
    Rows (received_at, capture_session_id, sequence_no, is_snapshot, bid_price_0, bid_qty_0,
    ask_price_0, ask_qty_0) in received order for ONE contract -> DepthFrameRow list.

    * Sequence flags are RECOMPUTED per capture session from sequence_no
      (cks_ofi_touch.recompute_sequence_flags) -- the stored is_regression is wrong after a reset
      without snapshot, and the stored gap_before is NULL there. A reset (is_regression), duplicate
      or gap breaks the OFI chain.
    * A capture-session boundary is also a chain break: sequence numbers of different sessions are
      unrelated, so the first frame of every session is treated as a fresh baseline (is_snapshot).
    * Missing is not zero: a frame where ANY of the four touch fields is NULL is emitted with all
      four = 0.0, which `_touch_level_delta` / `compute_mid_price_candles` already treat as "not
      comparable". A NULL qty is never turned into a real zero-size queue.
    """
    frames: List[DepthFrameRow] = []
    session_start = 0
    n = len(depth_rows)
    while session_start < n:
        session_id = depth_rows[session_start][1]
        session_end = session_start
        while session_end < n and depth_rows[session_end][1] == session_id:
            session_end += 1
        chunk = depth_rows[session_start:session_end]
        flags = recompute_sequence_flags(
            [(None if r[2] is None else int(r[2]), bool(r[3])) for r in chunk]
        )
        for i, (r, (gap_before, is_dup, is_reg)) in enumerate(zip(chunk, flags)):
            touch = (r[4], r[5], r[6], r[7])
            complete = all(v is not None for v in touch)
            bp, bq, ap, aq = (float(v) for v in touch) if complete else (0.0, 0.0, 0.0, 0.0)
            frames.append(
                DepthFrameRow(
                    received_at=r[0],
                    is_snapshot=bool(r[3]) or i == 0,
                    is_duplicate=is_dup,
                    gap_before=gap_before,
                    bid_price_0=bp, bid_qty_0=bq, ask_price_0=ap, ask_qty_0=aq,
                    is_regression=is_reg,
                )
            )
        session_start = session_end
    return frames


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
                SELECT received_at, capture_session_id, sequence_no, is_snapshot,
                       bid_price[1], bid_qty[1], ask_price[1], ask_qty[1]
                FROM depth_frames
                WHERE provider_symbol = %s
                ORDER BY received_at ASC, sequence_no ASC NULLS LAST;
                """,
                (symbol,),
            )
            depth_rows = cur.fetchall()
        except Exception as e:
            print(f"Notice: depth_frames query for {symbol} returned: {e}", file=sys.stderr)
            depth_rows = []

        if not depth_rows:
            continue

        frames = build_depth_frame_rows(depth_rows)
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


def compute_net_return_bps(opens: List[float], closes: List[float], idx: int, horizon_bars: int,
                           direction: str, friction_bps: float = ROUND_TRIP_FRICTION_BPS) -> float:
    """
    The TRADEABLE outcome of a signal on bar `idx`: enter at the NEXT bar's open (the signal bar's
    close is only known once that bar is over, so it cannot be traded at), hold `horizon_bars`
    bars, exit at that bar's close; long for BULLISH, short for BEARISH; minus round-trip friction.
    Requires idx + horizon_bars < len(closes) (the caller validates the horizon).

    This replaced a forward MFE (best excursion inside the window): MFE is non-negative by
    construction, was positive net of costs for ~80% of RANDOM bars, and cannot be captured by any
    exit rule, so a "surplus above zero" test on it measured the range of the next few bars, not a
    trade.
    """
    entry = opens[idx + 1]
    exit_price = closes[idx + horizon_bars]
    gross_bps = (exit_price - entry) / entry * 10000.0
    signed = gross_bps if direction == "BULLISH" else -gross_bps
    return signed - friction_bps


def _scan_direction(rows, instrument: str, direction: str, timeframe_minutes: int,
                    atr_series: List[Optional[float]], swing_series, vol_ratio_series: List[float],
                    ofi_joined: list, breadth_contexts: Optional[List[BreadthContext]],
                    connection: Optional[psycopg.Connection] = None,
                    options_underlying_symbol: Optional[str] = None,
                    options_books: Optional[OptionChainBooks] = None,
                    options_contract_multiplier: Optional[int] = None,
                    options_gex_cache: Optional[dict] = None,
                    ) -> Tuple[List[dict], dict]:
    """
    Drives ONE direction's Master5LayerScanner over the instrument's bars and returns one raw
    record per bar on which a qualified Fibonacci POI (a live leg) existed, plus diagnostics.

    Both directions go through the same scanner (the same Layer 0 -> Layer 1 -> Layer 2 order a
    trade would follow), so the bullish and bearish studies can no longer drift apart the way two
    hand-copied code paths did.
    """
    is_bull = direction == "BULLISH"
    closes = [float(r[4]) for r in rows]
    highs = [float(r[2]) for r in rows]
    lows = [float(r[3]) for r in rows]
    horizon_bars = max(1, round(HORIZON_MINUTES / timeframe_minutes))

    fib_art = FibAnchorCalibrationArtifact(
        calibrationId=f"FIB_CALIB_{instrument}_V1",
        featureDefinitionId="FIB_RETRACEMENT_STATEFUL_V1",
        instrument=instrument,
        regime="NORMAL",
        minRetracementTicks=10.0,
        minRetracementAtrMultiple=0.5,
        maxWindowBars=20,
        # Safety cap only. With anchor re-anchoring a POI now ends when its leg extends or is
        # invalidated, long before this; 2,000 stays as the upper bound on a POI that neither
        # extends nor invalidates (it used to be the *normal* way a POI ended).
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
        # Must satisfy calibration_end < evaluation_start <= every real decision_at.
        calibration_end=0,
        evaluation_start=1,
        tick_size=0.05,
        direction=direction,
        pivot_width=PIVOT_WIDTH,
    )

    candle_buffer: List[FootprintBar] = []
    records: List[dict] = []
    bars_evaluated = 0
    active_poi_bar_count = 0
    zone_contact_reject_reasons: Dict[str, int] = {}

    for idx, r in enumerate(rows):
        dt = r[0] if isinstance(r[0], datetime) else datetime.fromtimestamp(r[0] / 1000.0, tz=timezone.utc)
        t_ms = int(dt.timestamp() * 1000)
        session_str = dt.strftime("%Y-%m-%d")

        bar = FootprintBar(
            identity=CandleIdentity(barId=f"{instrument}_{idx + 1}", sequenceNumber=idx + 1, closeTimestamp=t_ms),
            open=float(r[1]), high=highs[idx], low=lows[idx], close=closes[idx],
            totalVolume=float(r[5]) if r[5] else 0.0,
            # No trade tape exists anywhere in this system: netDelta / POC / tail are PLACEHOLDERS
            # and the bar is flagged so Layer 2 reports "order flow unavailable" instead of
            # letting the zeros fail a gate. (Touch-level OFI below is real for BANKNIFTY only.)
            netDelta=0.0, pocDisplacementZ=0.0, tailVolumeRatio=0.0,
            availableAt=t_ms,
            orderFlowAvailable=False,
        )
        candle_buffer.append(bar)
        if len(candle_buffer) < 10:
            continue

        atr_val = atr_series[idx]
        if atr_val is None or atr_val <= 0:
            continue  # ATR not yet seeded (first 14 bars) -- numeric fail-closed guard

        # The structural level the MSS must break is the confirmed swing known BEFORE this bar:
        # the engine binds it when a pivot candidate forms, whose candidate time is the previous
        # bar's. Using the swing confirmed on this very bar would stamp the level one bar too new
        # for the candidate and silently drop every pivot whose swing happened to confirm now.
        swing = swing_series[idx - 1] if idx >= 1 else None
        if swing is None:
            continue
        _, confirming_idx, level_price = swing
        confirm_dt = rows[confirming_idx][0]
        if not isinstance(confirm_dt, datetime):
            confirm_dt = datetime.fromtimestamp(confirm_dt / 1000.0, tz=timezone.utc)
        level_ts_ms = int(confirm_dt.timestamp() * 1000)
        level = StructuralLevel(
            levelPrice=level_price, sequenceNumber=confirming_idx + 1,
            sourceTimestamp=level_ts_ms, availableAt=level_ts_ms,
        )
        if is_bull:
            retracement = RetracementObservation(low=bar.low, sequenceNumber=idx + 1, observedAt=t_ms, availableAt=t_ms)
        else:
            retracement = RetracementObservation(low=0.0, high=bar.high, sequenceNumber=idx + 1, observedAt=t_ms, availableAt=t_ms)

        tod_sin, tod_cos = time_of_day_sin_cos(dt)
        # Real daily advance/decline breadth via latest_breadth_at's staleness-bounded as-of lookup:
        # PIT-safe (an intraday bar always resolves to the prior completed session). 0.0 (neutral)
        # where none is available, honestly, not a fabricated reading.
        breadth_ctx = latest_breadth_at(breadth_contexts, dt) if breadth_contexts else None
        breadth_val = breadth_ctx.advance_decline if breadth_ctx else 0.0
        magnitude = MagnitudeEstimate(
            expectedMoveBps=(atr_val / bar.close) * 10000.0,  # real volatility-implied move size
            confidence=0.5, sourceTimestamp=t_ms, availableAt=t_ms,
        )
        ofi_value = ofi_joined[idx]
        # Missing is None, never a fabricated number: no OFI observation joined => ofi30s=None (it used
        # to be 0.0, indistinguishable from a real balanced book), and there is NO depth-normalisation
        # factor in this feed (the feature is RAW touch-level OFI, see CKS_OFI_TOUCH_5S_RAW_V1), so
        # depthNormFactor is None rather than a made-up 1000.0. These land in Optional featureVector
        # fields and nothing in Layer 2 reads them numerically; orderFlowAvailable stays False.
        normalized_ofi = NormalizedOFI(
            ofi30s=ofi_value,
            depthNormFactor=None, sourceTimestamp=t_ms, availableAt=t_ms,
            featureDefinitionId=CKS_OFI_TOUCH_5S_RAW_FEATURE_ID,
        )
        # No top-5 depth is computed in this pipeline (only level 0 is read): None, not a fake 0.0.
        l2_depth = L2DepthLiquidityObservation(meanTop5Depth=None, sourceTimestamp=t_ms, availableAt=t_ms)
        atr_obs = ATRObservation(atr14=atr_val, sourceTimestamp=t_ms, availableAt=t_ms)
        bars_evaluated += 1

        # Real windowed PCR + real dealer gamma exposure, both describing the SAME resolved
        # option-chain snapshot (see gex_resolver.py). UNAVAILABLE (not a fabricated reading)
        # whenever this instrument/direction has no options_books wired in (e.g. BANKNIFTY_FUT's
        # own futures OHLC series has no option_chain_snapshots rows under its own label -- it is
        # wired to BANKNIFTY's real chain by the caller instead) or the resolver itself refuses
        # (stale, no unsettled expiry listed, incomplete OI).
        if options_books is not None and connection is not None and options_underlying_symbol is not None:
            options_resolution = resolve_options_context(
                connection, options_books, options_underlying_symbol, spot=bar.close,
                contract_multiplier=options_contract_multiplier or 1, as_of=dt,
                gex_cache=options_gex_cache,
            )
            resolved_ms = (
                int(options_resolution.observed_at.timestamp() * 1000)
                if options_resolution.observed_at else None
            )
            gex_ctx = GEXContext(
                state=options_resolution.state,
                pcrRatio=options_resolution.pcr_windowed,
                snapshotTimestamp=resolved_ms,
                availableAt=resolved_ms,
                netDealerGammaExposure=options_resolution.net_dealer_gamma_exposure,
            )
        else:
            gex_ctx = GEXContext("UNAVAILABLE", None, None, None)

        sig = scanner.process_market_state(
            bar=bar,
            current_candles=candle_buffer[-20:],
            current_l2=None,
            gex_context=gex_ctx,
            magnitude=magnitude,
            normalized_ofi=normalized_ofi,
            l2_depth_liq=l2_depth,
            breadth_ad=breadth_val, breadth_available_at=t_ms, breadth_source_time=t_ms,
            yz_vol=vol_ratio_series[idx], yz_available_at=t_ms, yz_source_time=t_ms,
            # Volume-profile regime labeling is not implemented from this data source; held fixed
            # since it only affects layer0Status/rejectReason, which the episode construction
            # deliberately ignores (protocol amendment #2: Layer 0/2 are NOT treatment filters).
            vp_label="TRENDING_UP" if is_bull else "TRENDING_DOWN", vp_available_at=t_ms,
            tod_sin=tod_sin, tod_cos=tod_cos,
            structural_resistance=level,
            retracement=retracement, atr_obs=atr_obs,
            current_instrument=instrument, current_regime="NORMAL",
            decision_at=t_ms,
        )

        poi = scanner.layer1.active_poi
        anchor_id = scanner.layer1.poi_qualified_seq  # unique per qualified POI (leg)
        if anchor_id is None or poi is None:
            continue
        active_poi_bar_count += 1

        zone = sig.macroZone
        is_treat = zone in ("GOLDEN_POCKET", "OTE", "DEEP_RETRACEMENT")
        if is_treat:
            zone_contact_reject_reasons[sig.rejectReason] = zone_contact_reject_reasons.get(sig.rejectReason, 0) + 1

        # Horizon must stay inside the session and must not have been stretched by a capture gap.
        if idx + horizon_bars >= len(rows):
            continue
        exit_dt = rows[idx + horizon_bars][0]
        if not isinstance(exit_dt, datetime):
            exit_dt = datetime.fromtimestamp(exit_dt / 1000.0, tz=timezone.utc)
        horizon_minutes_actual = (exit_dt - dt).total_seconds() / 60.0
        if not (exit_dt.strftime("%Y-%m-%d") == session_str
                and horizon_minutes_actual <= HORIZON_MINUTES + MAX_HORIZON_SLACK_MINUTES):
            continue

        fv = sig.featureVector
        records.append({
            "anchor_id": anchor_id,
            "idx": idx,
            "dt": dt,
            "t_ms": t_ms,
            "session_str": session_str,
            "zone": zone,
            "is_treat": is_treat,
            "retracementRatio": fv.fibRetracement if fv.fibRetracement is not None else 0.50,
            "impulseRange": fv.anchorRangePrice if fv.anchorRangePrice else 0.0,
            "anchorAgeBars": float(fv.anchorAgeBars) if fv.anchorAgeBars is not None else 0.0,
            "todSin": tod_sin, "todCos": tod_cos,
            "yzVolRatio": vol_ratio_series[idx],
            "ofiValue": ofi_value,
            "breadthAd": breadth_val,
        })

    events = scanner.layer1.event_history

    def count(name: str) -> int:
        return sum(1 for e in events if e["eventType"] == name)

    diagnostics = {
        "barsEvaluated": bars_evaluated,
        "activePoiBarCount": active_poi_bar_count,
        "mssConfirmedCount": count("MSS_CONFIRMED"),
        "poiQualifiedCount": count("RETRACEMENT_QUALIFIED"),
        "anchorExtendedCount": count("ANCHOR_EXTENDED"),
        "invalidatedCount": count("INVALIDATED"),
        # Layer 2 verdict at zone contact. With no tape in the feed this should read
        # ORDER_FLOW_UNAVAILABLE (unmeasured), never LAMBDA_PROXY_PROOF_FAILED (measured, failed).
        "zoneContactLayerVerdicts": zone_contact_reject_reasons,
    }
    return records, diagnostics


def select_episode_records(records: List[dict], horizon_bars: int) -> Tuple[List[dict], List[dict]]:
    """
    Splits one direction's per-bar records into (treatments, controls), one treatment per anchor.

    Treatment: the FIRST bar of an anchor whose close is inside a Fibonacci zone (the spec's "first
    eligible entry timestamp"; one observation per anchor, so no pseudoreplication).

    Control: a bar of the SAME live anchor that is NOT in a zone, taken only from BEFORE that
    anchor's first zone contact, whose forward window ends before the contact (so no control's
    outcome overlaps its own treatment), and thinned to one per `horizon_bars` bars within an
    anchor (so no two controls share an outcome window). For an anchor that never touched a zone,
    every spaced non-zone bar qualifies.

    Why this replaced "one control = the first bar of a never-touched anchor": that control is by
    construction the youngest possible observation of its anchor, while a treatment is by
    construction a later one (measured: treatments sit a median 8 bars into the pullback, p90 74-195,
    controls at about 0-2). Anchor age is a matching covariate, so treatments and controls were
    separated by design and the propensity model could never balance them -- 0 matched pairs.
    Controls from the same anchors at comparable ages are the actual counterfactual the spec asks
    for: the same live leg, price not (yet) in the zone.
    """
    by_anchor: Dict[int, List[dict]] = {}
    for rec in records:
        by_anchor.setdefault(rec["anchor_id"], []).append(rec)

    treatments: List[dict] = []
    controls: List[dict] = []
    for recs in by_anchor.values():
        recs = sorted(recs, key=lambda r: r["idx"])
        first_contact = next((r for r in recs if r["is_treat"]), None)
        if first_contact is not None:
            treatments.append(first_contact)
        last_taken: Optional[int] = None
        for r in recs:
            if r["is_treat"]:
                continue
            if first_contact is not None and r["idx"] + horizon_bars >= first_contact["idx"]:
                continue
            if last_taken is not None and r["idx"] - last_taken < horizon_bars:
                continue
            controls.append(r)
            last_taken = r["idx"]
    return treatments, controls


def build_episodes_from_records(records: List[dict], opens: List[float], closes: List[float], horizon_bars: int,
                                instrument: str, direction: str) -> Tuple[List[ObservationEpisode], int, int, int]:
    """Returns (episodes, n_treatments, n_controls, episodes_with_real_ofi)."""
    treatments, controls = select_episode_records(records, horizon_bars)
    episodes: List[ObservationEpisode] = []
    for rec in treatments + controls:
        net_bps = compute_net_return_bps(opens, closes, rec["idx"], horizon_bars, direction)
        suffix = f"anchor_{rec['anchor_id']}" if rec["is_treat"] else f"anchor_{rec['anchor_id']}_ctl_{rec['idx']}"
        episodes.append(ObservationEpisode(
            episodeId=f"{instrument}_{direction}_{suffix}",
            symbol=instrument,
            sessionDate=rec["session_str"],
            entryTimestamp=rec["t_ms"],
            isSessionCloseExcluded=is_near_session_close(rec["dt"]),
            isTreatment=rec["is_treat"],
            fibZone=rec["zone"],
            hasRealActiveAnchor=True,
            retracementRatio=rec["retracementRatio"],
            netReturnBps=net_bps,
            impulseRange=rec["impulseRange"],
            yzVolRatio=rec["yzVolRatio"],
            anchorAgeBars=rec["anchorAgeBars"],
            todSin=rec["todSin"], todCos=rec["todCos"],
            breadthAd=rec["breadthAd"],
            l2DepthLiquidity=0.0,
        ))
    with_ofi = sum(1 for rec in treatments + controls if rec["ofiValue"] is not None)
    return episodes, len(treatments), len(controls), with_ofi


def build_instrument_episodes(rows, instrument: str, timeframe_minutes: int,
                              ofi_observations: Optional[List[OfiWindowObservation]] = None,
                              breadth_contexts: Optional[List[BreadthContext]] = None,
                              connection: Optional[psycopg.Connection] = None,
                              options_underlying_symbol: Optional[str] = None,
                              ) -> Tuple[List[ObservationEpisode], List[ObservationEpisode], dict]:
    """
    Builds ObservationEpisodes for ONE instrument's own chronologically-ordered, single-timeframe
    candle stream, by scanning each direction independently (see _scan_direction) and selecting
    treatments / same-anchor controls (see select_episode_records).

    Returns (bullish_episodes, bearish_episodes, diagnostics); diagnostics has "bullish" and
    "bearish" sub-dicts so a "0 treatment contacts" result is interpretable per direction: did the
    engine ever form a POI (pipeline working), or did price simply never reach a zone?
    """
    empty_diag = {"poiQualifiedCount": 0, "activePoiBarCount": 0, "barsEvaluated": 0}
    if len(rows) < 40:
        return [], [], {"bullish": dict(empty_diag), "bearish": dict(empty_diag)}

    opens = [float(r[1]) for r in rows]
    closes = [float(r[4]) for r in rows]
    highs = [float(r[2]) for r in rows]
    lows = [float(r[3]) for r in rows]
    atr_series = compute_atr_wilder_series(highs, lows, closes)
    swing_high_series = compute_confirmed_swing_highs(highs, PIVOT_WIDTH)
    swing_low_series = compute_confirmed_swing_lows(lows, PIVOT_WIDTH)
    vol_ratio_series = compute_vol_ratio_series(highs, lows, closes)

    if ofi_observations:
        candle_times = [r[0] if isinstance(r[0], datetime) else datetime.fromtimestamp(r[0] / 1000.0, tz=timezone.utc) for r in rows]
        ofi_joined = join_nearest_prior(ofi_observations, candle_times, max_staleness_seconds=60.0)
    else:
        ofi_joined = [None] * len(rows)
    ofi_available_count = sum(1 for v in ofi_joined if v is not None)
    horizon_bars = max(1, round(HORIZON_MINUTES / timeframe_minutes))

    # Loaded ONCE per instrument and shared by both directions: option_chain_snapshots and
    # instruments.lot_size don't change per direction, and the gex_cache memoizes GEX by resolved
    # snapshot so repeat candles between polls never re-solve the same chain's IV twice.
    options_books: Optional[OptionChainBooks] = None
    options_contract_multiplier: Optional[int] = None
    options_gex_cache: dict = {}
    if connection is not None and options_underlying_symbol is not None:
        options_books = load_option_chain_books(connection, options_underlying_symbol)
        options_contract_multiplier = fetch_lot_size(connection, options_underlying_symbol)

    episodes_by_direction: Dict[str, List[ObservationEpisode]] = {}
    diagnostics: dict = {}
    for direction, key, swing_series in (
        ("BULLISH", "bullish", swing_high_series),
        ("BEARISH", "bearish", swing_low_series),
    ):
        records, diag = _scan_direction(
            rows, instrument, direction, timeframe_minutes, atr_series, swing_series,
            vol_ratio_series, ofi_joined, breadth_contexts,
            connection=connection, options_underlying_symbol=options_underlying_symbol,
            options_books=options_books, options_contract_multiplier=options_contract_multiplier,
            options_gex_cache=options_gex_cache,
        )
        episodes, n_treat, n_ctrl, with_ofi = build_episodes_from_records(
            records, opens, closes, horizon_bars, instrument, direction
        )
        treat_ages = [e.anchorAgeBars for e in episodes if e.isTreatment]
        ctrl_ages = [e.anchorAgeBars for e in episodes if not e.isTreatment]
        diag.update({
            "treatmentEpisodes": n_treat,
            "controlEpisodes": n_ctrl,
            "episodesAfterSelection": len(episodes),
            "medianAnchorAgeBarsTreatment": float(np.median(treat_ages)) if treat_ages else None,
            "medianAnchorAgeBarsControl": float(np.median(ctrl_ages)) if ctrl_ages else None,
            "realOfiAvailableBarFraction": (ofi_available_count / diag["barsEvaluated"]) if diag["barsEvaluated"] else 0.0,
            "realOfiAvailableEpisodeCount": with_ofi,
        })
        episodes_by_direction[direction] = episodes
        diagnostics[key] = diag

    return episodes_by_direction["BULLISH"], episodes_by_direction["BEARISH"], diagnostics


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
                connection=connection, options_underlying_symbol=instrument,
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
                # BANKNIFTY_FUT_INSTRUMENT_LABEL has no row of its own in option_chain_snapshots or
                # instruments -- it's a futures-mid-price proxy series, not a distinct listed
                # underlying. Its dealer gamma exposure is BANKNIFTY's real options chain (the
                # futures and the index share one options market), so wire that chain in by name.
                connection=connection, options_underlying_symbol="BANKNIFTY",
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


def generate_synthetic_smoke_test_episodes(effect_bps: float = 4.0, seed: int = 42, n_sessions: int = 60) -> List[ObservationEpisode]:
    """
    Fabricated episodes with a KNOWN, injected treatment effect (`effect_bps`; 0.0 gives a known
    null). Purpose: prove the statistical plumbing -- matching, bootstrap, Holm-Bonferroni, the
    verdict logic -- can reach a verdict and can tell an effect from a null. It is circular as
    evidence of any real Fibonacci edge (the effect it "discovers" is the effect it was built to
    contain) and must never be presented as Phase C evidence.

    Treatments and controls are drawn from IDENTICAL covariate distributions -- including a
    realistic spread on every covariate. (The first version of this generator pinned
    l2DepthLiquidity to 450 / 480 / 520 for the three treatment zones and 460 for controls, a
    perfect separator, so the matcher returned 0 pairs and the "smoke test" never exercised the
    verdict path at all.) Only the outcome differs, by `effect_bps`.
    """
    rng = np.random.RandomState(seed)
    zone_specs = [("GOLDEN_POCKET", 0.618, 0.650, 10), ("OTE", 0.702, 0.786, 20), ("DEEP_RETRACEMENT", 0.786, 0.886, 30)]
    # Non-zone retracement ratios, including the bands that sit next to each zone boundary so the
    # F4 boundary contrasts have both sides populated.
    control_ratio_bands = [(0.30, 0.60), (0.60, 0.618), (0.650, 0.702), (0.886, 0.95)]
    control_minutes = [5, 10, 15, 20, 25, 30, 35]
    base_net_bps = -1.0  # round-trip friction already deducted: an uninformative bar loses ~1 bp
    outcome_sd = 3.0

    def covariates() -> dict:
        return dict(
            impulseRange=float(max(1.0, rng.normal(12.0, 2.5))),
            yzVolRatio=float(max(0.3, rng.normal(1.1, 0.2))),
            anchorAgeBars=float(rng.uniform(2, 15)),
            todSin=float(rng.normal(0.1, 0.5)),
            todCos=float(rng.normal(0.0, 0.5)),
            breadthAd=float(rng.normal(0.2, 0.3)),
            l2DepthLiquidity=float(rng.normal(475.0, 85.0)),
        )

    episodes: List[ObservationEpisode] = []
    for session_idx in range(n_sessions):
        day = datetime(2026, 1, 2, tzinfo=timezone.utc) + timedelta(days=session_idx)
        session_str = day.strftime("%Y-%m-%d")
        t_base = int(day.replace(hour=4, minute=0).timestamp() * 1000)  # 09:30 IST

        for zone, lo, hi, minute in zone_specs:
            episodes.append(ObservationEpisode(
                episodeId=f"EP_T_{zone}_{session_idx}", symbol="NIFTY50", sessionDate=session_str,
                entryTimestamp=t_base + minute * 60_000, isSessionCloseExcluded=False, isTreatment=True,
                fibZone=zone, hasRealActiveAnchor=True, retracementRatio=float(rng.uniform(lo, hi)),
                netReturnBps=float(rng.normal(base_net_bps + effect_bps, outcome_sd)),
                **covariates(),
            ))
        # F4 boundary probes: one episode just inside and one just outside each of the five zone
        # boundaries, so every F4 contrast has both sides populated (the 0.01-wide bands are far too
        # thin to fill from the zone/control draws above). Treatment status follows zone
        # membership: the 0.786 boundary separates OTE from DEEP, both zones, so both sides are
        # treatments there; every other boundary separates a zone from "NONE".
        probe_specs = [
            # (inside lo, inside hi, inside zone, inside treat, outside lo, outside hi, outside zone, outside treat)
            (0.618, 0.628, "GOLDEN_POCKET", True, 0.608, 0.618, "NONE", False),
            (0.640, 0.650, "GOLDEN_POCKET", True, 0.650, 0.660, "NONE", False),
            (0.702, 0.712, "OTE", True, 0.692, 0.702, "NONE", False),
            (0.786, 0.796, "DEEP_RETRACEMENT", True, 0.776, 0.786, "OTE", True),
            (0.876, 0.886, "DEEP_RETRACEMENT", True, 0.886, 0.896, "NONE", False),
        ]
        # Several probes per side so each treatment has a few same-session candidates inside the
        # 30-minute window (a propensity caliper of 0.2 SD only finds a partner among a few of them).
        for p_idx, (ilo, ihi, izone, itreat, olo, ohi, ozone, otreat) in enumerate(probe_specs):
            for side, (lo, hi, zone, treat) in enumerate(((ilo, ihi, izone, itreat), (olo, ohi, ozone, otreat))):
                for rep in range(4):
                    minute = int(rng.randint(5, 36))
                    outcome_mean = base_net_bps + (effect_bps if treat else 0.0)
                    episodes.append(ObservationEpisode(
                        episodeId=f"EP_P_{session_idx}_{p_idx}_{side}_{rep}", symbol="NIFTY50", sessionDate=session_str,
                        entryTimestamp=t_base + minute * 60_000 + (p_idx * 8 + side * 4 + rep) * 1_000,
                        isSessionCloseExcluded=False, isTreatment=treat, fibZone=zone, hasRealActiveAnchor=True,
                        retracementRatio=float(rng.uniform(lo, hi)),
                        netReturnBps=float(rng.normal(outcome_mean, outcome_sd)),
                        **covariates(),
                    ))
        for c_idx, minute in enumerate(control_minutes):
            lo, hi = control_ratio_bands[int(rng.randint(len(control_ratio_bands)))]
            episodes.append(ObservationEpisode(
                episodeId=f"EP_C_{session_idx}_{c_idx}", symbol="NIFTY50", sessionDate=session_str,
                entryTimestamp=t_base + minute * 60_000, isSessionCloseExcluded=False, isTreatment=False,
                fibZone="NONE", hasRealActiveAnchor=True, retracementRatio=float(rng.uniform(lo, hi)),
                netReturnBps=float(rng.normal(base_net_bps, outcome_sd)),
                **covariates(),
            ))
    return episodes


def run_synthetic_validation(effect_bps: float, B: int = 2000, seed: int = 42) -> dict:
    """
    Runs the full F1-F4 path on synthetic episodes with a known effect, through the SAME
    calibration split the real data uses. Returns the manifest plus explicit plumbing checks.
    """
    episodes = generate_synthetic_smoke_test_episodes(effect_bps=effect_bps, seed=seed)
    eval_episodes, means, stds = split_calibration_and_evaluation(episodes)
    manifest = run_phase_c_experiments(
        episodes=eval_episodes, calibration_means=means, calibration_stds=stds, B=B, seed=seed
    )
    family_a = manifest["familyAResults"]
    manifest["injectedEffectBps"] = effect_bps
    manifest["plumbingChecks"] = {
        "everyZoneReachedAVerdict": all(r["verdict"] != "INCONCLUSIVE_INSUFFICIENT_DATA" for r in family_a),
        "everyZoneHadMinimumMatchedPairs": all(r["nTreatmentMatched"] >= MIN_MATCHED_PAIRS_FOR_VERDICT for r in family_a),
        "supportedZones": [r["zoneName"] for r in family_a if r["verdict"] == "SUPPORTED"],
        # F4 is a different code path (boundary-local samples); prove it also reaches matching.
        "f4CellsWithMinimumMatchedPairs": sum(
            1 for r in manifest["familyBResults"] if r["nTreatmentMatched"] >= MIN_MATCHED_PAIRS_FOR_VERDICT
        ),
    }
    return manifest


def _build_real_data_manifest(episodes: List[ObservationEpisode], poi_diagnostics: dict, direction: str) -> Optional[dict]:
    if not episodes:
        return None
    eval_episodes, means, stds = split_calibration_and_evaluation(episodes)
    n_treat = sum(1 for ep in eval_episodes if ep.isTreatment)
    print(f"Real-data {direction} evaluation: {len(eval_episodes)} episodes ({n_treat} Fib-zone treatment contacts).", file=sys.stderr)
    manifest_real = run_phase_c_experiments(episodes=eval_episodes, calibration_means=means, calibration_stds=stds, B=10000, seed=42)
    manifest_real["fibEngineDiagnostics"] = poi_diagnostics  # interprets a "0 treatment" result: did a POI ever form/track?
    manifest_real["outcomeDefinition"] = (
        f"Signed net return in bps: enter at the next bar's open, exit at the close {HORIZON_MINUTES} "
        f"minutes of bars later, long for BULLISH / short for BEARISH, minus {ROUND_TRIP_FRICTION_BPS} bps "
        "round-trip friction. Not an excursion (MFE) -- see compute_net_return_bps."
    )
    manifest_real["dataCompleteness"] = {
        "ofiAvailable": False,
        "footprintTapeAvailable": False,
        "optionsGexAvailable": False,
        "marketBreadthAvailable": True,
        "note": (
            "Trade-tape footprint/netDelta and options GEX are not derivable from this OHLCV-only "
            "candle feed; Layer 2 therefore reports ORDER_FLOW_UNAVAILABLE (unmeasured) on every "
            "zone contact rather than a failed gate. Daily breadth is real (PIT as-of). This "
            "section tests a LOCATION-ONLY diagnostic (does price reach a Fib zone of the LIVE "
            "leg, and what is the tradeable net return there versus the same legs outside a zone) "
            "and is NOT a run of the full OFI-conditioned F1-F4 protocol in Research "
            "Specification v1.1. It must not be read as Phase C sign-off."
        ),
    }
    return manifest_real


def main():
    print("=== Phase C Numerical Pipeline Execution ===", file=sys.stderr)
    try:
        db_url = get_database_url()
    except RuntimeError as e:
        print(f"Notice: {e} No real-data evaluation will run.", file=sys.stderr)
        db_url = None

    bull_episodes_db: List[ObservationEpisode] = []
    bear_episodes_db: List[ObservationEpisode] = []
    poi_diagnostics: dict = {}  # {instrument: {"bullish": {...}, "bearish": {...}}}
    fut_bull_episodes_db: List[ObservationEpisode] = []
    fut_bear_episodes_db: List[ObservationEpisode] = []
    fut_poi_diagnostics: dict = {}
    if db_url:
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

    # Plumbing validation, run on every execution so a broken verdict path can never again hide
    # behind a green pipeline: a KNOWN effect must be found and a KNOWN null must not be.
    print("Running synthetic plumbing validation (known effect and known null; non-evidentiary)...", file=sys.stderr)
    synthetic_validation = {}
    for label, effect in (("knownEffect_plus4bps", 4.0), ("knownNull_0bps", 0.0)):
        manifest_synth = run_synthetic_validation(effect_bps=effect, B=2000, seed=42)
        manifest_synth["isSyntheticData"] = True
        manifest_synth["evidentiaryValue"] = "NONE_FOR_REAL_EDGE_CLAIMS"
        manifest_synth["governanceStatus"] = "SYNTHETIC_PLUMBING_VALIDATION_NOT_EVIDENCE"
        synthetic_validation[label] = manifest_synth
    synthetic_validation["plumbingVerdict"] = {
        "knownEffectDetected": bool(synthetic_validation["knownEffect_plus4bps"]["plumbingChecks"]["supportedZones"]),
        "knownNullNotSupported": not synthetic_validation["knownNull_0bps"]["plumbingChecks"]["supportedZones"],
        "verdictPathReachable": synthetic_validation["knownEffect_plus4bps"]["plumbingChecks"]["everyZoneReachedAVerdict"],
    }
    manifest_synthetic = synthetic_validation

    final_output = {
        "protocolVersion": "RESEARCH_SPECIFICATION_V1.1_CONTRACT_V1.4.1",
        "pipelineRevision": "2026-10-10_REALIGNED_V2 (docs/2026-10-10-fibonacci-order-flow-realignment.md)",
        "governanceStatus": (
            "PHASE_C_PARTIAL_EXECUTION_LOCATION_ONLY"
            if (manifest_real_bullish or manifest_real_bearish or manifest_fut_bullish or manifest_fut_bearish)
            else "PHASE_C_NO_REAL_DATA_AVAILABLE"
        ),
        "tradingExecutionAuthorized": False,  # Sole authority behind Phase E!
        # Read this before reading any verdict below.
        "exploratoryNotice": EXPLORATORY_NOTICE,
        bullish_section_label: manifest_real_bullish,
        bearish_section_label: manifest_real_bearish,
        fut_bullish_section_label: manifest_fut_bullish,
        fut_bearish_section_label: manifest_fut_bearish,
        "syntheticPlumbingValidation_NOT_EVIDENCE": manifest_synthetic,
    }

    out_file = "phase_c_results.json"
    with open(out_file, "w") as f:
        json.dump(final_output, f, indent=2)

    print(f"SUCCESS: Emitted Phase C execution manifest to {out_file}", file=sys.stderr)
    print(json.dumps(final_output, indent=2))


if __name__ == "__main__":
    main()
