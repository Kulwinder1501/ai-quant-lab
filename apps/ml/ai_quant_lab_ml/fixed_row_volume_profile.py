"""Fixed-row volume profile (frvp-rows48-v2) — Python port of the TypeScript definition.

Normative source: apps/api/src/modules/market-data/domain/fixed-row-volume-profile.ts
Protocol: docs/2026-10-13-frvp-rows-observation-protocol.md

Volume is futures contracts placed on the same minute's index high-low range.
This is a bar-volume allocation (VP_PRICE_VOLUME_ONLY), not trade-by-trade VAP.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Sequence

VOLUME_PROFILE_ALGORITHM_VERSION = "frvp-rows48-v2"
VOLUME_PROFILE_ROWS = 48
VALUE_AREA_FRACTION = 0.7
HVN_MIN_SHARE_OF_POC = 0.5
LVN_MAX_SHARE_OF_SIDE_PEAK = 0.5

ProfileShape = Literal["P", "b", "D", "B"]
ProfilePosition = Literal["INSIDE_VALUE", "ABOVE_VAH", "BELOW_VAL"]


@dataclass(frozen=True)
class ProfileBar:
    high: float
    low: float
    close: float
    volume: float


@dataclass(frozen=True)
class VolumeProfile:
    algorithm_version: str
    row_count: int
    row_width: float
    low: float
    high: float
    row_volumes: tuple[float, ...]
    total_volume: float
    poc: float
    vah: float
    val: float
    hvns: tuple[float, ...]
    lvns: tuple[float, ...]
    vwap: float
    volume_centroid: float


def _same_volume(a: float, b: float) -> bool:
    return abs(a - b) <= 1e-9 * max(1.0, abs(a), abs(b))


def _row_centre(low: float, row_width: float, index: int) -> float:
    return low + (index + 0.5) * row_width


def _point_of_control_row(
    row_volumes: Sequence[float],
    low: float,
    row_width: float,
    vwap: float,
) -> int:
    peak = max(row_volumes)
    best = -1
    for row, vol in enumerate(row_volumes):
        if not _same_volume(vol, peak):
            continue
        if best < 0 or abs(_row_centre(low, row_width, row) - vwap) < abs(
            _row_centre(low, row_width, best) - vwap
        ):
            best = row
    return best


def _value_area_rows(
    row_volumes: Sequence[float],
    poc_row: int,
    total_volume: float,
) -> tuple[int, int]:
    target = VALUE_AREA_FRACTION * total_volume
    lower = poc_row
    upper = poc_row
    running = row_volumes[poc_row]
    last = len(row_volumes) - 1

    while running < target and (lower > 0 or upper < last):
        up_pair = (
            row_volumes[upper + 1] + (row_volumes[upper + 2] if upper + 1 < last else 0)
            if upper < last
            else -1.0
        )
        down_pair = (
            row_volumes[lower - 1] + (row_volumes[lower - 2] if lower - 1 > 0 else 0)
            if lower > 0
            else -1.0
        )
        if up_pair > down_pair:
            upper = min(last, upper + 2)
            running += up_pair
        else:
            lower = max(0, lower - 2)
            running += down_pair
    return lower, upper


def _find_nodes(row_volumes: Sequence[float], poc_row: int) -> tuple[list[int], list[int]]:
    poc_volume = row_volumes[poc_row]
    hvn_rows: list[int] = []
    lvn_rows: list[int] = []
    last = len(row_volumes) - 1
    start = 0
    while start <= last:
        end = start
        while end < last and _same_volume(row_volumes[end + 1], row_volumes[start]):
            end += 1
        volume = row_volumes[start]
        middle = (start + end) // 2
        left_of = row_volumes[start - 1] if start > 0 else None
        right_of = row_volumes[end + 1] if end < last else None

        is_local_max = (left_of is None or (volume > left_of and not _same_volume(volume, left_of))) and (
            right_of is None or (volume > right_of and not _same_volume(volume, right_of))
        )
        is_local_min = left_of is not None and right_of is not None and volume < left_of and volume < right_of

        if is_local_max and volume >= HVN_MIN_SHARE_OF_POC * poc_volume:
            hvn_rows.append(middle)
        if is_local_min:
            peak_below = max(row_volumes[:start])
            peak_above = max(row_volumes[end + 1 :])
            if volume < LVN_MAX_SHARE_OF_SIDE_PEAK * min(peak_below, peak_above):
                lvn_rows.append(middle)
        start = end + 1
    return hvn_rows, lvn_rows


def build_fixed_row_volume_profile(
    bars: Sequence[ProfileBar],
    row_count: int = VOLUME_PROFILE_ROWS,
) -> VolumeProfile | None:
    usable = [
        b
        for b in bars
        if b.volume > 0
        and b.high == b.high
        and b.low == b.low
        and b.high >= b.low
    ]
    if not usable or row_count < 3:
        return None

    low = min(b.low for b in usable)
    high = max(b.high for b in usable)
    if not (high > low):
        return None

    row_width = (high - low) / row_count
    row_volumes = [0.0] * row_count
    notional = 0.0
    total_volume = 0.0

    for bar in usable:
        first = min(row_count - 1, max(0, int((bar.low - low) / row_width)))
        if bar.high == bar.low:
            row_volumes[first] += bar.volume
        else:
            span = bar.high - bar.low
            last = min(row_count - 1, max(0, int((bar.high - low) / row_width)))
            for row in range(first, last + 1):
                row_bottom = low + row * row_width
                overlap = min(bar.high, row_bottom + row_width) - max(bar.low, row_bottom)
                if overlap > 0:
                    row_volumes[row] += bar.volume * (overlap / span)
        notional += ((bar.high + bar.low + bar.close) / 3.0) * bar.volume
        total_volume += bar.volume

    if total_volume <= 0:
        return None

    vwap = notional / total_volume
    centroid_notional = sum(
        row_volumes[row] * _row_centre(low, row_width, row) for row in range(row_count)
    )
    poc_row = _point_of_control_row(row_volumes, low, row_width, vwap)
    val_row, vah_row = _value_area_rows(row_volumes, poc_row, total_volume)
    hvn_rows, lvn_rows = _find_nodes(row_volumes, poc_row)

    return VolumeProfile(
        algorithm_version=VOLUME_PROFILE_ALGORITHM_VERSION,
        row_count=row_count,
        row_width=row_width,
        low=low,
        high=high,
        row_volumes=tuple(row_volumes),
        total_volume=total_volume,
        poc=_row_centre(low, row_width, poc_row),
        val=low + val_row * row_width,
        vah=low + (vah_row + 1) * row_width,
        hvns=tuple(_row_centre(low, row_width, r) for r in hvn_rows),
        lvns=tuple(_row_centre(low, row_width, r) for r in lvn_rows),
        vwap=vwap,
        volume_centroid=centroid_notional / total_volume,
    )


def position_vs_value(profile: VolumeProfile, price: float) -> ProfilePosition:
    if price > profile.vah:
        return "ABOVE_VAH"
    if price < profile.val:
        return "BELOW_VAL"
    return "INSIDE_VALUE"
