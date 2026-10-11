"""
Regression tests (2026-10-10 realignment) for the Master 5-Layer Scanner:

  * the Layer 0 time-of-day gate vetoes the session open/close edges -- and nothing else
  * bearish (short) scans are supported end-to-end, with mirrored gates
  * a feed without trade-tape data reports ORDER_FLOW_UNAVAILABLE / INSUFFICIENT_DATA
    instead of a fake "order flow rejected the setup"
"""

import math

import pytest

from ai_quant_lab_ml.fibonacci_pit_engine import (
    ATRObservation,
    CandleIdentity,
    FibAnchorCalibrationArtifact,
    FibLifecycleState,
    FootprintBar,
    GEXContext,
    L2DepthLiquidityObservation,
    LambdaCalibrationArtifact,
    MagnitudeEstimate,
    NormalizedOFI,
    RetracementObservation,
    StructuralLevel,
)
from ai_quant_lab_ml.master_scanner import (
    NSE_SESSION_MINUTES,
    SESSION_EDGE_VETO_MINUTES,
    Layer0RegimeEvaluator,
    Layer2MicrostructureEngine,
    Master5LayerScanner,
)

T0 = 2_000_000


@pytest.fixture
def artifacts():
    fib_art = FibAnchorCalibrationArtifact(
        calibrationId="FIB_CALIB_V1", featureDefinitionId="FIB_RETRACEMENT_STATEFUL_V1",
        instrument="NIFTY", regime="NORMAL", minRetracementTicks=10.0, minRetracementAtrMultiple=0.5,
        maxWindowBars=20, maxQualifiedLifetimeBars=2000, trainedThrough=1_000_000,
    )
    lambda_art = LambdaCalibrationArtifact(
        calibrationId="LAMBDA_CALIB_V1", featureDefinitionId="LAMBDA_PROXY_RANGE_DELTA_V1",
        instrument="NIFTY", regime="NORMAL", quantile=0.25, threshold=0.05, trainedThrough=1_000_000,
    )
    return fib_art, lambda_art


def bar(seq, o, h, l, c, *, net_delta=100.0, poc_z=0.0, tail=0.1, of_available=True):
    ts = T0 + (seq - 1) * 1000
    return FootprintBar(
        identity=CandleIdentity(barId=f"bar_{seq}", sequenceNumber=seq, closeTimestamp=ts),
        open=o, high=h, low=l, close=c, totalVolume=1000.0,
        netDelta=net_delta, pocDisplacementZ=poc_z, tailVolumeRatio=tail,
        availableAt=ts, orderFlowAvailable=of_available,
    )


def evaluate(evaluator, direction, **overrides):
    kwargs = dict(
        magnitude=MagnitudeEstimate(5.0, 0.9, 1000, 1000), direction=direction,
        breadth_ad=0.0, breadth_available_at=1000, yz_vol_ratio=1.2, yz_available_at=1000,
        vp_label="TRENDING", vp_available_at=1000, tod_sin=0.5, tod_cos=-0.5, decision_at=1000,
    )
    kwargs.update(overrides)
    return evaluator.evaluate_regime(**kwargs)


# ------------------------------------------------------------------ Layer 0: time of day


def test_tod_gate_vetoes_exactly_the_open_and_close_edge_windows():
    evaluator = Layer0RegimeEvaluator()
    vetoed_minutes = []
    for minute in range(int(NSE_SESSION_MINUTES)):
        angle = 2.0 * math.pi * minute / NSE_SESSION_MINUTES
        ok, reason = evaluate(evaluator, "BULLISH", tod_sin=math.sin(angle), tod_cos=math.cos(angle))
        if not ok:
            assert reason == "TOD_SESSION_BOUNDARY_VETO"
            vetoed_minutes.append(minute)
    edge = int(SESSION_EDGE_VETO_MINUTES)
    session = int(NSE_SESSION_MINUTES)
    expected = [m for m in range(session) if m < edge or m > session - edge]
    # Boundary minutes themselves (== edge, == session - edge) sit on the threshold; ignore them.
    boundary = {edge, session - edge}
    assert set(vetoed_minutes) - boundary == set(expected) - boundary
    # The old rule vetoed 10:30-11:10 (quarter point) and 12:05-12:45 (midpoint); those must pass.
    for minute in (94, 187, 281):
        assert minute not in vetoed_minutes
    # ...and it never vetoed the actual open or close.
    assert 0 in vetoed_minutes and 374 in vetoed_minutes


def test_tod_gate_does_not_veto_mid_session_extreme_sin_or_cos():
    evaluator = Layer0RegimeEvaluator()
    assert evaluate(evaluator, "BULLISH", tod_sin=0.98, tod_cos=0.0)[0] is True
    assert evaluate(evaluator, "BULLISH", tod_sin=0.0, tod_cos=-0.98)[0] is True
    # The session open/close encode to (sin, cos) = (0, 1).
    assert evaluate(evaluator, "BULLISH", tod_sin=0.0, tod_cos=1.0) == (False, "TOD_SESSION_BOUNDARY_VETO")


