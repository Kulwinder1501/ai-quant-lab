"""
Unit Tests for Fibonacci Stateful Engine & PIT Lifecycle Invariants
Implementation Contract v1.4.1 & Research Specification v1.1
"""

import pytest
from ai_quant_lab_ml.fibonacci_pit_engine import (
    ATRObservation,
    CandleIdentity,
    FibAnchorCalibrationArtifact,
    FibLifecycleState,
    FootprintBar,
    RetracementObservation,
    StatefulPITFibEngine,
    StructuralLevel,
)


@pytest.fixture
def sample_artifact():
    return FibAnchorCalibrationArtifact(
        calibrationId="FIB_CALIB_TEST_V1",
        featureDefinitionId="FIB_RETRACEMENT_STATEFUL_V1",
        instrument="NIFTY",
        regime="NORMAL",
        minRetracementTicks=10.0,
        minRetracementAtrMultiple=0.5,
        maxWindowBars=20,
        maxQualifiedLifetimeBars=2000,
        trainedThrough=1000000000000
    )


def make_bar(seq: int, timestamp: int, open_p: float, high_p: float, low_p: float, close_p: float, available_at: int) -> FootprintBar:
    return FootprintBar(
        identity=CandleIdentity(barId=f"bar_{seq}", sequenceNumber=seq, closeTimestamp=timestamp),
        open=open_p, high=high_p, low=low_p, close=close_p,
        totalVolume=1000.0, netDelta=100.0, pocDisplacementZ=0.0, tailVolumeRatio=0.1,
        availableAt=available_at
    )


def test_fib_engine_initialization_and_reset(sample_artifact):
    engine = StatefulPITFibEngine(fib_artifact=sample_artifact, tick_size=0.05)
    assert engine.state == FibLifecycleState.IDLE
    assert engine.active_poi is None


def test_insufficient_candle_depth_safeguard(sample_artifact):
    engine = StatefulPITFibEngine(fib_artifact=sample_artifact, tick_size=0.05)
    candles = [make_bar(i, 1000 + i * 1000, 100, 101, 99, 100, 1000 + i * 1000) for i in range(5)]
    res, status = engine.process_new_candle(
        candles=candles,
        structural_resistance=StructuralLevel(105.0, 1, 1000, 1000),
        retracement=None,
        atr_obs=ATRObservation(2.0, 1000, 1000),
        decision_at=10000
    )
    assert res is False
    assert status == "INSUFFICIENT_CANDLES"


def test_pivot_detection_and_timestamp_invariants(sample_artifact):
    engine = StatefulPITFibEngine(fib_artifact=sample_artifact, tick_size=0.05)

    # 10 candles forming a fractal pivot low at candles[-3] (Index 7, Bar 8)
    # Bar 7 (prev): low 98.0  (index 6 = candles[-4])
    # Bar 8 (curr): low 95.0  (index 7 = candles[-3]) <- EXTREMUM PIVOT LOW (formedAt)
    # Bar 9 (nxt):  low 97.0  (index 8 = candles[-2]) <- FRACTAL DETECTED (candidateAt)
    # Bar 10:       low 98.0  (index 9 = candles[-1])
    timestamps = [100000 + i * 1000 for i in range(10)]

    candles = [
        make_bar(1, timestamps[0], 100, 101, 99, 100, timestamps[0]),
        make_bar(2, timestamps[1], 100, 101, 99, 100, timestamps[1]),
        make_bar(3, timestamps[2], 100, 101, 99, 100, timestamps[2]),
        make_bar(4, timestamps[3], 100, 101, 99, 100, timestamps[3]),
        make_bar(5, timestamps[4], 100, 101, 99, 100, timestamps[4]),
        make_bar(6, timestamps[5], 100, 101, 99, 100, timestamps[5]),
        make_bar(7, timestamps[6], 100, 101, 98, 100, timestamps[6]),   # prev (index 6)
        make_bar(8, timestamps[7], 99, 100, 95, 96, timestamps[7]),     # curr (index 7, low 95.0)
        make_bar(9, timestamps[8], 96, 98, 97, 97, timestamps[8]),     # nxt  (index 8, candidateAt)
        make_bar(10, timestamps[9], 97, 99, 98, 98, timestamps[9]),    # latest (index 9)
    ]

    resistance = StructuralLevel(levelPrice=105.0, sequenceNumber=1, sourceTimestamp=100000, availableAt=100000)
    atr = ATRObservation(atr14=2.0, sourceTimestamp=100000, availableAt=100000)

    res, status = engine.process_new_candle(candles, resistance, None, atr, timestamps[9])
    assert res is True
    assert engine.state == FibLifecycleState.PIVOT_CANDIDATE_DETECTED

    # Invariant Verification: formedAt (curr timestamp) < candidateAt (nxt timestamp)
    assert engine.pivot_formed_time == timestamps[7]
    assert engine.pending_pivot_time == timestamps[8]
    assert engine.pivot_formed_time < engine.pending_pivot_time


