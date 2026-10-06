"""
Master 5-Layer Scanner Core & Exhaustive Rejection Mapping
Implementation Contract v1.4.1 & Research Specification v1.1
"""

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from ai_quant_lab_ml.fibonacci_pit_engine import (
    ATRObservation,
    CandleIdentity,
    ExitGeometry,
    FeatureProvenance,
    FeatureVector,
    FibAnchorCalibrationArtifact,
    FootprintBar,
    GEXContext,
    GEXContextState,
    L2DepthLiquidityObservation,
    LambdaCalibrationArtifact,
    MagnitudeEstimate,
    NormalizedOFI,
    RetracementObservation,
    StatefulPITFibEngine,
    StructuralLevel,
)

SignalRejectReason = str
# Taxonomy:
# 'NONE' | 'PIT_FUTURE_DATA_REJECTION' | 'PIT_TIMESTAMP_INCONSISTENCY' | 'SEQUENCE_ORDER_VIOLATION'
# 'FEATURE_DEFINITION_MISMATCH' | 'MAGNITUDE_HURDLE_FAILED' | 'BREADTH_DETERIORATING_VETO'
# 'VOLATILITY_EXPANSION_VETO' | 'VOLUME_PROFILE_STABLE_VETO' | 'TOD_SESSION_BOUNDARY_VETO'
# 'LOCATION_NOT_IN_FIB_ZONE' | 'OFI_BELOW_BASELINE_THRESHOLD' | 'LAMBDA_PROXY_PROOF_FAILED'
# 'FOOTPRINT_SHAPE_UNQUALIFIED' | 'STRUCTURAL_INVALIDATION' | 'CALIBRATION_CONTEXT_MISMATCH'
# 'INSUFFICIENT_DATA_LAYER4_NULL' | 'INSUFFICIENT_DATA_CANDLE_COUNT' | 'CONTRACT_VIOLATION_UNKNOWN'

SignalState = str
# 'QUALIFIED_FOR_RESEARCH' | 'NOT_QUALIFIED' | 'INSUFFICIENT_DATA' | 'STALE_CONTEXT' | 'INVALIDATED'


@dataclass
class CandidateSignal:
    symbol: str
    timestamp: int
    signalState: SignalState
    rejectReason: SignalRejectReason
    signalType: str  # 'BULLISH_CANDIDATE' | 'NO_SIGNAL'
    macroZone: str   # 'GOLDEN_POCKET' | 'OTE' | 'DEEP_RETRACEMENT' | 'NONE'
    entryPrice: float
    exitGeometry: ExitGeometry
    featureVector: FeatureVector
    provenance: List[FeatureProvenance]
    layer0Status: bool
    layer1Status: bool
    layer2Status: bool
    layer3State: GEXContextState
    layer4Status: bool


class Layer0RegimeEvaluator:
    def __init__(self, friction_hurdle_bps: float = 2.0):
        self.friction_hurdle_bps = friction_hurdle_bps

    def evaluate_regime(self, magnitude: MagnitudeEstimate, direction: str,
                        breadth_ad: float, breadth_available_at: int,
                        yz_vol_ratio: float, yz_available_at: int,
                        vp_label: str, vp_available_at: int,
                        tod_sin: float, tod_cos: float,
                        decision_at: int) -> Tuple[bool, str]:
        # 1. Magnitude Hurdle Check
        if magnitude.expectedMoveBps < self.friction_hurdle_bps:
            return False, "EXPECTED_MOVE_BELOW_FRICTION_HURDLE"

        # 2. Breadth Gate
        if direction == "BULLISH" and breadth_ad < -0.5:
            return False, "BREADTH_DETERIORATING_LONG_VETO"

        # 3. Volatility Expansion Veto
        if yz_vol_ratio > 2.5:
            return False, "VOLATILITY_EXPANSION_MEAN_REVERSION_VETO"

        # 4. Volume Profile Regime Veto
        if vp_label == "BALANCED_RANGE":
            return False, "VOLUME_PROFILE_STABLE_BALANCE_VETO"

        # 5. Time of Day Prior Gate (Veto illiquid market open/close boundary windows)
        if abs(tod_sin) > 0.95 or tod_cos < -0.95:
            return False, "TOD_SESSION_BOUNDARY_VETO"

        return True, "NONE"


