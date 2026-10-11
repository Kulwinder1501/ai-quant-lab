"""
Shared, causal depth-imbalance (DI) plumbing for the ORDERBOOK-01 research scripts.

One implementation used by ``run_orderbook01_oos.py``, ``run_orderbook01_experiment.py`` and
``run_orderbook01_feature_select.py`` so that all three agree with each other and with the live gate
(``apps/api/.../orderbook-directional-gate.ts``) on:

* SIGN CONVENTION -- ``di_tilde = -DI`` UNIFORMLY for every level type and tier
  (docs/2026-09-25-orderbook-directional-gate-confluence.md). ``di_tilde > 0`` (sell-heavy depth)
  predicts REJECTION at Tier-1 levels and a SWEEP at PDL. Do not flip the sign per level side.
* CAUSAL WITHIN-DAY STANDARDISATION -- raw DI = (buy - sell) / (buy + sell) from the total
  buy/sell quantities is almost a per-day constant (on most days total_buy > total_sell in only
  0-2% of frames, mean DI -0.15 to -0.41), so ``di_tilde > 0`` was effectively always true or always
  false for a whole day. ``causal_detrend_di`` subtracts the trailing mean of the previous
  ``DI_WINDOW_MINUTES`` COMPLETE minutes (last DI of each minute; minimum
  ``DI_MIN_HISTORY_MINUTES`` populated minutes) BEFORE any sign or threshold is taken, and returns
  ``None`` -- never 0 -- when there is not enough past data. The window is an a-priori documented
  choice, not tuned against outcomes. Mirrors ``causalStandardiseDi`` /
  ``trailingMinuteDiSamples`` in the TypeScript gate.
* MISSING DATA IS MISSING -- a frame without total_buy_qty / total_sell_qty (or with both zero) has
  no DI and is skipped; it is never turned into DI = 0.
* ONE POPULATION -- depth comes only from the front-month BANKNIFTY futures contract for the day
  (``contract_for_date``); option-book frames and other contracts are excluded.
* INDEPENDENCE -- events are collapsed to one per level-day before testing
  (``collapse_to_level_days``); the effective independent n is the number of distinct level-days.
* PAST-ONLY MATCHING -- ``latest_value_at_or_before`` never looks after the query time.
"""

from __future__ import annotations

from bisect import bisect_right
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from ai_quant_lab_ml.cks_ofi_touch import contract_for_date, recompute_sequence_flags

DI_WINDOW_MINUTES = 30
DI_MIN_HISTORY_MINUTES = 10

# Population filters the OOS / experiment scripts apply by default.
DEFAULT_SYMBOL = "BANKNIFTY"
DEFAULT_TIMEFRAME = "5m"
LABELING_VERSION_LEGACY = "v1-legacy"
LABELING_VERSION_CAUSAL = "v2-causal"
CANDIDATE_VERSION_DEDUP = "v2-dedup"

# v2-causal labels are built from 1m bars that must CLOSE inside the horizon, so the finest honest
# horizon is 60s; there is no 30s label. Legacy labels did have a (mislabelled) 30s horizon.
TIER1_HORIZON_SECONDS = 300
TIER2_HORIZON_SECONDS_BY_LABELING_VERSION = {
    LABELING_VERSION_LEGACY: 30,
    LABELING_VERSION_CAUSAL: 60,
}


def raw_depth_imbalance(total_buy: Optional[float], total_sell: Optional[float]) -> Optional[float]:
    """(buy - sell) / (buy + sell); None when either total is missing or both are zero."""
    if total_buy is None or total_sell is None:
        return None
    total = float(total_buy) + float(total_sell)
    if total <= 0:
        return None
    return (float(total_buy) - float(total_sell)) / total


