/**
 * Pattern Intelligence V1.0.1 immutable observation contract.
 *
 * This module intentionally contains no score, probability, or expected-return
 * fields. Those belong to the separately frozen Falsification Harness.
 */

export type PatternTrendState = "UP" | "DOWN" | "SIDEWAYS" | "TRANSITIONING" | "UNKNOWN";
export type PatternSessionSegment = "PRE_OPEN" | "OPENING" | "MIDDAY" | "CLOSING";
export type PatternOrientation = "UP" | "DOWN" | "NONE" | "BIDIRECTIONAL";

export interface ObservationSource {
  exchange: "NSE";
  /**
   * Canonical spellings only. `"NIFTY"` is an accepted *input* alias but never a stored value —
   * resolve it through `normalizeUnderlying` before building a source. See `instrument-identifiers.ts`.
   */
  underlying: "NIFTY50" | "BANKNIFTY";
  instrumentType: "FUTIDX" | "INDEX";
  contractSymbol: string;
  contractExpiry: Date | null;
  contractRole: "NEAR_MONTH" | "MID_MONTH" | "FAR_MONTH" | "SPOT" | null;
  /** Canonical spellings only. `"1h"` is an input alias for `"60m"`; see `normalizeTimeframe`. */
  timeframe: "1m" | "3m" | "5m" | "10m" | "15m" | "30m" | "60m" | "1d";
  timezone: "Asia/Kolkata";
  /** Derived from `instruments.tick_size` — there is no `price_scale` column. See `priceScaleFromTickSize`. */
  priceScale: number;
  tickSize: number;
  dataVintageId: string;
  dataVintageAt: Date;
}

export interface PatternGeometry {
  durationBars: number;
  rangeBps: number;
  /**
   * Pattern range in ATR(14) units. Non-nullable, and kept that way deliberately.
   *
   * Errata Section 3 resolves this with a **strict non-emission rule** rather than nullability: a
   * detector refuses to emit any observation on a bar with fewer than 14 closed bars behind it, so a
   * sealed observation always has a real ATR to divide by. The alternative — emitting with
   * `rangeAtr: null` — was rejected because this field is covered by `observationHash`, and a nullable
   * measurement in the identity invites a `0` or `1.0` placeholder creeping back in later.
   *
   * Before this rule, warmup produced a *fabricated* value rather than a missing one: the orchestrator
   * substituted the pattern's own range for the unavailable ATR, so `rangeAtr` was emitted as exactly
   * `1.0` — a plausible "one ATR wide" reading that no consumer could tell from a measurement.
   */
  rangeAtr: number;
}

export interface PatternContext {
  trendState: PatternTrendState;
  sessionSegment: PatternSessionSegment;
  volumeZscore: number | null;
  rangeZscore: number | null;
  effortResultDivergence: number | null;
}

export interface PatternTiming {
  startAt: Date;
  dataThrough: Date;
  detectedAt: Date;
  knownAt: Date;
  /**
   * The bar open that any forward evaluation treats as Bar 0 (errata Section 6).
   *
   * Recorded here because it is the anchor the outcome system will use, and the off-by-one it
   * prevents is otherwise invisible: a horizon of H bars spans the H consecutive closed bars
   * `[0, H-1]` starting at this instant, not `[1, H]`. Entry price is the Bar 0 `open` under
   * `NEXT_BAR_OPEN`, the Bar 0 midpoint under `MIDPOINT`, or session VWAP as of the Bar 0 open under
   * `VWAP_OPEN`; MFE and MAE are direction-neutral extremes over that same window.
   *
   * No evaluator is implemented, deliberately — the spec's Harness Gate forbids experiments until the
   * Falsification Harness is separately frozen. The convention is written down so the eventual
   * implementation inherits it rather than re-deciding it.
   */
  earliestExecutionAt: Date;
}

export interface PatternDefinitionRef {
  definitionId: string;
  definitionVersion: string;
  definitionHash: string;
}