class Layer2MicrostructureEngine:
    def __init__(self, lambda_artifact: LambdaCalibrationArtifact):
        self.lambda_artifact = lambda_artifact

    def classify_footprint_shape(self, bar: FootprintBar) -> str:
        if bar.totalVolume <= 0:
            return "UNKNOWN"
        elif bar.tailVolumeRatio > 0.35 and bar.pocDisplacementZ < -0.5:
            return "B_SHAPE"
        elif bar.tailVolumeRatio > 0.35 and bar.pocDisplacementZ > 0.5:
            return "P_SHAPE"
        elif abs(bar.pocDisplacementZ) <= 0.3 and bar.tailVolumeRatio <= 0.25:
            return "D_SHAPE"
        return "IRREGULAR"

    def evaluate_microstructure(self, bar: FootprintBar, normalized_ofi: NormalizedOFI,
                                current_instrument: str, current_regime: str,
                                decision_at: int) -> Tuple[bool, SignalRejectReason]:
        if bar.availableAt > decision_at or normalized_ofi.availableAt > decision_at:
            return False, "PIT_FUTURE_DATA_REJECTION"

        if self.lambda_artifact.featureDefinitionId != "LAMBDA_PROXY_RANGE_DELTA_V1":
            return False, "CALIBRATION_CONTEXT_MISMATCH"
        if self.lambda_artifact.trainedThrough > decision_at:
            return False, "PIT_FUTURE_DATA_REJECTION"
        if self.lambda_artifact.instrument != current_instrument or self.lambda_artifact.regime != current_regime:
            return False, "CALIBRATION_CONTEXT_MISMATCH"

        # No validated gate threshold exists on this feature's raw value. "0.032" (Phase 28,
        # docs/phase-28-microstructure-information-flow.md section 11) is the measured
        # INFORMATION COEFFICIENT -- a dataset-level rank correlation between this feature and
        # a 30s-ahead forward return, naturally in [-1, 1] -- not a cutoff on the feature
        # itself, which is a raw signed sum of order quantities on a completely different
        # scale. Phase 28 also found the IC's sign is unstable across time windows ("DOES NOT
        # REPLICATE", doc section 9), so there is no stable direction to gate on even if units
        # matched. A prior version of this method applied `ofi30s <= 0.032` as if it were a
        # feature-value threshold; that compared incompatible units and has been removed. The
        # real value is still recorded in the feature vector for diagnostic/matching use.

        price_range = bar.high - bar.low
        DELTA_EPSILON = 1.0
        lambda_proxy = (price_range / abs(bar.netDelta)) if abs(bar.netDelta) >= DELTA_EPSILON else None

        if lambda_proxy is None or lambda_proxy >= self.lambda_artifact.threshold:
            return False, "LAMBDA_PROXY_PROOF_FAILED"

        shape = self.classify_footprint_shape(bar)
        if shape == "B_SHAPE":
            return True, "NONE"

        return False, "FOOTPRINT_SHAPE_UNQUALIFIED"


