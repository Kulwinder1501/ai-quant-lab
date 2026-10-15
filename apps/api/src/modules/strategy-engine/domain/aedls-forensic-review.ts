import type { TradeSide } from "./strategy.js";

export type ObservedTradeEvent =
  | "IMMEDIATE_ADVERSE_EXCURSION"
  | "FAVORABLE_STALL_REVERSAL"
  | "UNDERLYING_OPTION_PNL_DIVERGENCE"
  | "EXCESSIVE_SPREAD_SLIPPAGE";

export type TerminalTradeOutcome =
  | "STOP_LOSS"
  | "TARGET"
  | "TIMEOUT"
  | "MANUAL_EXIT"
  | "OTHER";

export type EventEvidenceStatus =
  | "TICK_VERIFIED"
  | "BAR_DERIVED_UNAMBIGUOUS"
  | "INTRABAR_AMBIGUOUS"
  | "INSUFFICIENT_DATA";

export type OutcomeValidity =
  | "VALID_RECONCILED"
  | "COSTS_UNRECONCILED"
  | "INSUFFICIENT_FILL_DATA";

export type ExcursionValidity =
  | "COMPLETE"
  | "INSUFFICIENT_DATA"
  | "CONFLICTING_DATA";

export interface ObservedEventEvidence {
  readonly event: ObservedTradeEvent;
  readonly evidenceStatus: EventEvidenceStatus;
  readonly eventWindowStart: string;
  readonly eventWindowEnd: string;
  readonly evidenceReferences: string[];
}

export interface EventTargetAssessment {
  readonly targetEvent: ObservedTradeEvent;
  readonly label: "POSITIVE" | "NEGATIVE" | "UNOBSERVABLE";
  readonly evidenceStatus: EventEvidenceStatus;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly evidenceReferences: string[];
}

export interface AedlsTradeForensicReview {
  readonly tradeId: string;
  readonly candidateId: string | null;

  // 1. Detected path events (multi-label) & Supervised Training Target Assessments
  readonly observedEvents: readonly ObservedEventEvidence[];
  readonly targetAssessments: readonly EventTargetAssessment[];
  readonly primaryObservedEvent: ObservedTradeEvent | null;

  // 2. Terminal exit classification & Independent Validity Flags
  readonly terminalOutcome: TerminalTradeOutcome;
  readonly outcomeValidity: OutcomeValidity;
  readonly excursionValidity: ExcursionValidity;

  // 3. Normalized risk and excursion metrics
  readonly plannedRiskRupees: number;
  readonly realizedGrossRupees: number | null;
  readonly realizedNetRupees: number | null;
  readonly realizedGrossR: number | null;
  readonly realizedNetR: number | null;

  // Excursions from actual fill (Nullable if excursionValidity != 'COMPLETE')
  readonly mae3BarsR: number | null;
  readonly mfe3BarsR: number | null;
  readonly maxFavourableExcursionR: number | null;
  readonly maxAdverseExcursionR: number | null;
  readonly underlyingExcursionPoints: number | null;

  // 4. Falsifiable causal hypotheses (EXPLICITLY NULLABLE)
  readonly causalHypothesis:
    | "OPPOSING_ORDER_FLOW"
    | "VOLATILITY_CRUSH_VEGA"
    | "LIQUIDITY_VACUUM_SLIP"
    | "COUNTER_DRIVER_TAPE"
    | "UNATTRIBUTED_MARKET_VARIANCE"
    | null;

  readonly attributionStatus: "SUPPORTED" | "REFUTED" | "UNKNOWN";

  // 5. Exact availability timestamps (Strict 4-Timestamp PIT Contract)
  readonly tradeClosedAt: string;
  readonly evidenceAvailableAt: string;
  readonly reviewAvailableAt: string;
  readonly embeddingAvailableAt: string | null;

  // 6. Embedding Provenance Metadata
  readonly reviewEmbeddingTemplateVersion: string;
  readonly embeddingModelId: string;
  readonly embeddingModelRevision: string;
  readonly embeddingConfigHash: string;
  readonly embeddingDim: 384;

  // 7. Versioning & Provenance
  readonly taxonomyVersion: string;
  readonly reviewerVersion: string;
  readonly proposedResearchTags: readonly string[];
}