export interface ResearchProvenance {
  engineVersion: string;
  configVersion: string;
  configHash: string;
  dataSource: string;
  dataSchemaVersion: string;
  observationHash: string;
}

export interface SweepReclaimDetails {
  kind: "SWEEP_RECLAIM";
  subtype: "SPRING" | "UPTHRUST" | "SFP_HIGH" | "SFP_LOW" | "RANGE_HIGH_SWEEP" | "RANGE_LOW_SWEEP" | "PDH_SWEEP" | "PDL_SWEEP" | "ORB_SWEEP";
  wyckoffEquivalent: "SPRING" | "UPTHRUST" | null;
  referenceLevel: number;
  penetrationExcursionBps: number;
  reclaimDistanceBps: number;
  rejectionWickBps: number;
}

export interface AuctionProfileDetails {
  kind: "AUCTION_PROFILE";
  subtype: "VPOC" | "TPOC" | "VAH_TEST" | "VAL_TEST" | "HVN_TEST" | "LVN_TRAVERSE" | "VALUE_MIGRATION" | "IB_BREAKOUT" | "IB_FAILURE" | "PROFILE_SHAPE";
  profileType: "VOLUME" | "TPO";
  profileState: "DEVELOPING" | "FINAL";
  profileSessionId: string;
  profileWindowStartAt: Date;
  profileWindowEndAt: Date;
  profileDataType: "TRADE_VAP" | "VENDOR_VAP";
  poc: number;
  vah: number;
  val: number;
  skewness: number;
  entropy: number;
  pocLocationPct: number;
  upperTailPct: number;
  lowerTailPct: number;
  numberOfModes: number;
}

export interface WyckoffEventDetails {
  kind: "WYCKOFF_EVENT";
  subtype: "PS" | "SC" | "AR" | "ST" | "SPRING" | "TEST_OF_SPRING" | "SOS" | "LPS" | "PSY" | "BC" | "UTAD" | "SOW" | "LPSY";
}

export interface BreakoutStateDetails {
  kind: "BREAKOUT_STATE";
  subtype: "BREAKOUT" | "BREAKDOWN" | "FAILED_BREAKOUT" | "FAILED_BREAKDOWN" | "RETEST_AFTER_BREAKOUT" | "RETEST_AFTER_BREAKDOWN";
  breakoutLevel: number;
  breakoutDistanceBps: number;
}

export interface CompressionExpansionDetails {
  kind: "COMPRESSION_EXPANSION";
  subtype: "NR4" | "NR7" | "INSIDE_BAR" | "DOUBLE_INSIDE_BAR" | "TRIPLE_INSIDE_BAR" | "VCP" | "SYMMETRICAL_TRIANGLE" | "ASCENDING_TRIANGLE" | "DESCENDING_TRIANGLE" | "PENNANT" | "COIL" | "EXPANSION";
  compressionRatio: number | null;
  vcpContractionCount: number | null;
}

export interface OpeningStructureDetails {
  kind: "OPENING_STRUCTURE";
  subtype: "ORB" | "ORB_FAILURE" | "OPENING_DRIVE" | "OPENING_REJECTION" | "OPENING_RANGE_SWEEP" | "DOUBLE_SIDED_SWEEP";
  openingRangeHigh: number;
  openingRangeLow: number;
  openingRangeBps: number;
}

export interface GapStructureDetails {
  kind: "GAP_STRUCTURE";
  subtype: "BREAKAWAY_GAP" | "CONTINUATION_GAP" | "EXHAUSTION_GAP" | "GAP_AND_GO" | "GAP_AND_FADE" | "GAP_FILL" | "ISLAND_REVERSAL";
  gapBps: number;
  gapVsAtr: number;
  gapDirectionVsPriorRange: "ABOVE_RANGE" | "BELOW_RANGE" | "INSIDE_RANGE";
  priorDayHigh: number;
  priorDayLow: number;
}