class Master5LayerScanner:
    def __init__(self, lambda_artifact: LambdaCalibrationArtifact,
                 fib_artifact: FibAnchorCalibrationArtifact,
                 calibration_end: int, evaluation_start: int, tick_size: float = 0.05):
        self.tick_size = tick_size
        self.fib_artifact = fib_artifact
        self.calibration_end = calibration_end
        self.evaluation_start = evaluation_start
        self.audit_log: List[Dict] = []
        self.layer0 = Layer0RegimeEvaluator()
        self.layer1 = StatefulPITFibEngine(fib_artifact=fib_artifact, tick_size=tick_size)
        self.layer2 = Layer2MicrostructureEngine(lambda_artifact=lambda_artifact)

    def emit_audit_event(self, event_type: str, decision_at: int, details: str):
        self.audit_log.append({
            "eventType": event_type,
            "decisionAt": decision_at,
            "details": details
        })

    def process_market_state(self, bar: FootprintBar, current_candles: List[FootprintBar], current_l2,
                             gex_context: GEXContext, magnitude: MagnitudeEstimate,
                             normalized_ofi: NormalizedOFI, l2_depth_liq: L2DepthLiquidityObservation,
                             breadth_ad: float, breadth_available_at: int, breadth_source_time: int,
                             yz_vol: float, yz_available_at: int, yz_source_time: int,
                             vp_label: str, vp_available_at: int, tod_sin: float, tod_cos: float,
                             structural_resistance: StructuralLevel,
                             retracement: Optional[RetracementObservation], atr_obs: ATRObservation,
                             current_instrument: str, current_regime: str,
                             decision_at: int) -> CandidateSignal:

        # ---------------------------------------------------------------------
        # STEP 1: ZERO-MUTATION UNIVERSAL PIT BUNDLE GATE (P0 Absolute Pre-Gate)
        # Aborts IMMEDIATELY before mutating Fib engine if ANY input is future-dated,
        # uncalibrated, mismatched, timestamp-inconsistent, or insufficient depth.
        # ---------------------------------------------------------------------
        null_exit_geom = ExitGeometry(
            structuralStop=None, opposingLiquidity=None, candidateFibTargets=[], barrierFree=None, pathScore=None, availableAt=None
        )
        dummy_feat_vec_empty = FeatureVector(
            decisionAt=decision_at, fibAnchorType="BULLISH_IMPULSE", fibDirection=1,
            fibAnchorAvailableAt=None, fibZone="NONE", fibRetracement=None, distanceTo618=None,
            distanceTo650=None, distanceTo702=None, distanceTo786=None, distanceTo886=None,
            inGoldenPocket=False, inOTE=False, inDeepRetracement=False, anchorLow=None,
            anchorHigh=None, anchorRangePrice=None, anchorRangeTicks=None, anchorRangeAtr=None, anchorAgeBars=None,
            impulseVelocity=None, normalizedOfi30s=normalized_ofi.ofi30s, depthNormFactor=normalized_ofi.depthNormFactor,
            l2DepthLiquidity=l2_depth_liq.meanTop5Depth, lambdaProxy=None, pocDisplacementZ=bar.pocDisplacementZ,
            tailVolumeRatio=bar.tailVolumeRatio, footprintShape="UNKNOWN", breadthAd=breadth_ad,
            yzVolRatio=yz_vol, todSin=tod_sin, todCos=tod_cos, gexState="UNAVAILABLE"
        )

        # Immediate Candle Depth Safeguard — Evaluated BEFORE accessing current_candles[-1]!
        if not current_candles or len(current_candles) < 10:
            return CandidateSignal(
                symbol=current_instrument, timestamp=decision_at, signalState="NOT_QUALIFIED",
                rejectReason="INSUFFICIENT_DATA_CANDLE_COUNT", signalType="NO_SIGNAL", macroZone="NONE", entryPrice=0,
                exitGeometry=null_exit_geom, featureVector=dummy_feat_vec_empty, provenance=[],
                layer0Status=False, layer1Status=False, layer2Status=False, layer3State="UNAVAILABLE", layer4Status=False
            )

        latest = current_candles[-1]

        # Sequence Monotonicity Validation
        seqs = [c.identity.sequenceNumber for c in current_candles]
        sequence_order_valid = all(a < b for a, b in zip(seqs, seqs[1:]))

        candles_pit_valid = all(c.availableAt <= decision_at and c.identity.closeTimestamp <= decision_at for c in current_candles)

        identity_consistent = (
            latest.identity.barId == bar.identity.barId and
            latest.identity.sequenceNumber == bar.identity.sequenceNumber and
            latest.identity.closeTimestamp == bar.identity.closeTimestamp
        )

        # Strict Universal Retracement Invariant: observedAt <= availableAt <= decisionAt
        retracement_pit_valid = (
            retracement is None or (
                retracement.observedAt <= retracement.availableAt <= decision_at and
                retracement.sequenceNumber <= latest.identity.sequenceNumber
            )
        )

        # Retracement & ATR Temporal Tie Validation in Step 1
        retracement_atr_tie_valid = (
            retracement is None or (
                atr_obs.sourceTimestamp <= retracement.observedAt and
                atr_obs.availableAt <= retracement.observedAt
            )
        )

        universal_timestamps_valid = (
            magnitude.sourceTimestamp <= magnitude.availableAt <= decision_at and
            normalized_ofi.sourceTimestamp <= normalized_ofi.availableAt <= decision_at and
            l2_depth_liq.sourceTimestamp <= l2_depth_liq.availableAt <= decision_at and
            breadth_source_time <= breadth_available_at <= decision_at and
            yz_source_time <= yz_available_at <= decision_at and
            vp_available_at <= decision_at and
            atr_obs.sourceTimestamp <= atr_obs.availableAt <= decision_at
        )

        features_definition_valid = (
            normalized_ofi.featureDefinitionId == "CKS_OFI_TOUCH_5S_RAW_V1" and
            atr_obs.featureDefinitionId == "ATR_14_WILDER_V1" and
            l2_depth_liq.featureDefinitionId == "L2_DEPTH_LIQUIDITY_TOP5_V1" and
            self.fib_artifact.featureDefinitionId == "FIB_RETRACEMENT_STATEFUL_V1" and
            self.layer2.lambda_artifact.featureDefinitionId == "LAMBDA_PROXY_RANGE_DELTA_V1"
        )

        # Global Calibration Separation Lock (asserts trainedThrough <= Tcal_end < Teval_start <= decisionAt)
        calibration_valid = (
            self.fib_artifact.trainedThrough <= self.calibration_end and
            self.calibration_end < self.evaluation_start and
            decision_at >= self.evaluation_start and
            self.fib_artifact.instrument == current_instrument and
            self.fib_artifact.regime == current_regime and
            self.layer2.lambda_artifact.trainedThrough <= self.calibration_end and
            self.layer2.lambda_artifact.instrument == current_instrument and
            self.layer2.lambda_artifact.regime == current_regime
        )

        pit_valid = (
            sequence_order_valid and
            candles_pit_valid and
            identity_consistent and
            retracement_pit_valid and
            retracement_atr_tie_valid and
            universal_timestamps_valid and
            features_definition_valid and
            calibration_valid
        )

        # Feature Provenance Tracking
        provenance = [
            FeatureProvenance("magnitude", "D0_E_MAGNITUDE_V1", magnitude.sourceTimestamp, magnitude.availableAt),
            FeatureProvenance("normalized_ofi", "CKS_OFI_TOUCH_5S_RAW_V1", normalized_ofi.sourceTimestamp, normalized_ofi.availableAt),
            FeatureProvenance("l2_depth_liquidity", "L2_DEPTH_LIQUIDITY_TOP5_V1", l2_depth_liq.sourceTimestamp, l2_depth_liq.availableAt),
            FeatureProvenance("lambda_proxy", "LAMBDA_PROXY_RANGE_DELTA_V1", bar.identity.closeTimestamp, bar.availableAt),
            FeatureProvenance("footprint_shape", "FP_SHAPE_POC_TAIL_Z_V1", bar.identity.closeTimestamp, bar.availableAt),
            FeatureProvenance("fib_retracement", "FIB_RETRACEMENT_STATEFUL_V1", bar.identity.closeTimestamp, bar.availableAt),
            FeatureProvenance("breadth", "BREADTH_AD_V1", breadth_source_time, breadth_available_at),
            FeatureProvenance("yz_vol", "YZ_VOL_10P_RATIO_V1", yz_source_time, yz_available_at),
            FeatureProvenance("gex", "GEX_PCR_15M_V1", gex_context.snapshotTimestamp, gex_context.availableAt)
        ]

        # Multi-State GEX Handling (Future timestamp validation strictly precedes state preservation)
        if gex_context.snapshotTimestamp is not None and gex_context.snapshotTimestamp > decision_at:
            gex_state_eval: GEXContextState = "INVALID"
            self.emit_audit_event("AUDIT_ANOMALY_FUTURE_GEX", decision_at, "Future-dated GEX snapshot timestamp detected")
        elif gex_context.availableAt is not None and gex_context.availableAt > decision_at:
            gex_state_eval: GEXContextState = "INVALID"
            self.emit_audit_event("AUDIT_ANOMALY_FUTURE_GEX", decision_at, "Future-dated GEX availability timestamp detected")
        elif gex_context.state == "INVALID":
            gex_state_eval: GEXContextState = "INVALID"
        elif gex_context.state == "UNAVAILABLE" or gex_context.snapshotTimestamp is None or gex_context.availableAt is None:
            gex_state_eval: GEXContextState = "UNAVAILABLE"
        elif gex_context.state == "STALE":
            gex_state_eval: GEXContextState = "STALE"
        else:
            gex_age_ms = decision_at - gex_context.snapshotTimestamp
            if gex_age_ms > 15 * 60 * 1000:
                gex_state_eval: GEXContextState = "STALE"
            else:
                gex_state_eval: GEXContextState = "FRESH"

        dummy_feat_vec = FeatureVector(
            decisionAt=decision_at, fibAnchorType="BULLISH_IMPULSE", fibDirection=1,
            fibAnchorAvailableAt=None, fibZone="NONE", fibRetracement=None, distanceTo618=None,
            distanceTo650=None, distanceTo702=None, distanceTo786=None, distanceTo886=None,
            inGoldenPocket=False, inOTE=False, inDeepRetracement=False, anchorLow=None,
            anchorHigh=None, anchorRangePrice=None, anchorRangeTicks=None, anchorRangeAtr=None, anchorAgeBars=None,
            impulseVelocity=None, normalizedOfi30s=normalized_ofi.ofi30s, depthNormFactor=normalized_ofi.depthNormFactor,
            l2DepthLiquidity=l2_depth_liq.meanTop5Depth, lambdaProxy=None, pocDisplacementZ=bar.pocDisplacementZ,
            tailVolumeRatio=bar.tailVolumeRatio, footprintShape="UNKNOWN", breadthAd=breadth_ad,
            yzVolRatio=yz_vol, todSin=tod_sin, todCos=tod_cos, gexState=gex_state_eval
        )

        # EARLY PIT ABORT — ZERO STATE ENGINE MUTATION OCCURS
        if not pit_valid:
            if not sequence_order_valid:
                pit_reject_code: SignalRejectReason = "SEQUENCE_ORDER_VIOLATION"
            elif not identity_consistent:
                pit_reject_code: SignalRejectReason = "PIT_TIMESTAMP_INCONSISTENCY"
            elif not features_definition_valid:
                pit_reject_code: SignalRejectReason = "FEATURE_DEFINITION_MISMATCH"
            elif not calibration_valid:
                pit_reject_code: SignalRejectReason = "CALIBRATION_CONTEXT_MISMATCH"
            else:
                pit_reject_code: SignalRejectReason = "PIT_FUTURE_DATA_REJECTION"

            return CandidateSignal(
                symbol=current_instrument, timestamp=decision_at, signalState="NOT_QUALIFIED",
                rejectReason=pit_reject_code, signalType="NO_SIGNAL", macroZone="NONE", entryPrice=0,
                exitGeometry=null_exit_geom, featureVector=dummy_feat_vec, provenance=provenance,
                layer0Status=False, layer1Status=False, layer2Status=False, layer3State=gex_state_eval, layer4Status=False
            )

        # ---------------------------------------------------------------------
        # STEP 2: MUTATE STATE ENGINE (Only after PIT bundle is 100% valid)
        # ---------------------------------------------------------------------
        engine_updated, engine_reason = self.layer1.process_new_candle(
            current_candles, structural_resistance=structural_resistance,
            retracement=retracement, atr_obs=atr_obs, decision_at=decision_at
        )

        if not engine_updated:
            return CandidateSignal(
                symbol=current_instrument, timestamp=decision_at, signalState="NOT_QUALIFIED",
                rejectReason="INSUFFICIENT_DATA_CANDLE_COUNT", signalType="NO_SIGNAL", macroZone="NONE", entryPrice=0,
                exitGeometry=null_exit_geom, featureVector=dummy_feat_vec, provenance=provenance,
                layer0Status=False, layer1Status=False, layer2Status=False, layer3State=gex_state_eval, layer4Status=False
            )

        in_location, zone_name = self.layer1.evaluate_location(bar.close, decision_at=decision_at)

        poi = self.layer1.active_poi
        price_range = bar.high - bar.low
        DELTA_EPSILON = 1.0
        lambda_proxy = (price_range / abs(bar.netDelta)) if abs(bar.netDelta) >= DELTA_EPSILON else None

        footprint_shape = self.layer2.classify_footprint_shape(bar)

        anchor_range_price = (poi.anchorHigh - poi.anchorLow) if poi else None
        anchor_range_ticks = (anchor_range_price / self.tick_size) if poi else None
        fib_retracement_val = ((poi.anchorHigh - bar.close) / anchor_range_price) if (poi and anchor_range_price and anchor_range_price > 0) else None
        range_atr_ratio = (anchor_range_price / atr_obs.atr14) if (anchor_range_price and atr_obs.atr14 > 0) else None

        anchor_age_bars = (bar.identity.sequenceNumber - self.layer1.mss_confirmed_seq) if (poi and self.layer1.mss_confirmed_seq) else None
        impulse_duration_bars = (poi.anchorHighBarIndex - poi.anchorLowBarIndex + 1) if poi else None
        impulse_velocity = (anchor_range_price / impulse_duration_bars) if (anchor_range_price and impulse_duration_bars and impulse_duration_bars >= 1) else None

        feat_vector = FeatureVector(
            decisionAt=decision_at,
            fibAnchorType="BULLISH_IMPULSE",
            fibDirection=1,
            fibAnchorAvailableAt=(poi.timestamps.availableAt if poi else None),
            fibZone=zone_name,
            fibRetracement=fib_retracement_val,
            distanceTo618=abs(fib_retracement_val - 0.618) if fib_retracement_val is not None else None,
            distanceTo650=abs(fib_retracement_val - 0.650) if fib_retracement_val is not None else None,
            distanceTo702=abs(fib_retracement_val - 0.702) if fib_retracement_val is not None else None,
            distanceTo786=abs(fib_retracement_val - 0.786) if fib_retracement_val is not None else None,
            distanceTo886=abs(fib_retracement_val - 0.886) if fib_retracement_val is not None else None,
            inGoldenPocket=(zone_name == "GOLDEN_POCKET"),
            inOTE=(zone_name == "OTE"),
            inDeepRetracement=(zone_name == "DEEP_RETRACEMENT"),
            anchorLow=(poi.anchorLow if poi else None),
            anchorHigh=(poi.anchorHigh if poi else None),
            anchorRangePrice=anchor_range_price,
            anchorRangeTicks=anchor_range_ticks,
            anchorRangeAtr=range_atr_ratio,
            anchorAgeBars=anchor_age_bars,
            impulseVelocity=impulse_velocity,
            normalizedOfi30s=normalized_ofi.ofi30s,
            depthNormFactor=normalized_ofi.depthNormFactor,
            l2DepthLiquidity=l2_depth_liq.meanTop5Depth,
            lambdaProxy=lambda_proxy,
            pocDisplacementZ=bar.pocDisplacementZ,
            tailVolumeRatio=bar.tailVolumeRatio,
            footprintShape=footprint_shape,
            breadthAd=breadth_ad,
            yzVolRatio=yz_vol,
            todSin=tod_sin,
            todCos=tod_cos,
            gexState=gex_state_eval
        )

        cand_targets = [poi.anchorHigh + anchor_range_price * 0.272, poi.anchorHigh + anchor_range_price * 0.618] if poi and anchor_range_price else []

        active_exit_geom = ExitGeometry(
            structuralStop=(poi.invalidation if poi else None),
            opposingLiquidity=None,
            candidateFibTargets=cand_targets,
            barrierFree=None,
            pathScore=None,
            availableAt=None
        )

        # Layer 0 Evaluation & Exhaustive Fail-Closed Rejection Mapping
        l0_pass, l0_reason = self.layer0.evaluate_regime(
            magnitude=magnitude, direction="BULLISH", breadth_ad=breadth_ad,
            breadth_available_at=breadth_available_at, yz_vol_ratio=yz_vol,
            yz_available_at=yz_available_at, vp_label=vp_label,
            vp_available_at=vp_available_at, tod_sin=tod_sin, tod_cos=tod_cos,
            decision_at=decision_at
        )

        l0_reject_map: Dict[str, SignalRejectReason] = {
            "EXPECTED_MOVE_BELOW_FRICTION_HURDLE": "MAGNITUDE_HURDLE_FAILED",
            "BREADTH_DETERIORATING_LONG_VETO": "BREADTH_DETERIORATING_VETO",
            "VOLATILITY_EXPANSION_MEAN_REVERSION_VETO": "VOLATILITY_EXPANSION_VETO",
            "VOLUME_PROFILE_STABLE_BALANCE_VETO": "VOLUME_PROFILE_STABLE_VETO",
            "TOD_SESSION_BOUNDARY_VETO": "TOD_SESSION_BOUNDARY_VETO"
        }

        if not l0_pass:
            if l0_reason not in l0_reject_map:
                raise ValueError(f"ContractViolation: Unknown Layer 0 rejection reason: {l0_reason}")
            return CandidateSignal(
                symbol=current_instrument, timestamp=decision_at,
                signalState="NOT_QUALIFIED", rejectReason=l0_reject_map[l0_reason],
                signalType="NO_SIGNAL", macroZone=zone_name, entryPrice=0,
                exitGeometry=null_exit_geom, featureVector=feat_vector,
                provenance=provenance, layer0Status=False, layer1Status=in_location,
                layer2Status=False, layer3State=gex_state_eval, layer4Status=False
            )

        if not in_location:
            return CandidateSignal(
                symbol=current_instrument, timestamp=decision_at,
                signalState="NOT_QUALIFIED", rejectReason="LOCATION_NOT_IN_FIB_ZONE",
                signalType="NO_SIGNAL", macroZone=zone_name, entryPrice=0,
                exitGeometry=null_exit_geom, featureVector=feat_vector,
                provenance=provenance, layer0Status=True, layer1Status=False,
                layer2Status=False, layer3State=gex_state_eval, layer4Status=False
            )

        # Layer 2 Evaluation & Exhaustive Rejection Mapping
        l2_pass, l2_reason = self.layer2.evaluate_microstructure(
            bar=bar, normalized_ofi=normalized_ofi, current_instrument=current_instrument,
            current_regime=current_regime, decision_at=decision_at
        )

        if not l2_pass:
            valid_rejections = [
                "OFI_BELOW_BASELINE_THRESHOLD", "LAMBDA_PROXY_PROOF_FAILED",
                "FOOTPRINT_SHAPE_UNQUALIFIED", "PIT_FUTURE_DATA_REJECTION",
                "CALIBRATION_CONTEXT_MISMATCH"
            ]
            if l2_reason not in valid_rejections:
                raise ValueError(f"ContractViolation: Unknown Layer 2 rejection reason: {l2_reason}")

            return CandidateSignal(
                symbol=current_instrument, timestamp=decision_at,
                signalState="NOT_QUALIFIED", rejectReason=l2_reason,
                signalType="NO_SIGNAL", macroZone=zone_name, entryPrice=0,
                exitGeometry=null_exit_geom, featureVector=feat_vector,
                provenance=provenance, layer0Status=True, layer1Status=True,
                layer2Status=False, layer3State=gex_state_eval, layer4Status=False
            )

        # Qualified signal candidate output (INSUFFICIENT_DATA due to Layer 4 Null State)
        return CandidateSignal(
            symbol=current_instrument,
            timestamp=decision_at,
            signalState="INSUFFICIENT_DATA",
            rejectReason="INSUFFICIENT_DATA_LAYER4_NULL",
            signalType="BULLISH_CANDIDATE",
            macroZone=zone_name,
            entryPrice=bar.close,
            exitGeometry=active_exit_geom,
            featureVector=feat_vector,
            provenance=provenance,
            layer0Status=True,
            layer1Status=True,
            layer2Status=True,
            layer3State=gex_state_eval,
            layer4Status=False
        )