def test_mss_confirmation_and_invalidation(sample_artifact):
    engine = StatefulPITFibEngine(fib_artifact=sample_artifact, tick_size=0.05)

    timestamps = [100000 + i * 1000 for i in range(12)]
    candles = [
        make_bar(1, timestamps[0], 100, 101, 99, 100, timestamps[0]),
        make_bar(2, timestamps[1], 100, 101, 99, 100, timestamps[1]),
        make_bar(3, timestamps[2], 100, 101, 99, 100, timestamps[2]),
        make_bar(4, timestamps[3], 100, 101, 99, 100, timestamps[3]),
        make_bar(5, timestamps[4], 100, 101, 99, 100, timestamps[4]),
        make_bar(6, timestamps[5], 100, 101, 99, 100, timestamps[5]),
        make_bar(7, timestamps[6], 100, 101, 98, 100, timestamps[6]),   # prev
        make_bar(8, timestamps[7], 99, 100, 95, 96, timestamps[7]),     # curr (low 95.0)
        make_bar(9, timestamps[8], 96, 98, 97, 97, timestamps[8]),     # nxt (candidateAt)
        make_bar(10, timestamps[9], 97, 99, 96, 98, timestamps[9]),
    ]

    resistance = StructuralLevel(levelPrice=102.0, sequenceNumber=1, sourceTimestamp=100000, availableAt=100000)
    atr = ATRObservation(atr14=2.0, sourceTimestamp=100000, availableAt=100000)

    # 1. Pivot candidate detection
    engine.process_new_candle(candles, resistance, None, atr, timestamps[9])
    assert engine.state == FibLifecycleState.PIVOT_CANDIDATE_DETECTED

    # 2. MSS confirmation (Bar 11 close 103.0 > 102.0 resistance)
    candles.append(make_bar(11, timestamps[10], 99, 105, 98, 103, timestamps[10]))
    engine.process_new_candle(candles, resistance, None, atr, timestamps[10])
    assert engine.state == FibLifecycleState.IMPULSE_TRACKING

    # 3. Qualify Retracement
    retracement = RetracementObservation(low=97.5, sequenceNumber=12, observedAt=timestamps[11], availableAt=timestamps[11])
    bar12 = make_bar(12, timestamps[11], 103, 104, 97.5, 98.0, timestamps[11])
    candles.append(bar12)

    res, status = engine.process_new_candle(candles, resistance, retracement, atr, timestamps[11])
    assert engine.state == FibLifecycleState.RETRACEMENT_QUALIFIED
    assert engine.active_poi is not None

    # Structural Stop Check: anchorLow (95.0) - 2*tick_size (0.10) = 94.90
    assert engine.active_poi.invalidation == pytest.approx(94.90)

    # Invalidation Trigger Test: price dropping to 94.85 <= 94.90
    bar13 = make_bar(13, timestamps[11] + 1000, 97, 97, 94.85, 95.0, timestamps[11] + 1000)
    candles.append(bar13)
    res_inv, status_inv = engine.process_new_candle(candles, resistance, None, atr, timestamps[11] + 1000)

    assert status_inv == "INVALIDATED"
    assert engine.state == FibLifecycleState.IDLE
    assert engine.active_poi is None


