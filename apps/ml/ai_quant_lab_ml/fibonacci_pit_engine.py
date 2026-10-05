"""
Fibonacci Point-In-Time (PIT) Stateful Engine & Data Interfaces
Implementation Contract v1.4.1 & Research Specification v1.1
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Tuple

FIB_PROCESSING_LAG_MS = 50  # Contract ID: FIB_PROCESSING_LAG_V1


class FibLifecycleState(Enum):
    IDLE = 1
    PIVOT_CANDIDATE_DETECTED = 2
    MSS_CONFIRMED = 3
    IMPULSE_TRACKING = 4
    ANCHOR_HIGH_FORMED = 5
    RETRACEMENT_QUALIFIED = 6
    EXPIRED = 7
    INVALIDATED = 8


@dataclass(frozen=True)
class CandleIdentity:
    barId: str
    sequenceNumber: int
    closeTimestamp: int


@dataclass
class FootprintBar:
    identity: CandleIdentity
    open: float
    high: float
    low: float
    close: float
    totalVolume: float
    netDelta: float
    pocDisplacementZ: float
    tailVolumeRatio: float
    availableAt: int


@dataclass(frozen=True)
class PITTimestamps:
    candidateAt: int
    formedAt: int
    confirmedAt: int
    availableAt: int


@dataclass(frozen=True)
class StructuralLevel:
    levelPrice: float
    sequenceNumber: int
    sourceTimestamp: int
    availableAt: int


@dataclass(frozen=True)
class RetracementObservation:
    low: float
    sequenceNumber: int
    observedAt: int
    availableAt: int


@dataclass(frozen=True)
class ATRObservation:
    atr14: float
    sourceTimestamp: int
    availableAt: int
    featureDefinitionId: str = "ATR_14_WILDER_V1"


@dataclass(frozen=True)
class L2DepthLiquidityObservation:
    meanTop5Depth: float
    sourceTimestamp: int
    availableAt: int
    featureDefinitionId: str = "L2_DEPTH_LIQUIDITY_TOP5_V1"


@dataclass(frozen=True)
class NormalizedOFI:
    ofi30s: float
    depthNormFactor: float
    sourceTimestamp: int
    availableAt: int
    featureDefinitionId: str = "CKS_OFI_30S_NORMALIZED_TOP5_V1"


@dataclass(frozen=True)
class MagnitudeEstimate:
    expectedMoveBps: float
    confidence: float
    sourceTimestamp: int
    availableAt: int


GEXContextState = str  # 'FRESH' | 'STALE' | 'UNAVAILABLE' | 'INVALID'


@dataclass
class GEXContext:
    state: GEXContextState
    pcrRatio: Optional[float]
    snapshotTimestamp: Optional[int]
    availableAt: Optional[int]


@dataclass
class ExitGeometry:
    structuralStop: Optional[float]
    opposingLiquidity: Optional[float]
    candidateFibTargets: List[float]
    barrierFree: Optional[bool]
    pathScore: Optional[float]
    availableAt: Optional[int]


@dataclass
class FeatureVector:
    decisionAt: int
    fibAnchorType: str
    fibDirection: int
    fibAnchorAvailableAt: Optional[int]
    fibZone: str
    fibRetracement: Optional[float]
    distanceTo618: Optional[float]
    distanceTo650: Optional[float]
    distanceTo702: Optional[float]
    distanceTo786: Optional[float]
    distanceTo886: Optional[float]
    inGoldenPocket: bool
    inOTE: bool
    inDeepRetracement: bool
    anchorLow: Optional[float]
    anchorHigh: Optional[float]
    anchorRangePrice: Optional[float]
    anchorRangeTicks: Optional[float]
    anchorRangeAtr: Optional[float]
    anchorAgeBars: Optional[int]
    impulseVelocity: Optional[float]
    normalizedOfi30s: Optional[float]
    depthNormFactor: Optional[float]
    l2DepthLiquidity: Optional[float]
    lambdaProxy: Optional[float]
    pocDisplacementZ: Optional[float]
    tailVolumeRatio: Optional[float]
    footprintShape: Optional[str]
    breadthAd: Optional[float]
    yzVolRatio: Optional[float]
    todSin: Optional[float]
    todCos: Optional[float]
    gexState: GEXContextState


@dataclass
class FeatureProvenance:
    featureName: str
    featureVersion: str
    sourceTimestamp: Optional[int]
    availableAt: Optional[int]


@dataclass
class FibonacciPOI:
    anchorLow: float
    anchorHigh: float
    anchorLowBarIndex: int
    anchorHighBarIndex: int
    goldenPocketLow: float
    goldenPocketHigh: float
    oteLow: float
    oteHigh: float
    deepLow: float
    deepHigh: float
    invalidation: float
    timestamps: PITTimestamps
    direction: str
    isAvailable: bool


@dataclass
class FibAnchorCalibrationArtifact:
    calibrationId: str
    featureDefinitionId: str
    instrument: str
    regime: str
    minRetracementTicks: float
    minRetracementAtrMultiple: float
    maxWindowBars: int
    trainedThrough: int


@dataclass
class LambdaCalibrationArtifact:
    calibrationId: str
    featureDefinitionId: str
    instrument: str
    regime: str
    quantile: float
    threshold: float
    trainedThrough: int


@dataclass
class RunCalibrationManifest:
    runId: str
    fibCalibrationId: str
    fibArtifactHash: str
    lambdaCalibrationId: str
    lambdaArtifactHash: str
    calibrationStart: int
    calibrationEnd: int
    evaluationStart: int
    parameterHash: str
    featureDefinitionHashes: Dict[str, str]
    covariateStandardizationMeans: List[float]
    covariateStandardizationStds: List[float]


class StatefulPITFibEngine:
    def __init__(self, fib_artifact: FibAnchorCalibrationArtifact, tick_size: float = 0.05):
        self.tick_size = tick_size
        self.fib_artifact = fib_artifact
        self.min_retracement_ticks = fib_artifact.minRetracementTicks
        self.min_retracement_atr_multiple = fib_artifact.minRetracementAtrMultiple
        self.max_window_bars = fib_artifact.maxWindowBars
        self.event_history: List[Dict] = []
        self.reset_engine()

    def reset_engine(self):
        self.state = FibLifecycleState.IDLE
        self.pending_pivot_low: Optional[float] = None
        self.pending_pivot_seq: Optional[int] = None
        self.pending_pivot_time: Optional[int] = None
        self.pivot_formed_time: Optional[int] = None  # Extremum candle closeTimestamp

        self.bound_resistance_price: Optional[float] = None
        self.bound_resistance_seq: Optional[int] = None
        self.bound_resistance_available_at: Optional[int] = None

        self.mss_confirmed_seq: Optional[int] = None
        self.mss_confirmed_time: Optional[int] = None
        self.mss_confirmed_available_at: Optional[int] = None

        self.anchor_high: Optional[float] = None
        self.anchor_high_seq: Optional[int] = None
        self.anchor_high_time: Optional[int] = None
        self.anchor_high_available_at: Optional[int] = None

        self.active_poi: Optional[FibonacciPOI] = None

    def emit_event(self, event_type: str, seq: int, event_time: int, decision_at: int, details: str):
        self.event_history.append({
            "eventType": event_type,
            "eventTimestamp": event_time,
            "emittedAt": decision_at,
            "sequenceNumber": seq,
            "details": details
        })

    def process_new_candle(self, candles: List[FootprintBar],
                           structural_resistance: StructuralLevel,
                           retracement: Optional[RetracementObservation],
                           atr_obs: ATRObservation,
                           decision_at: int) -> Tuple[bool, str]:
        # Immediate candle depth safeguard
        if not candles or len(candles) < 10:
            return False, "INSUFFICIENT_CANDLES"

        latest_bar = candles[-1]

        # 1. Structural Invalidation Check (Price touching or breaking AnchorLow - 2*tick_size)
        if self.active_poi and latest_bar.low <= self.active_poi.invalidation:
            self.emit_event(
                "INVALIDATED",
                latest_bar.identity.sequenceNumber,
                latest_bar.identity.closeTimestamp,
                decision_at,
                "Price touched or broke 2-tick structural stop"
            )
            self.state = FibLifecycleState.INVALIDATED
            self.reset_engine()
            return True, "INVALIDATED"

        # 2. Candidate Timeout Check (Pivot low candidate must achieve MSS within 10 bars)
        if self.state == FibLifecycleState.PIVOT_CANDIDATE_DETECTED:
            candidate_age_bars = latest_bar.identity.sequenceNumber - self.pending_pivot_seq
            if candidate_age_bars > 10:
                self.emit_event(
                    "EXPIRED",
                    latest_bar.identity.sequenceNumber,
                    latest_bar.identity.closeTimestamp,
                    decision_at,
                    "Pivot candidate timed out without MSS confirmation"
                )
                self.state = FibLifecycleState.EXPIRED
                self.reset_engine()
                return True, "EXPIRED"

        # 3. Post-MSS Independent Expiry Check (Window origin locked strictly to mss_confirmed_seq)
        if self.state in [FibLifecycleState.IMPULSE_TRACKING, FibLifecycleState.ANCHOR_HIGH_FORMED]:
            bars_elapsed = latest_bar.identity.sequenceNumber - self.mss_confirmed_seq
            if bars_elapsed > self.max_window_bars:
                self.emit_event(
                    "EXPIRED",
                    latest_bar.identity.sequenceNumber,
                    latest_bar.identity.closeTimestamp,
                    decision_at,
                    f"Exceeded max window {self.max_window_bars} bars post-MSS"
                )
                self.state = FibLifecycleState.EXPIRED
                self.reset_engine()
                return True, "EXPIRED"

        # State 1: Pivot Low Candidate Detection (Fractal detection with formedAt extremum)
        if self.state == FibLifecycleState.IDLE:
            curr = candles[-3]
            prev = candles[-4]
            nxt = candles[-2]
            candidate_at = nxt.identity.closeTimestamp

            if curr.low < prev.low and curr.low < nxt.low:
                if (prev.availableAt <= candidate_at and
                    curr.availableAt <= candidate_at and
                    nxt.availableAt <= candidate_at and
                    structural_resistance.sourceTimestamp <= candidate_at and
                    structural_resistance.availableAt <= candidate_at):

                    self.pending_pivot_low = curr.low
                    self.pending_pivot_seq = curr.identity.sequenceNumber
                    self.pending_pivot_time = candidate_at
                    self.pivot_formed_time = curr.identity.closeTimestamp  # Extremum price candle close timestamp!
                    self.bound_resistance_price = structural_resistance.levelPrice
                    self.bound_resistance_seq = structural_resistance.sequenceNumber
                    self.bound_resistance_available_at = structural_resistance.availableAt
                    self.state = FibLifecycleState.PIVOT_CANDIDATE_DETECTED
                    self.emit_event(
                        "CANDIDATE_DETECTED",
                        nxt.identity.sequenceNumber,
                        candidate_at,
                        decision_at,
                        "Fractal pivot low detected"
                    )

        # State 2: MSS Confirmation
        if self.state == FibLifecycleState.PIVOT_CANDIDATE_DETECTED:
            if latest_bar.close > self.bound_resistance_price:
                self.mss_confirmed_seq = latest_bar.identity.sequenceNumber
                self.mss_confirmed_time = latest_bar.identity.closeTimestamp
                self.mss_confirmed_available_at = latest_bar.availableAt

                self.anchor_high = latest_bar.high
                self.anchor_high_seq = latest_bar.identity.sequenceNumber
                self.anchor_high_time = latest_bar.identity.closeTimestamp
                self.anchor_high_available_at = latest_bar.availableAt

                self.state = FibLifecycleState.IMPULSE_TRACKING
                self.emit_event(
                    "MSS_CONFIRMED",
                    latest_bar.identity.sequenceNumber,
                    latest_bar.identity.closeTimestamp,
                    decision_at,
                    "Market Structure Shift confirmed"
                )

        # State 3: Dynamic Anchor High Tracking Post-MSS
        if self.state == FibLifecycleState.IMPULSE_TRACKING:
            if latest_bar.high > self.anchor_high:
                self.anchor_high = latest_bar.high
                self.anchor_high_seq = latest_bar.identity.sequenceNumber
                self.anchor_high_time = latest_bar.identity.closeTimestamp
                self.anchor_high_available_at = latest_bar.availableAt
            elif (retracement and
                  self.anchor_high_time < retracement.observedAt <= retracement.availableAt <= decision_at):
                self.state = FibLifecycleState.ANCHOR_HIGH_FORMED
                self.emit_event(
                    "ANCHOR_FORMED",
                    self.anchor_high_seq,
                    self.anchor_high_time,
                    decision_at,
                    f"Anchor High formed at {self.anchor_high}"
                )

        # State 4: Retracement Qualification Check
        if self.state in [FibLifecycleState.IMPULSE_TRACKING, FibLifecycleState.ANCHOR_HIGH_FORMED] and retracement:
            if (self.anchor_high_time < retracement.observedAt <= retracement.availableAt <= decision_at and
                atr_obs.availableAt <= decision_at and
                atr_obs.sourceTimestamp <= retracement.observedAt and
                atr_obs.availableAt <= retracement.observedAt):

                bars_elapsed = retracement.sequenceNumber - self.mss_confirmed_seq
                actual_retracement_ticks = (self.anchor_high - retracement.low) / self.tick_size
                actual_retracement_atr = ((self.anchor_high - retracement.low) / atr_obs.atr14) if atr_obs.atr14 > 0 else 0.0

                qualifies_retracement = (actual_retracement_ticks >= self.min_retracement_ticks or
                                         actual_retracement_atr >= self.min_retracement_atr_multiple)

                if qualifies_retracement and 0 < bars_elapsed <= self.max_window_bars:
                    self.state = FibLifecycleState.RETRACEMENT_QUALIFIED
                    diff = self.anchor_high - self.pending_pivot_low

                    composite_available_at = max(
                        self.pending_pivot_time,
                        self.bound_resistance_available_at,
                        self.mss_confirmed_available_at + FIB_PROCESSING_LAG_MS,
                        self.anchor_high_available_at,
                        retracement.availableAt,
                        atr_obs.availableAt
                    )

                    timestamps = PITTimestamps(
                        candidateAt=self.pending_pivot_time,
                        formedAt=self.pivot_formed_time,  # Extremum candle closeTimestamp (formedAt <= candidateAt <= confirmedAt <= availableAt)
                        confirmedAt=self.mss_confirmed_time,
                        availableAt=composite_available_at
                    )

                    is_available = timestamps.availableAt <= decision_at

                    self.active_poi = FibonacciPOI(
                        anchorLow=self.pending_pivot_low,
                        anchorHigh=self.anchor_high,
                        anchorLowBarIndex=self.pending_pivot_seq,
                        anchorHighBarIndex=self.anchor_high_seq,
                        goldenPocketLow=self.anchor_high - (diff * 0.650),
                        goldenPocketHigh=self.anchor_high - (diff * 0.618),
                        oteLow=self.anchor_high - (diff * 0.786),
                        oteHigh=self.anchor_high - (diff * 0.702),
                        deepLow=self.anchor_high - (diff * 0.886),
                        deepHigh=self.anchor_high - (diff * 0.786),
                        invalidation=self.pending_pivot_low - (2 * self.tick_size),
                        timestamps=timestamps,
                        direction="BULLISH",
                        isAvailable=is_available
                    )
                    self.emit_event(
                        "RETRACEMENT_QUALIFIED",
                        retracement.sequenceNumber,
                        retracement.observedAt,
                        decision_at,
                        "Retracement POI qualified"
                    )
        return True, "UPDATED"

    def evaluate_location(self, price: float, decision_at: int) -> Tuple[bool, str]:
        if not self.active_poi or not self.active_poi.isAvailable:
            return False, "NONE"
        if self.active_poi.timestamps.availableAt > decision_at:
            return False, "NONE"

        poi = self.active_poi
        anchor_range = poi.anchorHigh - poi.anchorLow
        if anchor_range <= 0:
            return False, "NONE"

        # Canonical Retracement Formula: r = (AnchorHigh - Price) / (AnchorHigh - AnchorLow)
        r = (poi.anchorHigh - price) / anchor_range

        if 0.618 <= r <= 0.650:
            return True, "GOLDEN_POCKET"
        elif 0.702 <= r < 0.786:
            return True, "OTE"
        elif 0.786 <= r <= 0.886:
            return True, "DEEP_RETRACEMENT"

        return False, "NONE"