export interface LevelInteractionDetails {
  kind: "LEVEL_INTERACTION";
  subtype: "BREAK_AND_HOLD" | "SWEEP_AND_REJECT" | "BREAK_RETEST_CONTINUE" | "FAILED_BREAKDOWN_AT_LEVEL" | "FAILED_BREAKOUT_AT_LEVEL";
  levelType: "PDH" | "PDL" | "PRIOR_CLOSE" | "PRIOR_MID" | "WEEKLY_HIGH" | "WEEKLY_LOW" | "VWAP" | "OPENING_PRICE";
  levelValue: number;
  distanceBps: number;
}

export interface SwingStructureDetails {
  kind: "SWING_STRUCTURE";
  subtype: "HIGHER_HIGH" | "HIGHER_LOW" | "LOWER_HIGH" | "LOWER_LOW" | "EQUAL_HIGH" | "EQUAL_LOW" | "BOS_UP" | "BOS_DOWN" | "CHOCH_UP" | "CHOCH_DOWN" | "BULLISH_TRANSITION" | "BEARISH_TRANSITION";
  swingLevel: number;
  priorSwingLevel: number;
}

export interface RelativeStructureDetails {
  kind: "RELATIVE_STRUCTURE";
  subtype: "CONFIRM_BOTH" | "DIVERGE_NIFTY_LEADS" | "DIVERGE_BANKNIFTY_LEADS" | "DIVERGE_NIFTY_BREAKS_BANKNIFTY_HOLDS" | "DIVERGE_BANKNIFTY_BREAKS_NIFTY_HOLDS";
  niftyLevel: number;
  bankniftyLevel: number;
}

/**
 * Errata Section 2 prunes this to its structurally unique fields.
 *
 * `volumeZscore`, `rangeZscore` and `effortResultDivergence` were duplicated here from
 * `PatternContext`, where they already sit for every family. Two copies of one measurement inside a
 * single hashed record is a consistency hazard with no upside — they could disagree, and nothing
 * checked that they did not.
 *
 * Both surviving fields are nullable because both can be genuinely uncomputable: the multiplier needs
 * a fully volume-positive 20-bar window (see `volume-semantics.ts`) and the wick ratio needs a bar
 * with non-zero range.
 */
export interface EffortResultDetails {
  kind: "EFFORT_RESULT";
  subtype: "BUYING_CLIMAX" | "SELLING_CLIMAX" | "ABSORPTION" | "HIGH_EFFORT_LOW_RESULT" | "LOW_EFFORT_HIGH_RESULT";
  /** Bar volume over its trailing 20-bar simple mean. Null when any bar in that window lacks usable volume. */
  climaxVolumeMultiplier: number | null;
  /** The subtype's rejection wick as a share of bar range. Null when the subtype makes no wick claim. */
  absorptionWickRatio: number | null;
}

export interface WyckoffStateDetails {
  kind: "WYCKOFF_STATE";
  subtype: "ACCUMULATION" | "DISTRIBUTION" | "REACCUMULATION" | "REDISTRIBUTION";
  priorTrend: "UP" | "DOWN";
  rangeDurationBars: number;
  rangeWidthAtr: number;
  downsideSweep: boolean;
  upsideBreak: boolean;
}

export interface ContinuationStructureDetails {
  kind: "CONTINUATION_STRUCTURE";
  subtype: "BULL_FLAG" | "BEAR_FLAG" | "BULL_PENNANT" | "BEAR_PENNANT" | "RISING_CHANNEL" | "FALLING_CHANNEL" | "HORIZONTAL_CHANNEL" | "PULLBACK_CONTINUATION" | "THROWBACK" | "ABC_CONTINUATION";
}

export interface BroadeningStructureDetails {
  kind: "BROADENING_STRUCTURE";
  subtype: "MEGAPHONE" | "EXPANDING_TRIANGLE" | "BROADENING_TOP" | "BROADENING_BOTTOM";
  swingAmplitudeRatio: number;
}

