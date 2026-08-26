import type { PatternObservationSummary } from "../../../pattern-intelligence/domain/observation-summary.js";
import { registeredPatternDefinitions } from "../../../pattern-intelligence/domain/pattern-definition-registry.js";
import type { StrategyMarketContext, TradeSide } from "../../../strategy-engine/domain/strategy.js";
import {
  buildProposal,
  buildStrategyDefinition,
  type ImmutableStrategyProposal,
  type ResearchStrategyDefinition,
} from "./contracts.js";
import { sha256Canonical } from "./identity.js";
import type { ResearchStrategyAdapter } from "./research-strategies.js";

/**
 * Pattern V4 Research, generation 2 — the same execution geometry, a different pattern taxonomy.
 *
 * ## What this is and is not
 *
 * `pattern-v4-research` (generation 1) stays exactly as it is, running on the incumbent
 * `pattern_detections` taxonomy. This is a *sibling* cohort under its own key, so the two accumulate
 * in parallel and the harness decides between them. It is not a replacement and it does not modify
 * the generation-1 definition, whose hash and captured rows must keep meaning what they meant.
 *
 * ## The layering, and where the decision actually happens
 *
 * Pattern Intelligence says "this observable structure occurred" and refuses to say more — no score,
 * no probability, no side. This adapter is the layer that says "that structure qualifies as a
 * proposal, at this geometry, in this direction". Every one of those is *this file's* judgement, made
 * under its own name, and none of them is attributed to the detector. That separation is the whole
 * reason V1.0.1 was frozen the way it was.
 *
 * Concretely, that is why nothing here routes through `ProposedTradeIdea`. That interface requires a
 * `confidence: number`, and manufacturing one — even a constant — would put a fabricated judgement
 * into the record under a field name that reads like a measurement. `buildProposal` needs no such
 * field, so the banned concept simply never appears.
 *
 * ## Execution geometry is frozen to the incumbent, on purpose
 *
 * Experiment P0 changes exactly one thing: the taxonomy. Stop, target, entry and expiry replicate
 * `MomentumScalpPatternStrategyV2` verbatim — entry at the bar close, a 1.0-ATR stop, a 1.5R target,
 * a 3-candle expiry. If the geometry moved at the same time, a change in result would be
 * uninterpretable: taxonomy and geometry would be confounded and no amount of later analysis could
 * separate them.
 *
 * The rules are re-stated here rather than imported because the incumbent strategy is frozen behind a
 * pinned `implementationArtifactChecksum`; exporting its private helpers would change that file and
 * invalidate the generation-1 cohort. Duplication is the lesser cost, and `geometryPolicyVersion`
 * records that this is a deliberate replication.
 */

/**
 * The families allowed to *trigger* a proposal, with the reason each is in or out.
 *
 * Measured firing rates over five sessions of live BANKNIFTY data (share of bars carrying at least
 * one observation) drove these calls, not taxonomy tier alone:
 *
 * ```
 * CANDLE_GEOMETRY        80.3% (1m)  71.8% (5m)   <- descriptor, not an event
 * CLASSICAL_REVERSAL     50.6%       52.0%        <- degenerate detector, see below
 * COMPRESSION_EXPANSION  39.8%       43.2%
 * MULTI_CANDLE           19.2%       21.4%
 * SWING_STRUCTURE        17.7%       18.4%
 * BREAKOUT_STATE         13.5%       13.3%
 * OPENING_STRUCTURE       1.7%       11.1%
 * CONTINUATION_STRUCTURE  1.7%        2.1%
 * SWEEP_RECLAIM           0.4%        3.7%
 * ```
 *
 * `CLASSICAL_REVERSAL` is excluded from triggering: 473 double-tops and 196 head-and-shoulders in
 * five 1m sessions is not a reversal detector. Its own frozen definition record already states the
 * cause — it reads peaks and troughs at *fixed bar offsets* (i-6/i-4/i-2, i-8/i-5/i-2) rather than
 * from detected pivots, so it fires whenever three bars at those exact lags happen to align. Letting
 * it propose would spend a pre-registered trial on a detector known to be broken, and would swamp
 * every other family in the pooled population.
 *
 * `CANDLE_GEOMETRY` is excluded for a different reason: at 80% of bars it is a description of almost
 * every candle, not an event. Both remain recorded as covariates on every proposal, which is what
 * keeps them analytically available without letting them dominate the sample.
 */
