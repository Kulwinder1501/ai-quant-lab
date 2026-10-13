"""OFVP Phase-2 event labels: price/profile-only (no order flow).

Research-only. Does not propose or authorize trades.

OFVP-H1 (failed auction / re-entry): probe beyond prior VAH/VAL by a buffer, then
return inside the prior value area within a fixed minute budget.

OFVP-H2 (accepted breakout): probe beyond prior VAH/VAL by a buffer, then remain
outside for a fixed acceptance window without reclaiming value.

Favourable-move distances for the cost-floor gate (before any trading rule):
- H1: |boundary − POC| on the probe side (intended target scale to prior POC).
- H2: |boundary − nearest HVN outside in breakout direction|, else session ATR
  proxy when no outside HVN exists (structure target fallback is recorded).

Normative: docs/research/orderflow-volume-profile/OFVP_MASTER_PLAN_v1.1.md §5.6, §7, §10 Phase 2.
Profile: frvp-rows48-v2 (fixed_row_volume_profile.py).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Literal, Sequence

from ai_quant_lab_ml.fixed_row_volume_profile import (
    ProfileBar,
    VolumeProfile,
    build_fixed_row_volume_profile,
    position_vs_value,
)

Side = Literal["ABOVE", "BELOW"]
Outcome = Literal["RETURNED", "HELD_OUTSIDE", "AMBIGUOUS", "TIMEOUT_STILL_OUT"]

# Frozen candidate event parameters for this baseline (not tuned on outcomes).
RETURN_BUDGET_MINUTES = 30
ACCEPTANCE_MINUTES = 15
# Probe must clear the boundary by at least one profile row width (noise filter).
PROBE_BUFFER_ROWS = 1.0

# Sealed cost floor from docs/2026-10-09-cost-stack-validation-record.md
# (6.23 + 2.45 + 1.00) bps ≈ 9.68; plan quotes ~9.7 bps.
COST_FLOOR_BPS = 9.7
# Indicative point floors at the plan's reference prices (recomputed per event mid too).
COST_FLOOR_POINTS_HINT = {"BANKNIFTY": 53.0, "NIFTY50": 22.0}


@dataclass(frozen=True)
class TimedBar:
    open_time: datetime
    high: float
    low: float
    close: float
    volume: float

    def as_profile_bar(self) -> ProfileBar:
        return ProfileBar(high=self.high, low=self.low, close=self.close, volume=self.volume)


@dataclass(frozen=True)
class ProbeEvent:
    underlying: str
    session_date: str
    prior_session_date: str
    contract: str
    side: Side
    probe_time: str
    probe_close: float
    boundary: float
    poc: float
    vah: float
    val: float
    row_width: float
    buffer_points: float
    outcome: Outcome
    return_or_hold_time: str | None
    minutes_to_outcome: int | None
    # Cost-floor distances (gross structure, not a backtest P&L).
    h1_target_points: float
    h1_target_bps: float
    h2_target_points: float
    h2_target_bps: float
    h2_target_kind: str
    excursion_beyond_boundary_points: float
    mid_price: float


def points_to_bps(points: float, mid_price: float) -> float:
    if mid_price <= 0:
        return float("nan")
    return (points / mid_price) * 10_000.0


def bps_to_points(bps: float, mid_price: float) -> float:
    return (bps / 10_000.0) * mid_price


def _nearest_hvn_outside(profile: VolumeProfile, side: Side, boundary: float) -> float | None:
    if side == "ABOVE":
        cands = [h for h in profile.hvns if h > boundary]
        return min(cands) if cands else None
    cands = [h for h in profile.hvns if h < boundary]
    return max(cands) if cands else None


def _session_range(bars: Sequence[TimedBar]) -> float:
    if not bars:
        return 0.0
    return max(b.high for b in bars) - min(b.low for b in bars)


def label_session_probes(
    *,
    underlying: str,
    session_date: str,
    prior_session_date: str,
    contract: str,
    prior_bars: Sequence[TimedBar],
    today_bars: Sequence[TimedBar],
    return_budget: int = RETURN_BUDGET_MINUTES,
    acceptance_minutes: int = ACCEPTANCE_MINUTES,
) -> list[ProbeEvent]:
    """Walk one session against a completed prior-session profile; emit probe events."""
    profile = build_fixed_row_volume_profile([b.as_profile_bar() for b in prior_bars])
    if profile is None or not today_bars:
        return []

    buffer = PROBE_BUFFER_ROWS * profile.row_width
    mid = (profile.high + profile.low) / 2.0
    range_proxy = max(_session_range(prior_bars), profile.row_width * 4)

    events: list[ProbeEvent] = []
    i = 0
    n = len(today_bars)

    while i < n:
        bar = today_bars[i]
        pos = position_vs_value(profile, bar.close)
        if pos == "INSIDE_VALUE":
            i += 1
            continue

        side: Side = "ABOVE" if pos == "ABOVE_VAH" else "BELOW"
        boundary = profile.vah if side == "ABOVE" else profile.val
        clearance = (bar.close - boundary) if side == "ABOVE" else (boundary - bar.close)
        if clearance < buffer:
            i += 1
            continue

        # Start of a probe episode.
        probe_idx = i
        extreme = bar.high if side == "ABOVE" else bar.low
        returned_at: int | None = None
        accepted_at: int | None = None
        outside_streak = 0

        j = probe_idx
        while j < n and (j - probe_idx) <= max(return_budget, acceptance_minutes):
            b = today_bars[j]
            if side == "ABOVE":
                extreme = max(extreme, b.high)
            else:
                extreme = min(extreme, b.low)

            inside = position_vs_value(profile, b.close) == "INSIDE_VALUE"
            if inside:
                returned_at = j
                break

            outside_streak += 1
            if outside_streak >= acceptance_minutes and accepted_at is None:
                accepted_at = j
                # Keep scanning within budget for a possible later return (ambiguous path).
            j += 1

        if returned_at is not None and (returned_at - probe_idx) <= return_budget:
            if accepted_at is not None and accepted_at < returned_at:
                outcome: Outcome = "AMBIGUOUS"
            else:
                outcome = "RETURNED"
            outcome_idx = returned_at
        elif accepted_at is not None:
            outcome = "HELD_OUTSIDE"
            outcome_idx = accepted_at
        else:
            outcome = "TIMEOUT_STILL_OUT"
            outcome_idx = min(n - 1, probe_idx + return_budget)

        h1_target_points = abs(boundary - profile.poc)
        hvn = _nearest_hvn_outside(profile, side, boundary)
        if hvn is not None:
            h2_target_points = abs(hvn - boundary)
            h2_kind = "nearest_hvn_outside"
        else:
            h2_target_points = 0.25 * range_proxy
            h2_kind = "fallback_25pct_prior_range"

        excursion = abs(extreme - boundary)
        events.append(
            ProbeEvent(
                underlying=underlying,
                session_date=session_date,
                prior_session_date=prior_session_date,
                contract=contract,
                side=side,
                probe_time=bar.open_time.isoformat(),
                probe_close=bar.close,
                boundary=boundary,
                poc=profile.poc,
                vah=profile.vah,
                val=profile.val,
                row_width=profile.row_width,
                buffer_points=buffer,
                outcome=outcome,
                return_or_hold_time=today_bars[outcome_idx].open_time.isoformat(),
                minutes_to_outcome=outcome_idx - probe_idx,
                h1_target_points=h1_target_points,
                h1_target_bps=points_to_bps(h1_target_points, mid),
                h2_target_points=h2_target_points,
                h2_target_bps=points_to_bps(h2_target_points, mid),
                h2_target_kind=h2_kind,
                excursion_beyond_boundary_points=excursion,
                mid_price=mid,
            )
        )

        # Advance past this episode to avoid double-counting overlapping probes.
        i = max(outcome_idx + 1, probe_idx + 1)

    return events


def summarize_cost_floor(events: Sequence[ProbeEvent], underlying: str | None = None) -> dict:
    """Median target distances vs cost floor; go/no-go before any trading backtest."""
    subset = [e for e in events if underlying is None or e.underlying == underlying]
    if not subset:
        return {
            "n_events": 0,
            "cost_floor_bps": COST_FLOOR_BPS,
            "h1_median_target_bps": None,
            "h2_median_target_bps": None,
            "h1_cost_floor": "NO_EVENTS",
            "h2_cost_floor": "NO_EVENTS",
        }

    h1 = sorted(e.h1_target_bps for e in subset)
    h2 = sorted(e.h2_target_bps for e in subset)

    def median(xs: list[float]) -> float:
        m = len(xs) // 2
        return xs[m] if len(xs) % 2 else 0.5 * (xs[m - 1] + xs[m])

    h1_med = median(h1)
    h2_med = median(h2)

    def gate(med: float) -> str:
        if med < COST_FLOOR_BPS:
            return "REJECT_UNECONOMIC"
        return "CLEARS_COST_FLOOR"

    mids = [e.mid_price for e in subset]
    mid = sum(mids) / len(mids)
    return {
        "n_events": len(subset),
        "cost_floor_bps": COST_FLOOR_BPS,
        "cost_floor_points_at_mean_mid": bps_to_points(COST_FLOOR_BPS, mid),
        "mean_mid_price": mid,
        "h1_median_target_bps": h1_med,
        "h1_median_target_points": bps_to_points(h1_med, mid) if mid else None,
        "h2_median_target_bps": h2_med,
        "h2_median_target_points": bps_to_points(h2_med, mid) if mid else None,
        "h1_cost_floor": gate(h1_med),
        "h2_cost_floor": gate(h2_med),
        "outcome_counts": _count_outcomes(subset),
    }


def _count_outcomes(events: Sequence[ProbeEvent]) -> dict[str, int]:
    out: dict[str, int] = {}
    for e in events:
        out[e.outcome] = out.get(e.outcome, 0) + 1
    return out


def events_to_dicts(events: Sequence[ProbeEvent]) -> list[dict]:
    return [asdict(e) for e in events]