# ------------------------------------------------------------------ Layer 0: breadth mirror


def test_breadth_gate_is_mirrored_for_shorts():
    evaluator = Layer0RegimeEvaluator()
    assert evaluate(evaluator, "BULLISH", breadth_ad=-0.8) == (False, "BREADTH_DETERIORATING_LONG_VETO")
    assert evaluate(evaluator, "BULLISH", breadth_ad=0.8)[0] is True
    assert evaluate(evaluator, "BEARISH", breadth_ad=0.8) == (False, "BREADTH_IMPROVING_SHORT_VETO")
    assert evaluate(evaluator, "BEARISH", breadth_ad=-0.8)[0] is True


# ------------------------------------------------------------------ Layer 2


def test_layer2_requires_p_shape_for_shorts_and_b_shape_for_longs(artifacts):
    _, lambda_art = artifacts
    engine = Layer2MicrostructureEngine(lambda_art)
    ofi = NormalizedOFI(0.05, 1000.0, T0, T0)
    b_shape = bar(1, 100, 100.5, 99.9, 100.0, net_delta=-100.0, poc_z=-0.6, tail=0.4)
    p_shape = bar(1, 100, 100.5, 99.9, 100.0, net_delta=100.0, poc_z=0.6, tail=0.4)
    args = ("NIFTY", "NORMAL", T0)
    assert engine.evaluate_microstructure(b_shape, ofi, *args, direction="BULLISH") == (True, "NONE")
    assert engine.evaluate_microstructure(p_shape, ofi, *args, direction="BULLISH") == (False, "FOOTPRINT_SHAPE_UNQUALIFIED")
    assert engine.evaluate_microstructure(p_shape, ofi, *args, direction="BEARISH") == (True, "NONE")
    assert engine.evaluate_microstructure(b_shape, ofi, *args, direction="BEARISH") == (False, "FOOTPRINT_SHAPE_UNQUALIFIED")


def test_layer2_reports_unmeasured_order_flow_instead_of_a_fake_rejection(artifacts):
    _, lambda_art = artifacts
    engine = Layer2MicrostructureEngine(lambda_art)
    ofi = NormalizedOFI(0.05, 1000.0, T0, T0)
    no_tape = bar(1, 100, 100.5, 99.9, 100.0, net_delta=0.0, poc_z=0.0, tail=0.0, of_available=False)
    assert engine.evaluate_microstructure(no_tape, ofi, "NIFTY", "NORMAL", T0) == (False, "ORDER_FLOW_UNAVAILABLE")
    # The same zero placeholders WITH availability claimed fail the lambda gate (the old, misleading behaviour).
    claimed = bar(1, 100, 100.5, 99.9, 100.0, net_delta=0.0, poc_z=0.0, tail=0.0, of_available=True)
    assert engine.evaluate_microstructure(claimed, ofi, "NIFTY", "NORMAL", T0)[1] == "LAMBDA_PROXY_PROOF_FAILED"


# ------------------------------------------------------------------ end-to-end, both directions


def _drive(scanner, bars, structural, retracement_at_last=None, *, last_bar_overrides=None):
    """Feed bars 10..N to the scanner one at a time; return the signal for the last bar."""
    atr = ATRObservation(atr14=2.0, sourceTimestamp=T0, availableAt=T0)
    signal = None
    for n in range(10, len(bars) + 1):
        window = bars[:n]
        latest = window[-1]
        decision_at = latest.identity.closeTimestamp
        is_last = n == len(bars)
        signal = scanner.process_market_state(
            bar=latest, current_candles=window, current_l2=None,
            gex_context=GEXContext("FRESH", 1.0, decision_at, decision_at),
            magnitude=MagnitudeEstimate(5.0, 0.9, decision_at, decision_at),
            normalized_ofi=NormalizedOFI(0.05, 1000.0, decision_at, decision_at),
            l2_depth_liq=L2DepthLiquidityObservation(500.0, decision_at, decision_at),
            breadth_ad=0.0, breadth_available_at=decision_at, breadth_source_time=decision_at,
            yz_vol=1.2, yz_available_at=decision_at, yz_source_time=decision_at,
            vp_label="TRENDING_UP", vp_available_at=decision_at, tod_sin=0.0, tod_cos=0.0,
            structural_resistance=structural,
            retracement=(retracement_at_last if is_last else None), atr_obs=atr,
            current_instrument="NIFTY", current_regime="NORMAL", decision_at=decision_at,
        )
    return signal


def _bullish_bars(**last):
    flat = [bar(i, 100, 101, 99, 100) for i in range(1, 7)]
    seq7 = bar(7, 102, 103, 102, 102)
    pivot = bar(8, 99, 100, 100, 100)       # pivot low 100
    b9 = bar(9, 101, 105, 102, 104)
    b10 = bar(10, 104, 110, 103, 108)
    mss = bar(11, 115, 200, 114, 195)       # closes through 110: MSS, anchor high 200
    retr = bar(12, 138.5, 138.8, 137.9, 138.0, **last)   # r = 0.62 -> golden pocket
    return flat + [seq7, pivot, b9, b10, mss, retr]


