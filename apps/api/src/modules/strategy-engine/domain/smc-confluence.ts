import { SMC_ALGORITHM_VERSION } from "../../technical-analysis/domain/technical-indicator.js";
import type { ProposedTradeIdea, StrategyMarketContext, TradeSide } from "./strategy.js";

type SmcDirection = "BULLISH" | "BEARISH";

export interface SmcSignalEvidence {
  code: "FVG" | "BOS" | "CHOCH" | "LIQUIDITY_SWEEP" | "ORDER_BLOCK";
  type: string;
  direction: SmcDirection;
  weight: number;
  values: Record<string, number | string | boolean | null>;
}

export interface SmcSideVerdict {
  /** Integer confidence points for the autonomous scorer; divide by 100 for idea confidence. */
  adjustment: number;
  reasoning: string | null;
}

export interface SmcConfluence {
  long: SmcSideVerdict;
  short: SmcSideVerdict;
  signals: SmcSignalEvidence[];
}

const SIGNAL_WEIGHTS: Record<SmcSignalEvidence["code"], number> = {
  FVG: 3,
  BOS: 5,
  CHOCH: 6,
  LIQUIDITY_SWEEP: 5,
  ORDER_BLOCK: 3,
};

const MAX_ABSOLUTE_ADJUSTMENT = 10;

function directionFromType(type: string): SmcDirection | null {
  if (type.startsWith("BULLISH")) return "BULLISH";
  if (type.startsWith("BEARISH")) return "BEARISH";
  return null;
}

function clampAdjustment(value: number): number {
  return Math.max(-MAX_ABSOLUTE_ADJUSTMENT, Math.min(MAX_ABSOLUTE_ADJUSTMENT, value));
}

function verdict(side: TradeSide, adjustment: number, signals: readonly SmcSignalEvidence[]): SmcSideVerdict {
  if (signals.length === 0) return { adjustment: 0, reasoning: null };
  const labels = signals.map((signal) => `${signal.code} ${signal.direction.toLowerCase()}`).join(", ");
  return {
    adjustment,
    reasoning: `Point-in-time SMC (${SMC_ALGORITHM_VERSION}) adjusts ${side} by ${adjustment >= 0 ? "+" : ""}${adjustment}: ${labels}.`,
  };
}

/**
 * Measures only SMC observations published on this completed candle.
 *
 * Zones are deliberately not carried forward here. FVG and order-block invalidation/retest
 * state is not modelled yet, so treating an old creation event as an active zone would invent
 * evidence. EQUILIBRIUM_ZONE is useful chart context but is not a directional event.
 */
export function measureSmcConfluence(context: StrategyMarketContext): SmcConfluence {
  const signals: SmcSignalEvidence[] = [];
  for (const indicator of context.indicators) {
    if (indicator.algorithmVersion !== SMC_ALGORITHM_VERSION) continue;
    if (!(indicator.code in SIGNAL_WEIGHTS)) continue;
    const code = indicator.code as SmcSignalEvidence["code"];
    const type = typeof indicator.values.type === "string" ? indicator.values.type : "";
    const direction = directionFromType(type);
    if (!direction) continue;
    signals.push({
      code,
      type,
      direction,
      weight: SIGNAL_WEIGHTS[code],
      values: indicator.values,
    });
  }

  const rawLong = signals.reduce(
    (total, signal) => total + (signal.direction === "BULLISH" ? signal.weight : -signal.weight),
    0,
  );
  const longAdjustment = clampAdjustment(rawLong);
  const shortAdjustment = clampAdjustment(-rawLong);
  return {
    long: verdict("LONG", longAdjustment, signals),
    short: verdict("SHORT", shortAdjustment, signals),
    signals,
  };
}

/** Adds SMC as bounded soft evidence; it cannot create a proposal whose base rules failed. */
export function applySmcConfluenceToProposal(
  context: StrategyMarketContext,
  proposal: ProposedTradeIdea,
): ProposedTradeIdea {
  const confluence = measureSmcConfluence(context);
  if (confluence.signals.length === 0) return proposal;

  const sideVerdict = proposal.side === "LONG" ? confluence.long : confluence.short;
  const confidenceContribution = sideVerdict.adjustment / 100;
  const confidence = Math.max(0, Math.min(1, proposal.confidence + confidenceContribution));
  return {
    ...proposal,
    confidence,
    reasoning: sideVerdict.reasoning
      ? [...proposal.reasoning, sideVerdict.reasoning]
      : proposal.reasoning,
    evidence: {
      ...proposal.evidence,
      smc: {
        algorithmVersion: SMC_ALGORITHM_VERSION,
        adjustment: sideVerdict.adjustment,
        baseConfidence: proposal.confidence,
        resultingConfidence: confidence,
        signals: confluence.signals,
      },
    },
    evidenceItems: [
      ...proposal.evidenceItems,
      {
        sourceType: "INDICATOR",
        sourceReference: `SMC:${SMC_ALGORITHM_VERSION}`,
        label: sideVerdict.reasoning ?? "Point-in-time SMC produced no directional adjustment.",
        contribution: confidenceContribution,
        details: {
          side: proposal.side,
          adjustment: sideVerdict.adjustment,
          baseConfidence: proposal.confidence,
          resultingConfidence: confidence,
          signals: confluence.signals,
        },
      },
    ],
  };
}
