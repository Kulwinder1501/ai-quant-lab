import { calculateDefinitionHash } from "./canonical-hash.js";
import type { PatternDefinition, PatternDefinitionRegistry, PatternFamily } from "./contracts.js";

/**
 * The Pattern Definition Registry — the frozen detection records the V1.0.1 Implementation Gate
 * requires before a detector may run.
 *
 * ## Why this exists
 *
 * The spec opens with a gate: *"PatternDefinition records — specifying pivot rules, detection
 * thresholds, and invalidation conditions for each family — must be frozen and stored in the Pattern
 * Definition Registry before implementing the corresponding detector. Implementing a detector before
 * its definition record exists is not permitted."*
 *
 * Twelve engines were written before any registry existed. This file closes that gap after the fact,
 * which is worth stating plainly rather than papering over: these records were written *from* the
 * implemented engines, so they document what the detectors do — they did not constrain what the
 * detectors became. A definition frozen before its detector and one reconstructed from it carry
 * different evidential weight, exactly as `StudyProvenance` distinguishes `PRE_SPECIFIED` from
 * `DATA_INSPECTED` in the exit-geometry program. `derivedFromImplementation` on each record carries
 * that flag, and it is `true` for all twelve.
 *
 * What the registry does buy from here on is the thing the gate was actually protecting: a threshold
 * can no longer move silently. `pattern-definition-registry.test.ts` pins every `definitionHash`, so
 * editing a number in an engine's config without registering a new definition version fails the
 * suite. Retrofitted or not, the ratchet works forwards.
 *
 * ## Per family, not per subtype
 *
 * `PatternDefinition.family` is a `PatternFamily` and the gate says "for each family", so there is one
 * record per family, with per-subtype thresholds nested inside `parameters`. The orchestrator
 * previously minted a synthetic `definitionId` per subtype (`sweep-reclaim-spring`,
 * `candle-hammer`, ...), which would have meant ~150 records for 12 detectors and no single place
 * where a family's rules could be read. The subtype is already carried on `identity.patternSubtype`.
 *
 * ## A version is a new record, never an edit
 *
 * `definitionVersion` is part of the hashed payload and part of the lookup key. Changing a threshold
 * means registering `1.1.0`, not editing `1.0.0` — observations already sealed against `1.0.0` refer
 * to the rules that actually produced them, and rewriting those rules underneath them would silently
 * restate history. This mirrors `study-registry.ts`, where `PATH_STUDY_V2` exists rather than a
 * widened `PATH_STUDY_V1`.
 *
 * ## Honesty about what the engines really enforce
 *
 * Where an engine declares a threshold it never applies, or applies a rule asymmetrically across
 * subtypes, that is recorded in `parameters` as an explicit note rather than smoothed over. A registry
 * that describes intended behaviour instead of actual behaviour is worse than none, because it reads
 * as verification.
 */

export const patternDefinitionRegistryEncodingVersion = "PATTERN_DEFINITION_REGISTRY_V1";

/** The instant these records were frozen. Part of the hashed payload. */
const frozenAt = new Date("2026-08-26T00:00:00.000Z");

const definitionVersion = "1.0.0";

export interface RegisteredPatternDefinition extends PatternDefinition {
  /**
   * Whether the record was written from an already-implemented detector rather than before it.
   *
   * True for every V1.0.1 record. Not a quality judgement — a provenance flag, so a later reader
   * cannot mistake a retrofit for a pre-registration.
   */
  readonly derivedFromImplementation: boolean;
}

type DefinitionSeed = Omit<PatternDefinition, "definitionHash"> & { derivedFromImplementation: boolean };

function seed(
  definitionId: string,
  family: PatternFamily,
  parameters: Record<string, unknown>,
  invalidationConditions: readonly string[],
): DefinitionSeed {
  return { definitionId, definitionVersion, family, parameters, invalidationConditions, frozenAt, derivedFromImplementation: true };
}

