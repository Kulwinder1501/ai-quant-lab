"""
Tests for ai_quant_lab_ml.gex_aggregator: the Black-Scholes/IV-solver/parity-forward port
(must agree with packages/pricing/src/index.ts on known values) and the GEX aggregation
built on top of it (must get the sign, the skip accounting, and the PCR ratio right).
"""

from datetime import datetime, timedelta, timezone

import pytest

from ai_quant_lab_ml.gex_aggregator import (
    OptionChainRow,
    aggregate_gex,
    compute_gex_for_expiry,
    effective_spot_for_forward,
    implied_forward_from_parity,
    implied_volatility_from_premium,
    mid_price_for_iv,
    price_european_option,
    ParityPair,
)


# ------------------------------------------------------------------ Black-Scholes pricer


def test_atm_call_matches_hand_derived_black_scholes_value():
    # Spot=strike=100, r=0.065, sigma=0.20, T=0.25y. Hand-derived: d1=0.2125, d2=0.1125,
    # N(d1)=0.5841, N(d2)=0.5448, discount=exp(-0.065*0.25)=0.98388 ->
    # premium = 100*0.5841 - 100*0.98388*0.5448 = 4.81.
    greeks = price_european_option(
        spot=100.0, strike=100.0, time_to_expiry_years=0.25,
        risk_free_rate=0.065, volatility=0.20, option_type="CE",
    )
    assert greeks.premium == pytest.approx(4.81, abs=0.02)
    assert greeks.delta == pytest.approx(0.5841, abs=0.001)
    assert greeks.gamma > 0


def test_put_call_parity_holds_on_the_pricer_itself():
    import math

    spot, strike, time_to_expiry, risk_free_rate = 57700.0, 57700.0, 0.05, 0.065
    call = price_european_option(
        spot=spot, strike=strike, time_to_expiry_years=time_to_expiry,
        risk_free_rate=risk_free_rate, volatility=0.15, option_type="CE",
    )
    put = price_european_option(
        spot=spot, strike=strike, time_to_expiry_years=time_to_expiry,
        risk_free_rate=risk_free_rate, volatility=0.15, option_type="PE",
    )
    discount = math.exp(-risk_free_rate * time_to_expiry)
    # C - P = S - K*e^(-rT)
    assert (call.premium - put.premium) == pytest.approx(spot - strike * discount, abs=0.5)


def test_gamma_is_identical_for_call_and_put_at_the_same_strike():
    # A textbook BS identity: gamma does not depend on option type.
    call = price_european_option(
        spot=100.0, strike=105.0, time_to_expiry_years=0.1,
        risk_free_rate=0.065, volatility=0.25, option_type="CE",
    )
    put = price_european_option(
        spot=100.0, strike=105.0, time_to_expiry_years=0.1,
        risk_free_rate=0.065, volatility=0.25, option_type="PE",
    )
    assert call.gamma == pytest.approx(put.gamma, abs=1e-6)


def test_zero_time_to_expiry_returns_intrinsic_value_only():
    greeks = price_european_option(
        spot=110.0, strike=100.0, time_to_expiry_years=0.0,
        risk_free_rate=0.065, volatility=0.20, option_type="CE",
    )
    assert greeks.premium == pytest.approx(10.0)
    assert greeks.gamma == 0.0
    assert greeks.delta == 0.0


# ------------------------------------------------------------------ implied volatility solver


def test_iv_solver_round_trips_a_price_generated_by_the_same_pricer():
    true_vol = 0.18
    priced = price_european_option(
        spot=57700.0, strike=57800.0, time_to_expiry_years=0.08,
        risk_free_rate=0.065, volatility=true_vol, option_type="CE",
    )
    solved = implied_volatility_from_premium(
        spot=57700.0, strike=57800.0, time_to_expiry_years=0.08,
        risk_free_rate=0.065, option_type="CE", premium=priced.premium,
    )
    assert solved.measurable
    assert solved.implied_volatility == pytest.approx(true_vol, abs=1e-3)


def test_iv_solver_refuses_a_premium_below_intrinsic():
    solved = implied_volatility_from_premium(
        spot=57700.0, strike=50000.0, time_to_expiry_years=0.08,
        risk_free_rate=0.065, option_type="CE", premium=1.0,  # far below intrinsic (~7700)
    )
    assert not solved.measurable
    assert solved.reason == "BELOW_INTRINSIC"


def test_iv_solver_refuses_an_expired_contract():
    solved = implied_volatility_from_premium(
        spot=57700.0, strike=57700.0, time_to_expiry_years=0.0,
        risk_free_rate=0.065, option_type="CE", premium=100.0,
    )
    assert not solved.measurable
    assert solved.reason == "EXPIRED_OR_ZERO_TIME"


