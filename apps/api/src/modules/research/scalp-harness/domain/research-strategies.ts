import {
  defaultMomentumScalpIndexStrategyConfiguration,
  MomentumScalpIndexStrategy,
} from "../../../strategy-engine/domain/momentum-scalp-index-strategy.js";
import {
  defaultMomentumScalpPatternStrategyConfiguration,
  MomentumScalpPatternStrategyV2,
} from "../../../strategy-engine/domain/momentum-scalp-pattern-strategy.js";
import {
  defaultMomentumScalpStrategyConfiguration,
  MomentumScalpStrategy,
} from "../../../strategy-engine/domain/momentum-scalp-strategy.js";
import type { ProposedTradeIdea, StrategyMarketContext } from "../../../strategy-engine/domain/strategy.js";
import {
  assertOnGridDecision,
  buildProposal,
  buildStrategyDefinition,
  controlPolicyVersion,
  gridPolicyVersion,
  istMinuteOfDay,
  istSessionId,
  type ImmutableStrategyProposal,
  type ResearchControlPoint,
  type ResearchStrategyDefinition,
} from "./contracts.js";
import { logicalKey, sha256Canonical } from "./identity.js";

export interface ResearchStrategyAdapter {
  readonly definition: ResearchStrategyDefinition;
  readonly supportedTimeframes: readonly string[];
  evaluate(strategyContext: StrategyMarketContext, reference1mContext: StrategyMarketContext): ImmutableStrategyProposal[];
}

interface BaseEvaluator {
  evaluate(context: StrategyMarketContext, configuration: Record<string, unknown>): ProposedTradeIdea[];
}

export const researchStrategySourceChecksums = Object.freeze({
  "momentum-scalp-strategy.ts": "d245e18d4d55d48cf38a715395b45b1916f3f469096950d81e70ec2d5746f093",
  "momentum-scalp-index-strategy.ts": "e9a74bf002c7b66adacdd7400128a27d6cb03fc8bf0f4bf9d9654dfc64eeed4d",
  "momentum-scalp-pattern-strategy.ts": "b1146d24f53bc225832302486990e5f9aa5e299785305c26834d07e3cbeb01bd",
});

/**
 * The score filter a historical strategy applied, preserved as a recorded covariate.
 *
 * Each strategy gates on a different quantity — the momentum pair on a blended `confidence`, the
 * pattern strategy on a raw confluence `score` — so the flag cannot be one shared threshold. The
 * research versions run ungated (see the configurations below), and this descriptor is what makes that
 * lossless: every captured row states which gate applied, at what threshold, what value it scored, and
 * whether it would have passed. The historical population stays exactly reconstructible with a `WHERE`
 * clause, while the rejected population becomes observable for the first time.
 */
export interface LegacyScoreGate {
  /** The configuration key that used to filter, named so a stored row is self-describing. */
  readonly parameter: string;
  readonly threshold: number;
  /** The scored quantity the threshold was compared against. */
  value(proposal: ProposedTradeIdea): number;
  /**
   * The scale the value is drawn from, where the strategy reports one.
   *
   * Recorded because a normalised score (`value / maximum`) and any response surface over score bands
   * are both meaningless without it — and the scale here is genuinely contested: the specification
   * describes an 11-point confluence gate while the implementation scores out of 9 and thresholds at 5.
   * The code is what ran, so the code is what is recorded; taking it from the proposal rather than a
   * constant means the stored value cannot drift from the implementation that produced it.
   */
  maximum?(proposal: ProposedTradeIdea): number | null;
}

const confidenceGate = (threshold: number): LegacyScoreGate => ({
  parameter: "minimumConfidence",
  threshold,
  value: (proposal) => proposal.confidence,
  maximum: () => 1,
});

const confluenceScoreGate = (threshold: number): LegacyScoreGate => ({
  parameter: "scoreThreshold",
  threshold,
  // The pattern strategy compares the raw confluence score, not the blended confidence it derives
  // from it. Recording the blend instead would silently move the reconstruction threshold.
  value: (proposal) => typeof proposal.evidence.score === "number" ? proposal.evidence.score : Number.NaN,
  maximum: (proposal) => typeof proposal.evidence.maxScore === "number" ? proposal.evidence.maxScore : null,
});