const proposalFamilies: readonly string[] = [
  // Tier A, data-ready.
  "SWEEP_RECLAIM", "BREAKOUT_STATE", "COMPRESSION_EXPANSION", "OPENING_STRUCTURE",
  "GAP_STRUCTURE", "LEVEL_INTERACTION", "SWING_STRUCTURE",
  // Tier B, data-ready.
  "CONTINUATION_STRUCTURE",
  // Tier C, sparse enough to carry its own weight.
  "MULTI_CANDLE",
];

/** Recorded on every proposal but never allowed to trigger one. See `proposalFamilies`. */
const covariateOnlyFamilies: readonly string[] = ["CANDLE_GEOMETRY", "CLASSICAL_REVERSAL"];

/** Tier labels travel with each proposal so Tier C can be filtered out of a headline claim. */
const familyTier: Readonly<Record<string, string>> = {
  SWEEP_RECLAIM: "A", BREAKOUT_STATE: "A", COMPRESSION_EXPANSION: "A", OPENING_STRUCTURE: "A",
  GAP_STRUCTURE: "A", LEVEL_INTERACTION: "A", SWING_STRUCTURE: "A",
  CONTINUATION_STRUCTURE: "B",
  MULTI_CANDLE: "C", CANDLE_GEOMETRY: "C", CLASSICAL_REVERSAL: "C",
};

/** Frozen to the incumbent. P0 varies the taxonomy and nothing else. */
export const patternIntelligenceResearchConfiguration = {
  atrStopMultiple: 1.0,
  rewardRiskMultiple: 1.5,
  expiryCandles: 3,
  entryOrderType: "MARKET_AT_REFERENCE",
  indicatorAlgorithmVersion: "ta-v1",
  proposalFamilies,
  covariateOnlyFamilies,
  /*
   * Only UP and DOWN can become a side.
   *
   * NONE and BIDIRECTIONAL are honest statements that the structure points nowhere in particular —
   * an inside bar, a doji, an equal high. Assigning them a direction would invent the one thing the
   * observation explicitly declines to assert, so they are recorded as covariates and never traded.
   */
  tradableOrientations: ["UP", "DOWN"],
  orientationToSide: { UP: "LONG", DOWN: "SHORT" },
  geometrySource: "REPLICATES_MOMENTUM_SCALP_PATTERN_V2 — entry at close, 1.0 ATR stop, 1.5R target, 3-candle expiry",
} as const;

function roundToTick(value: number, tickSize: number, mode: "DOWN" | "UP" | "NEAREST"): number {
  if (!(tickSize > 0)) return value;
  const ticks = value / tickSize;
  const rounded = mode === "DOWN" ? Math.floor(ticks) : mode === "UP" ? Math.ceil(ticks) : Math.round(ticks);
  return Number((rounded * tickSize).toFixed(10));
}

