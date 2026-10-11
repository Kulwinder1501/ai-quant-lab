"""
Unit Tests for Master 5-Layer Scanner & Zero-Mutation Universal PIT Gate
Implementation Contract v1.4.1 & Research Specification v1.1
"""

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
from ai_quant_lab_ml.master_scanner import Layer0RegimeEvaluator, Layer2MicrostructureEngine, Master5LayerScanner


@pytest.fixture
def sample_artifacts():
    fib_art = FibAnchorCalibrationArtifact(
        calibrationId="FIB_CALIB_V1", featureDefinitionId="FIB_RETRACEMENT_STATEFUL_V1",
        instrument="NIFTY", regime="NORMAL", minRetracementTicks=10.0, minRetracementAtrMultiple=0.5,
        maxWindowBars=20, maxQualifiedLifetimeBars=2000, trainedThrough=1000000
    )
    lambda_art = LambdaCalibrationArtifact(
        calibrationId="LAMBDA_CALIB_V1", featureDefinitionId="LAMBDA_PROXY_RANGE_DELTA_V1",
        instrument="NIFTY", regime="NORMAL", quantile=0.25, threshold=0.05, trainedThrough=1000000
    )
    return fib_art, lambda_art


def make_bar(seq: int, timestamp: int, open_p: float, high_p: float, low_p: float, close_p: float, available_at: int) -> FootprintBar:
    return FootprintBar(
        identity=CandleIdentity(barId=f"bar_{seq}", sequenceNumber=seq, closeTimestamp=timestamp),
        open=open_p, high=high_p, low=low_p, close=close_p,
        totalVolume=1000.0, netDelta=-100.0, pocDisplacementZ=-0.6, tailVolumeRatio=0.4, # B-shape footprint
        availableAt=available_at
    )


def test_immediate_candle_depth_safeguard_empty_list(sample_artifacts):
    fib_art, lambda_art = sample_artifacts
    scanner = Master5LayerScanner(lambda_artifact=lambda_art, fib_artifact=fib_art, calibration_end=1000000, evaluation_start=2000000)

    bar = make_bar(1, 2000000, 100, 101, 99, 100, 2000000)
    sig = scanner.process_market_state(
        bar=bar, current_candles=[], current_l2=None,
        gex_context=GEXContext("FRESH", 1.0, 2000000, 2000000),
        magnitude=MagnitudeEstimate(5.0, 0.9, 2000000, 2000000),
        normalized_ofi=NormalizedOFI(0.05, 1000.0, 2000000, 2000000),
        l2_depth_liq=L2DepthLiquidityObservation(500.0, 2000000, 2000000),
        breadth_ad=0.2, breadth_available_at=2000000, breadth_source_time=2000000,
        yz_vol=1.2, yz_available_at=2000000, yz_source_time=2000000,
        vp_label="TRENDING_UP", vp_available_at=2000000, tod_sin=0.0, tod_cos=0.0,
        structural_resistance=StructuralLevel(102.0, 1, 2000000, 2000000),
        retracement=None, atr_obs=ATRObservation(2.0, 2000000, 2000000),
        current_instrument="NIFTY", current_regime="NORMAL", decision_at=2000000
    )

    assert sig.signalState == "NOT_QUALIFIED"
    assert sig.rejectReason == "INSUFFICIENT_DATA_CANDLE_COUNT"


def test_layer0_tod_edge_veto_basic_evaluation():
    """
    Time-of-day gate: the session open/close (sin, cos) = (0, 1) are vetoed; mid-session values
    with extreme sin or cos are NOT (the earlier rule vetoed those and never the real edges --
    see tests/test_master_scanner_direction.py for the exhaustive per-minute check).
    """
    evaluator = Layer0RegimeEvaluator(friction_hurdle_bps=2.0)
    mag = MagnitudeEstimate(5.0, 0.9, 1000, 1000)

    def run(tod_sin, tod_cos):
        return evaluator.evaluate_regime(
            magnitude=mag, direction="BULLISH", breadth_ad=0.2, breadth_available_at=1000,
            yz_vol_ratio=1.2, yz_available_at=1000, vp_label="TRENDING", vp_available_at=1000,
            tod_sin=tod_sin, tod_cos=tod_cos, decision_at=1000,
        )

    assert run(0.5, 0.5) == (True, "NONE")
    assert run(0.98, 0.0) == (True, "NONE")      # quarter-session point: tradeable
    assert run(0.0, -0.98) == (True, "NONE")     # mid-session: tradeable
    assert run(0.0, 1.0) == (False, "TOD_SESSION_BOUNDARY_VETO")   # open / close edge