function rawContext(
  context: StrategyMarketContext,
  proposal: ProposedTradeIdea,
  legacyGate: LegacyScoreGate,
): Record<string, unknown> {
  const gateValue = legacyGate.value(proposal);
  return {
    featureDataThrough: new Date(context.candle.closeTime.getTime() - 1),
    // The hand-scored value and its components, recorded as covariates rather than applied as a
    // filter. Whether the score has discriminating power is a question for the estimators; treating it
    // as authoritative at capture time would assume the answer.
    nativeConfidence: proposal.confidence,
    nativeScoreComponents: proposal.evidence,
    legacyScoreGate: {
      parameter: legacyGate.parameter,
      threshold: legacyGate.threshold,
      value: gateValue,
      maximum: legacyGate.maximum?.(proposal) ?? null,
      passed: Number.isFinite(gateValue) ? gateValue >= legacyGate.threshold : null,
    },
    sourceCandle: {
      id: context.candle.id,
      timeframe: context.candle.timeframe,
      openTime: context.candle.openTime,
      closeTime: context.candle.closeTime,
      open: context.candle.open,
      high: context.candle.high,
      low: context.candle.low,
      close: context.candle.close,
      volume: context.candle.volume,
    },
    indicators: context.indicators.map((item) => ({
      code: item.code,
      algorithmVersion: item.algorithmVersion,
      parameters: item.parameters,
      values: item.values,
    })),
    patterns: context.patterns.map((item) => ({
      code: item.code,
      algorithmVersion: item.algorithmVersion,
      direction: item.direction,
      confidence: item.confidence,
      contextCandleIds: item.contextCandleIds,
      details: item.details,
    })),
    priceActionEvents: context.priceActionEvents.map((item) => ({
      eventCode: item.eventCode,
      algorithmVersion: item.algorithmVersion,
      direction: item.direction,
      level: item.level,
      confidence: item.confidence,
      details: item.details,
    })),
    regime: context.regime ?? null,
    triggerEvidence: proposal.evidenceItems.map((item) => ({
      sourceType: item.sourceType,
      sourceReference: item.sourceReference,
      details: item.details,
    })),
    // The setup's trigger conditions (EMA cross, RSI band, pattern) still define what counts as a
    // setup and are unchanged; only the score-based filter was lifted. So this says "a frozen trigger
    // fired here", not "a frozen rule judged this worth taking" — which is the whole point.
    triggeredByFrozenSetup: true,
  };
}

class FrozenResearchAdapter implements ResearchStrategyAdapter {
  constructor(
    readonly definition: ResearchStrategyDefinition,
    readonly supportedTimeframes: readonly string[],
    private readonly evaluator: BaseEvaluator,
    private readonly setupFamily: string,
    private readonly legacyGate: LegacyScoreGate,
  ) {}

  evaluate(strategyContext: StrategyMarketContext, reference1mContext: StrategyMarketContext): ImmutableStrategyProposal[] {
    if (!this.supportedTimeframes.includes(strategyContext.candle.timeframe)) return [];
    if (strategyContext.candle.instrumentId !== reference1mContext.candle.instrumentId) {
      throw new Error("Strategy and reference contexts must belong to the same instrument.");
    }
    const proposals = this.evaluator.evaluate(strategyContext, this.definition.configuration);
    return proposals.map((proposal) => {
      if (!proposal.expiresAt) throw new Error(`${this.definition.strategyKey} emitted a proposal without native expiry.`);
      const pattern = typeof proposal.evidence.pattern === "string" ? proposal.evidence.pattern : null;
      const setupType = pattern === null ? this.setupFamily : `${this.setupFamily}:${pattern}`;
      const evidenceReferences = proposal.evidenceItems
        .map((item) => `${item.sourceType}:${item.sourceReference ?? ""}`)
        .sort();
      return buildProposal({
        definition: this.definition,
        strategyContext,
        referenceCandle: reference1mContext.candle,
        direction: proposal.side,
        setupType,
        setupFingerprintParts: [proposal.side, setupType, evidenceReferences],
        nativeGeometry: {
          direction: proposal.side,
          entryOrderType: "MARKET_AT_REFERENCE",
          entryPrice: proposal.entryPrice,
          stopLoss: proposal.stopLoss,
          targetPrice: proposal.targetPrice,
          expiresAt: proposal.expiresAt,
          geometryPolicyVersion: `${this.definition.strategyKey.toUpperCase().replaceAll("-", "_")}_NATIVE_V1`,
        },
        rawContext: rawContext(strategyContext, proposal, this.legacyGate),
      });
    });
  }
}

/**
 * Lifts the score-based filter so the research versions record the setups the gate used to discard.
 *
 * The gate is a hard filter in the source strategies — `if (confidence < minimumConfidence) return null`
 * — so a below-threshold setup produced *no proposal at all*, and control points carry no feature
 * vector. The rejected population was therefore recorded nowhere, which made "does the hand-scored
 * threshold have edge?" unanswerable: the threshold decided what got observed.
 *
 * Setting the research floor to zero changes what is *captured*, not what is *scored*. The confidence
 * and its components are still computed and now travel with every row (`nativeConfidence`,
 * `passesLegacyConfidenceGate`), so the gated population remains exactly reconstructible by filtering,
 * and the ungated population becomes measurable for the first time. Strictly more information.
 *
 * Trigger conditions are untouched: an EMA cross, an RSI band and a candlestick pattern still define
 * what a setup *is*. Removing those too would not be an ungated strategy, it would be no strategy —
 * and the every-bar baseline already exists in the matched control grid.
 */
