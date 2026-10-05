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
    directional_bias: str  # 'BULLISH_REJECTION', 'BEARISH_REJECTION', 'BEARISH_SWEEP', 'BULLISH_SWEEP', 'NONE'
    gate_action: str       # 'BUY_CALL_OR_LONG', 'BUY_PUT_OR_SHORT', 'NO_ACTION'
    # Two-level agreement diagnostics (see select_confluent_level):
    second_level_type: str | None = None
    second_level_distance_bps: float | None = None
    levels_agree: bool | None = None  # None = nothing to compare against (0 or 1 level in band)

    def to_dict(self) -> dict:
        return asdict(self)


def _level_side(level_type: str) -> str | None:
    """Classify a structural level as resistance-side ('UP') or support-side ('DOWN').

    Returns None for a level type the gate does not recognize (e.g. 'PDH',
    which the fallback candle-derived path can still emit even though it is
    not wired into UP_LEVELS/DOWN_LEVELS). An unrecognized side can never be
    confirmed to agree with anything.
    """
    if level_type in UP_LEVELS:
        return "UP"
    if level_type in DOWN_LEVELS:
        return "DOWN"
    return None


@dataclass(frozen=True)
class LevelSelection:
    is_proximate: bool
    nearest_level_type: str | None
    nearest_level_price: float | None
    distance_bps: float | None
    second_level_type: str | None
    second_level_price: float | None
    second_distance_bps: float | None
    levels_agree: bool | None