def test_iv_solver_refuses_extrinsic_below_one_tick():
    import math

    # Deep ITM call: the no-arbitrage floor is spot minus the DISCOUNTED strike, not plain
    # intrinsic. Sit the premium just above that floor so extrinsic is far below the 0.05 tick.
    spot, strike, time_to_expiry, risk_free_rate = 57700.0, 50000.0, 0.08, 0.065
    floor = spot - strike * math.exp(-risk_free_rate * time_to_expiry)
    solved = implied_volatility_from_premium(
        spot=spot, strike=strike, time_to_expiry_years=time_to_expiry,
        risk_free_rate=risk_free_rate, option_type="CE", premium=floor + 0.001,
    )
    assert not solved.measurable
    assert solved.reason == "EXTRINSIC_BELOW_PRICE_RESOLUTION"


def test_mid_price_is_none_for_one_sided_or_crossed_quotes():
    assert mid_price_for_iv(None, 10.0) is None
    assert mid_price_for_iv(10.0, None) is None
    assert mid_price_for_iv(10.0, 9.0) is None  # crossed
    assert mid_price_for_iv(9.0, 10.0) == pytest.approx(9.5)


# ------------------------------------------------------------------ parity-implied forward


def test_parity_forward_recovers_a_known_discount_to_spot():
    # Construct calls/puts at several strikes consistent with forward=57700 (below a
    # risk-free-only forward of ~57870), and check the median recovers it.
    risk_free_rate = 0.065
    time_to_expiry = 0.08
    forward = 57700.0
    pairs = []
    for strike in (57200.0, 57500.0, 57700.0, 57900.0, 58200.0):
        call = price_european_option(
            spot=effective_spot_for_forward(forward, risk_free_rate, time_to_expiry),
            strike=strike, time_to_expiry_years=time_to_expiry,
            risk_free_rate=risk_free_rate, volatility=0.15, option_type="CE",
        )
        put = price_european_option(
            spot=effective_spot_for_forward(forward, risk_free_rate, time_to_expiry),
            strike=strike, time_to_expiry_years=time_to_expiry,
            risk_free_rate=risk_free_rate, volatility=0.15, option_type="PE",
        )
        pairs.append(ParityPair(strike=strike, call_mid=call.premium, put_mid=put.premium))

    recovered = implied_forward_from_parity(pairs, risk_free_rate, time_to_expiry)
    assert recovered == pytest.approx(forward, abs=1.0)


def test_parity_forward_is_none_with_no_valid_pairs():
    assert implied_forward_from_parity([], 0.065, 0.08) is None


# ------------------------------------------------------------------ GEX aggregation


def _row(expiry, strike, option_type, bid, ask, oi, observed_at):
    return OptionChainRow(
        expiry_date=expiry, strike_price=strike, option_type=option_type,
        bid=bid, ask=ask, open_interest=oi, observed_at=observed_at,
    )


def _synthetic_chain(observed_at, expiry, spot, true_vol, strikes, call_oi, put_oi):
    """Build a chain with KNOWN gamma/IV: price every quote with the pricer itself, so
    the aggregator's solved gamma can be checked against the pricer's own gamma directly."""
    time_to_expiry = (expiry - observed_at).total_seconds() / (365 * 24 * 3600)
    rows = []
    expected_call_gamma = {}
    expected_put_gamma = {}
    for strike in strikes:
        call = price_european_option(spot, strike, time_to_expiry, 0.065, true_vol, "CE")
        put = price_european_option(spot, strike, time_to_expiry, 0.065, true_vol, "PE")
        rows.append(_row(expiry, strike, "CE", call.premium - 0.01, call.premium + 0.01, call_oi, observed_at))
        rows.append(_row(expiry, strike, "PE", put.premium - 0.01, put.premium + 0.01, put_oi, observed_at))
        expected_call_gamma[strike] = call.gamma
        expected_put_gamma[strike] = put.gamma
    return rows, expected_call_gamma, expected_put_gamma


def test_gex_sign_convention_calls_positive_puts_negative():
    observed_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
    expiry = datetime(2026, 10, 30, tzinfo=timezone.utc)
    spot = 57700.0
    rows, _, _ = _synthetic_chain(
        observed_at, expiry, spot, true_vol=0.15,
        strikes=[57500.0, 57600.0, 57700.0, 57800.0, 57900.0],
        call_oi=1000, put_oi=1000,
    )
    result = compute_gex_for_expiry(rows, spot=spot, contract_multiplier=30, as_of=observed_at)
    assert result.total_call_gamma_exposure > 0
    assert result.total_put_gamma_exposure > 0
    assert result.net_dealer_gamma_exposure == pytest.approx(
        result.total_call_gamma_exposure - result.total_put_gamma_exposure,
    )
    assert result.contracts_skipped == 0
    assert result.contracts_priced == len(rows)


def test_gex_scales_linearly_with_open_interest():
    observed_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
    expiry = datetime(2026, 10, 30, tzinfo=timezone.utc)
    spot = 57700.0
    strikes = [57700.0]
    low_oi_rows, _, _ = _synthetic_chain(observed_at, expiry, spot, 0.15, strikes, call_oi=100, put_oi=100)
    high_oi_rows, _, _ = _synthetic_chain(observed_at, expiry, spot, 0.15, strikes, call_oi=1000, put_oi=1000)

    low = compute_gex_for_expiry(low_oi_rows, spot=spot, contract_multiplier=30, as_of=observed_at)
    high = compute_gex_for_expiry(high_oi_rows, spot=spot, contract_multiplier=30, as_of=observed_at)
    assert high.total_call_gamma_exposure == pytest.approx(low.total_call_gamma_exposure * 10, rel=1e-6)