const momentumDefinition = buildStrategyDefinition({
  // v5 rather than v4: the configuration changed materially, and reusing a version string for two
  // different definitions is the exact failure the settlement policy registry exists to prevent.
  // The definition hash changes regardless, so old captures never collide with new ones.
  strategyKey: "momentum-v5-research",
  researchVersion: 5,
  featureSchemaVersion: "scalp-raw-context-v2",
  implementationArtifactChecksum: researchStrategySourceChecksums["momentum-scalp-strategy.ts"],
  configuration: { ...defaultMomentumScalpStrategyConfiguration, minimumConfidence: 0 } as Record<string, unknown>,
});

const indexDefinition = buildStrategyDefinition({
  strategyKey: "index-v3-research",
  researchVersion: 3,
  featureSchemaVersion: "scalp-raw-context-v2",
  implementationArtifactChecksum: researchStrategySourceChecksums["momentum-scalp-index-strategy.ts"],
  configuration: { ...defaultMomentumScalpIndexStrategyConfiguration, minimumConfidence: 0 } as Record<string, unknown>,
});

const patternDefinition = buildStrategyDefinition({
  strategyKey: "pattern-v4-research",
  researchVersion: 4,
  featureSchemaVersion: "scalp-raw-context-v2",
  implementationArtifactChecksum: researchStrategySourceChecksums["momentum-scalp-pattern-strategy.ts"],
  // The pattern strategy gates on the raw confluence score, not on `minimumConfidence` — which it does
  // not even define. Setting the wrong key here would have added a dead parameter and left the 5-of-9
  // confluence gate fully active, quietly defeating the ungating.
  configuration: { ...defaultMomentumScalpPatternStrategyConfiguration, scoreThreshold: 0 } as Record<string, unknown>,
});

/** Separate registry. Operational `strategy-registry.ts` never imports this module. */
export const researchScalpStrategies: readonly ResearchStrategyAdapter[] = [
  new FrozenResearchAdapter(
    momentumDefinition, ["1m"], new MomentumScalpStrategy(), "MOMENTUM_CONTINUATION",
    confidenceGate(defaultMomentumScalpStrategyConfiguration.minimumConfidence),
  ),
  new FrozenResearchAdapter(
    indexDefinition, ["5m"], new MomentumScalpIndexStrategy(), "INDEX_MOMENTUM",
    confidenceGate(defaultMomentumScalpIndexStrategyConfiguration.minimumConfidence),
  ),
  new FrozenResearchAdapter(
    patternDefinition, ["1m", "3m", "5m"], new MomentumScalpPatternStrategyV2(), "PATTERN_TRIGGER",
    // Thresholds read from the historical defaults, so the reconstruction filter tracks the real
    // legacy value rather than a copy that can drift away from it.
    confluenceScoreGate(defaultMomentumScalpPatternStrategyConfiguration.scoreThreshold),
  ),
];

function canonicalAtrAvailable(context: StrategyMarketContext): boolean {
  return context.indicators.some((item) => (
    item.code === "ATR"
    && item.algorithmVersion === "ta-v1"
    && item.parameters.period === 14
    && item.parameters.smoothing === "WILDER"
    && typeof item.values.value === "number"
    && Number.isFinite(item.values.value)
    && item.values.value > 0
  ));
}

/** Every eligible 1m grid point creates both LONG and SHORT outcome-blind controls. */
export function buildControlPoints(context: StrategyMarketContext, sessionCloseAt: Date): ResearchControlPoint[] {
  if (context.candle.timeframe !== "1m") throw new Error("GRID_POLICY_V1 controls require a 1m context.");
  const decisionAt = context.candle.closeTime;
  assertOnGridDecision(decisionAt);
  const dataThrough = new Date(decisionAt.getTime() - 1);
  const available = canonicalAtrAvailable(context);
  const frozenControlPolicyVersion = `${controlPolicyVersion}:${gridPolicyVersion}`;
  return (["LONG", "SHORT"] as const).map((evaluationDirection) => {
    const controlPointKey = logicalKey("control-point", [
      context.candle.instrumentId,
      istSessionId(decisionAt),
      evaluationDirection,
      decisionAt,
      frozenControlPolicyVersion,
    ]);
    const payload = {
      controlPointKey,
      instrumentId: context.candle.instrumentId,
      sourceCandleId: context.candle.id,
      sessionId: istSessionId(decisionAt),
      sessionCloseAt,
      evaluationDirection,
      decisionAt,
      dataThrough,
      referencePrice: context.candle.close,
      minuteOfDay: istMinuteOfDay(decisionAt),
      volatilityRegime: context.regime?.regime ?? null,
      sampleEligible: available,
      ineligibleReason: available ? null : "FEATURE_WARMUP",
      controlPolicyVersion: frozenControlPolicyVersion,
    };
    return { ...payload, payloadHash: sha256Canonical(payload) };
  });
}