export interface CandleExtreme {
  readonly openTime: Date;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export interface SynchronizedTickOrBar {
  readonly timestamp: Date;
  readonly underlyingSpotPrice: number;
  readonly optionBidPrice: number;
}

export const AEDLS_TAXONOMY_VERSION = "taxonomy-v2.7";
export const AEDLS_REVIEWER_VERSION = "reviewer-v2.7";
export const AEDLS_EMBEDDING_TEMPLATE_VERSION = "review-template-v2.7";
export const AEDLS_PINNED_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const AEDLS_PINNED_MODEL_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
export const AEDLS_EMBEDDING_CONFIG_HASH = "59aeffb3e8b9d72e1c1f97f92c68ace8208bbde2d803d9e9c8e4b30493233ff3";

export function rounded(value: number, decimals = 6): number {
  return Number(value.toFixed(decimals));
}

/**
 * Calculates initial planned risk in rupees: |entry - stop| * quantity * multiplier
 */
export function calculatePlannedRiskRupees(input: {
  entryPrice: number;
  stopLoss: number;
  quantityUnits: number;
  contractMultiplier?: number;
}): number {
  if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0) {
    throw new Error("Entry price must be a positive finite number.");
  }
  if (!Number.isFinite(input.stopLoss) || input.stopLoss <= 0) {
    throw new Error("Stop loss must be a positive finite number.");
  }
  if (!Number.isFinite(input.quantityUnits) || input.quantityUnits <= 0) {
    throw new Error("Quantity units must be a positive finite number.");
  }
  const mult = input.contractMultiplier ?? 1;
  if (!Number.isFinite(mult) || mult <= 0) {
    throw new Error("Contract multiplier must be a positive finite number.");
  }
  const unitRisk = Math.abs(input.entryPrice - input.stopLoss);
  if (unitRisk === 0) {
    throw new Error("Entry price and stop loss cannot be identical (zero risk).");
  }
  return rounded(unitRisk * input.quantityUnits * mult);
}

/**
 * Calculates normalized R multiple from rupees: realizedRupees / plannedRiskRupees
 */
export function calculateRealizedR(realizedRupees: number, plannedRiskRupees: number): number {
  if (!Number.isFinite(plannedRiskRupees) || plannedRiskRupees <= 0) {
    throw new Error("Planned risk rupees must be a positive finite number.");
  }
  if (!Number.isFinite(realizedRupees)) {
    throw new Error("Realized rupees must be a finite number.");
  }
  return rounded(realizedRupees / plannedRiskRupees);
}

/**
 * Evaluates MAE and MFE over the first 3 completed 1-minute bars post-entry,
 * detecting intrabar ambiguity if both thresholds are touched within a single bar.
 */
export function evaluate3BarExcursion(input: {
  side: TradeSide;
  entryFillPrice: number;
  riskPerUnit: number;
  postEntry1mCandles: readonly CandleExtreme[];
}): {
  mae3BarsR: number | null;
  mfe3BarsR: number | null;
  intrabarAmbiguityDetected: boolean;
} {
  if (input.postEntry1mCandles.length < 3) {
    return {
      mae3BarsR: null,
      mfe3BarsR: null,
      intrabarAmbiguityDetected: false,
    };
  }

  const threeBars = input.postEntry1mCandles.slice(0, 3);
  let worstAdverseDistance = 0;
  let bestFavourableDistance = 0;
  let intrabarAmbiguityDetected = false;

  for (const bar of threeBars) {
    const barAdverse = input.side === "LONG"
      ? Math.max(0, input.entryFillPrice - bar.low)
      : Math.max(0, bar.high - input.entryFillPrice);

    const barFavourable = input.side === "LONG"
      ? Math.max(0, bar.high - input.entryFillPrice)
      : Math.max(0, input.entryFillPrice - bar.low);

    const barAdverseR = barAdverse / input.riskPerUnit;
    const barFavourableR = barFavourable / input.riskPerUnit;

    // P0.3 Invariant: If a single bar touches both MAE >= 1.0R and MFE >= 0.2R
    // without proven sub-bar tick ordering, intrabar ambiguity is flagged.
    if (barAdverseR >= 1.0 && barFavourableR >= 0.2) {
      intrabarAmbiguityDetected = true;
    }

    if (barAdverse > worstAdverseDistance) {
      worstAdverseDistance = barAdverse;
    }
    if (barFavourable > bestFavourableDistance) {
      bestFavourableDistance = barFavourable;
    }
  }

  return {
    mae3BarsR: rounded(worstAdverseDistance / input.riskPerUnit),
    mfe3BarsR: rounded(bestFavourableDistance / input.riskPerUnit),
    intrabarAmbiguityDetected,
  };
}

