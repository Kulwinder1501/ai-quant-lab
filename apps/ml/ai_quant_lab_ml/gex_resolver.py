"""
Point-in-time OptionsContext resolution: the windowed PCR and the real dealer gamma exposure,
for the SAME nearest-unsettled-expiry snapshot.

The expiry-selection, session-hygiene and staleness rules (nearest un-settled expiry per the
real expiry calendar, 09:15-15:30 IST only, >20 minutes old is unavailable) are not
reimplemented here -- they already exist, are shared with the live gate, and are already tested
(ai_quant_lab_ml/option_chain_pcr.py). This module reuses that resolution to pick exactly which
(expiry_date, observed_at) snapshot to price, then fetches that snapshot's full per-strike rows
(option_chain_pcr's own book is OI-summed only; gamma needs every strike's bid/ask) and runs
gex_aggregator's Black-Scholes/IV-solver pipeline on it. PCR and GEX this module returns always
describe the identical snapshot -- never two different polls or two different expiries.
"""

from __future__ import annotations

import dataclasses
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

from ai_quant_lab_ml.gex_aggregator import OptionChainRow, compute_gex_for_expiry
from ai_quant_lab_ml.option_chain_pcr import (
    MAX_SNAPSHOT_AGE_MINUTES,
    OptionChainBooks,
    PcrResolution,
    expiry_settlement,
)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)

_STRIKE_ROWS_SQL = """
    SELECT strike_price, option_type, bid, ask, open_interest
    FROM option_chain_snapshots
    WHERE underlying_symbol = %(underlying_symbol)s
      AND expiry_date = %(expiry_date)s
      AND observed_at = %(observed_at)s
"""


@dataclasses.dataclass(frozen=True)
class OptionsContextResolution:
    state: str  # 'FRESH' | 'UNAVAILABLE' -- see module docstring; master_scanner re-derives STALE/INVALID
    reason: Optional[str]
    pcr_windowed: Optional[float]
    net_dealer_gamma_exposure: Optional[float]
    expiry_date: Optional[Any]
    observed_at: Optional[datetime]
    contracts_priced: int
    contracts_skipped: int


def _unavailable(reason: str) -> OptionsContextResolution:
    return OptionsContextResolution(
        state="UNAVAILABLE", reason=reason, pcr_windowed=None, net_dealer_gamma_exposure=None,
        expiry_date=None, observed_at=None, contracts_priced=0, contracts_skipped=0,
    )


def resolve_options_context(
    connection: Any,
    books: OptionChainBooks,
    underlying_symbol: str,
    spot: float,
    contract_multiplier: int,
    as_of: datetime,
    max_age_minutes: float = MAX_SNAPSHOT_AGE_MINUTES,
    gex_cache: Optional[Dict[Tuple[Any, datetime], Tuple[float, int, int]]] = None,
) -> OptionsContextResolution:
    """
    Resolve both numbers for one decision time. `books` is a pre-loaded
    `option_chain_pcr.OptionChainBooks` for this underlying (load once per instrument, reuse
    across every candle -- loading it per call would re-read the whole options history each time).

    `gex_cache` memoizes GEX by (expiry_date, observed_at): many consecutive candles resolve to
    the SAME snapshot between polls, and re-solving ~100 contracts' IV for each one would be pure
    waste. Pass the same dict across calls for one instrument's whole run.
    """
    resolution: PcrResolution = books.resolve(as_of, max_age_minutes=max_age_minutes)
    if resolution.reason is not None or resolution.book is None:
        return _unavailable(resolution.reason or "NO_SNAPSHOT")
    if not (spot and spot > 0):
        return _unavailable("INVALID_SPOT")

    cache_key = (resolution.expiry_date, resolution.observed_at)
    if gex_cache is not None and cache_key in gex_cache:
        net_gamma, priced, skipped = gex_cache[cache_key]
    else:
        with connection.cursor() as cursor:
            cursor.execute(_STRIKE_ROWS_SQL, {
                "underlying_symbol": underlying_symbol,
                "expiry_date": resolution.expiry_date,
                "observed_at": resolution.observed_at,
            })
            strike_rows = cursor.fetchall()

        # 15:30 IST settlement -- the SAME moment option_chain_pcr.expiry_settlement() uses to
        # decide whether this expiry is even still listed as unsettled. Using midnight UTC
        # instead (~9.5 hours earlier) would under-count time-to-expiry relative to the rule
        # that selected this expiry in the first place.
        expiry_datetime = expiry_settlement(resolution.expiry_date)
        rows = [
            OptionChainRow(
                expiry_date=expiry_datetime,
                strike_price=float(strike_price),
                option_type=option_type,
                bid=float(bid) if bid is not None else None,
                ask=float(ask) if ask is not None else None,
                open_interest=int(open_interest) if open_interest is not None else None,
                observed_at=resolution.observed_at,
            )
            for strike_price, option_type, bid, ask, open_interest in strike_rows
        ]
        if not rows:
            return _unavailable("NO_SNAPSHOT")

        expiry_gex = compute_gex_for_expiry(
            rows, spot=spot, contract_multiplier=contract_multiplier, as_of=as_of,
        )
        net_gamma = expiry_gex.net_dealer_gamma_exposure
        priced = expiry_gex.contracts_priced
        skipped = expiry_gex.contracts_skipped
        if gex_cache is not None:
            gex_cache[cache_key] = (net_gamma, priced, skipped)

    return OptionsContextResolution(
        state="FRESH",
        reason=None,
        pcr_windowed=resolution.pcr_windowed,
        net_dealer_gamma_exposure=net_gamma,
        expiry_date=resolution.expiry_date,
        observed_at=resolution.observed_at,
        contracts_priced=priced,
        contracts_skipped=skipped,
    )
