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
from datetime import datetime, timedelta
from typing import List, Optional, Sequence, Tuple

CKS_OFI_TOUCH_5S_RAW_FEATURE_ID = "CKS_OFI_TOUCH_5S_RAW_V1"
OFI_WINDOW_MS = 5000  # matches Phase 28's validated evaluate-ofi-signal.ts default

# Known BANKNIFTY futures contracts with captured depth, and the (UTC, inclusive) date range
# each dominates -- confirmed against real depth_frames rows, not assumed. Never average two
# contracts' OFI across a roll; each gets its own independent chain below.
BANKNIFTY_DEPTH_CONTRACTS: List[Tuple[str, str, str]] = [
    ("NSE:BANKNIFTY26AUGFUT", "2026-08-21", "2026-08-25"),
    ("NSE:BANKNIFTY26SEPFUT", "2026-08-27", "2026-09-29"),
    ("NSE:BANKNIFTY26OCTFUT", "2026-09-30", "2026-12-31"),  # open-ended: current contract
]


def contract_for_date(session_date: str) -> Optional[str]:
    """Which captured BANKNIFTY futures contract (if any) covers this calendar date (UTC)."""
    for symbol, start, end in BANKNIFTY_DEPTH_CONTRACTS:
        if start <= session_date <= end:
            return symbol
    return None


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
    or a one-sided (not comparable) book all break the chain. The opening frame of the whole
    series (or of a segment) establishes a baseline and contributes no observation of its own.
    """
    segments: List[List[Tuple[datetime, float]]] = []
    current: List[Tuple[datetime, float]] = []
    previous: Optional[DepthFrameRow] = None

    for frame in frames:
        breaks_chain = (
            "DUPLICATE" if frame.is_duplicate
            else "SNAPSHOT" if frame.is_snapshot
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