def _bearish_bars(**last):
    flat = [bar(i, 100, 101, 99, 100) for i in range(1, 7)]
    b7 = bar(7, 100, 102, 99, 100)
    pivot = bar(8, 101, 105, 100, 104)      # pivot high 105
    b9 = bar(9, 104, 103, 102, 103)
    b10 = bar(10, 103, 102, 96, 99)
    mss = bar(11, 97, 98, 60, 62)           # closes through support 98: MSS, anchor low 60
    retr = bar(12, 88.5, 88.8, 87.9, 88.0, **last)       # r = (88-60)/45 = 0.622 -> golden pocket
    return flat + [b7, pivot, b9, b10, mss, retr]


def _scanner(artifacts, direction):
    fib_art, lambda_art = artifacts
    return Master5LayerScanner(
        lambda_artifact=lambda_art, fib_artifact=fib_art,
        calibration_end=1_000_000, evaluation_start=T0, direction=direction,
    )


def test_scanner_rejects_an_unknown_direction(artifacts):
    with pytest.raises(ValueError):
        _scanner(artifacts, "SIDEWAYS")


def test_bullish_scan_reaches_the_layer4_null_with_a_b_shape_bar(artifacts):
    bars = _bullish_bars(net_delta=-100.0, poc_z=-0.6, tail=0.4)
    retr = RetracementObservation(low=135.0, sequenceNumber=12, observedAt=bars[-1].identity.closeTimestamp, availableAt=bars[-1].identity.closeTimestamp)
    scanner = _scanner(artifacts, "BULLISH")
    sig = _drive(scanner, bars, StructuralLevel(110.0, 1, T0, T0), retr)
    assert scanner.layer1.state == FibLifecycleState.RETRACEMENT_QUALIFIED
    assert sig.macroZone == "GOLDEN_POCKET"
    assert sig.signalType == "BULLISH_CANDIDATE"
    assert (sig.layer0Status, sig.layer1Status, sig.layer2Status) == (True, True, True)
    assert sig.rejectReason == "INSUFFICIENT_DATA_LAYER4_NULL"  # Layer 4 is deliberately always closed
    assert sig.featureVector.fibDirection == 1
    # Anchor age is bars since the impulse extreme (bar 11), not since the original MSS.
    assert sig.featureVector.anchorAgeBars == 1


def test_bearish_scan_reaches_the_layer4_null_with_a_p_shape_bar(artifacts):
    bars = _bearish_bars(net_delta=100.0, poc_z=0.6, tail=0.4)
    retr = RetracementObservation(low=0.0, high=90.0, sequenceNumber=12, observedAt=bars[-1].identity.closeTimestamp, availableAt=bars[-1].identity.closeTimestamp)
    scanner = _scanner(artifacts, "BEARISH")
    sig = _drive(scanner, bars, StructuralLevel(98.0, 1, T0, T0), retr)
    assert scanner.layer1.state == FibLifecycleState.RETRACEMENT_QUALIFIED
    assert sig.macroZone == "GOLDEN_POCKET"
    assert sig.signalType == "BEARISH_CANDIDATE"
    assert (sig.layer0Status, sig.layer1Status, sig.layer2Status) == (True, True, True)
    assert sig.featureVector.fibDirection == -1
    assert sig.featureVector.fibAnchorType == "BEARISH_IMPULSE"
    assert 0.60 < sig.featureVector.fibRetracement < 0.65
    # Targets are extensions BELOW the impulse low for a short.
    assert all(t < 60.0 for t in sig.exitGeometry.candidateFibTargets)
    assert sig.exitGeometry.structuralStop > 105.0


def test_bearish_scan_rejects_a_b_shape_bar(artifacts):
    bars = _bearish_bars(net_delta=-100.0, poc_z=-0.6, tail=0.4)
    retr = RetracementObservation(low=0.0, high=90.0, sequenceNumber=12, observedAt=bars[-1].identity.closeTimestamp, availableAt=bars[-1].identity.closeTimestamp)
    sig = _drive(_scanner(artifacts, "BEARISH"), bars, StructuralLevel(98.0, 1, T0, T0), retr)
    assert sig.signalState == "NOT_QUALIFIED"
    assert sig.rejectReason == "FOOTPRINT_SHAPE_UNQUALIFIED"
    assert sig.layer1Status is True and sig.layer2Status is False


def test_scan_without_tape_data_is_insufficient_data_not_not_qualified(artifacts):
    bars = _bullish_bars(net_delta=0.0, poc_z=0.0, tail=0.0, of_available=False)
    retr = RetracementObservation(low=135.0, sequenceNumber=12, observedAt=bars[-1].identity.closeTimestamp, availableAt=bars[-1].identity.closeTimestamp)
    sig = _drive(_scanner(artifacts, "BULLISH"), bars, StructuralLevel(110.0, 1, T0, T0), retr)
    assert sig.rejectReason == "ORDER_FLOW_UNAVAILABLE"
    assert sig.signalState == "INSUFFICIENT_DATA"
    assert sig.layer1Status is True and sig.layer2Status is False