def test_candidate_timeout_expiry(sample_artifact):
    engine = StatefulPITFibEngine(fib_artifact=sample_artifact, tick_size=0.05)
    timestamps = [100000 + i * 1000 for i in range(25)]

    candles = [
        make_bar(1, timestamps[0], 100, 101, 99, 100, timestamps[0]),
        make_bar(2, timestamps[1], 100, 101, 99, 100, timestamps[1]),
        make_bar(3, timestamps[2], 100, 101, 99, 100, timestamps[2]),
        make_bar(4, timestamps[3], 100, 101, 99, 100, timestamps[3]),
        make_bar(5, timestamps[4], 100, 101, 99, 100, timestamps[4]),
        make_bar(6, timestamps[5], 100, 101, 99, 100, timestamps[5]),
        make_bar(7, timestamps[6], 100, 101, 98, 100, timestamps[6]),   # prev
        make_bar(8, timestamps[7], 99, 100, 95, 96, timestamps[7]),     # curr
        make_bar(9, timestamps[8], 96, 98, 97, 97, timestamps[8]),     # nxt candidateAt (seq 9)
        make_bar(10, timestamps[9], 97, 99, 96, 98, timestamps[9]),
    ]

    resistance = StructuralLevel(levelPrice=110.0, sequenceNumber=1, sourceTimestamp=100000, availableAt=100000)
    atr = ATRObservation(atr14=2.0, sourceTimestamp=100000, availableAt=100000)

    engine.process_new_candle(candles, resistance, None, atr, timestamps[9])
    assert engine.state == FibLifecycleState.PIVOT_CANDIDATE_DETECTED

    # Add 11 bars without close > 110.0 (seq 20 -> candidate age = 20 - 8 = 12 > 10)
    for seq in range(11, 21):
        candles.append(make_bar(seq, timestamps[seq - 1], 98, 100, 97, 98, timestamps[seq - 1]))

    res, status = engine.process_new_candle(candles, resistance, None, atr, timestamps[19])
    assert status == "EXPIRED"
    assert engine.state == FibLifecycleState.IDLE