const seeds: readonly DefinitionSeed[] = [
  seed(
    "pattern-intelligence.sweep-reclaim",
    "SWEEP_RECLAIM",
    {
      minimumBars: 5,
      lookbackBars: 20,
      minPenetrationBps: 2.0,
      minReclaimBps: 3.0,
      swingReferenceRule:
        "Extreme high/low over [i-lookbackBars, i-2]. The current and immediately prior bar are "
        + "excluded from the reference so the sweeping bars cannot define the level they sweep.",
      sweepRule: "current.low < reference || prev.low < reference, with sweepLow = min(current.low, prev.low)",
      reclaimRule: "current.close strictly back across the reference",
      /*
       * Declared in `defaultSweepReclaimConfig` and never read by `detect`.
       *
       * Recorded rather than deleted because deleting it would change the engine's public config
       * shape, and recorded as unenforced rather than as a threshold because writing it down as if it
       * bound would make this registry assert a constraint that does not exist. A sweep with a
       * 40-ATR excursion is currently emitted.
       */
      maxExcursionAtr: { value: 2.5, enforced: false, note: "Declared in engine config; never referenced by detect()." },
      /*
       * A real asymmetry between subtype groups, not an oversight this file should hide.
       *
       * SPRING and UPTHRUST require both minPenetrationBps and minReclaimBps. PDH_SWEEP and PDL_SWEEP
       * require only minPenetrationBps, so they fire on a marginal reclaim that would not qualify as a
       * swing sweep.
       */
      subtypeGating: {
        SPRING: ["minPenetrationBps", "minReclaimBps"],
        UPTHRUST: ["minPenetrationBps", "minReclaimBps"],
        PDH_SWEEP: ["minPenetrationBps"],
        PDL_SWEEP: ["minPenetrationBps"],
      },
      emittedSubtypes: ["SPRING", "UPTHRUST", "PDH_SWEEP", "PDL_SWEEP"],
      declaredButUnemittedSubtypes: ["SFP_HIGH", "SFP_LOW", "RANGE_HIGH_SWEEP", "RANGE_LOW_SWEEP", "ORB_SWEEP"],
    },
    [
      "Close beyond the swept extreme in the sweep direction invalidates the reclaim.",
      "A later bar re-sweeping the same reference supersedes the observation.",
    ],
  ),
  seed(
    "pattern-intelligence.breakout-state",
    "BREAKOUT_STATE",
    {
      minimumBars: 5,
      lookbackBars: 20,
      minBreakoutBps: 3.0,
      retestToleranceBps: 4.0,
      levelRule: "Extreme high (resistance) and low (support) over [i-lookbackBars, i-2].",
      breakoutRule: "current.close > level && prev.close <= level, distance >= minBreakoutBps",
      failedBreakoutRule:
        "prev.high > level && current.close < level && current.open > level * 0.999. The 0.999 factor "
        + "is a 10 bps allowance expressed multiplicatively in the engine.",
      retestRule: "candles[i-2].close beyond level, current wick re-touches within retestToleranceBps, current.close still beyond",
      subtypeGating: {
        BREAKOUT: ["minBreakoutBps"],
        BREAKDOWN: ["minBreakoutBps"],
        FAILED_BREAKOUT: [],
        FAILED_BREAKDOWN: [],
        RETEST_AFTER_BREAKOUT: ["retestToleranceBps"],
        RETEST_AFTER_BREAKDOWN: ["retestToleranceBps"],
      },
      unenforcedNote: "minBreakoutBps does not gate the FAILED_* or RETEST_* subtypes; they emit on structure alone.",
    },
    [
      "Close back across the breakout level in the opposite direction invalidates the breakout.",
      "A retest that closes through the level converts the state rather than confirming it.",
    ],
  ),
  seed(
    "pattern-intelligence.compression-expansion",
    "COMPRESSION_EXPANSION",
    {
      minimumBars: 2,
      insideBarRule: "current.high <= prev.high && current.low >= prev.low",
      insideBarChainMax: 3,
      nr4Rule: "current range strictly narrower than each of the prior 3 ranges",
      nr7Rule: "current range strictly narrower than each of the prior 6 ranges",
      vcpRule: "Three consecutive 3-bar waves over [i-9, i] with strictly decreasing depth (depth1 > depth2 > depth3)",
      vcpContractionCount: 3,
      expansionRule: "current range >= 2.0x the mean range of the prior 5 bars",
      expansionMultiple: 2.0,
      compressionRatioNullRule:
        "Null when the denominator range is zero. Never 1.0 — that is a legitimate ratio meaning "
        + "'as wide as the reference', and the two must stay distinguishable.",
      declaredButUnemittedSubtypes: ["SYMMETRICAL_TRIANGLE", "ASCENDING_TRIANGLE", "DESCENDING_TRIANGLE", "PENNANT", "COIL"],
    },
    [
      "A close outside the compression range resolves it; the observation does not persist past resolution.",
      "An inside-bar chain is superseded by its own longer chain on the following bar.",
    ],
  ),
  seed(
    "pattern-intelligence.opening-structure",
    "OPENING_STRUCTURE",
    {
      minimumSessionBars: 3,
      openingRangeMinutes: 15,
      openingRangeRule: "Bars whose openTime is strictly less than openingRangeMinutes after the session's first bar.",
      sessionGrouping: "By IST calendar date derived from bar openTime.",
      openingDriveBodyRatio: 0.75,
      orbRule: "First post-opening-range close beyond the range, once per side per session.",
      orbFailureRule: "After an upside break, any bar closing below the opening range low.",
      orbFailureRepeats: { value: true, note: "Emits on every qualifying bar, not only the first. Not deduplicated." },
      sweepRule: "Wick beyond one extreme with close back inside the opening range.",
      preOpenExcluded: {
        value: true,
        note: "Errata Section 5 — pre-open auction prints (09:00-09:15 IST) are excluded from ORB.",
      },
      declaredButUnemittedSubtypes: ["OPENING_REJECTION", "DOUBLE_SIDED_SWEEP"],
    },
    [
      "A close back inside the opening range invalidates an ORB.",
      "The opening range itself is fixed once the window closes and is never recomputed.",
    ],
  ),
  seed(
    "pattern-intelligence.gap-structure",
    "GAP_STRUCTURE",
    {
      minimumBars: 2,
      sessionOpenRule: "First bar whose IST calendar date differs from the prior bar's.",
      referenceLevels: "Caller-supplied prior-day high/low/close; falls back to the prior bar's own high/low/close.",
      breakawayGapAtrMultiple: 1.0,
      gapAndGoRule: "Open beyond the prior day's range and close continuing in the gap direction.",
      gapAndFadeRule: "Open beyond the prior day's range and close reversing against the gap direction.",
      atrRequirement: {
        period: 14,
        substitution: "NONE",
        note:
          "The engine previously substituted the prior-day range for an unavailable ATR. Because "
          + "BREAKAWAY_GAP fires on abs(gapVsAtr) >= 1.0, that substitution changed which patterns "
          + "existed during warmup rather than only what was recorded. It now refuses to emit.",
      },
      declaredButUnemittedSubtypes: ["CONTINUATION_GAP", "EXHAUSTION_GAP", "GAP_FILL", "ISLAND_REVERSAL"],
    },
    [
      "A close back inside the prior day's range fills the gap and invalidates a gap-and-go.",
      "The prior-day reference levels are fixed at session open and never revised intraday.",
    ],
  ),
  seed(
    "pattern-intelligence.level-interaction",
    "LEVEL_INTERACTION",
    {
      minimumBars: 2,
      levelTypesSupplied: ["PDH", "PDL", "PRIOR_CLOSE"],
      breakAndHoldToleranceBps: {
        value: 10,
        note: "Expressed in the engine as level * 0.999 (up) and level * 1.001 (down).",
      },
      breakAndHoldRule: "Prior close on one side, current close through, and the current wick holding within tolerance.",
      sweepAndRejectRule: "Wick through the level with close back on the originating side, prior close also on that side.",
      declaredButUnsuppliedLevelTypes: ["PRIOR_MID", "WEEKLY_HIGH", "WEEKLY_LOW", "VWAP", "OPENING_PRICE"],
      vwapNote:
        "VWAP is declared in the contract but never supplied, and on an index it would not be an "
        + "execution benchmark in any case — index volume is a constituent aggregate, so an index VWAP "
        + "is an activity-weighted index level. See volume-semantics.ts.",
      declaredButUnemittedSubtypes: ["BREAK_RETEST_CONTINUE", "FAILED_BREAKDOWN_AT_LEVEL", "FAILED_BREAKOUT_AT_LEVEL"],
    },
    [
      "A close back across the level invalidates a break-and-hold.",
      "A level is invalidated for the session once decisively broken and not reclaimed.",
    ],
  ),
  seed(
    "pattern-intelligence.swing-structure",
    "SWING_STRUCTURE",
    {
      pivotAlgorithm: "SYMMETRIC_WINDOW",
      swingWindow: 3,
      minimumBars: 7,
      pivotRule: "A bar is a pivot high when strictly higher than all bars within +/- swingWindow; symmetric for lows.",
      confirmationLag: {
        bars: 3,
        note:
          "detectedIndex = pivotIndex + swingWindow, which is what keeps the pivot point-in-time "
          + "honest: a pivot cannot be known until its right-hand window has closed.",
      },
      equalLevelToleranceFraction: 0.0005,
      bosRule: "A higher high additionally emits BOS_UP; a lower low additionally emits BOS_DOWN.",
      declaredButUnemittedSubtypes: ["CHOCH_UP", "CHOCH_DOWN", "BULLISH_TRANSITION", "BEARISH_TRANSITION"],
    },
    [
      "A close beyond the opposing swing invalidates the structural read.",
      "A superseding pivot in the same direction replaces the prior swing reference.",
    ],
  ),
  seed(
    "pattern-intelligence.effort-result",
    "EFFORT_RESULT",
    {
      windowBars: 20,
      highEffortLowResult: { volumeZscoreMin: 1.5, rangeZscoreMax: 0.0 },
      climax: { volumeZscoreMin: 2.0, wickRule: "Rejection wick at least as large as the bar body." },
      lowEffortHighResult: { rangeZscoreMin: 1.5, volumeZscoreMax: -0.5 },
      absorptionOrientationRule: "UP when close is above the bar midpoint, otherwise DOWN.",
      rejectionWickAssignment: {
        BUYING_CLIMAX: "UPPER",
        SELLING_CLIMAX: "LOWER",
        ABSORPTION: "LOWER when orientation UP, UPPER when DOWN",
        HIGH_EFFORT_LOW_RESULT: "MAX(UPPER, LOWER) — direction-neutral by construction",
        LOW_EFFORT_HIGH_RESULT: "NONE — a range-expansion claim asserts nothing about rejection",
      },
      climaxVolumeMultiplierDefinition: "bar volume / trailing 20-bar simple mean, same window as the z-score",
      volumeValidityRule:
        "Every bar in the window must have strictly positive volume. A stored 0 means unknown, not "
        + "zero activity, and a window mixing real volumes with zeros produces a large-variance, "
        + "meaningless z-score that clears every threshold above.",
      dataReadinessStatus: {
        value: "BLOCKED_PARTIAL",
        note:
          "Errata Section 1. Index volume is a constituent aggregate (corr 0.877 with constituent "
          + "cash volume, no expiry spike), not auction volume at a price level, so effort/result "
          + "semantics are not satisfied by the available feed. The engine is implemented and "
          + "volume-safe; the family remains unevaluable until futures volume is ingested.",
      },
    },
    [
      "A subsequent bar exceeding the climax extreme on higher volume supersedes the climax.",
      "An absorption read is invalidated by a close beyond the absorbing bar's range.",
    ],
  ),
  seed(
    "pattern-intelligence.candle-geometry",
    "CANDLE_GEOMETRY",
    {
      minimumBars: 1,
      zeroRangeBarsSkipped: true,
      dojiBodyRatioMax: 0.10,
      dragonflyDoji: { upperShadowMaxFraction: 0.05, lowerShadowMinFraction: 0.70 },
      gravestoneDoji: { lowerShadowMaxFraction: 0.05, upperShadowMinFraction: 0.70 },
      hammerFamily: { shadowToBodyMin: 2.0, opposingShadowMaxFraction: 0.15, bodyRatioRange: [0.10, 0.40] },
      marubozuBodyRatioMin: 0.85,
      spinningTop: { bodyRatioRange: [0.15, 0.35], eachShadowMinFraction: 0.25 },
      tweezerToleranceFraction: 0.0002,
      tweezerShadowMinFraction: 0.3,
      kicker: { currentBodyRatioMin: 0.7, priorBodyRatioMin: 0.7 },
      pairedEmissionNote:
        "HAMMER/HANGING_MAN and SHOOTING_STAR/INVERTED_HAMMER are emitted as pairs from one geometric "
        + "test, because the two members of each pair differ only by prior trend, which this engine "
        + "does not consult. Both are recorded and the observer decides; nothing here asserts which is "
        + "correct.",
      declaredButUnemittedSubtypes: ["ABANDONED_BABY_UP", "ABANDONED_BABY_DOWN"],
    },
    [
      "A single-bar geometry is descriptive of its own bar and is never invalidated retrospectively.",
      "A two-bar pattern is invalidated if the pair is re-evaluated under a revised bar.",
    ],
  ),
  seed(
    "pattern-intelligence.multi-candle",
    "MULTI_CANDLE",
    {
      minimumBars: 2,
      haramiBodyRatioMax: 0.6,
      haramiCrossBodyToRangeMax: 0.1,
      haramiContainmentRule: "Current body fully inside the prior body, measured on open/close extremes.",
      piercingLine: { priorBearish: true, gapRule: "current.open < prev.low", closeRule: "above prior body midpoint, below prior open" },
      darkCloudCover: { priorBullish: true, gapRule: "current.open > prev.high", closeRule: "below prior body midpoint, above prior open" },
      starPattern: { firstBodyToRangeMin: 0.5, middleBodyToFirstBodyMax: 0.4 },
      threeSoldiersRule: "Each open inside the prior body and each close above the prior close.",
      threeMethods: { consolidationBars: 3, containmentRule: "inside the first bar's range", counterTrendMajority: 2 },
      declaredButUnemittedSubtypes: ["TOWER_TOP", "TOWER_BOTTOM"],
    },
    [
      "A multi-bar reversal is invalidated by a close beyond the pattern extreme against its orientation.",
      "The pattern window is fixed at detection and never extended.",
    ],
  ),
  seed(
    "pattern-intelligence.classical-reversal",
    "CLASSICAL_REVERSAL",
    {
      minimumBars: 5,
      pivotAlgorithm: {
        value: "FIXED_BAR_OFFSETS",
        note:
          "A stated limitation, frozen so it cannot be mistaken for pivot detection. Peaks and "
          + "troughs are read at hard-coded lags — double patterns at i-6/i-4/i-2, head-and-shoulders "
          + "at i-8/i-6/i-5/i-3/i-2 — not from the ZigZag or symmetric-window pivots used by "
          + "SWING_STRUCTURE. The family therefore only detects formations whose geometry happens to "
          + "align with those exact spacings, and its recall is unmeasured.",
      },
      doubleTopBottomPeakMatchFraction: 0.003,
      doubleTopConfirmation: "Close beyond the intervening valley (top) or peak (bottom).",
      headAndShouldersShoulderMatchFraction: 0.01,
      necklineRule: "Mean of the two intervening extremes.",
      headAndShouldersConfirmation: "Close beyond the neckline.",
      declaredButUnemittedSubtypes: [
        "TRIPLE_TOP", "TRIPLE_BOTTOM", "ROUNDING_TOP", "ROUNDING_BOTTOM", "V_REVERSAL", "RISING_WEDGE", "FALLING_WEDGE",
      ],
    },
    [
      "A close back across the neckline against the orientation invalidates the reversal.",
      "A new extreme beyond the head invalidates the formation.",
    ],
  ),
  seed(
    "pattern-intelligence.continuation-structure",
    "CONTINUATION_STRUCTURE",
    {
      minimumBars: 6,
      poleRule: "Impulse measured from candles[i-5] to candles[i-3].",
      flagBars: 2,
      maxRetraceFraction: 0.50,
      breakoutRule: "Close beyond the flag extreme in the pole direction.",
      pullbackContinuationRule: "Two counter-trend bars after an in-trend bar, resolved by a close beyond the first pullback bar's extreme.",
      pivotAlgorithm: {
        value: "FIXED_BAR_OFFSETS",
        note: "Same limitation as CLASSICAL_REVERSAL — fixed lags, not detected pivots.",
      },
      declaredButUnemittedSubtypes: [
        "BULL_PENNANT", "BEAR_PENNANT", "RISING_CHANNEL", "FALLING_CHANNEL", "HORIZONTAL_CHANNEL", "THROWBACK", "ABC_CONTINUATION",
      ],
    },
    [
      "A close back inside the flag against the breakout invalidates the continuation.",
      "A close beyond the pole origin invalidates the impulse premise entirely.",
    ],
  ),
];

