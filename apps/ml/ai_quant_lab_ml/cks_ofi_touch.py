"""
Real CKS order-flow imbalance (OFI): touch-level, 5-second trailing window.

Faithful port of the validated TypeScript implementation (Phase 28,
docs/phase-28-microstructure-information-flow.md):
  apps/api/src/modules/research/domain/order-flow-imbalance.ts
    (levelOrderFlowImbalance, accumulateOrderFlowImbalance)
  apps/api/src/modules/research/domain/ofi-signal-observations.ts
    (trailing-window sum over a segment)

Feature ID: CKS_OFI_TOUCH_5S_RAW_V1 -- deliberately NOT "CKS_OFI_30S_NORMALIZED_TOP5_V1".
That name, hardcoded as the Fibonacci scanner's feature contract (fibonacci_pit_engine.py /
master_scanner.py), implies a 30-second window, top-5-level, depth-normalized feature.
Nothing in this codebase has ever computed that. What Phase 28 actually built and validated
is touch-level only (levels=1), a 5000ms trailing window, raw (unnormalized) units -- "30s"
in its reported results is the forward-return HORIZON used to measure predictive power, not
the OFI accumulation window. Porting the real, validated config under its own correct name
is the point: relabeling it to fit an unvalidated spec string would repeat the exact mistake
this module exists to fix.

IMPORTANT -- there is no validated gate threshold on the raw feature value. The "0.032" the
Fibonacci spec/scanner treats as a frozen per-bar threshold is Phase 28's measured
INFORMATION COEFFICIENT (a dataset-level rank correlation between this feature and a
30s-ahead forward return, naturally in [-1, 1]) -- not a cutoff on the feature itself, which
is a raw signed sum of order quantities (tens to low hundreds of lots on BANKNIFTY futures)
on a completely different numeric scale. "OFI value > 0.032" compares incompatible units.
Phase 28 also found the IC's SIGN is unstable across time windows ("DOES NOT REPLICATE",
doc section 9): even with matching units there is no stable direction to gate on. This
module therefore only computes and exposes the real feature value; it does not gate on it.

Data reality: real depth frames exist ONLY for BANKNIFTY, and ONLY as rolling monthly
futures contracts -- never the cash index, never NIFTY50. Contracts must never be blended
across a roll (per-contract capture windows below); each is its own OFI chain.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Sequence, Tuple

CKS_OFI_TOUCH_5S_RAW_FEATURE_ID = "CKS_OFI_TOUCH_5S_RAW_V1"
OFI_WINDOW_MS = 5000  # matches Phase 28's validated evaluate-ofi-signal.ts default

# Known BANKNIFTY futures contracts with captured depth, and the (UTC, inclusive) date range
# each dominates -- confirmed against real depth_frames rows, not assumed. Never average two
# contracts' OFI across a roll; each gets its own independent chain below.
BANKNIFTY_DEPTH_CONTRACTS: List[Tuple[str, str, str]] = [
    ("NSE:BANKNIFTY26AUGFUT", "2026-08-21", "2026-08-25"),
    ("NSE:BANKNIFTY26SEPFUT", "2026-08-27", "2026-09-29"),
    # Valid to its REAL expiry: NSE BANKNIFTY monthly futures expire on the last Tuesday of the
    # month; Oct 2026's last Tuesday is the 27th. This was "2026-12-31", which kept a dead
    # contract mapped for two months past expiry. The next contract (NOV) has no captured depth
    # yet; add it when it does.
    ("NSE:BANKNIFTY26OCTFUT", "2026-09-30", "2026-10-27"),
]


def contract_for_date(session_date: str) -> Optional[str]:
    """Which captured BANKNIFTY futures contract (if any) covers this calendar date (UTC)."""
    for symbol, start, end in BANKNIFTY_DEPTH_CONTRACTS:
        if start <= session_date <= end:
            return symbol
    return None


def recompute_sequence_flags(
    frames: Sequence[Tuple[Optional[int], bool]],
) -> List[Tuple[Optional[int], bool, bool]]:
    """
    Recompute (gap_before, is_duplicate, is_regression) from raw sequence numbers.

    `frames` is ONE symbol's (sequence_no, is_snapshot) pairs in received order (one trading day
    is the intended unit: a feed restart overnight resets the chain anyway). This mirrors the
    FIXED capture-time rule in `capture-depth-frames.ts` (marker always follows the last usable
    sequence number, so a reset is flagged ONCE and later frames are clean):

      * no usable sequence (None / negative)  -> (None, False, False), marker unchanged
      * snapshot frame                        -> (None, False, False), marker re-based
      * first usable frame                    -> (None, False, False)
      * seq == marker                         -> (0, True, False)   duplicate
      * seq <  marker                         -> (None, False, True) regression / reset
      * seq >  marker                         -> (seq - marker - 1, False, False)

    Why this exists: depth_frames rows captured BEFORE the capture fix carry `is_regression=TRUE`
    on EVERY frame after a reset-without-snapshot (e.g. 29,954 frames on 2026-09-11), and their
    stored `gap_before` is NULL there. Research that filters `is_regression = FALSE` silently drops
    those sessions. Stored flags are NOT mutated; recompute from `sequence_no` instead.
    """
    out: List[Tuple[Optional[int], bool, bool]] = []
    marker: Optional[int] = None
    for seq, is_snapshot in frames:
        usable = seq is not None and seq >= 0
        if not usable:
            out.append((None, False, False))
            continue
        if is_snapshot or marker is None:
            out.append((None, False, False))
        elif seq == marker:
            out.append((0, True, False))
        elif seq < marker:
            out.append((None, False, True))
        else:
            out.append((seq - marker - 1, False, False))
        marker = seq
    return out


def recompute_sequence_flags_by_stream(
    frames: Sequence[Tuple[object, Optional[int], bool]],
) -> List[Tuple[Optional[int], bool, bool, bool]]:
    """
    `recompute_sequence_flags` for rows that interleave several independent streams (e.g. several
    provider symbols and/or capture sessions loaded in ONE received-order query). 2026-10-10
    follow-up (code gaps): the stored `is_regression` / `gap_before` of pre-fix rows cannot be
    trusted, and sequence numbers of different streams are unrelated, so the flags must be
    recomputed per stream.

    `frames` is [(stream_id, sequence_no, is_snapshot)] in received order. Returns, ALIGNED with the
    input, (gap_before, is_duplicate, is_regression, is_stream_start). `is_stream_start` is True for
    the first row of each stream: its sequence chain has no predecessor, so callers building an OFI
    chain should treat it as a baseline (like a snapshot) rather than differencing across streams.
    """
    indices_by_stream: Dict[object, List[int]] = {}
    for index, (stream_id, _seq, _snap) in enumerate(frames):
        indices_by_stream.setdefault(stream_id, []).append(index)

    out: List[Tuple[Optional[int], bool, bool, bool]] = [(None, False, False, False)] * len(frames)
    for indices in indices_by_stream.values():
        stream_flags = recompute_sequence_flags([(frames[i][1], frames[i][2]) for i in indices])
        for position, (index, (gap, is_dup, is_reg)) in enumerate(zip(indices, stream_flags)):
            out[index] = (gap, is_dup, is_reg, position == 0)
    return out


def drop_reset_and_duplicate_rows(rows: Sequence, flags: Sequence[Tuple]) -> list:
    """Rows whose recomputed flags are neither a duplicate nor a SEQUENCE_RESET (is_regression).
    `flags[i]` must be (gap_before, is_duplicate, is_regression, ...) for `rows[i]`."""
    return [row for row, flag in zip(rows, flags) if not flag[1] and not flag[2]]


@dataclass(frozen=True)
class DepthFrameRow:
    received_at: datetime
    is_snapshot: bool
    is_duplicate: bool
    gap_before: Optional[int]
    bid_price_0: float
    bid_qty_0: float
    ask_price_0: float
    ask_qty_0: float
    # A sequence reset without a snapshot (see `recompute_sequence_flags`). Treated as a chain
    # break exactly like a snapshot: the frame becomes the new baseline and contributes no delta.
    # Defaults False so callers that never carried the flag keep their behaviour.
    is_regression: bool = False


@dataclass(frozen=True)
class OfiWindowObservation:
    at: datetime
    window_sum: float


def _touch_level_delta(previous: DepthFrameRow, current: DepthFrameRow) -> Optional[float]:
    """Port of levelOrderFlowImbalance(level=0): signed queue change at the best quotes."""
    if previous.bid_price_0 <= 0 or current.bid_price_0 <= 0:
        return None
    if previous.ask_price_0 <= 0 or current.ask_price_0 <= 0:
        return None

    if current.bid_price_0 > previous.bid_price_0:
        bid_flow = current.bid_qty_0
    elif current.bid_price_0 < previous.bid_price_0:
        bid_flow = -previous.bid_qty_0
    else:
        bid_flow = current.bid_qty_0 - previous.bid_qty_0

    if current.ask_price_0 < previous.ask_price_0:
        ask_flow = -current.ask_qty_0
    elif current.ask_price_0 > previous.ask_price_0:
        ask_flow = previous.ask_qty_0
    else:
        ask_flow = -(current.ask_qty_0 - previous.ask_qty_0)

    return bid_flow + ask_flow


def _split_into_segments(frames: Sequence[DepthFrameRow]) -> List[List[Tuple[datetime, float]]]:
    """
    Port of accumulateOrderFlowImbalance's segmenting: a snapshot, a duplicate, a sequence gap,
    a sequence reset (regression) or a one-sided (not comparable) book all break the chain. The opening frame of the whole
    series (or of a segment) establishes a baseline and contributes no observation of its own.
    """
    segments: List[List[Tuple[datetime, float]]] = []
    current: List[Tuple[datetime, float]] = []
    previous: Optional[DepthFrameRow] = None

    for frame in frames:
        breaks_chain = (
            "DUPLICATE" if frame.is_duplicate
            else "SNAPSHOT" if frame.is_snapshot
            else "SEQUENCE_RESET" if frame.is_regression
            else "SEQUENCE_GAP" if (frame.gap_before is not None and frame.gap_before > 0)
            else None
        )
        if breaks_chain is not None:
            if previous is not None and current:
                segments.append(current)
            current = []
            # A duplicate restates a book we already had; it is not a valid baseline either.
            previous = previous if breaks_chain == "DUPLICATE" else frame
            continue

        if previous is None:
            previous = frame
            continue

        delta = _touch_level_delta(previous, frame)
        if delta is None:
            if current:
                segments.append(current)
            current = []
            previous = frame
            continue

        current.append((frame.received_at, delta))
        previous = frame

    if current:
        segments.append(current)
    return segments


def compute_windowed_ofi_series(frames: Sequence[DepthFrameRow]) -> List[OfiWindowObservation]:
    """
    Segment-aware trailing-window OFI sum, touch-level only, OFI_WINDOW_MS=5000.
    Frames must be received_at-ordered. A window never reaches back across a segment
    boundary (snapshot / duplicate / sequence gap / one-sided book) -- it truncates there,
    exactly as the validated TS implementation (ofi-signal-observations.ts) does.
    """
    observations: List[OfiWindowObservation] = []
    window_ms = timedelta(milliseconds=OFI_WINDOW_MS)

    for segment in _split_into_segments(frames):
        window_start = 0
        window_sum = 0.0
        for cursor in range(len(segment)):
            at, delta = segment[cursor]
            window_sum += delta
            cutoff = at - window_ms
            while window_start < cursor and segment[window_start][0] < cutoff:
                window_sum -= segment[window_start][1]
                window_start += 1
            observations.append(OfiWindowObservation(at=at, window_sum=window_sum))

    return observations


@dataclass(frozen=True)
class FuturesMidCandle:
    close_time: datetime
    open: float
    high: float
    low: float
    close: float


def compute_mid_price_candles(frames: Sequence[DepthFrameRow], timeframe_minutes: int) -> List[FuturesMidCandle]:
    """
    Buckets real captured depth frames' touch-level mid-price ((bid+ask)/2) into
    `timeframe_minutes`-wide OHLC bars, floored to the same UTC-minute grid the rest of this
    system's candles already use (the 09:15 IST session open is 03:45 UTC, itself a multiple
    of 5, so a plain floor-to-boundary lines up with the real 5m candle grid with no special
    casing).

    This exists to close the spot/futures basis gap: BANKNIFTY candles elsewhere in this
    pipeline are the CASH INDEX, while OFI is computed from the FUTURES order book, which
    trades at a persistent premium to spot (confirmed directly against real captured data:
    2026-09-15 09:00 UTC index close 55981.6 vs. the SEPFUT contract's mid-price 56195.9 at
    the same moment, a 214pt / 0.38% gap). A Fibonacci zone computed on the index's own price
    levels and an OFI reading computed on the futures order book describe two different
    instruments; this function derives a real OHLC series from the exact same book OFI is
    computed from, so a Fibonacci engine run on it and its OFI conditioning are never more
    than a touch-level spread apart.

    Buckets with zero captured frames are skipped entirely (not interpolated/forward-filled)
    -- an honest gap in capture, never a fabricated flat candle; real captured depth has
    intraday gaps (~6% of consecutive 5m buckets here are more than one bar apart), which is
    why callers that walk this series for a forward-return horizon must validate elapsed wall
    time between entry and exit bars rather than trusting a fixed bar-count offset. Frames
    with a crossed or one-sided book (bid<=0 or ask<=0) are excluded from the mid-price,
    matching `_touch_level_delta`'s own validity check.
    """
    bucket_ms = timeframe_minutes * 60_000
    buckets: Dict[int, List[float]] = {}
    for frame in frames:
        if frame.bid_price_0 <= 0 or frame.ask_price_0 <= 0:
            continue
        mid = (frame.bid_price_0 + frame.ask_price_0) / 2.0
        epoch_ms = int(frame.received_at.timestamp() * 1000)
        bucket_start_ms = (epoch_ms // bucket_ms) * bucket_ms
        buckets.setdefault(bucket_start_ms, []).append(mid)

    candles: List[FuturesMidCandle] = []
    for bucket_start_ms in sorted(buckets.keys()):
        mids = buckets[bucket_start_ms]
        close_time = datetime.fromtimestamp((bucket_start_ms + bucket_ms) / 1000.0, tz=timezone.utc)
        candles.append(FuturesMidCandle(
            close_time=close_time, open=mids[0], high=max(mids), low=min(mids), close=mids[-1],
        ))
    return candles


def join_nearest_prior(
    observations: Sequence[OfiWindowObservation],
    target_times: Sequence[datetime],
    max_staleness_seconds: float = 60.0,
) -> List[Optional[float]]:
    """
    For each strictly-increasing `target_times[i]`, the OFI window_sum from the most recent
    observation at or before it, or None if the nearest one is more than `max_staleness_seconds`
    stale (or none exists yet) -- point-in-time correct, no lookahead, by construction.
    """
    results: List[Optional[float]] = []
    obs_idx = 0
    n_obs = len(observations)
    max_staleness = timedelta(seconds=max_staleness_seconds)

    for target in target_times:
        while obs_idx < n_obs and observations[obs_idx].at <= target:
            obs_idx += 1
        # obs_idx now points past the last observation <= target
        if obs_idx == 0:
            results.append(None)
            continue
        nearest = observations[obs_idx - 1]
        if target - nearest.at > max_staleness:
            results.append(None)
            continue
        results.append(nearest.window_sum)

    return results
