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
    ANCHOR_LOW_FORMED = 9  # bearish mirror of ANCHOR_HIGH_FORMED (StatefulPITFibEngineBearish only)


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
    # False when the source feed has no trade-tape / footprint data (e.g. an OHLCV-only candle
    # series): netDelta / pocDisplacementZ / tailVolumeRatio are then placeholders, NOT readings.
    # Layer 2 reports such bars as ORDER_FLOW_UNAVAILABLE (unmeasured) rather than letting the
    # zeros fail a gate and be misread as "order flow tested and rejected".
    orderFlowAvailable: bool = True


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
    # Bearish mirror field (StatefulPITFibEngineBearish qualifies retracement DEPTH as a pullback
    # UP from an anchor low, using `high`, not `low`). Defaulted so every existing bullish-only
    # construction of this frozen dataclass stays valid unchanged.
    high: float = 0.0


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
    # "CKS_OFI_30S_NORMALIZED_TOP5_V1" (30s window, top-5 levels, depth-normalized) was never
    # implemented or validated anywhere in this codebase. What Phase 28 actually built and
    # validated (docs/phase-28-microstructure-information-flow.md) is touch-level-only, a
    # 5000ms trailing window, raw units -- see apps/ml/ai_quant_lab_ml/cks_ofi_touch.py, which
    # ports it faithfully under its correct name.
    featureDefinitionId: str = "CKS_OFI_TOUCH_5S_RAW_V1"


@dataclass(frozen=True)
class MagnitudeEstimate:
    expectedMoveBps: float
    confidence: float
    sourceTimestamp: int
    availableAt: int


OptionsContextState = str  # 'FRESH' | 'STALE' | 'UNAVAILABLE' | 'INVALID'
# Backward-compatible alias: existing imports and tests keep using the old name.
GEXContextState = OptionsContextState


@dataclass
class OptionsContext:
    """Freshness envelope of an options snapshot. This is NOT gamma exposure (GEX).

    No GEX model exists in this repository: gamma exposure needs per-strike gamma x open interest
    x contract multiplier aggregated by dealer-positioning assumptions, and nothing here computes
    it. What this object carries is only:

    * ``state`` / ``snapshotTimestamp`` / ``availableAt`` -- whether an options snapshot was
      available, fresh and not future-dated at the decision time. The scanner's Layer 3 reads ONLY
      these (a freshness flag, ``layer3State``).
    * ``pcrRatio`` -- a put/call OI ratio, carried but NEVER read by the scanner. If a producer ever
      fills it, it is a windowed PCR (the collector's +/-strikecount strikes around spot for the
      nearest un-settled expiry), not a whole-chain PCR and not a gamma measure.

    Historical name: ``GEXContext`` (kept as an alias below). The old name overstated what the data
    is; tests that construct ``GEXContext("FRESH", 1.0, t, t)`` fabricate the ratio and prove only
    the freshness logic.
    """

    state: OptionsContextState
    pcrRatio: Optional[float]
    snapshotTimestamp: Optional[int]
    availableAt: Optional[int]


# Backward-compatible alias (same class object): `GEXContext(...)`, isinstance checks and imports
# in existing callers and tests continue to work unchanged.
GEXContext = OptionsContext


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
    # Options-context FRESHNESS state (not gamma exposure). The field name is kept for stored-JSON
    # compatibility; see `OptionsContext`.
    gexState: OptionsContextState


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
    # RETRACEMENT_QUALIFIED has no natural exit besides INVALIDATED (price breaking 2 ticks below
    # the anchor low). Empirically (see run_phase_c_pipeline.py 2026-10-06 finding), a POI whose
    # anchor low is never revisited stays qualified forever, blocking all new pivot detection: one
    # NIFTY50 POI stayed qualified for 92% of a 2.75-year history. This bounds how long a qualified
    # zone stays live before it is force-expired and the engine re-arms to look for a fresh pivot.
    maxQualifiedLifetimeBars: int


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