def test_qualified_poi_expires_after_shelf_life_without_invalidation():
    """
    Regression test for the re-arm/expiry fix: a RETRACEMENT_QUALIFIED POI with no further
    expiry path (only INVALIDATED) can get stuck tracking one stale setup forever if price
    never revisits the stop -- confirmed on real NIFTY50 history (qualified once at bar 1283
    of 15742, then stuck for the remaining 92%). After maxQualifiedLifetimeBars (20, this
    test's own value -- see this artifact's own comment for why it is NOT sample_artifact's
    production value of 2000) bars past qualification with no invalidation, the engine must
    now EXPIRE and re-arm (reset to IDLE), rather than silently sitting in
    RETRACEMENT_QUALIFIED indefinitely.
    """
    artifact = FibAnchorCalibrationArtifact(
        calibrationId="FIB_CALIB_TEST_V1", featureDefinitionId="FIB_RETRACEMENT_STATEFUL_V1",
        instrument="NIFTY", regime="NORMAL", minRetracementTicks=10.0, minRetracementAtrMultiple=0.5,
        # Deliberately a small, test-friendly value, not sample_artifact's production 2000 --
        # this test needs the shelf life short enough to exhaust in a few dozen bars.
        maxWindowBars=20, maxQualifiedLifetimeBars=20, trainedThrough=1000000000000,
    )
    engine = StatefulPITFibEngine(fib_artifact=artifact, tick_size=0.05)

    timestamps = [100000 + i * 1000 for i in range(12)]
    candles = [
        make_bar(1, timestamps[0], 100, 101, 99, 100, timestamps[0]),
        make_bar(2, timestamps[1], 100, 101, 99, 100, timestamps[1]),
        make_bar(3, timestamps[2], 100, 101, 99, 100, timestamps[2]),
        make_bar(4, timestamps[3], 100, 101, 99, 100, timestamps[3]),
        make_bar(5, timestamps[4], 100, 101, 99, 100, timestamps[4]),
        make_bar(6, timestamps[5], 100, 101, 99, 100, timestamps[5]),
        make_bar(7, timestamps[6], 100, 101, 98, 100, timestamps[6]),   # prev
        make_bar(8, timestamps[7], 99, 100, 95, 96, timestamps[7]),     # curr (low 95.0)
        make_bar(9, timestamps[8], 96, 98, 97, 97, timestamps[8]),      # nxt (candidateAt)
        make_bar(10, timestamps[9], 97, 99, 96, 98, timestamps[9]),
    ]

    resistance = StructuralLevel(levelPrice=102.0, sequenceNumber=1, sourceTimestamp=100000, availableAt=100000)
    atr = ATRObservation(atr14=2.0, sourceTimestamp=100000, availableAt=100000)

    engine.process_new_candle(candles, resistance, None, atr, timestamps[9])
    assert engine.state == FibLifecycleState.PIVOT_CANDIDATE_DETECTED

    candles.append(make_bar(11, timestamps[10], 99, 105, 98, 103, timestamps[10]))
    engine.process_new_candle(candles, resistance, None, atr, timestamps[10])
    assert engine.state == FibLifecycleState.IMPULSE_TRACKING

    retracement = RetracementObservation(low=97.5, sequenceNumber=12, observedAt=timestamps[11], availableAt=timestamps[11])
    candles.append(make_bar(12, timestamps[11], 103, 104, 97.5, 98.0, timestamps[11]))
    engine.process_new_candle(candles, resistance, retracement, atr, timestamps[11])
    assert engine.state == FibLifecycleState.RETRACEMENT_QUALIFIED
    assert engine.poi_qualified_seq == 12

    # 21 more bars (> maxQualifiedLifetimeBars=20), price drifting sideways well above the 94.90 stop --
    # never invalidates, so the only way out used to be "never". No new retracement observations
    # are supplied either, so State 4 cannot re-qualify a (non-existent) new POI in the interim.
    t = timestamps[11]
    last_status = None
    for seq in range(13, 34):
        t += 1000
        bar = make_bar(seq, t, 98, 99, 97, 98, t)
        candles.append(bar)
        _, last_status = engine.process_new_candle(candles[-20:], resistance, None, atr, t)

    assert last_status == "EXPIRED"
    assert engine.state == FibLifecycleState.IDLE
    assert engine.active_poi is None
    assert engine.poi_qualified_seq is None


