"""STRUCTURE-01: Structure Intelligence Engine.

Provides walk-forward past-only structural level calculation (PDH, PDL, P4HH, P4HL),
proximity detection, and 15m reaction distribution evaluation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, date, time, timedelta
import zoneinfo
from typing import Any, Sequence
import numpy as np
import psycopg

from .session_forward import forward_index_in_session, session_dates_of

INDIA_TZ = zoneinfo.ZoneInfo("Asia/Kolkata")

# Tolerance (as a fraction of price) within which PDH/P4HH (or PDL/P4HL) are
# merged into a single CONFLUENCE_HIGH/LOW level instead of being treated as
# two isolated levels.
#
# Swept across {0.0002, 0.0005, 0.0010, 0.0020} on real BANKNIFTY (Jan-Oct
# 2026, 187 sessions with both PDH/PDL and P4HH/P4HL available) and NIFTY50
# (2024-2026, 209 such sessions) history --
# docs/2026-10-05-confluence-tolerance-calibration.md. Result: BANKNIFTY shows
# no distinguishable REJECTION/SWEEP/NEUTRAL split between merged and isolated
# events at any tested tolerance (chi2 p >= 0.38 throughout). NIFTY50 alone
# shows a nominally low p-value at 3 of 4 tolerances (p=0.031-0.040), but in
# the direction opposite the "stronger reaction zone" hypothesis (merged
# events reject LESS and sweep MORE than isolated ones), does not replicate
# in BANKNIFTY, and does not survive Holm-Bonferroni correction across the 12
# chi2 tests run (smallest raw p=0.0220 against a required ~0.0042). This
# tolerance is therefore a checked-but-arbitrary choice, kept at its original
# 0.0005 -- no tested value is an empirically superior "stronger zone"
# classifier, and the merge concept itself is not shown to add predictive
# value at any tested tolerance.
DEFAULT_CONFLUENCE_TOLERANCE_PCT = 0.0005

def get_db_connection_string() -> str:
    import os
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        raise RuntimeError("DATABASE_URL is not set; refusing to fall back to a built-in credential.")
    return db_url


@dataclass(frozen=True)
class StructuralLevel:
    level_type: str  # 'PDH', 'PDL', 'P4HH', 'P4HL', 'CONFLUENCE_HIGH', 'CONFLUENCE_LOW'
    price: float
    session_date: date
    timeframe_origin: str  # '1d', '4h'


@dataclass
class ProximityEvent:
    symbol: str
    bar_index: int
    bar_time: datetime
    level_type: str
    level_price: float
    bar_open: float
    bar_high: float
    bar_low: float
    bar_close: float
    distance_bps: float
    forward_15m_return_bps: float | None = None
    reaction_type: str | None = None  # 'REJECTION', 'SWEEP', 'NEUTRAL'


@dataclass
class CalibrationSummary:
    symbol: str
    proximity_bandwidth_bps: float
    reaction_threshold_bps: float
    confluence_tolerance_pct: float
    total_sessions: int
    total_5m_bars: int
    total_proximity_events: int
    events_per_session: float
    median_abs_return_15m_event_bps: float
    median_abs_return_15m_control_bps: float
    return_ratio_event_vs_control: float
    rejection_count: int
    rejection_rate_pct: float
    sweep_count: int
    sweep_rate_pct: float
    neutral_count: int
    neutral_rate_pct: float
    by_level_type: dict[str, dict[str, Any]] = field(default_factory=dict)


def fetch_candles(
    symbol: str,
    timeframe: str = "5m",
    start_dt: datetime | None = None,
    end_dt: datetime | None = None,
) -> list[dict[str, Any]]:
    """Fetch complete candles from Postgres DB ordered by close_time."""
    conn_str = get_db_connection_string()
    query = """
        SELECT
            c.id,
            c.open_time,
            c.close_time,
            c.open,
            c.high,
            c.low,
            c.close,
            c.volume
        FROM candles c
        JOIN instruments i ON c.instrument_id = i.id
        WHERE i.symbol = %s
          AND c.timeframe = %s
          AND c.is_complete = TRUE
    """
    params: list[Any] = [symbol, timeframe]
    if start_dt:
        query += " AND c.open_time >= %s"
        params.append(start_dt)
    if end_dt:
        query += " AND c.close_time <= %s"
        params.append(end_dt)
    query += " ORDER BY c.close_time ASC;"

    with psycopg.connect(conn_str) as conn:
        with conn.cursor() as cur:
            cur.execute(query, params)
            rows = cur.fetchall()
            cols = [desc[0] for desc in cur.description]
            return [dict(zip(cols, row)) for row in rows]


def compute_daily_levels(daily_candles: list[dict[str, Any]]) -> dict[date, dict[str, float]]:
    """Compute PDH and PDL for each trading session date strictly using the previous completed daily bar."""
    daily_levels: dict[date, dict[str, float]] = {}
    if not daily_candles:
        return daily_levels

    sorted_daily = sorted(daily_candles, key=lambda c: c["open_time"])
    
    for i in range(1, len(sorted_daily)):
        prev_bar = sorted_daily[i - 1]
        curr_bar = sorted_daily[i]
        curr_dt = curr_bar["open_time"]
        if isinstance(curr_dt, str):
            curr_dt = datetime.fromisoformat(curr_dt)
        if curr_dt.tzinfo is None:
            curr_dt = curr_dt.replace(tzinfo=zoneinfo.ZoneInfo("UTC"))
        curr_ist_date = curr_dt.astimezone(INDIA_TZ).date()

        daily_levels[curr_ist_date] = {
            "PDH": float(prev_bar["high"]),
            "PDL": float(prev_bar["low"]),
        }

    return daily_levels


def compute_4h_levels_from_5m(bars_5m: list[dict[str, Any]]) -> dict[date, dict[str, float]]:
    """Compute prior session's 4H swing high (P4HH) and low (P4HL) strictly from previous session's 5m candles.
    
    For session D, P4HH/P4HL is defined as the High and Low of the afternoon 4H block (13:15 - 15:30) of date D-1.
    If unavailable, falls back to the full previous session's High/Low.
    """
    session_bars: dict[date, list[dict[str, Any]]] = {}
    for bar in bars_5m:
        ot = bar["open_time"]
        if isinstance(ot, str):
            ot = datetime.fromisoformat(ot)
        if ot.tzinfo is None:
            ot = ot.replace(tzinfo=zoneinfo.ZoneInfo("UTC"))
        ist_dt = ot.astimezone(INDIA_TZ)
        d = ist_dt.date()
        session_bars.setdefault(d, []).append({**bar, "ist_dt": ist_dt})

    sorted_dates = sorted(session_bars.keys())
    levels_4h: dict[date, dict[str, float]] = {}

    for i in range(1, len(sorted_dates)):
        prev_date = sorted_dates[i - 1]
        curr_date = sorted_dates[i]
        prev_bars = session_bars[prev_date]

        afternoon_bars = [b for b in prev_bars if b["ist_dt"].time() >= time(13, 15)]
        if not afternoon_bars:
            afternoon_bars = prev_bars

        p4hh = max(float(b["high"]) for b in afternoon_bars)
        p4hl = min(float(b["low"]) for b in afternoon_bars)

        levels_4h[curr_date] = {
            "P4HH": p4hh,
            "P4HL": p4hl,
        }

    return levels_4h


def build_active_levels(
    pdh: float | None,
    p4hh: float | None,
    pdl: float | None,
    p4hl: float | None,
    session_date: date,
    confluence_tolerance_pct: float = DEFAULT_CONFLUENCE_TOLERANCE_PCT,
) -> list[StructuralLevel]:
    """Build a session's active structural levels.

    PDH and P4HH (resp. PDL and P4HL) are merged into a single
    CONFLUENCE_HIGH (resp. CONFLUENCE_LOW) level when they sit within
    `confluence_tolerance_pct` of each other (as a fraction of price);
    otherwise both are kept as isolated levels.
    """
    active_levels: list[StructuralLevel] = []

    if pdh and p4hh and abs(pdh - p4hh) / min(pdh, p4hh) <= confluence_tolerance_pct:
        active_levels.append(StructuralLevel("CONFLUENCE_HIGH", (pdh + p4hh) / 2.0, session_date, "1d+4h"))
    else:
        if pdh:
            active_levels.append(StructuralLevel("PDH", pdh, session_date, "1d"))
        if p4hh:
            active_levels.append(StructuralLevel("P4HH", p4hh, session_date, "4h"))

    if pdl and p4hl and abs(pdl - p4hl) / min(pdl, p4hl) <= confluence_tolerance_pct:
        active_levels.append(StructuralLevel("CONFLUENCE_LOW", (pdl + p4hl) / 2.0, session_date, "1d+4h"))
    else:
        if pdl:
            active_levels.append(StructuralLevel("PDL", pdl, session_date, "1d"))
        if p4hl:
            active_levels.append(StructuralLevel("P4HL", p4hl, session_date, "4h"))

    return active_levels


def compute_confluence_merge_stats(
    daily_levels: dict[date, dict[str, float]],
    levels_4h: dict[date, dict[str, float]],
    confluence_tolerance_pct: float = DEFAULT_CONFLUENCE_TOLERANCE_PCT,
) -> dict[str, int]:
    """Count, across every session where both sides of a pair exist, how many
    sessions merge PDH/P4HH (resp. PDL/P4HL) into CONFLUENCE_HIGH/LOW versus
    stay isolated at the given tolerance. This is a session-level count of
    *eligible pairs*, independent of whether price ever traded near either
    level (contrast with the event-level counts in CalibrationSummary).
    """
    high_merged = high_isolated = low_merged = low_isolated = 0
    for session_date, d_lvl in daily_levels.items():
        h_lvl = levels_4h.get(session_date, {})
        pdh, p4hh = d_lvl.get("PDH"), h_lvl.get("P4HH")
        pdl, p4hl = d_lvl.get("PDL"), h_lvl.get("P4HL")

        if pdh and p4hh:
            if abs(pdh - p4hh) / min(pdh, p4hh) <= confluence_tolerance_pct:
                high_merged += 1
            else:
                high_isolated += 1

        if pdl and p4hl:
            if abs(pdl - p4hl) / min(pdl, p4hl) <= confluence_tolerance_pct:
                low_merged += 1
            else:
                low_isolated += 1

    return {
        "high_merged": high_merged,
        "high_isolated": high_isolated,
        "low_merged": low_merged,
        "low_isolated": low_isolated,
    }


def run_calibration_experiment(
    symbol: str = "BANKNIFTY",
    start_date: date = date(2026, 1, 1),
    end_date: date = date(2026, 6, 30),
    proximity_bandwidth_bps: float = 15.0,
    reaction_threshold_bps: float = 10.0,
    forward_window_bars: int = 3,
    confluence_tolerance_pct: float = DEFAULT_CONFLUENCE_TOLERANCE_PCT,
) -> CalibrationSummary:
    """Run exploratory backtest on calibration window (Jan-Jun 2026 ONLY)."""
    warmup_start = datetime(2025, 12, 1, 0, 0, tzinfo=zoneinfo.ZoneInfo("UTC"))
    cal_end = datetime(end_date.year, end_date.month, end_date.day, 23, 59, 59, tzinfo=zoneinfo.ZoneInfo("UTC"))

    bars_5m = fetch_candles(symbol, timeframe="5m", start_dt=warmup_start, end_dt=cal_end)
    daily_candles = fetch_candles(symbol, timeframe="1d", start_dt=warmup_start, end_dt=cal_end)

    daily_levels = compute_daily_levels(daily_candles)
    levels_4h = compute_4h_levels_from_5m(bars_5m)

    cal_bars: list[dict[str, Any]] = []
    for idx, bar in enumerate(bars_5m):
        ot = bar["open_time"]
        if isinstance(ot, str):
            ot = datetime.fromisoformat(ot)
        if ot.tzinfo is None:
            ot = ot.replace(tzinfo=zoneinfo.ZoneInfo("UTC"))
        ist_dt = ot.astimezone(INDIA_TZ)
        if start_date <= ist_dt.date() <= end_date:
            cal_bars.append({
                "global_idx": idx,
                "bar": bar,
                "ist_dt": ist_dt,
                "date": ist_dt.date(),
            })

    bar_session_dates = session_dates_of(bars_5m)
    session_dates = sorted(list(set(b["date"] for b in cal_bars)))
    total_sessions = len(session_dates)
    total_5m_bars = len(cal_bars)

    events: list[ProximityEvent] = []
    control_15m_returns: list[float] = []
    proximity_bar_indices: set[int] = set()

    for s_date in session_dates:
        d_lvl = daily_levels.get(s_date, {})
        h_lvl = levels_4h.get(s_date, {})

        if not d_lvl and not h_lvl:
            continue

        pdh = d_lvl.get("PDH")
        p4hh = h_lvl.get("P4HH")
        pdl = d_lvl.get("PDL")
        p4hl = h_lvl.get("P4HL")

        active_levels = build_active_levels(pdh, p4hh, pdl, p4hl, s_date, confluence_tolerance_pct)

        triggered_levels_this_session: set[str] = set()

        s_bars = [b for b in cal_bars if b["date"] == s_date]
        for b_item in s_bars:
            g_idx = b_item["global_idx"]
            bar = b_item["bar"]
            b_open = float(bar["open"])
            b_high = float(bar["high"])
            b_low = float(bar["low"])
            b_close = float(bar["close"])

            # The forward bar must be in the SAME IST session: the last `forward_window_bars` bars
            # of a session get no forward return (None) instead of one measured to the next open.
            fwd_idx = forward_index_in_session(bar_session_dates, g_idx, forward_window_bars)
            fwd_return_bps = None
            if fwd_idx is not None:
                fwd_close = float(bars_5m[fwd_idx]["close"])
                fwd_return_bps = ((fwd_close - b_close) / b_close) * 10000.0

            # Unlabelable bar (horizon past the session close, or the end of the data): dropped
            # from the evaluation -- not recorded as a NEUTRAL event and not allowed to consume
            # the level's one-per-session trigger.
            if fwd_return_bps is None:
                continue

            is_prox = False
            for lvl in active_levels:
                if lvl.level_type in triggered_levels_this_session:
                    continue

                if b_low <= lvl.price <= b_high:
                    dist_bps = 0.0
                else:
                    dist_bps = (min(abs(b_high - lvl.price), abs(b_low - lvl.price), abs(b_close - lvl.price)) / lvl.price) * 10000.0

                if dist_bps <= proximity_bandwidth_bps:
                    triggered_levels_this_session.add(lvl.level_type)
                    is_prox = True
                    proximity_bar_indices.add(g_idx)

                    rxn_type = "NEUTRAL"
                    if fwd_return_bps is not None:
                        is_high_lvl = "HIGH" in lvl.level_type or lvl.level_type in ("PDH", "P4HH")
                        is_low_lvl = "LOW" in lvl.level_type or lvl.level_type in ("PDL", "P4HL")

                        if is_high_lvl:
                            if fwd_return_bps <= -reaction_threshold_bps:
                                rxn_type = "REJECTION"
                            elif fwd_return_bps >= reaction_threshold_bps:
                                rxn_type = "SWEEP"
                        elif is_low_lvl:
                            if fwd_return_bps >= reaction_threshold_bps:
                                rxn_type = "REJECTION"
                            elif fwd_return_bps <= -reaction_threshold_bps:
                                rxn_type = "SWEEP"

                    events.append(
                        ProximityEvent(
                            symbol=symbol,
                            bar_index=g_idx,
                            bar_time=b_item["ist_dt"],
                            level_type=lvl.level_type,
                            level_price=lvl.price,
                            bar_open=b_open,
                            bar_high=b_high,
                            bar_low=b_low,
                            bar_close=b_close,
                            distance_bps=dist_bps,
                            forward_15m_return_bps=fwd_return_bps,
                            reaction_type=rxn_type,
                        )
                    )

            if not is_prox and fwd_return_bps is not None:
                control_15m_returns.append(abs(fwd_return_bps))

    total_events = len(events)
    events_per_session = total_events / max(total_sessions, 1)

    event_15m_abs_returns = [
        abs(e.forward_15m_return_bps) for e in events if e.forward_15m_return_bps is not None
    ]

    med_event_ret = float(np.median(event_15m_abs_returns)) if event_15m_abs_returns else 0.0
    med_control_ret = float(np.median(control_15m_returns)) if control_15m_returns else 0.0
    return_ratio = med_event_ret / med_control_ret if med_control_ret > 0 else 1.0

    rejections = [e for e in events if e.reaction_type == "REJECTION"]
    sweeps = [e for e in events if e.reaction_type == "SWEEP"]
    neutrals = [e for e in events if e.reaction_type == "NEUTRAL"]

    rej_count = len(rejections)
    sweep_count = len(sweeps)
    neu_count = len(neutrals)

    rej_pct = (rej_count / total_events * 100.0) if total_events > 0 else 0.0
    sweep_pct = (sweep_count / total_events * 100.0) if total_events > 0 else 0.0
    neu_pct = (neu_count / total_events * 100.0) if total_events > 0 else 0.0

    by_level: dict[str, dict[str, Any]] = {}
    level_types = set(e.level_type for e in events)
    for lt in sorted(level_types):
        lt_events = [e for e in events if e.level_type == lt]
        lt_total = len(lt_events)
        lt_rej = sum(1 for e in lt_events if e.reaction_type == "REJECTION")
        lt_sweep = sum(1 for e in lt_events if e.reaction_type == "SWEEP")
        lt_abs_ret = [abs(e.forward_15m_return_bps) for e in lt_events if e.forward_15m_return_bps is not None]
        by_level[lt] = {
            "total_events": lt_total,
            "rejection_count": lt_rej,
            "rejection_rate_pct": (lt_rej / lt_total * 100.0) if lt_total > 0 else 0.0,
            "sweep_count": lt_sweep,
            "sweep_rate_pct": (lt_sweep / lt_total * 100.0) if lt_total > 0 else 0.0,
            "median_abs_return_15m_bps": float(np.median(lt_abs_ret)) if lt_abs_ret else 0.0,
        }

    return CalibrationSummary(
        symbol=symbol,
        proximity_bandwidth_bps=proximity_bandwidth_bps,
        reaction_threshold_bps=reaction_threshold_bps,
        confluence_tolerance_pct=confluence_tolerance_pct,
        total_sessions=total_sessions,
        total_5m_bars=total_5m_bars,
        total_proximity_events=total_events,
        events_per_session=events_per_session,
        median_abs_return_15m_event_bps=med_event_ret,
        median_abs_return_15m_control_bps=med_control_ret,
        return_ratio_event_vs_control=return_ratio,
        rejection_count=rej_count,
        rejection_rate_pct=rej_pct,
        sweep_count=sweep_count,
        sweep_rate_pct=sweep_pct,
        neutral_count=neu_count,
        neutral_rate_pct=neu_pct,
        by_level_type=by_level,
    )