export interface HarmonicDetails {
  kind: "HARMONIC";
  subtype: "GARTLEY" | "BAT" | "CRAB" | "BUTTERFLY" | "CYPHER" | "DEEP_CRAB" | "SHARK" | "FIVE_ZERO" | "ABCD";
  pivotAlgorithm: "ZIGZAG";
  pivotThresholdAtr: number;
  ratioTolerancePct: number;
  abXaRatio: number;
  bcAbRatio: number;
  cdBcRatio: number;
  adXaRatio: number;
  maxRatioError: number;
  przLow: number;
  przHigh: number;
}

export interface ClassicalReversalDetails {
  kind: "CLASSICAL_REVERSAL";
  subtype: "HEAD_AND_SHOULDERS" | "INVERSE_HEAD_AND_SHOULDERS" | "DOUBLE_TOP" | "DOUBLE_BOTTOM" | "TRIPLE_TOP" | "TRIPLE_BOTTOM" | "ROUNDING_TOP" | "ROUNDING_BOTTOM" | "V_REVERSAL" | "RISING_WEDGE" | "FALLING_WEDGE";
  necklineLevel: number | null;
}

export interface CandleGeometryDetails {
  kind: "CANDLE_GEOMETRY";
  subtype: "HAMMER" | "INVERTED_HAMMER" | "HANGING_MAN" | "SHOOTING_STAR" | "DOJI" | "DRAGONFLY_DOJI" | "GRAVESTONE_DOJI" | "BULLISH_ENGULFING" | "BEARISH_ENGULFING" | "BULLISH_MARUBOZU" | "BEARISH_MARUBOZU" | "SPINNING_TOP" | "KICKER_UP" | "KICKER_DOWN" | "THREE_LINE_STRIKE_UP" | "THREE_LINE_STRIKE_DOWN" | "ABANDONED_BABY_UP" | "ABANDONED_BABY_DOWN" | "INSIDE_BAR" | "OUTSIDE_BAR" | "TWEEZER_TOP" | "TWEEZER_BOTTOM";
}

export interface MultiCandleDetails {
  kind: "MULTI_CANDLE";
  subtype: "MORNING_STAR" | "EVENING_STAR" | "THREE_WHITE_SOLDIERS" | "THREE_BLACK_CROWS" | "RISING_THREE_METHODS" | "FALLING_THREE_METHODS" | "TOWER_TOP" | "TOWER_BOTTOM" | "BULLISH_HARAMI" | "BEARISH_HARAMI" | "HARAMI_CROSS" | "PIERCING_LINE" | "DARK_CLOUD_COVER" | "THREE_INSIDE_UP" | "THREE_INSIDE_DOWN";
}

export interface PatternDetailsMap {
  SWEEP_RECLAIM: SweepReclaimDetails;
  AUCTION_PROFILE: AuctionProfileDetails;
  WYCKOFF_EVENT: WyckoffEventDetails;
  BREAKOUT_STATE: BreakoutStateDetails;
  COMPRESSION_EXPANSION: CompressionExpansionDetails;
  OPENING_STRUCTURE: OpeningStructureDetails;
  GAP_STRUCTURE: GapStructureDetails;
  LEVEL_INTERACTION: LevelInteractionDetails;
  SWING_STRUCTURE: SwingStructureDetails;
  RELATIVE_STRUCTURE: RelativeStructureDetails;
  EFFORT_RESULT: EffortResultDetails;
  WYCKOFF_STATE: WyckoffStateDetails;
  CONTINUATION_STRUCTURE: ContinuationStructureDetails;
  BROADENING_STRUCTURE: BroadeningStructureDetails;
  HARMONIC: HarmonicDetails;
  CLASSICAL_REVERSAL: ClassicalReversalDetails;
  CANDLE_GEOMETRY: CandleGeometryDetails;
  MULTI_CANDLE: MultiCandleDetails;
}

export type PatternFamily = keyof PatternDetailsMap;
export type SubtypeOf<F extends PatternFamily> = PatternDetailsMap[F] extends { subtype: infer S } ? S : never;

export interface PatternObservationIdentity<F extends PatternFamily> {
  observationId: string;
  patternFamily: F;
  patternSubtype: SubtypeOf<F>;
  orientation: PatternOrientation;
}

