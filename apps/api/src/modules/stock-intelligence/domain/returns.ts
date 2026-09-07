import type { CorporateActionRecord, CorporateActionType } from "./canonical.js";
import { STOCK_INTELLIGENCE_CORPORATE_ACTION_ADJUSTMENT_VERSION } from "./versions.js";

export const outcomeTypes = ["COMPLETE", "DELISTED", "ACQUIRED", "HALTED_GAP_FILL"] as const;
export type OutcomeType = (typeof outcomeTypes)[number];

export const priceSeriesBases = ["as_traded", "split_adjusted"] as const;
export type PriceSeriesBasis = (typeof priceSeriesBases)[number];

export interface PriceObservation {
  readonly asOf: Date;
  readonly close: number;
}

export interface UnresolvableCorporateAction {
  readonly actionType: CorporateActionType;
  readonly exDate: string;
  readonly reason: string;
}

export interface AppliedPriceAdjustment {
  readonly actionType: CorporateActionType;
  readonly exDate: string;
  readonly factor: number;
}

export interface AppliedDividend {
  readonly exDate: string;
  readonly amountPerShare: number;
}

export interface AdjustmentMethodology {
  readonly version: typeof STOCK_INTELLIGENCE_CORPORATE_ACTION_ADJUSTMENT_VERSION;
  readonly priceSeriesBasis: PriceSeriesBasis;
  readonly entryPriceUnchanged: true;
  readonly terminalAdjustmentFactor: number;
  readonly priceAdjustmentsApplied: readonly AppliedPriceAdjustment[];
  readonly dividendsIncludedInTotalReturn: readonly AppliedDividend[];
  readonly unresolvable: readonly UnresolvableCorporateAction[];
  readonly splitsIgnoredBecauseSeriesIsSplitAdjusted: boolean;
}

export interface HorizonReturnInput {
  readonly predictionAsOf: Date;
  readonly horizonEnd: Date;
  readonly evaluationCutoff: Date;
  readonly entryPrice: number;
  readonly pricePath: readonly PriceObservation[];
  readonly actions: readonly CorporateActionRecord[];
  readonly priceSeriesBasis: PriceSeriesBasis;
  readonly outcomeType?: OutcomeType;
}

export interface HorizonReturnResult {
  readonly outcomeType: OutcomeType;
  readonly entryPrice: number;
  readonly terminalPriceAsTraded: number;
  readonly terminalPriceComparable: number;
  readonly forwardPriceReturn: number;
  readonly forwardTotalReturn: number;
  readonly maxDrawdown: number;
  readonly lastValidPriceAt: string;
  readonly gapFilled: boolean;
  readonly methodology: AdjustmentMethodology;
}

export function utcDateKey(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("utcDateKey requires a valid Date.");
  }
  return value.toISOString().slice(0, 10);
}

export function actionExDateKey(action: CorporateActionRecord): string {
  return action.exDate.slice(0, 10);
}

/**
 * Actions that affect the forward comparison: strictly after the prediction calendar
 * day, on or before the horizon day, and knowable by the evaluation cutoff.
 *
 * Prediction inputs still use `available_at <= data_cutoff`. Outcome measurement uses
 * `evaluationCutoff` (typically the horizon date or later), otherwise every in-horizon
 * split would be invisible because Yahoo only gives the ex-date.
 */
export function actionsInForwardWindow(
  actions: readonly CorporateActionRecord[],
  predictionAsOf: Date,
  horizonEnd: Date,
  evaluationCutoff: Date,
): CorporateActionRecord[] {
  const from = utcDateKey(predictionAsOf);
  const to = utcDateKey(horizonEnd);
  return actions.filter((action) => {
    if (action.availableAt.getTime() > evaluationCutoff.getTime()) return false;
    const ex = actionExDateKey(action);
    return ex > from && ex <= to;
  });
}
