"""
Equity Stance R0: Step A2 - Python Levels Engine
Pre-Registered Spec: docs/2026-10-17-equity-stance-r0-spec.md
Parity Target: apps/api/src/modules/equity-research/domain/levels.ts

Strict Parity Rules:
1. Exact mathematical parity with TypeScript levels.ts to 1e-9 on float values.
2. Identical clustering, pivot half-window, break/flip detection, 52W levels, SMAs,
   round numbers, gaps, volume profile (POC/VAH/VAL), and artifact truncation.
3. Parameters loaded from equity-rules-v1.json.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

RULES_PATH = Path(__file__).resolve().parent.parent.parent / "api" / "src" / "modules" / "equity-research" / "domain" / "equity-rules-v1.json"


def load_rules(rules_path: Optional[Path] = None) -> dict[str, Any]:
    path = rules_path or RULES_PATH
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


@dataclass
class Bar:
    bar_date: str
    open: float
    high: float
    low: float
    close: float
    volume: int


@dataclass
class SwingPivot:
    price: float
    bar_date: str
    bar_index: int
    volume: int
    kind: str  # "SWING_LOW" | "SWING_HIGH"


@dataclass
class VolumeProfileResult:
    poc: float
    vah: float
    val: float
    bin_width: float
    total_volume: float


@dataclass
class LevelItem:
    id: str
    price: float
    kind: str  # SWING, 52W_HIGH, 52W_LOW, SMA_50, SMA_200, ROUND_NUMBER, GAP, VOLUME_PROFILE_POC, VOLUME_PROFILE_VAH, VOLUME_PROFILE_VAL
    source: str
    side: str  # SUPPORT, RESISTANCE
    touches: int
    strength: float
    first_date: str
    last_date: str
    distance_pct: float
    distance_atr: float
    zone_low: float
    zone_high: float
    state: str  # INTACT, BROKEN, FLIPPED
    broken_on: Optional[str] = None
    volume: Optional[float] = None


@dataclass
class LevelsResult:
    as_of_date: Optional[str]
    state: str  # OK, INSUFFICIENT_HISTORY, SUSPENDED, NOT_MEANINGFUL
    atr14: Optional[float]
    atr_percent: Optional[float]
    levels: list[LevelItem]
    nearest_support: Optional[LevelItem]
    nearest_resistance: Optional[LevelItem]
    risk_distance_atr: Optional[float]
    warnings: list[str]


def compute_true_ranges(bars: list[Bar]) -> list[float]:
    if not bars:
        return []
    trs: list[float] = [bars[0].high - bars[0].low]
    for i in range(1, len(bars)):
        high = bars[i].high
        low = bars[i].low
        prev_close = bars[i - 1].close
        tr = max(high - low, abs(high - prev_close), abs(low - prev_close))
        trs.append(tr)
    return trs


def compute_atr14(bars: list[Bar], period: int = 14) -> Optional[float]:
    if len(bars) < period:
        return None
    trs = compute_true_ranges(bars)
    last_n = trs[-period:]
    return sum(last_n) / period


def find_swing_pivots(bars: list[Bar], k: int = 5, lookback_bars: int = 252) -> list[SwingPivot]:
    total_bars = len(bars)
    if total_bars < 2 * k + 1:
        return []

    pivots: list[SwingPivot] = []
    T = total_bars - 1
    min_index = max(k, T - lookback_bars)
    max_index = T - k

    for i in range(min_index, max_index + 1):
        curr_low = bars[i].low
        curr_high = bars[i].high

        # Swing Low check
        is_swing_low = True
        for j in range(i - k, i):
            if curr_low >= bars[j].low:
                is_swing_low = False
                break
        if is_swing_low:
            for j in range(i + 1, i + k + 1):
                if curr_low > bars[j].low:
                    is_swing_low = False
                    break
        if is_swing_low:
            pivots.append(SwingPivot(
                price=curr_low,
                bar_date=bars[i].bar_date,
                bar_index=i,
                volume=bars[i].volume,
                kind="SWING_LOW",
            ))

        # Swing High check
        is_swing_high = True
        for j in range(i - k, i):
            if curr_high <= bars[j].high:
                is_swing_high = False
                break
        if is_swing_high:
            for j in range(i + 1, i + k + 1):
                if curr_high < bars[j].high:
                    is_swing_high = False
                    break
        if is_swing_high:
            pivots.append(SwingPivot(
                price=curr_high,
                bar_date=bars[i].bar_date,
                bar_index=i,
                volume=bars[i].volume,
                kind="SWING_HIGH",
            ))

    return pivots


def cluster_pivots(pivots: list[SwingPivot], cluster_gap_pct: float = 0.015) -> list[list[SwingPivot]]:
    if not pivots:
        return []
    sorted_pivots = sorted(pivots, key=lambda p: p.price)

    clusters: list[list[SwingPivot]] = [[sorted_pivots[0]]]
    for i in range(1, len(sorted_pivots)):
        prev = sorted_pivots[i - 1]
        curr = sorted_pivots[i]
        gap = (curr.price - prev.price) / prev.price
        if gap <= cluster_gap_pct:
            clusters[-1].append(curr)
        else:
            clusters.append([curr])

    return clusters


def compute_volume_profile(
    bars: list[Bar],
    bins_count: int = 60,
    value_area_pct: float = 0.70,
) -> Optional[VolumeProfileResult]:
    if not bars:
        return None

    min_low = min(b.low for b in bars)
    max_high = max(b.high for b in bars)
    total_volume = sum(b.volume for b in bars)

    if min_low >= max_high or total_volume == 0:
        return None

    bin_width = (max_high - min_low) / bins_count
    bin_volumes = [0.0] * bins_count

    for b in bars:
        if b.volume <= 0:
            continue
        start_bin = max(0, min(bins_count - 1, int(math.floor((b.low - min_low) / bin_width))))
        end_bin = max(0, min(bins_count - 1, int(math.floor((b.high - min_low) / bin_width))))
        if end_bin < start_bin:
            continue
        touched_count = end_bin - start_bin + 1
        vol_per_bin = b.volume / touched_count
        for bi in range(start_bin, end_bin + 1):
            bin_volumes[bi] += vol_per_bin

    # Find POC (highest volume bin midpoint, lowest bin index on ties)
    poc_index = 0
    max_bin_vol = -1.0
    for i in range(bins_count):
        if bin_volumes[i] > max_bin_vol:
            max_bin_vol = bin_volumes[i]
            poc_index = i
    poc = min_low + (poc_index + 0.5) * bin_width

    # Value Area: contiguous expansion around POC until volume reaches desired percentage
    desired_va_vol = total_volume * value_area_pct
    va_volume = bin_volumes[poc_index]
    va_low_index = poc_index
    va_high_index = poc_index

    while va_volume < desired_va_vol and (va_low_index > 0 or va_high_index < bins_count - 1):
        next_lower_vol = bin_volumes[va_low_index - 1] if va_low_index > 0 else -1.0
        next_higher_vol = bin_volumes[va_high_index + 1] if va_high_index < bins_count - 1 else -1.0

        # Reviewer tie-breaker: expansion takes lower neighbor on equal volume
        if next_lower_vol >= next_higher_vol and next_lower_vol >= 0:
            va_low_index -= 1
            va_volume += next_lower_vol
        elif next_higher_vol >= 0:
            va_high_index += 1
            va_volume += next_higher_vol
        elif next_lower_vol >= 0:
            va_low_index -= 1
            va_volume += next_lower_vol
        else:
            break

    val = min_low + va_low_index * bin_width
    vah = min_low + (va_high_index + 1) * bin_width

    return VolumeProfileResult(
        poc=poc,
        vah=vah,
        val=val,
        bin_width=bin_width,
        total_volume=total_volume,
    )


def compute_levels(
    bars: list[Bar],
    rules: Optional[dict[str, Any]] = None,
    rebackfill_needed: bool = False,
) -> LevelsResult:
    config = rules or load_rules()
    levels_rules = config["levels"]

    pivot_half_window = levels_rules["pivotHalfWindow"]
    lookback_bars = levels_rules["lookbackBars"]
    cluster_gap_pct = levels_rules["clusterGapPct"]
    min_pivots = levels_rules["minPivots"]
    zone_min_pct = levels_rules["zoneMinPct"]
    zone_atr_multiple = levels_rules["zoneAtrMultiple"]
    atr_period = levels_rules["atrPeriod"]
    recency_half_life_bars = levels_rules["recencyHalfLifeBars"]
    round_number_range_pct = levels_rules["roundNumberRangePct"]
    gap_min_atr = levels_rules["gapMinAtr"]
    volume_profile_bins = levels_rules["volumeProfileBins"]
    value_area_pct = levels_rules["valueAreaPct"]
    broken_lookback_bars = levels_rules["brokenLookbackBars"]
    large_move_pct = levels_rules["largeMovePct"]
    artifact_move_pct = levels_rules.get("artifactMovePct", 0.40)

    warnings: list[str] = []

    # Sort valid bars ascending by date
    valid_bars = [
        b for b in bars
        if math.isfinite(b.close) and b.close > 0
        and math.isfinite(b.high) and b.high > 0
        and math.isfinite(b.low) and b.low > 0
    ]
    valid_bars.sort(key=lambda b: b.bar_date)

    total_bars = len(valid_bars)
    as_of_date = valid_bars[-1].bar_date if total_bars > 0 else None

    if rebackfill_needed:
        return LevelsResult(
            as_of_date=as_of_date,
            state="SUSPENDED",
            atr14=None,
            atr_percent=None,
            levels=[],
            nearest_support=None,
            nearest_resistance=None,
            risk_distance_atr=None,
            warnings=["Calculations suspended: full price series re-backfill pending."],
        )

    # Detect artifact moves (> 40%)
    latest_artifact_index = -1
    latest_artifact_date: Optional[str] = None
    latest_artifact_move = 0.0

    for i in range(1, total_bars):
        prev_c = valid_bars[i - 1].close
        curr_c = valid_bars[i].close
        change = curr_c / prev_c - 1.0
        abs_change = abs(change)

        if abs_change > artifact_move_pct:
            latest_artifact_index = i
            latest_artifact_date = valid_bars[i].bar_date
            latest_artifact_move = change

        if abs_change > large_move_pct:
            pct_str = f"{'+' if change > 0 else ''}{change * 100:.2f}%"
            warnings.append(
                f"Contains a one-day move of {pct_str} on {valid_bars[i].bar_date}, which may be an unadjusted corporate action."
            )

    # Slice series strictly after latest corporate action artifact
    usable_bars = valid_bars
    if latest_artifact_index >= 0:
        pct_str = f"{'+' if latest_artifact_move > 0 else ''}{latest_artifact_move * 100:.2f}%"
        warnings.append(
            f"Suspected corporate-action artifact of {pct_str} on {latest_artifact_date}: calculations use only subsequent data."
        )
        usable_bars = valid_bars[latest_artifact_index + 1:]

    usable_count = len(usable_bars)
    current_close = usable_bars[-1].close if usable_count > 0 else (valid_bars[-1].close if valid_bars else 0.0)

    # Requires at least atrPeriod (14) bars
    if usable_count < atr_period or total_bars == 0:
        reason_warning = (
            f"Requires at least {atr_period} trading bars after artifact on {latest_artifact_date} to compute price levels; {usable_count} available."
            if latest_artifact_index >= 0
            else f"Requires at least {atr_period} trading bars to compute price levels; {usable_count} available."
        )
        warnings.append(reason_warning)
        return LevelsResult(
            as_of_date=as_of_date,
            state="INSUFFICIENT_HISTORY",
            atr14=None,
            atr_percent=None,
            levels=[],
            nearest_support=None,
            nearest_resistance=None,
            risk_distance_atr=None,
            warnings=list(dict.fromkeys(warnings)),
        )

    atr14 = compute_atr14(usable_bars, atr_period)
    if atr14 is None:
        warnings.append(f"Requires at least {atr_period} trading bars to compute ATR.")
        return LevelsResult(
            as_of_date=as_of_date,
            state="INSUFFICIENT_HISTORY",
            atr14=None,
            atr_percent=None,
            levels=[],
            nearest_support=None,
            nearest_resistance=None,
            risk_distance_atr=None,
            warnings=list(dict.fromkeys(warnings)),
        )

    atr_percent = (atr14 / current_close) if current_close > 0 else 0.0
    levels: list[LevelItem] = []
    T = usable_count - 1

    def build_level_item(
        id_: str,
        price: float,
        kind: str,
        source: str,
        touches: int,
        strength: float,
        first_date: str,
        last_date: str,
        state: str = "INTACT",
        broken_on: Optional[str] = None,
        volume: Optional[float] = None,
    ) -> LevelItem:
        side = "SUPPORT" if price < current_close else "RESISTANCE"
        w = max(zone_min_pct * price, zone_atr_multiple * atr14)
        dist_pct = (current_close - price) / price if price > 0 else 0.0
        dist_atr = ((current_close - price) / atr14) if atr14 > 0 else (math.inf if current_close >= price else -math.inf)
        return LevelItem(
            id=id_,
            price=price,
            kind=kind,
            source=source,
            side=side,
            touches=touches,
            strength=strength,
            first_date=first_date,
            last_date=last_date,
            distance_pct=dist_pct,
            distance_atr=dist_atr,
            zone_low=price - w,
            zone_high=price + w,
            state=state,
            broken_on=broken_on,
            volume=volume,
        )

    # 1. Swing Clusters (requires >= 258 bars)
    required_bars_for_swing = lookback_bars + pivot_half_window + 1
    if usable_count >= required_bars_for_swing:
        pivots = find_swing_pivots(usable_bars, pivot_half_window, lookback_bars)
        clusters = cluster_pivots(pivots, cluster_gap_pct)

        for idx, cluster in enumerate(clusters):
            if len(cluster) < min_pivots:
                continue

            cluster_price_sum = sum(p.price for p in cluster)
            level_price = cluster_price_sum / len(cluster)

            strength = 0.0
            cluster_vol = 0.0
            earliest_date = cluster[0].bar_date
            latest_date = cluster[0].bar_date
            latest_pivot_index = cluster[0].bar_index

            for p in cluster:
                age = T - p.bar_index
                strength += math.pow(0.5, age / recency_half_life_bars)
                cluster_vol += p.volume
                if p.bar_date < earliest_date:
                    earliest_date = p.bar_date
                if p.bar_date > latest_date:
                    latest_date = p.bar_date
                if p.bar_index > latest_pivot_index:
                    latest_pivot_index = p.bar_index

            # Break / Flip analysis
            known_from_bar = latest_pivot_index + pivot_half_window
            check_start = max(T - broken_lookback_bars + 1, known_from_bar)
            w = max(zone_min_pct * level_price, zone_atr_multiple * atr14)

            prior_bar_index = max(0, check_start - 1)
            prior_close = usable_bars[prior_bar_index].close
            if prior_close > level_price:
                prior_side = "SUPPORT"
            elif prior_close < level_price:
                prior_side = "RESISTANCE"
            else:
                latest_p = max(cluster, key=lambda p: p.bar_index)
                prior_side = "SUPPORT" if latest_p.kind == "SWING_LOW" else "RESISTANCE"

            is_broken = False
            broken_on = None

            for bi in range(check_start, T + 1):
                b_close = usable_bars[bi].close
                if prior_side == "SUPPORT" and b_close < level_price - w:
                    is_broken = True
                    broken_on = usable_bars[bi].bar_date
                    break
                elif prior_side == "RESISTANCE" and b_close > level_price + w:
                    is_broken = True
                    broken_on = usable_bars[bi].bar_date
                    break

            state = "INTACT"
            if is_broken:
                curr_side = "SUPPORT" if level_price < current_close else "RESISTANCE"
                state = "FLIPPED" if curr_side != prior_side else "BROKEN"

            levels.append(
                build_level_item(
                    id_=f"swing-{idx}-{level_price:.2f}",
                    price=level_price,
                    kind="SWING",
                    source="Swing Clusters",
                    touches=len(cluster),
                    strength=strength,
                    first_date=earliest_date,
                    last_date=latest_date,
                    state=state,
                    broken_on=broken_on,
                    volume=cluster_vol,
                )
            )
    else:
        warnings.append(
            f"Requires at least {required_bars_for_swing} trading bars to compute swing levels; {usable_count} available."
        )

    # 2. Reference Level: 52-Week High & Low (trailing 365 calendar days)
    last_bar_dt = datetime.strptime(usable_bars[-1].bar_date, "%Y-%m-%d")
    cutoff_dt_str = (last_bar_dt - timedelta(days=365)).strftime("%Y-%m-%d")

    high_52w = -math.inf
    high_52w_date = usable_bars[-1].bar_date
    low_52w = math.inf
    low_52w_date = usable_bars[-1].bar_date

    for i in range(usable_count - 1, -1, -1):
        if usable_bars[i].bar_date <= cutoff_dt_str:
            break
        if usable_bars[i].high > high_52w:
            high_52w = usable_bars[i].high
            high_52w_date = usable_bars[i].bar_date
        if usable_bars[i].low < low_52w:
            low_52w = usable_bars[i].low
            low_52w_date = usable_bars[i].bar_date

    if math.isfinite(high_52w) and high_52w > 0:
        levels.append(
            build_level_item(
                id_=f"ref-52w-high-{high_52w:.2f}",
                price=high_52w,
                kind="52W_HIGH",
                source="52-Week High",
                touches=1,
                strength=1.0,
                first_date=high_52w_date,
                last_date=high_52w_date,
            )
        )

    if math.isfinite(low_52w) and low_52w > 0:
        levels.append(
            build_level_item(
                id_=f"ref-52w-low-{low_52w:.2f}",
                price=low_52w,
                kind="52W_LOW",
                source="52-Week Low",
                touches=1,
                strength=1.0,
                first_date=low_52w_date,
                last_date=low_52w_date,
            )
        )

    # 3. Reference Level: 50-Day SMA
    if usable_count >= 50:
        sum_50 = sum(b.close for b in usable_bars[-50:])
        sma_50 = sum_50 / 50.0
        levels.append(
            build_level_item(
                id_=f"ref-sma50-{sma_50:.2f}",
                price=sma_50,
                kind="SMA_50",
                source="50-Day SMA",
                touches=1,
                strength=1.0,
                first_date=usable_bars[-50].bar_date,
                last_date=usable_bars[-1].bar_date,
            )
        )

    # 4. Reference Level: 200-Day SMA
    if usable_count >= 200:
        sum_200 = sum(b.close for b in usable_bars[-200:])
        sma_200 = sum_200 / 200.0
        levels.append(
            build_level_item(
                id_=f"ref-sma200-{sma_200:.2f}",
                price=sma_200,
                kind="SMA_200",
                source="200-Day SMA",
                touches=1,
                strength=1.0,
                first_date=usable_bars[-200].bar_date,
                last_date=usable_bars[-1].bar_date,
            )
        )

    # 5. Reference Level: Round Numbers (within 15% of close)
    if current_close > 0:
        magnitude = math.pow(10, math.floor(math.log10(current_close)))
        step = magnitude / 2.0
        min_range = current_close * (1.0 - round_number_range_pct)
        max_range = current_close * (1.0 + round_number_range_pct)

        first_step = math.ceil(min_range / step)
        last_step = math.floor(max_range / step)

        for s in range(first_step, last_step + 1):
            rn_price = s * step
            levels.append(
                build_level_item(
                    id_=f"ref-round-{rn_price:.2f}",
                    price=rn_price,
                    kind="ROUND_NUMBER",
                    source="Round Number",
                    touches=1,
                    strength=1.0,
                    first_date=usable_bars[-1].bar_date,
                    last_date=usable_bars[-1].bar_date,
                )
            )

    # 6. Reference Level: Unfilled Gaps (>= 1.0 * ATR14 within lookback)
    if atr14 > 0:
        min_gap_size = gap_min_atr * atr14
        usable_lookback_start = max(0, usable_count - lookback_bars)
        for i in range(max(1, usable_lookback_start), T + 1):
            prev_b = usable_bars[i - 1]
            curr_b = usable_bars[i]

            # Gap Up: low_i > high_{i-1}
            if curr_b.low - prev_b.high >= min_gap_size:
                gap_edge = prev_b.high
                is_filled = any(usable_bars[j].low <= gap_edge for j in range(i + 1, T + 1))
                if not is_filled:
                    levels.append(
                        build_level_item(
                            id_=f"ref-gap-up-{prev_b.bar_date}-{gap_edge:.2f}",
                            price=gap_edge,
                            kind="GAP",
                            source="Unfilled Gap Up Edge",
                            touches=1,
                            strength=1.0,
                            first_date=prev_b.bar_date,
                            last_date=curr_b.bar_date,
                        )
                    )

            # Gap Down: high_i < low_{i-1}
            if prev_b.low - curr_b.high >= min_gap_size:
                gap_edge = prev_b.low
                is_filled = any(usable_bars[j].high >= gap_edge for j in range(i + 1, T + 1))
                if not is_filled:
                    levels.append(
                        build_level_item(
                            id_=f"ref-gap-down-{prev_b.bar_date}-{gap_edge:.2f}",
                            price=gap_edge,
                            kind="GAP",
                            source="Unfilled Gap Down Edge",
                            touches=1,
                            strength=1.0,
                            first_date=prev_b.bar_date,
                            last_date=curr_b.bar_date,
                        )
                    )

    # 7. Reference Level: Volume Profile (over lookback)
    vp_window = usable_bars[max(0, usable_count - lookback_bars):]
    vp = compute_volume_profile(vp_window, volume_profile_bins, value_area_pct)
    if vp:
        levels.append(
            build_level_item(
                id_=f"ref-vp-poc-{vp.poc:.2f}",
                price=vp.poc,
                kind="VOLUME_PROFILE_POC",
                source="Volume Profile POC",
                touches=1,
                strength=1.0,
                first_date=vp_window[0].bar_date,
                last_date=usable_bars[-1].bar_date,
                volume=vp.total_volume,
            )
        )
        levels.append(
            build_level_item(
                id_=f"ref-vp-vah-{vp.vah:.2f}",
                price=vp.vah,
                kind="VOLUME_PROFILE_VAH",
                source="Volume Profile VAH",
                touches=1,
                strength=1.0,
                first_date=vp_window[0].bar_date,
                last_date=usable_bars[-1].bar_date,
            )
        )
        levels.append(
            build_level_item(
                id_=f"ref-vp-val-{vp.val:.2f}",
                price=vp.val,
                kind="VOLUME_PROFILE_VAL",
                source="Volume Profile VAL",
                touches=1,
                strength=1.0,
                first_date=vp_window[0].bar_date,
                last_date=usable_bars[-1].bar_date,
            )
        )

    # Sort levels by distance from current price ascending
    levels.sort(key=lambda l: abs(l.distance_pct))

    # Nearest swing support and resistance (SWING levels only)
    nearest_support: Optional[LevelItem] = None
    nearest_resistance: Optional[LevelItem] = None
    min_support_dist = math.inf
    min_resistance_dist = math.inf

    for lvl in levels:
        if lvl.kind == "SWING":
            if lvl.side == "SUPPORT":
                dist = current_close - lvl.price
                if 0 <= dist < min_support_dist:
                    min_support_dist = dist
                    nearest_support = lvl
            elif lvl.side == "RESISTANCE":
                dist = lvl.price - current_close
                if 0 <= dist < min_resistance_dist:
                    min_resistance_dist = dist
                    nearest_resistance = lvl

    risk_distance_atr = (
        (current_close - nearest_support.price) / atr14
        if nearest_support and atr14 > 0
        else None
    )

    state = "INSUFFICIENT_HISTORY" if usable_count < required_bars_for_swing else "OK"

    return LevelsResult(
        as_of_date=as_of_date,
        state=state,
        atr14=atr14,
        atr_percent=atr_percent,
        levels=levels,
        nearest_support=nearest_support,
        nearest_resistance=nearest_resistance,
        risk_distance_atr=risk_distance_atr,
        warnings=list(dict.fromkeys(warnings)),
    )