/**
 * Seals a record by hashing every field except the hash itself.
 *
 * `derivedFromImplementation` is inside the hashed payload deliberately, for the same reason
 * `studyDefinitionHash` covers `provenance` in the exit-geometry registry: reclassifying a retrofit as
 * a pre-registration is a change to what the record claims, and it must not be possible to make that
 * change without the hash moving. It is also load-bearing mechanically —
 * `recordDetectedPattern` re-derives the hash from the stored object and rejects a mismatch, so any
 * field on the record has to be covered or the write path refuses every observation.
 */
function freeze(definition: DefinitionSeed): RegisteredPatternDefinition {
  const payload: RegisteredPatternDefinition = { ...definition, definitionHash: "" };
  return { ...payload, definitionHash: calculateDefinitionHash(payload) };
}

/** The twelve frozen V1.0.1 family definitions, in registration order. */
export const registeredPatternDefinitions: readonly RegisteredPatternDefinition[] = seeds.map(freeze);

/**
 * The families with an implemented detector.
 *
 * Deliberately not all eighteen. `AUCTION_PROFILE` needs near-month FUTIDX contracts and a
 * TRADE_VAP/VENDOR_VAP store, and the database has neither — `instruments.instrument_type` holds only
 * EQUITY/INDEX/ETF and there is no volume-at-price table. `WYCKOFF_EVENT`, `WYCKOFF_STATE`,
 * `RELATIVE_STRUCTURE`, `HARMONIC` and `BROADENING_STRUCTURE` are declared in the taxonomy with no
 * engine behind them. A family without a definition here has no detector, and that is the intended
 * reading.
 */
