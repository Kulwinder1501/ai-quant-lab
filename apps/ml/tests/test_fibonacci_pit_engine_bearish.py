"""
Unit Tests for StatefulPITFibEngineBearish -- the mirror-direction engine built to detect
impulse-down + retrace-up setups, which the original (bullish-only) engine never looked for.

Mirrors test_fibonacci_pit_lifecycle.py's bullish test structure test-for-test, so the two
engines' behavior can be audited side by side.
"""

import pytest
from ai_quant_lab_ml.fibonacci_pit_engine import (
    ATRObservation,
    CandleIdentity,
    FibAnchorCalibrationArtifact,
    FibLifecycleState,
    FootprintBar,
    RetracementObservation,
    StatefulPITFibEngineBearish,
    StructuralLevel,
)


@pytest.fixture
def sample_artifact():
    return FibAnchorCalibrationArtifact(
        calibrationId="FIB_CALIB_BEARISH_TEST_V1",
        featureDefinitionId="FIB_RETRACEMENT_STATEFUL_V1",
        instrument="NIFTY",
        regime="NORMAL",
        minRetracementTicks=10.0,
        minRetracementAtrMultiple=0.5,
        maxWindowBars=20,
        trainedThrough=1000000000000
    )


def make_bar(seq: int, timestamp: int, open_p: float, high_p: float, low_p: float, close_p: float, available_at: int) -> FootprintBar:
    return FootprintBar(
        identity=CandleIdentity(barId=f"bar_{seq}", sequenceNumber=seq, closeTimestamp=timestamp),
        open=open_p, high=high_p, low=low_p, close=close_p,
        totalVolume=1000.0, netDelta=100.0, pocDisplacementZ=0.0, tailVolumeRatio=0.1,
        availableAt=available_at
    )


def test_bearish_engine_initialization_and_reset(sample_artifact):
    engine = StatefulPITFibEngineBearish(fib_artifact=sample_artifact, tick_size=0.05)
    assert engine.state == FibLifecycleState.IDLE
    assert engine.active_poi is None


def test_bearish_insufficient_candle_depth_safeguard(sample_artifact):
    engine = StatefulPITFibEngineBearish(fib_artifact=sample_artifact, tick_size=0.05)
    candles = [make_bar(i, 1000 + i * 1000, 100, 101, 99, 100, 1000 + i * 1000) for i in range(5)]
    res, status = engine.process_new_candle(
        candles=candles,
        structural_support=StructuralLevel(95.0, 1, 1000, 1000),
        retracement=None,
        atr_obs=ATRObservation(2.0, 1000, 1000),
        decision_at=10000
    )
    assert res is False
    assert status == "INSUFFICIENT_CANDLES"


def test_bearish_pivot_detection_and_timestamp_invariants(sample_artifact):
    engine = StatefulPITFibEngineBearish(fib_artifact=sample_artifact, tick_size=0.05)

    # 10 candles forming a fractal pivot HIGH at candles[-3] (Index 7, Bar 8)
    # Bar 7 (prev): high 102.0  (index 6 = candles[-4])
    # Bar 8 (curr): high 105.0  (index 7 = candles[-3]) <- EXTREMUM PIVOT HIGH (formedAt)
    # Bar 9 (nxt):  high 103.0  (index 8 = candles[-2]) <- FRACTAL DETECTED (candidateAt)
    # Bar 10:       high 102.0  (index 9 = candles[-1])
    timestamps = [100000 + i * 1000 for i in range(10)]

    candles = [
        make_bar(1, timestamps[0], 100, 101, 99, 100, timestamps[0]),
        make_bar(2, timestamps[1], 100, 101, 99, 100, timestamps[1]),
        make_bar(3, timestamps[2], 100, 101, 99, 100, timestamps[2]),
        make_bar(4, timestamps[3], 100, 101, 99, 100, timestamps[3]),
        make_bar(5, timestamps[4], 100, 101, 99, 100, timestamps[4]),
        make_bar(6, timestamps[5], 100, 101, 99, 100, timestamps[5]),
        make_bar(7, timestamps[6], 100, 102, 99, 100, timestamps[6]),   # prev (index 6)
        make_bar(8, timestamps[7], 101, 105, 100, 104, timestamps[7]),  # curr (index 7, high 105.0)
        make_bar(9, timestamps[8], 104, 103, 102, 103, timestamps[8]),  # nxt  (index 8, candidateAt)
        make_bar(10, timestamps[9], 103, 102, 101, 102, timestamps[9]), # latest (index 9)
    ]

    support = StructuralLevel(levelPrice=95.0, sequenceNumber=1, sourceTimestamp=100000, availableAt=100000)
    atr = ATRObservation(atr14=2.0, sourceTimestamp=100000, availableAt=100000)

    res, status = engine.process_new_candle(candles, support, None, atr, timestamps[9])
    assert res is True
    assert engine.state == FibLifecycleState.PIVOT_CANDIDATE_DETECTED

    # Invariant Verification: formedAt (curr timestamp) < candidateAt (nxt timestamp)
    assert engine.pivot_formed_time == timestamps[7]
    assert engine.pending_pivot_time == timestamps[8]
    assert engine.pivot_formed_time < engine.pending_pivot_time


