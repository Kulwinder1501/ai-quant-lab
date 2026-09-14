import type { CanonicalMarketBar } from "../domain/adapters.js";
import { calculateAdjustedHorizonReturn } from "./adjusted-return-calculator.js";
import { selectBarsAsOf } from "../domain/pit-audit.js";
import {
  horizonEndUtc,
  horizonHasCompleted,
  type RealizedAnalogueOutcome,
} from "../domain/outcome-model.js";
import type { AnalogueMember } from "../domain/analogue-search.js";
import type { CorporateActionRecord } from "../domain/canonical.js";
import type { StockIntelligenceHorizon } from "../domain/data-quality.js";
import type { OutcomeType, PriceSeriesBasis } from "../domain/returns.js";
import { utcDateKey } from "../domain/returns.js";

export const incompleteHorizonReasons = [
  "HORIZON_NOT_COMPLETE",
  "NO_ENTRY_PRICE",
  "NO_PRICE_PATH",
] as const;
export type IncompleteHorizonReason = (typeof incompleteHorizonReasons)[number];

export type MeasuredHorizon =
  | { readonly status: "REALIZED"; readonly outcome: Omit<RealizedAnalogueOutcome, "weight" | "similarity"> & { totalReturn: number; priceReturn: number } }
  | { readonly status: "DROPPED"; readonly reason: IncompleteHorizonReason };

function parseClose(bar: CanonicalMarketBar): number | null {
  const close = Number(bar.close);
  return Number.isFinite(close) && close > 0 ? close : null;
}

export function outcomeTypeFromActions(actions: readonly CorporateActionRecord[]): OutcomeType {
  if (actions.some((action) => action.actionType === "DELISTING")) return "DELISTED";
  if (actions.some((action) => action.actionType === "MERGER")) return "ACQUIRED";
  return "COMPLETE";
}

export function measureReturnToDate(input: {
  predictionAsOf: Date;
  endDate: Date;
  evaluationCutoff: Date;
  bars: readonly CanonicalMarketBar[];
  actions: readonly CorporateActionRecord[];
  priceSeriesBasis?: PriceSeriesBasis;
}): MeasuredHorizon {
  if (utcDateKey(input.endDate) > utcDateKey(input.evaluationCutoff)) {
    return { status: "DROPPED", reason: "HORIZON_NOT_COMPLETE" };
  }
  const known = selectBarsAsOf(input.bars, input.evaluationCutoff);
  const predictionDay = utcDateKey(input.predictionAsOf);
  const entryBar = [...known]
    .filter((bar) => utcDateKey(bar.availableAt) <= predictionDay || utcDateKey(bar.effectiveAt) <= predictionDay)
    .sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime())
    .at(-1);
  const entryPrice = entryBar ? parseClose(entryBar) : null;
  if (entryPrice === null) return { status: "DROPPED", reason: "NO_ENTRY_PRICE" };

  const pricePath = known
    .map((bar) => {
      const close = parseClose(bar);
      if (close === null) return null;
      return { asOf: bar.availableAt, close };
    })
    .filter((row): row is { asOf: Date; close: number } => row !== null);

  try {
    const result = calculateAdjustedHorizonReturn({
      predictionAsOf: input.predictionAsOf,
      horizonEnd: input.endDate,
      evaluationCutoff: input.evaluationCutoff,
      entryPrice,
      pricePath,
      actions: input.actions,
      priceSeriesBasis: input.priceSeriesBasis ?? "split_adjusted",
      outcomeType: outcomeTypeFromActions(input.actions),
    });
    return {
      status: "REALIZED",
      outcome: {
        instrumentId: entryBar!.instrumentId,
        asOf: predictionDay,
        totalReturn: result.forwardTotalReturn,
        priceReturn: result.forwardPriceReturn,
        maxDrawdown: result.maxDrawdown,
        outcomeType: result.outcomeType,
      },
    };
  } catch {
    return { status: "DROPPED", reason: "NO_PRICE_PATH" };
  }
}

export function measureRealizedHorizon(input: {
  predictionAsOf: Date;
  horizon: StockIntelligenceHorizon;
  evaluationCutoff: Date;
  bars: readonly CanonicalMarketBar[];
  actions: readonly CorporateActionRecord[];
  priceSeriesBasis?: PriceSeriesBasis;
}): MeasuredHorizon {
  if (!horizonHasCompleted(input.predictionAsOf, input.horizon, input.evaluationCutoff)) {
    return { status: "DROPPED", reason: "HORIZON_NOT_COMPLETE" };
  }
  return measureReturnToDate({
    ...input,
    endDate: horizonEndUtc(input.predictionAsOf, input.horizon),
  });
}

export function realizeAnalogueMembers(input: {
  members: readonly AnalogueMember[];
  horizon: StockIntelligenceHorizon;
  evaluationCutoff: Date;
  barsFor: (instrumentId: string) => readonly CanonicalMarketBar[];
  actionsFor: (instrumentId: string) => readonly CorporateActionRecord[];
}): { realized: RealizedAnalogueOutcome[]; nDroppedIncomplete: number } {
  const realized: RealizedAnalogueOutcome[] = [];
  let nDroppedIncomplete = 0;
  for (const member of input.members) {
    const measured = measureRealizedHorizon({
      predictionAsOf: new Date(`${member.asOf}T23:59:59.999Z`),
      horizon: input.horizon,
      evaluationCutoff: input.evaluationCutoff,
      bars: input.barsFor(member.instrumentId),
      actions: input.actionsFor(member.instrumentId),
    });
    if (measured.status === "DROPPED") {
      nDroppedIncomplete += 1;
      continue;
    }
    realized.push({
      ...measured.outcome,
      instrumentId: member.instrumentId,
      asOf: member.asOf,
      weight: member.weight,
      similarity: member.similarity,
    });
  }
  return { realized, nDroppedIncomplete };
}