export const definedPatternFamilies: readonly PatternFamily[] = registeredPatternDefinitions.map((d) => d.family);

/** The canonical definition id for a family, used by the detection orchestrator. */
export function definitionIdForFamily(family: PatternFamily): string | null {
  return registeredPatternDefinitions.find((d) => d.family === family)?.definitionId ?? null;
}

/** Rejects a record that cannot serve as a frozen registration before it reaches storage. */
export function assertDefinitionRegistrable(definition: PatternDefinition): void {
  if (!/^pattern-intelligence\.[a-z0-9-]+$/.test(definition.definitionId)) {
    throw new Error(
      `Definition id "${definition.definitionId}" must be namespaced as pattern-intelligence.<family-kebab> `
      + "so it cannot collide with the incumbent pattern-recognition module's definition ids.",
    );
  }
  if (!/^\d+\.\d+\.\d+$/.test(definition.definitionVersion)) {
    throw new Error(`${definition.definitionId} needs an explicit semantic definitionVersion.`);
  }
  if (Object.keys(definition.parameters).length === 0) {
    throw new Error(`${definition.definitionId} has empty parameters, so nothing is actually frozen.`);
  }
  if (definition.invalidationConditions.length === 0) {
    throw new Error(
      `${definition.definitionId} needs at least one invalidation condition — the Implementation Gate `
      + "requires invalidation to be specified, not just detection.",
    );
  }
  if (Number.isNaN(definition.frozenAt.getTime())) {
    throw new Error(`${definition.definitionId} needs a valid frozenAt instant.`);
  }
}

/**
 * The registry the detection orchestrator reads.
 *
 * Serves only the frozen records above, so a detector cannot persist an observation against a
 * definition nobody registered — which is the Implementation Gate, enforced at the write path by
 * `recordDetectedPattern`.
 */
export class StaticPatternDefinitionRegistry implements PatternDefinitionRegistry {
  private readonly byKey: ReadonlyMap<string, RegisteredPatternDefinition>;

  constructor(definitions: readonly RegisteredPatternDefinition[] = registeredPatternDefinitions) {
    for (const definition of definitions) assertDefinitionRegistrable(definition);
    this.byKey = new Map(definitions.map((d) => [`${d.definitionId}:${d.definitionVersion}`, d]));
  }

  async findFrozen(input: { definitionId: string; definitionVersion: string }): Promise<PatternDefinition | null> {
    return this.byKey.get(`${input.definitionId}:${input.definitionVersion}`) ?? null;
  }
}