def test_bearish_mss_confirmation_and_invalidation(sample_artifact):
    engine = StatefulPITFibEngineBearish(fib_artifact=sample_artifact, tick_size=0.05)

    timestamps = [100000 + i * 1000 for i in range(12)]
    candles = [
        make_bar(1, timestamps[0], 100, 101, 99, 100, timestamps[0]),
        make_bar(2, timestamps[1], 100, 101, 99, 100, timestamps[1]),
        make_bar(3, timestamps[2], 100, 101, 99, 100, timestamps[2]),
        make_bar(4, timestamps[3], 100, 101, 99, 100, timestamps[3]),
        make_bar(5, timestamps[4], 100, 101, 99, 100, timestamps[4]),
        make_bar(6, timestamps[5], 100, 101, 99, 100, timestamps[5]),
        make_bar(7, timestamps[6], 100, 102, 99, 100, timestamps[6]),   # prev
        make_bar(8, timestamps[7], 101, 105, 100, 104, timestamps[7]),  # curr (high 105.0)
        make_bar(9, timestamps[8], 104, 103, 102, 103, timestamps[8]),  # nxt (candidateAt)
        make_bar(10, timestamps[9], 103, 102, 96, 99, timestamps[9]),  # close stays >= support
    ]

    support = StructuralLevel(levelPrice=98.0, sequenceNumber=1, sourceTimestamp=100000, availableAt=100000)
    atr = ATRObservation(atr14=2.0, sourceTimestamp=100000, availableAt=100000)

    # 1. Pivot candidate detection
    engine.process_new_candle(candles, support, None, atr, timestamps[9])
    assert engine.state == FibLifecycleState.PIVOT_CANDIDATE_DETECTED

    # 2. MSS confirmation (Bar 11 close 95.0 < 98.0 support)
    candles.append(make_bar(11, timestamps[10], 97, 98, 95, 95, timestamps[10]))
    engine.process_new_candle(candles, support, None, atr, timestamps[10])
    assert engine.state == FibLifecycleState.IMPULSE_TRACKING
    assert engine.anchor_low == 95  # low of the MSS-confirming bar

    # 3. Qualify Retracement (pullback UP from anchor_low=95 to retracement.high=99.5, >= 10
    # ticks / 0.5 ATR deep)
    retracement = RetracementObservation(low=0.0, high=99.5, sequenceNumber=12, observedAt=timestamps[11], availableAt=timestamps[11])
    bar12 = make_bar(12, timestamps[11], 95, 99.5, 96.0, 99.0, timestamps[11])
    candles.append(bar12)

    res, status = engine.process_new_candle(candles, support, retracement, atr, timestamps[11])
    assert engine.state == FibLifecycleState.RETRACEMENT_QUALIFIED
    assert engine.active_poi is not None
    assert engine.active_poi.direction == "BEARISH"

    # Structural Stop Check: anchorHigh (105.0) + 2*tick_size (0.10) = 105.10
    assert engine.active_poi.invalidation == pytest.approx(105.10)

    # Invalidation Trigger Test: price rising to 105.15 >= 105.10
    bar13 = make_bar(13, timestamps[11] + 1000, 99, 105.15, 98, 100, timestamps[11] + 1000)
    candles.append(bar13)
    res_inv, status_inv = engine.process_new_candle(candles, support, None, atr, timestamps[11] + 1000)

    assert status_inv == "INVALIDATED"
    assert engine.state == FibLifecycleState.IDLE
    assert engine.active_poi is None


