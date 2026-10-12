"""Estimated Fixed Range Volume Profile (FRVP) for FRVP-MSP Phase 0.

Builds a PRIOR-SESSION profile from OHLCV bars by uniformly allocating each bar's
total volume across the tick bins spanning [low, high]. This is an
``estimated_volume_profile``, not trade-resolved VAP.

Normative rules: docs/2026-10-12-frvp-momentum-scalp-phase0-preregistration.md
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Iterable, Literal, Mapping, Sequence

Side = Literal["LONG", "SHORT"]
EventCode = Literal[
    "LVN_AHEAD",
    "ENTRY_AT_LVN",
    "ENTRY_AT_HVN",
    "ENTRY_AT_POC",
    "INSIDE_VALUE",
    "ABOVE_VAH",
    "BELOW_VAL",
    "PREDECISION_LVN_CROSS",
    "PREDECISION_LVN_REJECTION",
    "PROFILE_UNAVAILABLE",
]

VALUE_AREA_FRACTION = 0.70
HVN_LVN_PROMINENCE_FRAC_OF_POC = 0.05
ENTRY_PROXIMITY_ATR_FRAC = 0.10
ENTRY_PROXIMITY_MIN_TICKS = 2
LVN_AHEAD_MAX_ATR_FRAC = 0.25
LVN_AHEAD_MAX_TICKS_FLOOR = 8
PREDECISION_LOOKBACK_BARS = 3


@dataclass(frozen=True)
class OhlcvBar:
    open_time: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass(frozen=True)
class EstimatedVolumeProfile:
    """Point-in-time prior-session estimated FRVP."""

    algorithm_version: str
    estimation_label: str
    contract_symbol: str
    range_start: datetime
    range_end: datetime
    tick_size: float
    bin_prices: tuple[float, ...]
    bin_volumes: tuple[float, ...]
    poc: float
    vah: float
    val: float
    hvns: tuple[float, ...]
    lvns: tuple[float, ...]
    session_vwap: float
    total_volume: float


def _round_to_tick(price: float, tick_size: float) -> float:
    return round(round(price / tick_size) * tick_size, 10)


def allocate_bar_volume_uniform(
    low: float,
    high: float,
    volume: float,
    tick_size: float,
) -> dict[float, float]:
    """Uniform allocation of bar volume across inclusive tick bins from low to high."""
    if volume <= 0 or tick_size <= 0 or high < low:
        return {}
    lo = _round_to_tick(low, tick_size)
    hi = _round_to_tick(high, tick_size)
    if hi < lo:
        lo, hi = hi, lo
    bins: list[float] = []
    price = lo
    # Guard against float drift.
    while price <= hi + tick_size * 0.1:
        bins.append(_round_to_tick(price, tick_size))
        price = _round_to_tick(price + tick_size, tick_size)
        if len(bins) > 100_000:
            raise ValueError("bin explosion; check tick_size")
    if not bins:
        return {}
    share = volume / len(bins)
    return {b: share for b in bins}


def build_estimated_session_profile(
    bars: Sequence[OhlcvBar],
    *,
    tick_size: float,
    contract_symbol: str,
    algorithm_version: str = "estimated-frvp-uniform-v1",
) -> EstimatedVolumeProfile | None:
    if not bars or tick_size <= 0:
        return None
    accum: dict[float, float] = {}
    notional = 0.0
    vol_sum = 0.0
    for bar in bars:
        if bar.volume <= 0:
            continue
        part = allocate_bar_volume_uniform(bar.low, bar.high, bar.volume, tick_size)
        for price, vol in part.items():
            accum[price] = accum.get(price, 0.0) + vol
        typical = (bar.high + bar.low + bar.close) / 3.0
        notional += typical * bar.volume
        vol_sum += bar.volume
    if not accum or vol_sum <= 0:
        return None

    prices = tuple(sorted(accum))
    volumes = tuple(accum[p] for p in prices)
    session_vwap = notional / vol_sum
    poc_vol = max(volumes)
    poc_candidates = [p for p, v in zip(prices, volumes) if v == poc_vol]
    poc = min(poc_candidates, key=lambda p: (abs(p - session_vwap), p))

    # Value area: expand from POC until >= 70% volume.
    target = VALUE_AREA_FRACTION * vol_sum
    included = {poc}
    running = accum[poc]
    lo_i = prices.index(poc)
    hi_i = lo_i
    while running < target and (lo_i > 0 or hi_i < len(prices) - 1):
        below = accum[prices[lo_i - 1]] if lo_i > 0 else -1.0
        above = accum[prices[hi_i + 1]] if hi_i < len(prices) - 1 else -1.0
        if below < 0 and above < 0:
            break
        if above > below:
            hi_i += 1
            included.add(prices[hi_i])
            running += above
        elif below > above:
            lo_i -= 1
            included.add(prices[lo_i])
            running += below
        else:
            # Tie: prefer lower-price bin first.
            if lo_i > 0:
                lo_i -= 1
                included.add(prices[lo_i])
                running += below
            else:
                hi_i += 1
                included.add(prices[hi_i])
                running += above

    val = min(included)
    vah = max(included)

    # Minimum prominence: 5% of POC volume (lot floor can be applied by the caller if needed).
    prominence = HVN_LVN_PROMINENCE_FRAC_OF_POC * poc_vol
    hvns: list[float] = []
    lvns: list[float] = []
    for i, price in enumerate(prices):
        v = volumes[i]
        left = volumes[i - 1] if i > 0 else v
        right = volumes[i + 1] if i < len(prices) - 1 else v
        if v >= left and v >= right and (v - min(left, right)) >= prominence and price != poc:
            hvns.append(price)
        if v <= left and v <= right and (min(left, right) - v) >= prominence:
            lvns.append(price)

    return EstimatedVolumeProfile(
        algorithm_version=algorithm_version,
        estimation_label="estimated_volume_profile",
        contract_symbol=contract_symbol,
        range_start=bars[0].open_time,
        range_end=bars[-1].open_time,
        tick_size=tick_size,
        bin_prices=prices,
        bin_volumes=volumes,
        poc=poc,
        vah=vah,
        val=val,
        hvns=tuple(hvns),
        lvns=tuple(lvns),
        session_vwap=session_vwap,
        total_volume=vol_sum,
    )


def map_futures_level_to_index(level_futures: float, basis: float) -> float:
    """L_index = L_futures - B_t with B_t = F_t - I_t."""
    return level_futures - basis


def classify_profile_events_at_decision(
    *,
    side: Side,
    entry_price_index: float,
    profile_index: EstimatedVolumeProfile,
    atr_1m: float,
    prior_bars_index: Sequence[OhlcvBar],
) -> tuple[EventCode, ...]:
    """Causal event codes at decision time. ``profile_index`` levels must already be index-mapped."""
    if atr_1m <= 0 or profile_index.tick_size <= 0:
        return ("PROFILE_UNAVAILABLE",)

    prox = max(ENTRY_PROXIMITY_MIN_TICKS * profile_index.tick_size, ENTRY_PROXIMITY_ATR_FRAC * atr_1m)
    ahead_max = max(LVN_AHEAD_MAX_TICKS_FLOOR * profile_index.tick_size, LVN_AHEAD_MAX_ATR_FRAC * atr_1m)
    codes: list[EventCode] = []

    if profile_index.val <= entry_price_index <= profile_index.vah:
        codes.append("INSIDE_VALUE")
    elif entry_price_index > profile_index.vah:
        codes.append("ABOVE_VAH")
    else:
        codes.append("BELOW_VAL")

    if abs(entry_price_index - profile_index.poc) <= prox:
        codes.append("ENTRY_AT_POC")
    for hvn in profile_index.hvns:
        if abs(entry_price_index - hvn) <= prox:
            codes.append("ENTRY_AT_HVN")
            break
    for lvn in profile_index.lvns:
        if abs(entry_price_index - lvn) <= prox:
            codes.append("ENTRY_AT_LVN")
            break

    # LVN_AHEAD: nearest LVN strictly ahead in trade direction within window.
    if side == "LONG":
        ahead = [l for l in profile_index.lvns if entry_price_index < l <= entry_price_index + ahead_max]
    else:
        ahead = [l for l in profile_index.lvns if entry_price_index - ahead_max <= l < entry_price_index]
    if ahead:
        # Require no HVN between entry and that LVN (corridor).
        target = min(ahead) if side == "LONG" else max(ahead)
        if side == "LONG":
            blocking = any(entry_price_index < h < target for h in profile_index.hvns)
        else:
            blocking = any(target < h < entry_price_index for h in profile_index.hvns)
        if not blocking:
            codes.append("LVN_AHEAD")

    lookback = list(prior_bars_index)[-PREDECISION_LOOKBACK_BARS:]
    for lvn in profile_index.lvns:
        if abs(entry_price_index - lvn) > ahead_max:
            continue
        crossed = False
        rejected = False
        for bar in lookback:
            if side == "LONG":
                if bar.low <= lvn <= bar.high and bar.close > lvn:
                    crossed = True
                if bar.low <= lvn + prox and bar.close < lvn:
                    rejected = True
            else:
                if bar.low <= lvn <= bar.high and bar.close < lvn:
                    crossed = True
                if bar.high >= lvn - prox and bar.close > lvn:
                    rejected = True
        if crossed:
            codes.append("PREDECISION_LVN_CROSS")
        if rejected:
            codes.append("PREDECISION_LVN_REJECTION")
        break

    # Deduplicate preserving order.
    seen: set[str] = set()
    out: list[EventCode] = []
    for code in codes:
        if code not in seen:
            seen.add(code)
            out.append(code)
    return tuple(out)


def profile_policy_lvn_ahead_v1(events: Sequence[str]) -> bool:
    """Single primary Phase 0 policy."""
    if "PROFILE_UNAVAILABLE" in events:
        return False
    return "LVN_AHEAD" in events


def inventory_has_index_futures_volume(rows: Iterable[Mapping[str, object]]) -> bool:
    """True if any instrument row looks like an index future with positive volume bars."""
    for row in rows:
        symbol = str(row.get("symbol", "")).upper()
        itype = str(row.get("instrument_type", "")).upper()
        vol_pos = int(row.get("vol_pos") or 0)
        if itype == "FUTURE" and vol_pos > 0:
            return True
        if ("FUT" in symbol) and vol_pos > 0 and ("NIFTY" in symbol or "BANKNIFTY" in symbol):
            return True
    return False