def test_canonical_location_evaluation(sample_artifact):
    engine = StatefulPITFibEngine(fib_artifact=sample_artifact, tick_size=0.05)

    # Manually setup active POI: anchorLow=100, anchorHigh=200, range=100
    timestamps = [100000 + i * 1000 for i in range(15)]
    candles = [
        make_bar(1, timestamps[0], 100, 101, 99, 100, timestamps[0]),
        make_bar(2, timestamps[1], 100, 101, 99, 100, timestamps[1]),
        make_bar(3, timestamps[2], 100, 101, 99, 100, timestamps[2]),
        make_bar(4, timestamps[3], 100, 101, 99, 100, timestamps[3]),
        make_bar(5, timestamps[4], 100, 101, 99, 100, timestamps[4]),
        make_bar(6, timestamps[5], 100, 101, 99, 100, timestamps[5]),
        make_bar(7, timestamps[6], 102, 103, 102, 102, timestamps[6]), # prev (low 102.0)
        make_bar(8, timestamps[7], 99, 100, 100, 100, timestamps[7]),   # curr (low 100.0)
        make_bar(9, timestamps[8], 101, 105, 102, 104, timestamps[8]), # nxt (low 102.0)
        make_bar(10, timestamps[9], 104, 110, 103, 108, timestamps[9]),
    ]

    resistance = StructuralLevel(levelPrice=110.0, sequenceNumber=1, sourceTimestamp=100000, availableAt=100000)
    atr = ATRObservation(atr14=2.0, sourceTimestamp=100000, availableAt=100000)

    engine.process_new_candle(candles, resistance, None, atr, timestamps[9])
    assert engine.state == FibLifecycleState.PIVOT_CANDIDATE_DETECTED

    # MSS close 195 > 110 (anchorHigh 200)
    candles.append(make_bar(11, timestamps[10], 115, 200, 114, 195, timestamps[10]))
    engine.process_new_candle(candles, resistance, None, atr, timestamps[10])
    assert engine.state == FibLifecycleState.IMPULSE_TRACKING

    retracement = RetracementObservation(low=135.0, sequenceNumber=12, observedAt=timestamps[11], availableAt=timestamps[11])
    candles.append(make_bar(12, timestamps[11], 195, 196, 135, 136, timestamps[11]))
    engine.process_new_candle(candles, resistance, retracement, atr, timestamps[11])

    assert engine.state == FibLifecycleState.RETRACEMENT_QUALIFIED

    # Range = 200 - 100 = 100. Canonical r = (200 - P) / 100
    # P = 138 -> r = 0.62 (Golden Pocket: [0.618, 0.650])
    in_loc, zone = engine.evaluate_location(138.0, decision_at=timestamps[11] + 5000)
    assert in_loc is True
    assert zone == "GOLDEN_POCKET"

    # P = 125 -> r = 0.75 (OTE: [0.702, 0.786))
    in_loc, zone = engine.evaluate_location(125.0, decision_at=timestamps[11] + 5000)
    assert in_loc is True
    assert zone == "OTE"

    # P = 115 -> r = 0.85 (Deep Retracement: [0.786, 0.886])
    in_loc, zone = engine.evaluate_location(115.0, decision_at=timestamps[11] + 5000)
    assert in_loc is True
    assert zone == "DEEP_RETRACEMENT"

    # P = 150 -> r = 0.50 (Outside)
    in_loc, zone = engine.evaluate_location(150.0, decision_at=timestamps[11] + 5000)
    assert in_loc is False
    assert zone == "NONE"