def test_bearish_candidate_timeout_expiry(sample_artifact):
    engine = StatefulPITFibEngineBearish(fib_artifact=sample_artifact, tick_size=0.05)
    timestamps = [100000 + i * 1000 for i in range(25)]

    candles = [
        make_bar(1, timestamps[0], 100, 101, 99, 100, timestamps[0]),
        make_bar(2, timestamps[1], 100, 101, 99, 100, timestamps[1]),
        make_bar(3, timestamps[2], 100, 101, 99, 100, timestamps[2]),
        make_bar(4, timestamps[3], 100, 101, 99, 100, timestamps[3]),
        make_bar(5, timestamps[4], 100, 101, 99, 100, timestamps[4]),
        make_bar(6, timestamps[5], 100, 101, 99, 100, timestamps[5]),
        make_bar(7, timestamps[6], 100, 102, 99, 100, timestamps[6]),   # prev
        make_bar(8, timestamps[7], 101, 105, 100, 104, timestamps[7]),  # curr (high 105.0)
        make_bar(9, timestamps[8], 104, 103, 102, 103, timestamps[8]),  # nxt candidateAt (seq 9)
        make_bar(10, timestamps[9], 103, 102, 96, 97, timestamps[9]),
    ]

    support = StructuralLevel(levelPrice=90.0, sequenceNumber=1, sourceTimestamp=100000, availableAt=100000)
    atr = ATRObservation(atr14=2.0, sourceTimestamp=100000, availableAt=100000)

    engine.process_new_candle(candles, support, None, atr, timestamps[9])
    assert engine.state == FibLifecycleState.PIVOT_CANDIDATE_DETECTED

    # Add 11 bars without close < 90.0 (seq 20 -> candidate age = 20 - 8 = 12 > 10)
    for seq in range(11, 21):
        candles.append(make_bar(seq, timestamps[seq - 1], 98, 100, 97, 98, timestamps[seq - 1]))

    res, status = engine.process_new_candle(candles, support, None, atr, timestamps[19])
    assert status == "EXPIRED"
    assert engine.state == FibLifecycleState.IDLE


def test_bearish_qualified_poi_expires_after_shelf_life_without_invalidation(sample_artifact):
    """
    Regression test mirroring the bullish re-arm/expiry fix: a RETRACEMENT_QUALIFIED bearish POI
    with no further expiry path (only INVALIDATED) could get stuck tracking one stale setup
    forever if price never revisits the stop. After max_window_bars (20) bars past
    qualification with no invalidation, the engine must EXPIRE and re-arm.
    """
    engine = StatefulPITFibEngineBearish(fib_artifact=sample_artifact, tick_size=0.05)

    timestamps = [100000 + i * 1000 for i in range(12)]
    candles = [
        make_bar(1, timestamps[0], 100, 101, 99, 100, timestamps[0]),
        make_bar(2, timestamps[1], 100, 101, 99, 100, timestamps[1]),
        make_bar(3, timestamps[2], 100, 101, 99, 100, timestamps[2]),
        make_bar(4, timestamps[3], 100, 101, 99, 100, timestamps[3]),
        make_bar(5, timestamps[4], 100, 101, 99, 100, timestamps[4]),
        make_bar(6, timestamps[5], 100, 101, 99, 100, timestamps[5]),
        make_bar(7, timestamps[6], 100, 102, 99, 100, timestamps[6]),
        make_bar(8, timestamps[7], 101, 105, 100, 104, timestamps[7]),
        make_bar(9, timestamps[8], 104, 103, 102, 103, timestamps[8]),
        make_bar(10, timestamps[9], 103, 102, 96, 99, timestamps[9]),  # close stays >= support
    ]

    support = StructuralLevel(levelPrice=98.0, sequenceNumber=1, sourceTimestamp=100000, availableAt=100000)
    atr = ATRObservation(atr14=2.0, sourceTimestamp=100000, availableAt=100000)

    engine.process_new_candle(candles, support, None, atr, timestamps[9])
    assert engine.state == FibLifecycleState.PIVOT_CANDIDATE_DETECTED

    candles.append(make_bar(11, timestamps[10], 97, 98, 95, 95, timestamps[10]))
    engine.process_new_candle(candles, support, None, atr, timestamps[10])
    assert engine.state == FibLifecycleState.IMPULSE_TRACKING

    retracement = RetracementObservation(low=0.0, high=99.5, sequenceNumber=12, observedAt=timestamps[11], availableAt=timestamps[11])
    candles.append(make_bar(12, timestamps[11], 95, 99.5, 96.0, 99.0, timestamps[11]))
    engine.process_new_candle(candles, support, retracement, atr, timestamps[11])
    assert engine.state == FibLifecycleState.RETRACEMENT_QUALIFIED
    assert engine.poi_qualified_seq == 12

    # 21 more bars (> max_window_bars=20), price drifting sideways well below the 105.10 stop --
    # never invalidates. No new retracement observations either.
    t = timestamps[11]
    last_status = None
    for seq in range(13, 34):
        t += 1000
        bar = make_bar(seq, t, 99, 100, 98, 99, t)
        candles.append(bar)
        _, last_status = engine.process_new_candle(candles[-20:], support, None, atr, t)

    assert last_status == "EXPIRED"
    assert engine.state == FibLifecycleState.IDLE
    assert engine.active_poi is None
    assert engine.poi_qualified_seq is None