def test_gex_skips_rows_with_no_open_interest_and_counts_the_reason():
    observed_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
    expiry = datetime(2026, 10, 30, tzinfo=timezone.utc)
    rows = [
        _row(expiry, 57700.0, "CE", 100.0, 102.0, None, observed_at),  # no OI -> skipped
        _row(expiry, 57700.0, "PE", 100.0, 102.0, 500, observed_at),
    ]
    result = compute_gex_for_expiry(rows, spot=57700.0, contract_multiplier=30, as_of=observed_at)
    assert result.contracts_skipped == 1
    assert result.skip_reasons.get("NO_OPEN_INTEREST") == 1


def test_gex_skips_one_sided_quotes_and_counts_the_reason():
    observed_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
    expiry = datetime(2026, 10, 30, tzinfo=timezone.utc)
    rows = [
        _row(expiry, 57700.0, "CE", None, None, 500, observed_at),  # no quote at all
        _row(expiry, 57700.0, "PE", 100.0, 102.0, 500, observed_at),
    ]
    result = compute_gex_for_expiry(rows, spot=57700.0, contract_multiplier=30, as_of=observed_at)
    assert result.skip_reasons.get("NO_TWO_SIDED_QUOTE") == 1
    assert result.contracts_priced == 1


def test_aggregate_gex_sums_across_expiries_and_computes_pcr():
    observed_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
    near_expiry = datetime(2026, 10, 8, tzinfo=timezone.utc)
    far_expiry = datetime(2026, 10, 30, tzinfo=timezone.utc)
    spot = 57700.0
    strikes = [57700.0]

    near_rows, _, _ = _synthetic_chain(observed_at, near_expiry, spot, 0.15, strikes, call_oi=1000, put_oi=2000)
    far_rows, _, _ = _synthetic_chain(observed_at, far_expiry, spot, 0.15, strikes, call_oi=500, put_oi=500)

    observation = aggregate_gex(
        rows=[*near_rows, *far_rows], underlying_symbol="NIFTY50", spot=spot,
        contract_multiplier=75, as_of=observed_at,
    )
    assert len(observation.by_expiry) == 2
    assert observation.by_expiry[0].expiry_date == near_expiry  # sorted ascending
    assert observation.total_call_gamma_exposure == pytest.approx(
        observation.by_expiry[0].total_call_gamma_exposure + observation.by_expiry[1].total_call_gamma_exposure,
    )
    # total put OI (2000+500) / total call OI (1000+500) = 1.6667
    assert observation.put_call_oi_ratio == pytest.approx(2500 / 1500, rel=1e-6)


def test_put_call_oi_ratio_is_none_with_zero_call_open_interest():
    observed_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
    expiry = datetime(2026, 10, 30, tzinfo=timezone.utc)
    rows = [_row(expiry, 57700.0, "PE", 100.0, 102.0, 500, observed_at)]
    observation = aggregate_gex(
        rows=rows, underlying_symbol="NIFTY50", spot=57700.0,
        contract_multiplier=75, as_of=observed_at,
    )
    assert observation.put_call_oi_ratio is None


def test_compute_gex_for_expiry_requires_at_least_one_row():
    as_of = datetime(2026, 10, 1, tzinfo=timezone.utc)
    with pytest.raises(ValueError):
        compute_gex_for_expiry([], spot=57700.0, contract_multiplier=75, as_of=as_of)


def test_expired_expiry_is_skipped_even_though_its_rows_were_captured_while_still_alive():
    # The bug this guards: an expiry's rows are last captured WHILE IT WAS STILL ALIVE (their
    # own observed_at predates expiry), but `as_of` (today's decision time) is now well past
    # that expiry. Time-to-expiry must be measured from `as_of`, not from the rows' own
    # observed_at, or a long-dead contract prices as if it still had weeks left.
    observed_at = datetime(2026, 8, 20, tzinfo=timezone.utc)
    expiry = datetime(2026, 8, 25, tzinfo=timezone.utc)
    as_of = datetime(2026, 10, 10, tzinfo=timezone.utc)  # six weeks after expiry
    rows, _, _ = _synthetic_chain(
        observed_at, expiry, spot=57700.0, true_vol=0.15, strikes=[57700.0], call_oi=100, put_oi=100,
    )
    result = compute_gex_for_expiry(rows, spot=57700.0, contract_multiplier=30, as_of=as_of)
    assert result.contracts_priced == 0
    assert result.contracts_skipped == len(rows)
    assert result.skip_reasons == {"EXPIRED_OR_ZERO_TIME": len(rows)}
    assert result.forward is None
    assert result.net_dealer_gamma_exposure == 0.0
    # Open interest is still reported even though nothing could be priced.
    assert result.call_open_interest == 100
    assert result.put_open_interest == 100