def test_qualified_zone_staleness_forces_rearm():
    """
    RETRACEMENT_QUALIFIED previously had no exit besides INVALIDATED -- a POI whose anchor low
    is never revisited stayed qualified forever (real-data finding, 2026-10-06: one NIFTY50 POI
    stayed qualified for 92% of a 2.75-year history, blocking all new pivot detection). This
    proves the force-expiry actually re-arms the engine, not just that it stops being
    RETRACEMENT_QUALIFIED.

    maxWindowBars=20 and maxQualifiedLifetimeBars=3 are deliberately set to DIFFERENT values
    here, decoupled from each other: an earlier version of this fix reused max_window_bars as
    the qualified-zone shelf life, which is wrong (that parameter bounds a different window
    entirely, and the real lifetime distribution of naturally-invalidated POIs showed 20 bars
    would force-expire most still-genuinely-active ones). This test would still pass if the
    engine silently fell back to max_window_bars (since 20 > 3, expiry would just never fire
    within this test's 4-bar window) -- so it only proves the mechanism if a bug like that
    is ruled out by also reading the production calibration (2,000) in run_phase_c_pipeline.py.
    """
    artifact = FibAnchorCalibrationArtifact(
        calibrationId="FIB_CALIB_TEST_V1", featureDefinitionId="FIB_RETRACEMENT_STATEFUL_V1",
        instrument="NIFTY", regime="NORMAL", minRetracementTicks=10.0, minRetracementAtrMultiple=0.5,
        maxWindowBars=20, maxQualifiedLifetimeBars=3, trainedThrough=1000000000000,
    )
    engine = StatefulPITFibEngine(fib_artifact=artifact, tick_size=0.05)
    timestamps = [100000 + i * 1000 for i in range(30)]

    candles = [
        make_bar(1, timestamps[0], 100, 101, 99, 100, timestamps[0]),
        make_bar(2, timestamps[1], 100, 101, 99, 100, timestamps[1]),
        make_bar(3, timestamps[2], 100, 101, 99, 100, timestamps[2]),
        make_bar(4, timestamps[3], 100, 101, 99, 100, timestamps[3]),
        make_bar(5, timestamps[4], 100, 101, 99, 100, timestamps[4]),
        make_bar(6, timestamps[5], 100, 101, 99, 100, timestamps[5]),
        make_bar(7, timestamps[6], 102, 103, 102, 102, timestamps[6]),  # prev (low 102.0)
        make_bar(8, timestamps[7], 99, 100, 100, 100, timestamps[7]),  # curr (low 100.0)
        make_bar(9, timestamps[8], 101, 105, 102, 104, timestamps[8]),  # nxt (low 102.0)
        make_bar(10, timestamps[9], 104, 110, 103, 108, timestamps[9]),
    ]
    resistance = StructuralLevel(levelPrice=110.0, sequenceNumber=1, sourceTimestamp=100000, availableAt=100000)
    atr = ATRObservation(atr14=2.0, sourceTimestamp=100000, availableAt=100000)

    engine.process_new_candle(candles, resistance, None, atr, timestamps[9])
    assert engine.state == FibLifecycleState.PIVOT_CANDIDATE_DETECTED

    candles.append(make_bar(11, timestamps[10], 115, 200, 114, 195, timestamps[10]))
    engine.process_new_candle(candles, resistance, None, atr, timestamps[10])
    assert engine.state == FibLifecycleState.IMPULSE_TRACKING

    retracement = RetracementObservation(low=135.0, sequenceNumber=12, observedAt=timestamps[11], availableAt=timestamps[11])
    candles.append(make_bar(12, timestamps[11], 195, 196, 135, 136, timestamps[11]))
    engine.process_new_candle(candles, resistance, retracement, atr, timestamps[11])
    assert engine.state == FibLifecycleState.RETRACEMENT_QUALIFIED
    assert engine.poi_qualified_seq == 12

    # Price drifts sideways well above the invalidation level (pendingPivotLow 100 - 2 ticks =
    # 99.9) without ever revisiting it -- exactly the real-world condition that stalled the engine.
    for seq in (13, 14, 15):
        candles.append(make_bar(seq, timestamps[seq - 1], 150, 151, 150.0, 150, timestamps[seq - 1]))
        engine.process_new_candle(candles, resistance, None, atr, timestamps[seq - 1])
        assert engine.state == FibLifecycleState.RETRACEMENT_QUALIFIED, f"should still be qualified at age {seq - 12}"

    # Age now exceeds maxQualifiedLifetimeBars=3 (seq 16 - poi_qualified_seq 12 = 4) -- force-expire.
    candles.append(make_bar(16, timestamps[15], 150, 151, 150.0, 150, timestamps[15]))
    _, status = engine.process_new_candle(candles, resistance, None, atr, timestamps[15])
    assert status == "EXPIRED"
    assert engine.state == FibLifecycleState.IDLE
    assert engine.active_poi is None
    assert engine.poi_qualified_seq is None

    # Re-arm proof: the engine can now detect a brand-new pivot low, which the old, never-exiting
    # RETRACEMENT_QUALIFIED state would otherwise have blocked forever.
    candles.append(make_bar(17, timestamps[16], 150, 151, 120, 150, timestamps[16]))  # prev (low 120)
    candles.append(make_bar(18, timestamps[17], 119, 120, 110, 111, timestamps[17]))  # curr (low 110)
    candles.append(make_bar(19, timestamps[18], 112, 118, 115, 117, timestamps[18]))  # nxt (low 115)
    candles.append(make_bar(20, timestamps[19], 117, 119, 108, 109, timestamps[19]))  # latest, close 109 < resistance 110 (no MSS cascade yet)
    engine.process_new_candle(candles, resistance, None, atr, timestamps[19])
    assert engine.state == FibLifecycleState.PIVOT_CANDIDATE_DETECTED