def test_bearish_canonical_location_evaluation(sample_artifact):
    engine = StatefulPITFibEngineBearish(fib_artifact=sample_artifact, tick_size=0.05)

    # Manually setup active POI via the real lifecycle: anchorLow=100 (impulse extreme),
    # anchorHigh=200 (origin pivot), range=100 -- same magnitudes as the bullish canonical test,
    # mirrored in direction.
    timestamps = [100000 + i * 1000 for i in range(15)]
    candles = [
        make_bar(1, timestamps[0], 150, 151, 149, 150, timestamps[0]),
        make_bar(2, timestamps[1], 150, 151, 149, 150, timestamps[1]),
        make_bar(3, timestamps[2], 150, 151, 149, 150, timestamps[2]),
        make_bar(4, timestamps[3], 150, 151, 149, 150, timestamps[3]),
        make_bar(5, timestamps[4], 150, 151, 149, 150, timestamps[4]),
        make_bar(6, timestamps[5], 150, 151, 149, 150, timestamps[5]),
        make_bar(7, timestamps[6], 148, 149, 147, 148, timestamps[6]),  # prev (high 149.0)
        make_bar(8, timestamps[7], 150, 200, 199, 200, timestamps[7]),  # curr (high 200.0, pivot)
        make_bar(9, timestamps[8], 199, 198, 196, 197, timestamps[8]),  # nxt (high 198.0)
        make_bar(10, timestamps[9], 197, 196, 190, 196, timestamps[9]),  # close stays >= support
    ]

    support = StructuralLevel(levelPrice=195.0, sequenceNumber=1, sourceTimestamp=100000, availableAt=100000)
    atr = ATRObservation(atr14=2.0, sourceTimestamp=100000, availableAt=100000)

    engine.process_new_candle(candles, support, None, atr, timestamps[9])
    assert engine.state == FibLifecycleState.PIVOT_CANDIDATE_DETECTED

    # MSS close 105 < 195 (support)
    candles.append(make_bar(11, timestamps[10], 190, 191, 100, 105, timestamps[10]))
    engine.process_new_candle(candles, support, None, atr, timestamps[10])
    assert engine.state == FibLifecycleState.IMPULSE_TRACKING
    assert engine.anchor_low == 100

    retracement = RetracementObservation(low=0.0, high=165.0, sequenceNumber=12, observedAt=timestamps[11], availableAt=timestamps[11])
    candles.append(make_bar(12, timestamps[11], 105, 165, 104, 164, timestamps[11]))
    engine.process_new_candle(candles, support, retracement, atr, timestamps[11])

    assert engine.state == FibLifecycleState.RETRACEMENT_QUALIFIED
    assert engine.active_poi.anchorLow == 100
    assert engine.active_poi.anchorHigh == 200

    # Range = 200 - 100 = 100. Canonical r = (P - 100) / 100
    # P = 162 -> r = 0.62 (Golden Pocket: [0.618, 0.650])
    in_loc, zone = engine.evaluate_location(162.0, decision_at=timestamps[11] + 5000)
    assert in_loc is True
    assert zone == "GOLDEN_POCKET"

    # P = 175 -> r = 0.75 (OTE: [0.702, 0.786))
    in_loc, zone = engine.evaluate_location(175.0, decision_at=timestamps[11] + 5000)
    assert in_loc is True
    assert zone == "OTE"

    # P = 185 -> r = 0.85 (Deep Retracement: [0.786, 0.886])
    in_loc, zone = engine.evaluate_location(185.0, decision_at=timestamps[11] + 5000)
    assert in_loc is True
    assert zone == "DEEP_RETRACEMENT"

    # P = 150 -> r = 0.50 (Outside)
    in_loc, zone = engine.evaluate_location(150.0, decision_at=timestamps[11] + 5000)
    assert in_loc is False
    assert zone == "NONE"