def select_confluent_level(
    levels: list[tuple[str, float]],
    spot_price: float,
    bandwidth_bps: float,
) -> LevelSelection:
    """Rank active levels by distance from spot and check two-level agreement.

    Previously the gate tracked only the single nearest level and acted on it
    alone, even when another active level nearby pointed the other way (e.g.
    spot 10bps from a SESSION_HIGH but also 15bps from a contradictory
    SWING_LOW). This function fixes that: it looks at the two nearest active
    levels and, when both are within `bandwidth_bps` of spot, requires them to
    agree on structural side (resistance/'UP' vs support/'DOWN') before the
    selection is treated as actionable.

    Edge cases (explicit, not accidental):
    - Zero levels at all, or the nearest level is further than
      `bandwidth_bps` away: not proximate at all. `levels_agree` is None
      (there is nothing to agree or disagree about). Unchanged from the
      pre-fix behavior.
    - Exactly one level within the band (no second level close enough to
      compare): the single level is still fully usable on its own -- this
      fix adds a second check, it does not remove the single-level path.
      `levels_agree` is None here too, meaning "not applicable", which the
      caller must not confuse with False ("checked, and they disagree").
    - Two or more levels, and the second-nearest is also within the band:
      compare sides. Agreement -> proceed using the nearest level as before.
      Disagreement -> proximate=True but the caller must report a neutral /
      no-signal outcome instead of acting on the nearer level alone.
    """
    candidates: list[tuple[float, str, float]] = []
    for lvl_type, lvl_price in levels:
        if lvl_price <= 0:
            continue
        dist_bps = abs(spot_price - lvl_price) / lvl_price * 10_000.0
        candidates.append((dist_bps, lvl_type, lvl_price))

    if not candidates:
        return LevelSelection(
            is_proximate=False,
            nearest_level_type=None,
            nearest_level_price=None,
            distance_bps=None,
            second_level_type=None,
            second_level_price=None,
            second_distance_bps=None,
            levels_agree=None,
        )

    candidates.sort(key=lambda c: c[0])
    nearest_dist, nearest_type, nearest_price = candidates[0]

    if nearest_dist > bandwidth_bps:
        return LevelSelection(
            is_proximate=False,
            nearest_level_type=nearest_type,
            nearest_level_price=nearest_price,
            distance_bps=round(nearest_dist, 2),
            second_level_type=None,
            second_level_price=None,
            second_distance_bps=None,
            levels_agree=None,
        )

    # candidates is sorted ascending, so candidates[1] (if any) is the
    # second-nearest level overall -- no need to scan further.
    second = candidates[1] if len(candidates) > 1 else None
    if second is None or second[0] > bandwidth_bps:
        return LevelSelection(
            is_proximate=True,
            nearest_level_type=nearest_type,
            nearest_level_price=nearest_price,
            distance_bps=round(nearest_dist, 2),
            second_level_type=None,
            second_level_price=None,
            second_distance_bps=None,
            levels_agree=None,  # only one level nearby: nothing to compare
        )

    second_dist, second_type, second_price = second
    nearest_side = _level_side(nearest_type)
    second_side = _level_side(second_type)
    agree = nearest_side is not None and nearest_side == second_side

    return LevelSelection(
        is_proximate=True,
        nearest_level_type=nearest_type,
        nearest_level_price=nearest_price,
        distance_bps=round(nearest_dist, 2),
        second_level_type=second_type,
        second_level_price=second_price,
        second_distance_bps=round(second_dist, 2),
        levels_agree=agree,
    )


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

    # liquidity_pool_candidates has no `status` column; a level is active as of
    # as_of_time when it was already knowable (known_at_time <= as_of_time) and
    # not yet invalidated by that time. `created_at` is just the row's insertion
    # timestamp (DEFAULT CURRENT_TIMESTAMP, stamped in per-run batches by
    # generate-liquidity-candidates.ts) and is not safe for walk-forward filtering.
    query = """
        SELECT pool_type, price
        FROM liquidity_pool_candidates
        WHERE symbol = %s
          AND known_at_time <= %s
          AND (invalidated_at_time IS NULL OR invalidated_at_time > %s)
          AND pool_type IN ('PDL', 'SWING_HIGH', 'SWING_LOW', 'SESSION_HIGH', 'SESSION_LOW', 'ITH', 'ITL')
        ORDER BY known_at_time DESC
        LIMIT 50;
    """
    with conn.cursor() as cur:
        cur.execute(query, (symbol, as_of_time, as_of_time))
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

    # 1. Fetch active levels, rank by proximity, and require two-level agreement
    levels = fetch_active_structural_levels(conn, symbol, as_of_time)
    selection = select_confluent_level(levels, spot_price, bandwidth_bps)

    if not selection.is_proximate:
        return ConfluenceGateSignal(
            is_level_proximate=False,
            nearest_level_type=selection.nearest_level_type,
            nearest_level_price=selection.nearest_level_price,
            distance_bps=selection.distance_bps,
            raw_di=None,
            di_tilde=None,
            directional_bias="NONE",
            gate_action="NO_ACTION",
            second_level_type=None,
            second_level_distance_bps=None,
            levels_agree=None,
        )

    if selection.levels_agree is False:
        # Two nearby levels contradict each other -- report neutral rather
        # than acting on the nearer one alone (the core fix).
        return ConfluenceGateSignal(
            is_level_proximate=True,
            nearest_level_type=selection.nearest_level_type,
            nearest_level_price=selection.nearest_level_price,
            distance_bps=selection.distance_bps,
            raw_di=None,
            di_tilde=None,
            directional_bias="NONE",
            gate_action="NO_ACTION",
            second_level_type=selection.second_level_type,
            second_level_distance_bps=selection.second_distance_bps,
            levels_agree=False,
        )

    best_level_type = selection.nearest_level_type
    best_level_price = selection.nearest_level_price
    min_dist_bps = selection.distance_bps

    # 2. Fetch depth imbalance
    raw_di, di_tilde = fetch_latest_depth_di(conn, as_of_time)

    if di_tilde is None:
        return ConfluenceGateSignal(
            is_level_proximate=True,
            nearest_level_type=best_level_type,
            nearest_level_price=best_level_price,
            distance_bps=min_dist_bps,
            raw_di=None,
            di_tilde=None,
            directional_bias="NONE",
            gate_action="NO_ACTION",
            second_level_type=selection.second_level_type,
            second_level_distance_bps=selection.second_distance_bps,
            levels_agree=selection.levels_agree,
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
        distance_bps=min_dist_bps,
        raw_di=round(raw_di, 4) if raw_di is not None else None,
        di_tilde=round(di_tilde, 4) if di_tilde is not None else None,
        directional_bias=bias,
        gate_action=action,
        second_level_type=selection.second_level_type,
        second_level_distance_bps=selection.second_distance_bps,
        levels_agree=selection.levels_agree,
    )