def _fractal_wings(candles: List[FootprintBar], width: int):
    """
    Returns (left_wing, pivot_candidate, right_wing) for a `width`-bar fractal whose right wing
    ends at candles[-2] (the newest bar, candles[-1], is the decision bar and is NOT part of the
    fractal -- the pivot is only knowable once its whole right wing has closed). width=1 is the
    original 3-bar fractal (candles[-4], candles[-3], candles[-2]); width=2 is the standard
    5-bar (Williams) fractal. Returns None when there is not enough history.
    """
    if width < 1 or len(candles) < 2 * width + 2:
        return None
    pivot = candles[-(width + 2)]
    left = candles[-(2 * width + 2):-(width + 2)]
    right = candles[-(width + 1):-1]
    return left, pivot, right


class StatefulPITFibEngine:
    """
    Bullish engine: an impulse UP (MSS above a confirmed swing high), then a retracement DOWN
    into a Fibonacci zone.

    Anchor lifecycle (2026-10-10 correction): the impulse's anchor high is the highest high of
    the CURRENT leg. The original engine froze the anchor the first time price paused, and then
    kept measuring zones against that frozen leg for up to `maxQualifiedLifetimeBars` bars no
    matter how far price had run past it (measured on NIFTY50 5m: price ran >1 ATR past the
    frozen anchor in 57% of qualified setups and >5 ATR in 38%). A new high above the anchor now
    means the leg extended: the engine re-enters IMPULSE_TRACKING with the new anchor and discards
    the superseded POI, so a zone only ever exists for the leg that is actually still live.
    Likewise a break below the pivot low invalidates the setup in EVERY post-MSS state, not only
    after a POI qualified.
    """

    def __init__(self, fib_artifact: FibAnchorCalibrationArtifact, tick_size: float = 0.05, pivot_width: int = 1):
        self.tick_size = tick_size
        self.fib_artifact = fib_artifact
        self.pivot_width = pivot_width
        self.min_retracement_ticks = fib_artifact.minRetracementTicks
        self.min_retracement_atr_multiple = fib_artifact.minRetracementAtrMultiple
        self.max_window_bars = fib_artifact.maxWindowBars
        self.max_qualified_lifetime_bars = fib_artifact.maxQualifiedLifetimeBars
        self.event_history: List[Dict] = []
        self.reset_engine()

    def reset_engine(self):
        self.state = FibLifecycleState.IDLE
        # Sequence number the post-MSS windows are measured from: the MSS bar initially, then the
        # bar of the latest anchor extension (a leg that keeps extending has not "timed out").
        self.window_origin_seq: Optional[int] = None
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

        self.poi_qualified_seq: Optional[int] = None  # bar at which RETRACEMENT_QUALIFIED was reached

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

        # 1b. Pre-POI structural invalidation. After MSS, the origin pivot low is the leg's
        # structural stop whether or not a POI has qualified yet; with re-anchoring a leg can live
        # for many bars, so price breaking the pivot before any pullback qualified must kill the
        # setup too (previously only a qualified POI could be invalidated).
        if (self.active_poi is None
                and self.state in (FibLifecycleState.IMPULSE_TRACKING, FibLifecycleState.ANCHOR_HIGH_FORMED)
                and self.pending_pivot_low is not None
                and latest_bar.low <= self.pending_pivot_low - 2 * self.tick_size):
            self.emit_event(
                "INVALIDATED",
                latest_bar.identity.sequenceNumber,
                latest_bar.identity.closeTimestamp,
                decision_at,
                "Price broke the origin pivot low before any retracement qualified"
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

        # 3. Post-MSS Independent Expiry Check (window origin = MSS bar, then the latest anchor extension)
        if self.state in [FibLifecycleState.IMPULSE_TRACKING, FibLifecycleState.ANCHOR_HIGH_FORMED]:
            bars_elapsed = latest_bar.identity.sequenceNumber - self.window_origin_seq
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

        # 4. Post-Qualification Shelf-Life Expiry (re-arm rule). Without this, a qualified POI has
        # no way out except INVALIDATED (price breaking 2 ticks below the anchor low) -- if price
        # simply never revisits that level, the engine stays stuck on one aging setup forever and
        # never looks for a fresh one again. Confirmed on real NIFTY50 history: the only POI
        # qualified in a 15742-bar/~2.75yr series stayed active for the remaining 92% of it (68%
        # for a BANKNIFTY POI). An earlier version of this fix reused max_window_bars (20) as the
        # shelf life -- wrong: that parameter bounds a completely different window (pre-
        # qualification, post-MSS), never validated for this purpose, and the real lifetime
        # distribution of all 31 naturally-invalidated POIs across NIFTY50+BANKNIFTY 5m history
        # (median 49 bars, p90 392, max 1,734) shows 20 would force-expire the majority of
        # genuinely still-active POIs long before they'd naturally invalidate. maxQualifiedLifetimeBars
        # is its own calibrated parameter (2,000, comfortably above the observed max) precisely so
        # this shelf life is never silently coupled to an unrelated window again.
        if self.state == FibLifecycleState.RETRACEMENT_QUALIFIED:
            bars_since_qualified = latest_bar.identity.sequenceNumber - self.poi_qualified_seq
            if bars_since_qualified > self.max_qualified_lifetime_bars:
                self.emit_event(
                    "EXPIRED",
                    latest_bar.identity.sequenceNumber,
                    latest_bar.identity.closeTimestamp,
                    decision_at,
                    f"Qualified POI exceeded max shelf life of {self.max_qualified_lifetime_bars} bars without invalidation"
                )
                self.state = FibLifecycleState.EXPIRED
                self.reset_engine()
                return True, "EXPIRED"

        # State 1: Pivot Low Candidate Detection (Fractal detection with formedAt extremum)
        wings = _fractal_wings(candles, self.pivot_width) if self.state == FibLifecycleState.IDLE else None
        if wings is not None:
            left, curr, right = wings
            nxt = right[-1]
            candidate_at = nxt.identity.closeTimestamp

            if all(curr.low < b.low for b in left) and all(curr.low < b.low for b in right):
                if (all(b.availableAt <= candidate_at for b in left) and
                    all(b.availableAt <= candidate_at for b in right) and
                    curr.availableAt <= candidate_at and
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
                self.window_origin_seq = latest_bar.identity.sequenceNumber

                self.state = FibLifecycleState.IMPULSE_TRACKING
                self.emit_event(
                    "MSS_CONFIRMED",
                    latest_bar.identity.sequenceNumber,
                    latest_bar.identity.closeTimestamp,
                    decision_at,
                    "Market Structure Shift confirmed"
                )

        # State 2b: Anchor extension. A new high above the anchor means the leg is still live, so
        # the retracement measured so far (and any POI built on it) belongs to a superseded leg.
        # Re-enter impulse tracking with the new extreme and drop the stale POI -- never keep
        # measuring Fibonacci zones against a swing price has already run away from.
        if (self.state in (FibLifecycleState.ANCHOR_HIGH_FORMED, FibLifecycleState.RETRACEMENT_QUALIFIED)
                and latest_bar.high > self.anchor_high):
            superseded_poi = self.active_poi is not None
            self.anchor_high = latest_bar.high
            self.anchor_high_seq = latest_bar.identity.sequenceNumber
            self.anchor_high_time = latest_bar.identity.closeTimestamp
            self.anchor_high_available_at = latest_bar.availableAt
            self.window_origin_seq = latest_bar.identity.sequenceNumber
            self.active_poi = None
            self.poi_qualified_seq = None
            self.state = FibLifecycleState.IMPULSE_TRACKING
            self.emit_event(
                "ANCHOR_EXTENDED",
                latest_bar.identity.sequenceNumber,
                latest_bar.identity.closeTimestamp,
                decision_at,
                f"Leg extended to {self.anchor_high}" + ("; superseded the previous POI" if superseded_poi else "")
            )

        # State 3: Dynamic Anchor High Tracking Post-MSS
        if self.state == FibLifecycleState.IMPULSE_TRACKING:
            if latest_bar.high > self.anchor_high:
                self.anchor_high = latest_bar.high
                self.anchor_high_seq = latest_bar.identity.sequenceNumber
                self.anchor_high_time = latest_bar.identity.closeTimestamp
                self.anchor_high_available_at = latest_bar.availableAt
                self.window_origin_seq = latest_bar.identity.sequenceNumber
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

                bars_elapsed = retracement.sequenceNumber - self.window_origin_seq
                actual_retracement_ticks = (self.anchor_high - retracement.low) / self.tick_size
                actual_retracement_atr = ((self.anchor_high - retracement.low) / atr_obs.atr14) if atr_obs.atr14 > 0 else 0.0

                # BOTH floors must hold. The original `or` let the tick floor (10 ticks = 0.5 index
                # points on NIFTY) qualify any one-bar pause, because the ATR floor then never
                # bound: median MSS-to-qualification was 2 bars. The tick floor is a guard against
                # a collapsed ATR; the ATR floor is what makes a pullback structurally meaningful.
                qualifies_retracement = (actual_retracement_ticks >= self.min_retracement_ticks and
                                         actual_retracement_atr >= self.min_retracement_atr_multiple)

                if qualifies_retracement and 0 < bars_elapsed <= self.max_window_bars:
                    self.state = FibLifecycleState.RETRACEMENT_QUALIFIED
                    self.poi_qualified_seq = retracement.sequenceNumber
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


class StatefulPITFibEngineBearish:
    """
    Exact structural mirror of StatefulPITFibEngine for the opposite direction: a sharp impulse
    DOWN, followed by a retracement UP into a Fib zone, with price expected to resume down from
    there. Built as new, parallel code rather than a parameterized/shared engine so the original,
    already-tested bullish class is not touched at all and the two can be audited side by side.

    Built because the original engine only ever detected bullish setups -- a structural gap, not
    a tuned parameter: a rough mirror-logic check on real NIFTY50 history found roughly as many
    bearish MSS confirmations (828) as the real bullish engine found qualified retracements (401),
    meaning a comparable population of real setups was sitting completely undetected.

    Mirror mapping (bullish -> bearish):
      pivot LOW candidate (fractal low)      -> pivot HIGH candidate (fractal high)
      structural resistance (close breaks above) -> structural support (close breaks below)
      anchor HIGH tracked rising post-MSS     -> anchor LOW tracked falling post-MSS
      retracement.low (pullback depth down)   -> retracement.high (pullback height up)
      invalidation = anchorLow - 2*tick       -> invalidation = anchorHigh + 2*tick
      r = (anchorHigh - price) / range        -> r = (price - anchorLow) / range
      zones = anchorHigh - diff*ratio         -> zones = anchorLow + diff*ratio

    FibonacciPOI's anchorLow/anchorHigh fields keep their literal meaning (the lower and upper
    price bound of the impulse range) for both directions; only which one is the "origin pivot"
    vs the "impulse extreme" swaps. The invalidation level, the zone bands, and
    evaluate_location's formula are direction-specific; everything else (PIT timestamp
    invariants, candidate timeout, post-MSS expiry, post-qualification shelf-life re-arm) is
    identical in structure to the bullish engine, intentionally, since none of that logic is
    direction-specific.
    """

    def __init__(self, fib_artifact: FibAnchorCalibrationArtifact, tick_size: float = 0.05, pivot_width: int = 1):
        self.tick_size = tick_size
        self.fib_artifact = fib_artifact
        self.pivot_width = pivot_width
        self.min_retracement_ticks = fib_artifact.minRetracementTicks
        self.min_retracement_atr_multiple = fib_artifact.minRetracementAtrMultiple
        self.max_window_bars = fib_artifact.maxWindowBars
        self.max_qualified_lifetime_bars = fib_artifact.maxQualifiedLifetimeBars
        self.event_history: List[Dict] = []
        self.reset_engine()

    def reset_engine(self):
        self.state = FibLifecycleState.IDLE
        self.window_origin_seq: Optional[int] = None  # MSS bar, then the latest anchor extension
        self.pending_pivot_high: Optional[float] = None
        self.pending_pivot_seq: Optional[int] = None
        self.pending_pivot_time: Optional[int] = None
        self.pivot_formed_time: Optional[int] = None

        self.bound_support_price: Optional[float] = None
        self.bound_support_seq: Optional[int] = None
        self.bound_support_available_at: Optional[int] = None

        self.mss_confirmed_seq: Optional[int] = None
        self.mss_confirmed_time: Optional[int] = None
        self.mss_confirmed_available_at: Optional[int] = None

        self.anchor_low: Optional[float] = None
        self.anchor_low_seq: Optional[int] = None
        self.anchor_low_time: Optional[int] = None
        self.anchor_low_available_at: Optional[int] = None

        self.poi_qualified_seq: Optional[int] = None

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
                           structural_support: StructuralLevel,
                           retracement: Optional[RetracementObservation],
                           atr_obs: ATRObservation,
                           decision_at: int) -> Tuple[bool, str]:
        if not candles or len(candles) < 10:
            return False, "INSUFFICIENT_CANDLES"

        latest_bar = candles[-1]

        # 1. Structural Invalidation Check (price touching or breaking anchorHigh + 2*tick_size --
        # the mirror of the bullish engine's anchorLow - 2*tick_size).
        if self.active_poi and latest_bar.high >= self.active_poi.invalidation:
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

        # 1b. Pre-POI structural invalidation (mirror of the bullish engine): price breaking the
        # origin pivot HIGH kills the setup in every post-MSS state, not only once a POI qualified.
        if (self.active_poi is None
                and self.state in (FibLifecycleState.IMPULSE_TRACKING, FibLifecycleState.ANCHOR_LOW_FORMED)
                and self.pending_pivot_high is not None
                and latest_bar.high >= self.pending_pivot_high + 2 * self.tick_size):
            self.emit_event(
                "INVALIDATED",
                latest_bar.identity.sequenceNumber,
                latest_bar.identity.closeTimestamp,
                decision_at,
                "Price broke the origin pivot high before any retracement qualified"
            )
            self.state = FibLifecycleState.INVALIDATED
            self.reset_engine()
            return True, "INVALIDATED"

        # 2. Candidate Timeout Check (identical to bullish: 10 bars to reach MSS)
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

        # 3. Post-MSS Independent Expiry Check (identical structure to bullish)
        if self.state in [FibLifecycleState.IMPULSE_TRACKING, FibLifecycleState.ANCHOR_LOW_FORMED]:
            bars_elapsed = latest_bar.identity.sequenceNumber - self.window_origin_seq
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

        # 4. Post-Qualification Shelf-Life Expiry (re-arm rule; identical structure to bullish,
        # bound by its own maxQualifiedLifetimeBars calibration parameter -- see the bullish
        # engine's process_new_candle for why this must not reuse max_window_bars)
        if self.state == FibLifecycleState.RETRACEMENT_QUALIFIED:
            bars_since_qualified = latest_bar.identity.sequenceNumber - self.poi_qualified_seq
            if bars_since_qualified > self.max_qualified_lifetime_bars:
                self.emit_event(
                    "EXPIRED",
                    latest_bar.identity.sequenceNumber,
                    latest_bar.identity.closeTimestamp,
                    decision_at,
                    f"Qualified POI exceeded max shelf life of {self.max_qualified_lifetime_bars} bars without invalidation"
                )
                self.state = FibLifecycleState.EXPIRED
                self.reset_engine()
                return True, "EXPIRED"

        # State 1: Pivot High Candidate Detection (fractal high; mirror of fractal low)
        wings = _fractal_wings(candles, self.pivot_width) if self.state == FibLifecycleState.IDLE else None
        if wings is not None:
            left, curr, right = wings
            nxt = right[-1]
            candidate_at = nxt.identity.closeTimestamp

            if all(curr.high > b.high for b in left) and all(curr.high > b.high for b in right):
                if (all(b.availableAt <= candidate_at for b in left) and
                    all(b.availableAt <= candidate_at for b in right) and
                    curr.availableAt <= candidate_at and
                    structural_support.sourceTimestamp <= candidate_at and
                    structural_support.availableAt <= candidate_at):

                    self.pending_pivot_high = curr.high
                    self.pending_pivot_seq = curr.identity.sequenceNumber
                    self.pending_pivot_time = candidate_at
                    self.pivot_formed_time = curr.identity.closeTimestamp
                    self.bound_support_price = structural_support.levelPrice
                    self.bound_support_seq = structural_support.sequenceNumber
                    self.bound_support_available_at = structural_support.availableAt
                    self.state = FibLifecycleState.PIVOT_CANDIDATE_DETECTED
                    self.emit_event(
                        "CANDIDATE_DETECTED",
                        nxt.identity.sequenceNumber,
                        candidate_at,
                        decision_at,
                        "Fractal pivot high detected"
                    )

        # State 2: MSS Confirmation (close breaks BELOW bound support; mirror of breaking above resistance)
        if self.state == FibLifecycleState.PIVOT_CANDIDATE_DETECTED:
            if latest_bar.close < self.bound_support_price:
                self.mss_confirmed_seq = latest_bar.identity.sequenceNumber
                self.mss_confirmed_time = latest_bar.identity.closeTimestamp
                self.mss_confirmed_available_at = latest_bar.availableAt

                self.anchor_low = latest_bar.low
                self.anchor_low_seq = latest_bar.identity.sequenceNumber
                self.anchor_low_time = latest_bar.identity.closeTimestamp
                self.anchor_low_available_at = latest_bar.availableAt
                self.window_origin_seq = latest_bar.identity.sequenceNumber

                self.state = FibLifecycleState.IMPULSE_TRACKING
                self.emit_event(
                    "MSS_CONFIRMED",
                    latest_bar.identity.sequenceNumber,
                    latest_bar.identity.closeTimestamp,
                    decision_at,
                    "Market Structure Shift confirmed"
                )

        # State 2b: Anchor extension (mirror of the bullish engine): a new LOW below the anchor
        # low means the down-leg is still live; supersede any POI built on the old extreme.
        if (self.state in (FibLifecycleState.ANCHOR_LOW_FORMED, FibLifecycleState.RETRACEMENT_QUALIFIED)
                and latest_bar.low < self.anchor_low):
            superseded_poi = self.active_poi is not None
            self.anchor_low = latest_bar.low
            self.anchor_low_seq = latest_bar.identity.sequenceNumber
            self.anchor_low_time = latest_bar.identity.closeTimestamp
            self.anchor_low_available_at = latest_bar.availableAt
            self.window_origin_seq = latest_bar.identity.sequenceNumber
            self.active_poi = None
            self.poi_qualified_seq = None
            self.state = FibLifecycleState.IMPULSE_TRACKING
            self.emit_event(
                "ANCHOR_EXTENDED",
                latest_bar.identity.sequenceNumber,
                latest_bar.identity.closeTimestamp,
                decision_at,
                f"Leg extended to {self.anchor_low}" + ("; superseded the previous POI" if superseded_poi else "")
            )

        # State 3: Dynamic Anchor Low Tracking Post-MSS (mirror of anchor high tracking)
        if self.state == FibLifecycleState.IMPULSE_TRACKING:
            if latest_bar.low < self.anchor_low:
                self.anchor_low = latest_bar.low
                self.anchor_low_seq = latest_bar.identity.sequenceNumber
                self.anchor_low_time = latest_bar.identity.closeTimestamp
                self.anchor_low_available_at = latest_bar.availableAt
                self.window_origin_seq = latest_bar.identity.sequenceNumber
            elif (retracement and
                  self.anchor_low_time < retracement.observedAt <= retracement.availableAt <= decision_at):
                self.state = FibLifecycleState.ANCHOR_LOW_FORMED
                self.emit_event(
                    "ANCHOR_FORMED",
                    self.anchor_low_seq,
                    self.anchor_low_time,
                    decision_at,
                    f"Anchor Low formed at {self.anchor_low}"
                )

        # State 4: Retracement Qualification Check (pullback UP from anchor low, using retracement.high)
        if self.state in [FibLifecycleState.IMPULSE_TRACKING, FibLifecycleState.ANCHOR_LOW_FORMED] and retracement:
            if (self.anchor_low_time < retracement.observedAt <= retracement.availableAt <= decision_at and
                atr_obs.availableAt <= decision_at and
                atr_obs.sourceTimestamp <= retracement.observedAt and
                atr_obs.availableAt <= retracement.observedAt):

                bars_elapsed = retracement.sequenceNumber - self.window_origin_seq
                actual_retracement_ticks = (retracement.high - self.anchor_low) / self.tick_size
                actual_retracement_atr = ((retracement.high - self.anchor_low) / atr_obs.atr14) if atr_obs.atr14 > 0 else 0.0

                # BOTH floors must hold (see the bullish engine for why `or` was a defect).
                qualifies_retracement = (actual_retracement_ticks >= self.min_retracement_ticks and
                                         actual_retracement_atr >= self.min_retracement_atr_multiple)

                if qualifies_retracement and 0 < bars_elapsed <= self.max_window_bars:
                    self.state = FibLifecycleState.RETRACEMENT_QUALIFIED
                    self.poi_qualified_seq = retracement.sequenceNumber
                    diff = self.pending_pivot_high - self.anchor_low

                    composite_available_at = max(
                        self.pending_pivot_time,
                        self.bound_support_available_at,
                        self.mss_confirmed_available_at + FIB_PROCESSING_LAG_MS,
                        self.anchor_low_available_at,
                        retracement.availableAt,
                        atr_obs.availableAt
                    )

                    timestamps = PITTimestamps(
                        candidateAt=self.pending_pivot_time,
                        formedAt=self.pivot_formed_time,
                        confirmedAt=self.mss_confirmed_time,
                        availableAt=composite_available_at
                    )

                    is_available = timestamps.availableAt <= decision_at

                    # Zones mirror the bullish formula (zone = anchorHigh - diff*ratio) around the
                    # LOW instead: zone = anchorLow + diff*ratio. anchorLow/anchorHigh fields keep
                    # their literal (lower bound / upper bound) meaning; anchorHigh here is the
                    # origin pivot, anchorLow is the impulse extreme -- the opposite role
                    # assignment from the bullish engine, where anchorHigh is the impulse extreme.
                    self.active_poi = FibonacciPOI(
                        anchorLow=self.anchor_low,
                        anchorHigh=self.pending_pivot_high,
                        anchorLowBarIndex=self.anchor_low_seq,
                        anchorHighBarIndex=self.pending_pivot_seq,
                        goldenPocketLow=self.anchor_low + (diff * 0.618),
                        goldenPocketHigh=self.anchor_low + (diff * 0.650),
                        oteLow=self.anchor_low + (diff * 0.702),
                        oteHigh=self.anchor_low + (diff * 0.786),
                        deepLow=self.anchor_low + (diff * 0.786),
                        deepHigh=self.anchor_low + (diff * 0.886),
                        invalidation=self.pending_pivot_high + (2 * self.tick_size),
                        timestamps=timestamps,
                        direction="BEARISH",
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

        # Mirror of the bullish canonical formula: r = (Price - AnchorLow) / (AnchorHigh - AnchorLow)
        # -- r=0 at the impulse extreme low, r=1 at the origin pivot high, so retracement DEPTH is
        # measured as height climbed back up from the low, the bearish mirror of "distance pulled
        # back down from the high".
        r = (price - poi.anchorLow) / anchor_range

        if 0.618 <= r <= 0.650:
            return True, "GOLDEN_POCKET"
        elif 0.702 <= r < 0.786:
            return True, "OTE"
        elif 0.786 <= r <= 0.886:
            return True, "DEEP_RETRACEMENT"

        return False, "NONE"
