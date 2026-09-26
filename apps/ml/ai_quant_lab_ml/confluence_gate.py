"""Production Directional Confluence Gate Module.

Integrates:
1. STRUCTURE-01 Structural Proximity Gate (<= 15.0 bps from key levels)
2. ORDERBOOK-01 Depth Imbalance Gate (DI_tilde = -DI > 0)

Provides a clean API for live prediction engines, shadow runners, and trading bots:
- evaluate_confluence_signal(conn, symbol, spot_price, as_of_time, bandwidth_bps=15.0)
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, date
import zoneinfo
import psycopg

INDIA_TZ = zoneinfo.ZoneInfo("Asia/Kolkata")

TIER1_REVERSAL_LEVELS = {"SWING_HIGH", "SWING_LOW", "ITH", "ITL", "SESSION_HIGH", "SESSION_LOW"}
TIER2_MOMENTUM_LEVELS = {"PDL"}
UP_LEVELS = {"SWING_HIGH", "ITH", "SESSION_HIGH"}
DOWN_LEVELS = {"SWING_LOW", "ITL", "SESSION_LOW", "PDL"}


@dataclass(frozen=True)
class ConfluenceGateSignal:
    is_level_proximate: bool
    nearest_level_type: str | None
    nearest_level_price: float | None
    distance_bps: float | None
    raw_di: float | None
    di_tilde: float | None
    directional_bias: str  # 'BULLISH_REJECTION', 'BEARISH_REJECTION', 'BEARISH_SWEEP', 'NONE'
    gate_action: str       # 'BUY_CALL_OR_LONG', 'BUY_PUT_OR_SHORT', 'NO_ACTION'

    def to_dict(self) -> dict:
        return asdict(self)


def fetch_latest_depth_di(conn: psycopg.Connection, as_of_time: datetime) -> tuple[float | None, float | None]:
    """Fetch nearest L2 depth frame received <= as_of_time + 1s (within 5 seconds)."""
    max_allowed = as_of_time + timedelta(seconds=1)
    min_allowed = as_of_time - timedelta(seconds=5)

    query = """
        SELECT total_buy_qty, total_sell_qty
        FROM depth_frames
        WHERE received_at >= %s AND received_at <= %s
        ORDER BY received_at DESC
        LIMIT 1;
    """
    with conn.cursor() as cur:
        cur.execute(query, (min_allowed, max_allowed))
        row = cur.fetchone()

    if not row:
        return None, None

    tb, ts = float(row[0]), float(row[1])
    if tb + ts == 0:
        return None, None

    raw_di = (tb - ts) / (tb + ts)
    di_tilde = -raw_di
    return raw_di, di_tilde


def fetch_active_structural_levels(conn: psycopg.Connection, symbol: str, as_of_time: datetime) -> list[tuple[str, float]]:
    """Fetch recent active structural level candidates from liquidity_pool_candidates or daily/4H candles."""
    as_of_ist = as_of_time.astimezone(INDIA_TZ) if as_of_time.tzinfo else as_of_time.replace(tzinfo=INDIA_TZ)
    session_date = as_of_ist.date()

    query = """
        SELECT pool_type, price
        FROM liquidity_pool_candidates
        WHERE status = 'ACTIVE'
          AND created_at <= %s
          AND pool_type IN ('PDL', 'SWING_HIGH', 'SWING_LOW', 'SESSION_HIGH', 'SESSION_LOW', 'ITH', 'ITL')
        ORDER BY created_at DESC
        LIMIT 50;
    """
    with conn.cursor() as cur:
        cur.execute(query, (as_of_time,))
        rows = cur.fetchall()

    if rows:
        return [(str(r[0]), float(r[1])) for r in rows]

    # Fallback to computing from daily candles if candidates table is empty
    warmup_start = as_of_time - timedelta(days=30)
    query_candles = """
        SELECT c.open_time, c.high, c.low, c.close
        FROM candles c JOIN instruments i ON i.id = c.instrument_id
        WHERE i.symbol = %s AND c.timeframe = '1d' AND c.open_time < %s
        ORDER BY c.open_time DESC LIMIT 2;
    """
    with conn.cursor() as cur:
        cur.execute(query_candles, (symbol, as_of_time))
        c_rows = cur.fetchall()

    levels = []
    if c_rows:
        prev_bar = c_rows[0]
        levels.append(("PDH", float(prev_bar[1])))
        levels.append(("PDL", float(prev_bar[2])))

    return levels


def evaluate_confluence_signal(
    conn: psycopg.Connection,
    symbol: str,
    spot_price: float,
    as_of_time: datetime,
    bandwidth_bps: float = 15.0,
) -> ConfluenceGateSignal:
    """Evaluate directional confluence gate signal for a given spot price and timestamp."""
    if spot_price <= 0:
        return ConfluenceGateSignal(
            is_level_proximate=False,
            nearest_level_type=None,
            nearest_level_price=None,
            distance_bps=None,
            raw_di=None,
            di_tilde=None,
            directional_bias="NONE",
            gate_action="NO_ACTION",
        )

    # 1. Fetch active levels & check proximity
    levels = fetch_active_structural_levels(conn, symbol, as_of_time)
    best_level_type = None
    best_level_price = None
    min_dist_bps = float("inf")

    for lvl_type, lvl_price in levels:
        if lvl_price <= 0:
            continue
        dist_bps = abs(spot_price - lvl_price) / lvl_price * 10_000.0
        if dist_bps < min_dist_bps:
            min_dist_bps = dist_bps
            best_level_type = lvl_type
            best_level_price = lvl_price

    is_proximate = min_dist_bps <= bandwidth_bps

    if not is_proximate or best_level_type is None:
        return ConfluenceGateSignal(
            is_level_proximate=False,
            nearest_level_type=best_level_type,
            nearest_level_price=best_level_price,
            distance_bps=round(min_dist_bps, 2) if min_dist_bps < 99999 else None,
            raw_di=None,
            di_tilde=None,
            directional_bias="NONE",
            gate_action="NO_ACTION",
        )

    # 2. Fetch depth imbalance
    raw_di, di_tilde = fetch_latest_depth_di(conn, as_of_time)

    if di_tilde is None:
        return ConfluenceGateSignal(
            is_level_proximate=True,
            nearest_level_type=best_level_type,
            nearest_level_price=best_level_price,
            distance_bps=round(min_dist_bps, 2),
            raw_di=None,
            di_tilde=None,
            directional_bias="NONE",
            gate_action="NO_ACTION",
        )

    # 3. Determine directional bias based on ORDERBOOK-01 frozen spec rules:
    # di_tilde > 0 (sell-side dominance) predicts bearish bias at the level.
    # At UP levels (resistance): bearish bias = price bounces -> REJECTION (SELL / BUY_PUT)
    # At DOWN levels (support):
    #   - Tier 1 (SWING_LOW, ITL, SESSION_LOW): di_tilde > 0 -> REJECTION (BUY_CALL / BULLISH)
    #   - Tier 2 (PDL): di_tilde > 0 -> SWEEP through support (BUY_PUT / BEARISH)

    bias = "NONE"
    action = "NO_ACTION"

    if best_level_type in UP_LEVELS:
        if di_tilde > 0:
            bias = "BEARISH_REJECTION"
            action = "BUY_PUT_OR_SHORT"
        else:
            bias = "BULLISH_SWEEP"
            action = "BUY_CALL_OR_LONG"

    elif best_level_type in TIER1_REVERSAL_LEVELS:
        if di_tilde > 0:
            bias = "BULLISH_REJECTION"
            action = "BUY_CALL_OR_LONG"
        else:
            bias = "BEARISH_SWEEP"
            action = "BUY_PUT_OR_SHORT"

    elif best_level_type in TIER2_MOMENTUM_LEVELS:  # PDL
        if di_tilde > 0:
            bias = "BEARISH_SWEEP"
            action = "BUY_PUT_OR_SHORT"
        else:
            bias = "BULLISH_REJECTION"
            action = "BUY_CALL_OR_LONG"

    return ConfluenceGateSignal(
        is_level_proximate=True,
        nearest_level_type=best_level_type,
        nearest_level_price=best_level_price,
        distance_bps=round(min_dist_bps, 2),
        raw_di=round(raw_di, 4) if raw_di is not None else None,
        di_tilde=round(di_tilde, 4) if di_tilde is not None else None,
        directional_bias=bias,
        gate_action=action,
    )