function findAtr(context: StrategyMarketContext): number | null {
  const indicator = context.indicators.find((item) => (
    item.code === "ATR"
    && item.algorithmVersion === patternIntelligenceResearchConfiguration.indicatorAlgorithmVersion
    && item.parameters.period === 14
  ));
  const value = indicator?.values.value;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The implementation identity of this strategy.
 *
 * Not a checksum of this source file, which is what the incumbent adapters use. What actually decides
 * whether a structure qualifies here is the set of frozen Pattern Definition records this cohort
 * consumes, so hashing those is both more meaningful and more stable: it moves exactly when a
 * detection threshold moves, and not when a comment in this file changes.
 */
export function patternIntelligenceImplementationChecksum(): string {
  return sha256Canonical({
    encoding: "PATTERN_INTELLIGENCE_RESEARCH_V1",
    definitions: registeredPatternDefinitions
      .filter((definition) => proposalFamilies.includes(definition.family))
      .map((definition) => ({
        definitionId: definition.definitionId,
        definitionVersion: definition.definitionVersion,
        definitionHash: definition.definitionHash,
      }))
      .sort((left, right) => left.definitionId.localeCompare(right.definitionId)),
  });
}

export const patternIntelligenceResearchDefinition: ResearchStrategyDefinition = buildStrategyDefinition({
  // A new key, never an edit to `pattern-v4-research`. Generation 1 keeps its hash and its rows.
  strategyKey: "pattern-v4-research-v2",
  researchVersion: 2,
  featureSchemaVersion: "scalp-raw-context-v2",
  implementationArtifactChecksum: patternIntelligenceImplementationChecksum(),
  configuration: patternIntelligenceResearchConfiguration as unknown as Record<string, unknown>,
});

export class PatternIntelligenceResearchAdapter implements ResearchStrategyAdapter {
  readonly definition = patternIntelligenceResearchDefinition;
  readonly supportedTimeframes: readonly string[] = ["1m", "5m"];

  evaluate(
    strategyContext: StrategyMarketContext,
    reference1mContext: StrategyMarketContext,
  ): ImmutableStrategyProposal[] {
    if (!this.supportedTimeframes.includes(strategyContext.candle.timeframe)) return [];
    if (strategyContext.candle.instrumentId !== reference1mContext.candle.instrumentId) {
      throw new Error("Strategy and reference contexts must belong to the same instrument.");
    }

    /*
     * No observations loaded is not the same as no patterns found.
     *
     * `undefined` means the caller never fetched them, and emitting nothing in that state is correct
     * — but it must not be recorded as a quiet bar. The coverage flag is what a later reader uses to
     * tell the two apart, and it travels on every proposal below.
     */
    const observations = strategyContext.patternObservations;
    if (observations === undefined || observations.length === 0) return [];

    const atr = findAtr(strategyContext);
    if (atr === null) return [];

    const candle = strategyContext.candle;
    const tickSize = candle.tickSize;
    const barDurationMs = candle.closeTime.getTime() - candle.openTime.getTime();
    const expiresAt = new Date(
      candle.closeTime.getTime() + barDurationMs * patternIntelligenceResearchConfiguration.expiryCandles,
    );

    // Recorded on every proposal, so a dense family stays visible as context without being able to
    // generate a population of its own.
    const covariates = observations
      .filter((item) => covariateOnlyFamilies.includes(item.patternFamily))
      .map((item) => ({
        patternFamily: item.patternFamily,
        patternSubtype: item.patternSubtype,
        orientation: item.orientation,
        observationId: item.observationId,
      }));

    const proposals: ImmutableStrategyProposal[] = [];
    for (const observation of observations) {
      if (!proposalFamilies.includes(observation.patternFamily)) continue;
      if (observation.orientation !== "UP" && observation.orientation !== "DOWN") continue;

      const direction: TradeSide = observation.orientation === "UP" ? "LONG" : "SHORT";
      const entryPrice = candle.close;
      const stopDistance = atr * patternIntelligenceResearchConfiguration.atrStopMultiple;
      const stopLoss = direction === "LONG"
        ? roundToTick(entryPrice - stopDistance, tickSize, "DOWN")
        : roundToTick(entryPrice + stopDistance, tickSize, "UP");
      const risk = Math.abs(entryPrice - stopLoss);
      if (!(risk > 0)) continue;
      const targetPrice = direction === "LONG"
        ? roundToTick(entryPrice + risk * patternIntelligenceResearchConfiguration.rewardRiskMultiple, tickSize, "NEAREST")
        : roundToTick(entryPrice - risk * patternIntelligenceResearchConfiguration.rewardRiskMultiple, tickSize, "NEAREST");
      // Same guard the incumbent applies, so a degenerate bracket is dropped rather than recorded.
      if (direction === "LONG" && !(stopLoss < entryPrice && targetPrice > entryPrice)) continue;
      if (direction === "SHORT" && !(stopLoss > entryPrice && targetPrice < entryPrice)) continue;

      proposals.push(buildProposal({
        definition: this.definition,
        strategyContext,
        referenceCandle: reference1mContext.candle,
        direction,
        // One setup type per family:subtype, so cohorts never have to be reconstructed by parsing.
        setupType: `PATTERN_INTELLIGENCE:${observation.patternFamily}:${observation.patternSubtype}`,
        setupFingerprintParts: [
          direction, observation.patternFamily, observation.patternSubtype,
          observation.definitionHash,
        ],
        nativeGeometry: {
          direction,
          entryOrderType: "MARKET_AT_REFERENCE",
          entryPrice,
          stopLoss,
          targetPrice,
          expiresAt,
          geometryPolicyVersion: "PATTERN_INTELLIGENCE_V2_FROZEN_INCUMBENT_V1",
        },
        rawContext: {
          featureDataThrough: new Date(candle.closeTime.getTime() - 1),
          /*
           * The full provenance chain, preserved so the research question can be
           * "does SWEEP_RECLAIM have edge?" rather than only "did Pattern V4 make money?".
           */
          patternObservation: {
            observationId: observation.observationId,
            patternFamily: observation.patternFamily,
            patternSubtype: observation.patternSubtype,
            orientation: observation.orientation,
            tier: familyTier[observation.patternFamily] ?? "UNKNOWN",
            definitionRef: {
              definitionId: observation.definitionId,
              definitionVersion: observation.definitionVersion,
              definitionHash: observation.definitionHash,
            },
            detectedAt: observation.detectedAt,
            knownAt: observation.knownAt,
            earliestExecutionAt: observation.earliestExecutionAt,
            durationBars: observation.durationBars,
            rangeBps: observation.rangeBps,
            rangeAtr: observation.rangeAtr,
            trendState: observation.trendState,
            sessionSegment: observation.sessionSegment,
            volumeZscore: observation.volumeZscore,
            rangeZscore: observation.rangeZscore,
            effortResultDivergence: observation.effortResultDivergence,
            details: observation.details,
          },
          /*
           * There is no legacy score gate on this cohort, and that is recorded rather than faked.
           *
           * Generation 1 carries a `legacyScoreGate` descriptor so its historical population stays
           * reconstructible by filtering. Generation 2 never had a gate, so inventing a threshold and
           * a `passed` verdict would assert a filter that never existed. `null` is the true answer.
           */
          legacyScoreGate: null,
          /*
           * No score of any kind is attached. The detector declined to rank the structure and this
           * adapter has nothing to add — it decides only *whether* the structure qualifies and at
           * what geometry, which is exactly what `setupType` and `nativeGeometry` already record.
           */
          scoreSource: "NOT_SCORED — Pattern Intelligence V1.0.1 emits no score, and this adapter adds none",
          patternObservationCoverage: strategyContext.patternObservationCoverage ?? "UNKNOWN",
          observationsOnBar: observations.length,
          covariateObservations: covariates,
          sourceCandle: {
            id: candle.id,
            timeframe: candle.timeframe,
            openTime: candle.openTime,
            closeTime: candle.closeTime,
            open: candle.open, high: candle.high, low: candle.low, close: candle.close,
            volume: candle.volume,
          },
          indicators: strategyContext.indicators.map((item) => ({
            code: item.code,
            algorithmVersion: item.algorithmVersion,
            parameters: item.parameters,
            values: item.values,
          })),
          regime: strategyContext.regime ?? null,
          triggeredByFrozenSetup: true,
        },
      }));
    }
    return proposals;
  }
}