def causal_detrend_di(
    times: Sequence[datetime],
    dis: Sequence[Optional[float]],
    window_minutes: int = DI_WINDOW_MINUTES,
    min_history_minutes: int = DI_MIN_HISTORY_MINUTES,
) -> List[Optional[float]]:
    """
    Per-frame ``DI - mean(trailing complete-minute DI)``, or None while history is insufficient.

    ``times`` must be ascending; ``dis`` may contain None (skipped, not zero-filled). For a frame in
    minute M the history is the LAST DI of each complete minute in [M - window, M - 1]; the current
    minute and everything later are never read.
    """
    if len(times) != len(dis):
        raise ValueError("times and dis must have the same length")

    last_per_minute: Dict[int, float] = {}
    minutes: List[int] = []
    for t, di in zip(times, dis):
        minute = int(t.timestamp() // 60)
        minutes.append(minute)
        if di is not None:
            last_per_minute[minute] = float(di)  # ascending input => last write is the last frame

    mean_cache: Dict[int, Optional[float]] = {}

    def trailing_mean(minute: int) -> Optional[float]:
        if minute in mean_cache:
            return mean_cache[minute]
        samples = [
            last_per_minute[m]
            for m in range(minute - window_minutes, minute)
            if m in last_per_minute
        ]
        value = sum(samples) / len(samples) if len(samples) >= min_history_minutes else None
        mean_cache[minute] = value
        return value

    out: List[Optional[float]] = []
    for minute, di in zip(minutes, dis):
        if di is None:
            out.append(None)
            continue
        mean = trailing_mean(minute)
        out.append(None if mean is None else float(di) - mean)
    return out


def latest_value_at_or_before(
    times: Sequence[datetime],
    values: Sequence[Optional[float]],
    query_time: datetime,
    max_gap_seconds: float = 5.0,
) -> Optional[Tuple[float, float]]:
    """
    (value, lag_seconds) of the most recent frame with ``time <= query_time`` and a non-None value,
    no older than ``max_gap_seconds``. PAST-ONLY: a frame after ``query_time`` is never returned,
    even if it is nearer. Returns None when nothing qualifies.
    """
    idx = bisect_right(times, query_time) - 1
    while idx >= 0:
        lag = (query_time - times[idx]).total_seconds()
        if lag > max_gap_seconds:
            return None
        value = values[idx]
        if value is not None:
            return float(value), lag
        idx -= 1
    return None


def level_day_key(event: Dict[str, Any]) -> Tuple[Any, ...]:
    """One level-day: (symbol, timeframe, pool_type, level price, session date of the contact)."""
    contact = event["contact_time"]
    session_date = event.get("session_date") or contact.date()
    return (
        event.get("symbol"),
        event.get("timeframe"),
        event["pool_type"],
        round(float(event["level_price"]), 4),
        session_date,
    )


def collapse_to_level_days(events: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Keep only the EARLIEST contact event of each level-day. Several contacts of one level on one day
    are the same market situation observed repeatedly, not independent samples; testing them as if
    they were i.i.d. overstates significance. The length of the result is the effective independent n.
    """
    first: Dict[Tuple[Any, ...], Dict[str, Any]] = {}
    for ev in events:
        key = level_day_key(ev)
        if key not in first or ev["contact_time"] < first[key]["contact_time"]:
            first[key] = ev
    return sorted(first.values(), key=lambda e: e["contact_time"])


def fetch_front_month_depth_rows(
    conn: Any,
    start_dt: datetime,
    end_dt: datetime,
    session_date: str,
    include_levels: bool = False,
) -> List[Dict[str, Any]]:
    """
    Front-month BANKNIFTY-futures depth frames in [start_dt, end_dt), ascending by received_at, with
    duplicates and sequence resets removed using flags RECOMPUTED from ``sequence_no`` (the stored
    ``is_regression`` is wrong on days with a reset-without-snapshot: every later frame is flagged).

    Returns ``[]`` when no captured contract covers ``session_date`` (never a different contract or an
    option book). Each row: received_at, total_buy_qty / total_sell_qty (float or None -- missing stays
    None), and with ``include_levels`` also bid_qty / ask_qty lists.
    """
    symbol = contract_for_date(session_date)
    if symbol is None:
        return []
    cols = "received_at, sequence_no, is_snapshot, total_buy_qty, total_sell_qty"
    if include_levels:
        cols += ", bid_qty, ask_qty"
    query = f"""
        SELECT {cols}
        FROM depth_frames
        WHERE provider_symbol = %s
          AND received_at >= %s AND received_at < %s
        ORDER BY received_at ASC, sequence_no ASC NULLS LAST
    """
    with conn.cursor() as cur:
        cur.execute(query, (symbol, start_dt, end_dt))
        rows = cur.fetchall()

    flags = recompute_sequence_flags(
        [(None if r[1] is None else int(r[1]), bool(r[2])) for r in rows]
    )
    out: List[Dict[str, Any]] = []
    for r, (_gap, is_dup, is_reg) in zip(rows, flags):
        if is_dup or is_reg:
            continue
        item: Dict[str, Any] = {
            "received_at": r[0],
            "total_buy_qty": None if r[3] is None else float(r[3]),
            "total_sell_qty": None if r[4] is None else float(r[4]),
        }
        if include_levels:
            item["bid_qty"] = r[5] or []
            item["ask_qty"] = r[6] or []
        out.append(item)
    return out