/**
 * Evaluates target assessment for IMMEDIATE_ADVERSE_EXCURSION:
 * Target condition: MAE_3 >= 1.0R AND MFE_3 < 0.2R over first 3 completed 1m bars post-entry.
 * Enforces strict POSITIVE, NEGATIVE, or UNOBSERVABLE classification.
 */
export function assessImmediateAdverseExcursion(input: {
  side: TradeSide;
  entryFillPrice: number;
  riskPerUnit: number;
  postEntry1mCandles: readonly CandleExtreme[];
  entryTime: Date;
  tickSequenceVerified?: boolean;
}): EventTargetAssessment {
  const windowStart = input.entryTime.toISOString();
  const windowEnd = input.postEntry1mCandles.length >= 3
    ? new Date(input.postEntry1mCandles[2].openTime.getTime() + 60000).toISOString()
    : windowStart;

  if (input.postEntry1mCandles.length < 3) {
    return {
      targetEvent: "IMMEDIATE_ADVERSE_EXCURSION",
      label: "UNOBSERVABLE",
      evidenceStatus: "INSUFFICIENT_DATA",
      windowStart,
      windowEnd,
      evidenceReferences: ["candles_under_3_bars"],
    };
  }

  const { mae3BarsR, mfe3BarsR, intrabarAmbiguityDetected } = evaluate3BarExcursion({
    side: input.side,
    entryFillPrice: input.entryFillPrice,
    riskPerUnit: input.riskPerUnit,
    postEntry1mCandles: input.postEntry1mCandles,
  });

  if (mae3BarsR === null || mfe3BarsR === null) {
    return {
      targetEvent: "IMMEDIATE_ADVERSE_EXCURSION",
      label: "UNOBSERVABLE",
      evidenceStatus: "INSUFFICIENT_DATA",
      windowStart,
      windowEnd,
      evidenceReferences: ["excursion_unmeasurable"],
    };
  }

  // If both adverse stop and favorable threshold were touched intrabar and tick order is unproven:
  if (intrabarAmbiguityDetected && !input.tickSequenceVerified) {
    return {
      targetEvent: "IMMEDIATE_ADVERSE_EXCURSION",
      label: "UNOBSERVABLE",
      evidenceStatus: "INTRABAR_AMBIGUOUS",
      windowStart,
      windowEnd,
      evidenceReferences: ["intrabar_threshold_collision"],
    };
  }

  const evidenceStatus: EventEvidenceStatus = input.tickSequenceVerified
    ? "TICK_VERIFIED"
    : "BAR_DERIVED_UNAMBIGUOUS";

  if (mae3BarsR >= 1.0 && mfe3BarsR < 0.2) {
    return {
      targetEvent: "IMMEDIATE_ADVERSE_EXCURSION",
      label: "POSITIVE",
      evidenceStatus,
      windowStart,
      windowEnd,
      evidenceReferences: [`mae3=${mae3BarsR}`, `mfe3=${mfe3BarsR}`],
    };
  }

  return {
    targetEvent: "IMMEDIATE_ADVERSE_EXCURSION",
    label: "NEGATIVE",
    evidenceStatus,
    windowStart,
    windowEnd,
    evidenceReferences: [`mae3=${mae3BarsR}`, `mfe3=${mfe3BarsR}`],
  };
}

/**
 * Evaluates UNDERLYING_OPTION_PNL_DIVERGENCE:
 * Scope: Exclusively for option buyer trades (CALL or PUT).
 * Rule: Underlying moved >= 0.05% in favor, and at that SAME observation timestamp within 15 min,
 * option bid liquidation price is <= entry fill price.
 */