export type DetectedPatternV2<F extends PatternFamily> = {
  identity: PatternObservationIdentity<F>;
  source: ObservationSource;
  definitionRef: PatternDefinitionRef;
  timing: PatternTiming;
  geometry: PatternGeometry;
  context: PatternContext;
  details: PatternDetailsMap[F];
  provenance: ResearchProvenance;
};

export type AnyDetectedPattern = {
  [F in PatternFamily]: DetectedPatternV2<F>;
}[PatternFamily];

export interface PatternDefinition {
  definitionId: string;
  definitionVersion: string;
  family: PatternFamily;
  parameters: Record<string, unknown>;
  invalidationConditions: readonly string[];
  definitionHash: string;
  frozenAt: Date;
}

/** Registry implementations may return only immutable, approved definitions. */
export interface PatternDefinitionRegistry {
  findFrozen(input: { definitionId: string; definitionVersion: string }): Promise<PatternDefinition | null>;
}

/**
 * One database transaction must insert both records or neither. Implementations
 * own the storage-level lock and uniqueness constraints for this operation.
 */
export interface PatternObservationLedger {
  insertObservationWithInitialEvent(input: {
    observation: AnyDetectedPattern;
    initialEvent: PatternLifecycleEvent;
  }): Promise<void>;
}

/**
 * Proof that a detection window was *evaluated*, recorded separately from what it found.
 *
 * ## Why zero detections is not evidence of a quiet market
 *
 * Absence of observations is ambiguous by construction: "the detectors ran across this window and
 * nothing qualified" and "the detectors have not run across this window" are the same empty result,
 * and no query over the observation table separates them.
 *
 * This repository has already paid for that ambiguity once. The scalp research harness read
 * `pattern_detections` with a bare `WHERE candle_id = $1` while the detection cron had not yet run
 * for that minute; 46% of live evaluations saw zero patterns on candles that have them, and the loss
 * was indistinguishable from a quiet market. Migration 079 (`candle_feature_coverage`) closed it for
 * that module by writing an explicit first-cover marker. This record is the same instrument, scoped
 * to Pattern Intelligence and shaped by errata Section 7.
 *
 * ## First-cover semantics
 *
 * `recordedAt` must be the time coverage was *first* established for a window, never the most recent
 * write. A storage implementation therefore inserts with `ON CONFLICT DO NOTHING` — a re-run over an
 * already-covered window must not advance the timestamp, because the value's whole purpose is to date
 * a feature's earliest availability relative to a reader. `pattern_detections.detected_at` and
 * `indicator_snapshots.calculated_at` both fail at exactly this: later recompute passes rewrite them,
 * so they record the most recent write and can date nothing.
 *
 * ## No backfill
 *
 * Nothing is stamped for history. For a window already evaluated we genuinely do not know when its
 * observations landed relative to any reader, and inventing a coverage row would assert precisely the
 * fact this record exists to establish. An absent row reads as "unknown", which is true.
 */
export interface PatternCoverageRecord {
  coverageId: string;
  source: ObservationSource;
  fromTime: Date;
  toTime: Date;
  candlesEvaluated: number;
  patternsFound: number;
  recordedAt: Date;
  engineVersion: string;
}

/**
 * Storage port for coverage markers.
 *
 * Implementations must be first-cover stable: a repeat call for an already-covered window is a no-op,
 * not an update. See `PatternCoverageRecord`.
 */
export interface PatternCoverageRecorder {
  recordCoverage(record: PatternCoverageRecord): Promise<void>;
}

export type PatternLifecycleEventType = "DETECTED" | "CONFIRMED" | "INVALIDATED" | "EXPIRED" | "COMPLETED";

export interface PatternLifecycleEvent {
  eventId: string;
  eventSchemaVersion: "1.0";
  observationId: string;
  eventType: PatternLifecycleEventType;
  dataThrough: Date;
  eventTime: Date;
  knownAt: Date;
  sequenceNumber: number;
  idempotencyKey: string;
  cause: string | null;
}