def test_future_gex_anomaly_logging(sample_artifacts):
    fib_art, lambda_art = sample_artifacts
    scanner = Master5LayerScanner(lambda_artifact=lambda_art, fib_artifact=fib_art, calibration_end=1000000, evaluation_start=2000000)

    t = 2000000
    candles = [make_bar(i + 1, t + i * 1000, 100, 101, 99, 100, t + i * 1000) for i in range(10)]
    bar = candles[-1]

    # Future-dated GEX snapshot timestamp: t + 5000 > decision_at (t)
    gex_future = GEXContext(state="FRESH", pcrRatio=1.0, snapshotTimestamp=t + 5000, availableAt=t + 5000)

    sig = scanner.process_market_state(
        bar=bar, current_candles=candles, current_l2=None,
        gex_context=gex_future,
        magnitude=MagnitudeEstimate(5.0, 0.9, t, t),
        normalized_ofi=NormalizedOFI(0.05, 1000.0, t, t),
        l2_depth_liq=L2DepthLiquidityObservation(500.0, t, t),
        breadth_ad=0.2, breadth_available_at=t, breadth_source_time=t,
        yz_vol=1.2, yz_available_at=t, yz_source_time=t,
        vp_label="TRENDING_UP", vp_available_at=t, tod_sin=0.0, tod_cos=0.0,
        structural_resistance=StructuralLevel(102.0, 1, t, t),
        retracement=None, atr_obs=ATRObservation(2.0, t, t),
        current_instrument="NIFTY", current_regime="NORMAL", decision_at=t
    )

    assert sig.layer3State == "INVALID"
    assert len(scanner.audit_log) == 1
    assert scanner.audit_log[0]["eventType"] == "AUDIT_ANOMALY_FUTURE_GEX"


def test_step1_pit_rejection_zero_mutation(sample_artifacts):
    fib_art, lambda_art = sample_artifacts
    scanner = Master5LayerScanner(lambda_artifact=lambda_art, fib_artifact=fib_art, calibration_end=1000000, evaluation_start=2000000)

    t = 2000000
    candles = [make_bar(i + 1, t + i * 1000, 100, 101, 99, 100, t + i * 1000) for i in range(10)]
    bar = candles[-1]

    # Mismatched OFI feature definition ID
    invalid_ofi = NormalizedOFI(0.05, 1000.0, t, t, featureDefinitionId="WRONG_ID")

    sig = scanner.process_market_state(
        bar=bar, current_candles=candles, current_l2=None,
        gex_context=GEXContext("FRESH", 1.0, t, t),
        magnitude=MagnitudeEstimate(5.0, 0.9, t, t),
        normalized_ofi=invalid_ofi,
        l2_depth_liq=L2DepthLiquidityObservation(500.0, t, t),
        breadth_ad=0.2, breadth_available_at=t, breadth_source_time=t,
        yz_vol=1.2, yz_available_at=t, yz_source_time=t,
        vp_label="TRENDING_UP", vp_available_at=t, tod_sin=0.0, tod_cos=0.0,
        structural_resistance=StructuralLevel(102.0, 1, t, t),
        retracement=None, atr_obs=ATRObservation(2.0, t, t),
        current_instrument="NIFTY", current_regime="NORMAL", decision_at=t
    )

    assert sig.signalState == "NOT_QUALIFIED"
    assert sig.rejectReason == "FEATURE_DEFINITION_MISMATCH"
    # Verify Fib engine state was ZERO mutated (still IDLE)
    assert scanner.layer1.state == FibLifecycleState.IDLE