export function assessUnderlyingOptionPnlDivergence(input: {
  isOptionBuyerTrade: boolean;
  optionType: "CE" | "PE";
  entryFillPrice: number;
  entrySpotPrice: number;
  entryTime: Date;
  synchronizedObservations: readonly SynchronizedTickOrBar[];
}): EventTargetAssessment {
  const windowStart = input.entryTime.toISOString();
  const windowEnd = new Date(input.entryTime.getTime() + 15 * 60000).toISOString();

  if (!input.isOptionBuyerTrade) {
    return {
      targetEvent: "UNDERLYING_OPTION_PNL_DIVERGENCE",
      label: "UNOBSERVABLE",
      evidenceStatus: "INSUFFICIENT_DATA",
      windowStart,
      windowEnd,
      evidenceReferences: ["not_option_buyer_trade"],
    };
  }

  if (input.synchronizedObservations.length === 0) {
    return {
      targetEvent: "UNDERLYING_OPTION_PNL_DIVERGENCE",
      label: "UNOBSERVABLE",
      evidenceStatus: "INSUFFICIENT_DATA",
      windowStart,
      windowEnd,
      evidenceReferences: ["no_synchronized_observations"],
    };
  }

  for (const obs of input.synchronizedObservations) {
    // Check 15-minute window
    if (obs.timestamp.getTime() - input.entryTime.getTime() > 15 * 60000) {
      continue;
    }

    const spotReturn = (obs.underlyingSpotPrice - input.entrySpotPrice) / input.entrySpotPrice;
    const directionalFavorable = input.optionType === "CE"
      ? spotReturn >= 0.0005 // >= +0.05% for call
      : spotReturn <= -0.0005; // <= -0.05% for put

    const optionPnlNonPositive = obs.optionBidPrice <= input.entryFillPrice;

    // Both conditions must hold at the SAME observation timestamp
    if (directionalFavorable && optionPnlNonPositive) {
      return {
        targetEvent: "UNDERLYING_OPTION_PNL_DIVERGENCE",
        label: "POSITIVE",
        evidenceStatus: "BAR_DERIVED_UNAMBIGUOUS",
        windowStart,
        windowEnd,
        evidenceReferences: [
          `divergence_at=${obs.timestamp.toISOString()}`,
          `spotReturn=${rounded(spotReturn * 100, 4)}%`,
          `bidPrice=${obs.optionBidPrice}`,
          `entryFill=${input.entryFillPrice}`,
        ],
      };
    }
  }

  return {
    targetEvent: "UNDERLYING_OPTION_PNL_DIVERGENCE",
    label: "NEGATIVE",
    evidenceStatus: "BAR_DERIVED_UNAMBIGUOUS",
    windowStart,
    windowEnd,
    evidenceReferences: ["no_divergence_observed_in_15m"],
  };
}

/**
 * Evaluates EXCESSIVE_SPREAD_SLIPPAGE:
 * frictionRupees / plannedRiskRupees > 0.5R
 */
export function assessExcessiveSpreadSlippage(input: {
  frictionRupees: number;
  plannedRiskRupees: number;
  entryTime: Date;
}): EventTargetAssessment {
  const windowStart = input.entryTime.toISOString();
  const windowEnd = input.entryTime.toISOString();

  if (!Number.isFinite(input.frictionRupees) || !Number.isFinite(input.plannedRiskRupees) || input.plannedRiskRupees <= 0) {
    return {
      targetEvent: "EXCESSIVE_SPREAD_SLIPPAGE",
      label: "UNOBSERVABLE",
      evidenceStatus: "INSUFFICIENT_DATA",
      windowStart,
      windowEnd,
      evidenceReferences: ["invalid_friction_or_risk"],
    };
  }

  const frictionR = input.frictionRupees / input.plannedRiskRupees;
  if (frictionR > 0.5) {
    return {
      targetEvent: "EXCESSIVE_SPREAD_SLIPPAGE",
      label: "POSITIVE",
      evidenceStatus: "BAR_DERIVED_UNAMBIGUOUS",
      windowStart,
      windowEnd,
      evidenceReferences: [`frictionR=${rounded(frictionR)}`, `frictionRupees=${input.frictionRupees}`],
    };
  }

  return {
    targetEvent: "EXCESSIVE_SPREAD_SLIPPAGE",
    label: "NEGATIVE",
    evidenceStatus: "BAR_DERIVED_UNAMBIGUOUS",
    windowStart,
    windowEnd,
    evidenceReferences: [`frictionR=${rounded(frictionR)}`],
  };
}

/**
 * Deterministic selection of primaryObservedEvent by registered priority:
 * 1. IMMEDIATE_ADVERSE_EXCURSION
 * 2. UNDERLYING_OPTION_PNL_DIVERGENCE
 * 3. FAVORABLE_STALL_REVERSAL
 * 4. EXCESSIVE_SPREAD_SLIPPAGE
 */
export function selectPrimaryObservedEvent(
  events: readonly ObservedEventEvidence[],
): ObservedTradeEvent | null {
  const priorityOrder: readonly ObservedTradeEvent[] = [
    "IMMEDIATE_ADVERSE_EXCURSION",
    "UNDERLYING_OPTION_PNL_DIVERGENCE",
    "FAVORABLE_STALL_REVERSAL",
    "EXCESSIVE_SPREAD_SLIPPAGE",
  ];

  for (const candidate of priorityOrder) {
    if (events.some((e) => e.event === candidate)) {
      return candidate;
    }
  }
  return null;
}
