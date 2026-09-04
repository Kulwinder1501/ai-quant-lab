import type { CorporateActionRecord } from "./canonical.js";
import type { AppliedDividend, AppliedPriceAdjustment, UnresolvableCorporateAction } from "./returns.js";

export interface ParsedPriceAdjustment {
  readonly factor: number;
  readonly applied: AppliedPriceAdjustment;
}

export interface ParsedDividend {
  readonly amountPerShare: number;
  readonly applied: AppliedDividend;
}

export interface ParsedActionEffects {
  readonly priceAdjustments: readonly ParsedPriceAdjustment[];
  readonly dividends: readonly ParsedDividend[];
  readonly unresolvable: readonly UnresolvableCorporateAction[];
}

function finitePositive(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Factor that restates a *later* as-traded print onto the prediction-date share basis.
 * Entry price is never divided. A 2-for-1 (or 1:1 bonus) contributes 2.
 */
export function priceAdjustmentFactor(action: CorporateActionRecord): number | UnresolvableCorporateAction {
  if (action.actionType === "DIVIDEND" || action.actionType === "BUYBACK" || action.actionType === "MERGER" || action.actionType === "DELISTING") {
    return {
      actionType: action.actionType,
      exDate: action.exDate,
      reason: `${action.actionType} is not a price-divisor event.`,
    };
  }

  const details = action.details;
  const numerator = finitePositive(details.numerator);
  const denominator = finitePositive(details.denominator);
  if (numerator !== null && denominator !== null) {
    return numerator / denominator;
  }

  const additional = finitePositive(details.additionalSharesPerHeld);
  if (additional !== null) {
    return 1 + additional;
  }

  if (action.actionType === "RIGHTS") {
    const held = finitePositive(details.held);
    const neu = finitePositive(details.new);
    const issuePrice = finitePositive(details.issuePrice);
    const cumPrice = finitePositive(details.cumPrice);
    if (held === null || neu === null || issuePrice === null || cumPrice === null) {
      return {
        actionType: action.actionType,
        exDate: action.exDate,
        reason: "Rights issue is missing held/new/issuePrice/cumPrice, so TERP cannot be computed.",
      };
    }
    const terp = (cumPrice * held + issuePrice * neu) / (held + neu);
    if (!(terp > 0)) {
      return {
        actionType: action.actionType,
        exDate: action.exDate,
        reason: "Rights TERP was not a positive number.",
      };
    }
    return cumPrice / terp;
  }

  return {
    actionType: action.actionType,
    exDate: action.exDate,
    reason: `${action.actionType} is missing a numerator/denominator (or bonus additionalSharesPerHeld).`,
  };
}

export function dividendAmount(action: CorporateActionRecord): number | UnresolvableCorporateAction {
  if (action.actionType !== "DIVIDEND") {
    return {
      actionType: action.actionType,
      exDate: action.exDate,
      reason: `${action.actionType} is not a cash dividend.`,
    };
  }
  const amount = finitePositive(action.details.amountPerShare) ?? finitePositive(action.details.amount);
  if (amount === null) {
    return {
      actionType: action.actionType,
      exDate: action.exDate,
      reason: "Dividend is missing amountPerShare.",
    };
  }
  return amount;
}

export function parseActionEffects(
  actions: readonly CorporateActionRecord[],
  options: { applyPriceDivisors: boolean },
): ParsedActionEffects {
  const priceAdjustments: ParsedPriceAdjustment[] = [];
  const dividends: ParsedDividend[] = [];
  const unresolvable: UnresolvableCorporateAction[] = [];

  for (const action of actions) {
    if (action.actionType === "DIVIDEND") {
      const parsed = dividendAmount(action);
      if (typeof parsed === "number") {
        dividends.push({ amountPerShare: parsed, applied: { exDate: action.exDate, amountPerShare: parsed } });
      } else {
        unresolvable.push(parsed);
      }
      continue;
    }

    if (action.actionType === "BUYBACK") {
      continue;
    }

    if (action.actionType === "MERGER" || action.actionType === "DELISTING") {
      continue;
    }

    if (!options.applyPriceDivisors) continue;

    const parsed = priceAdjustmentFactor(action);
    if (typeof parsed === "number") {
      priceAdjustments.push({
        factor: parsed,
        applied: { actionType: action.actionType, exDate: action.exDate, factor: parsed },
      });
    } else {
      unresolvable.push(parsed);
    }
  }

  return { priceAdjustments, dividends, unresolvable };
}

export function productOfFactors(adjustments: readonly ParsedPriceAdjustment[]): number {
  return adjustments.reduce((product, item) => product * item.factor, 1);
}

/** Remaining factor for a path point: splits whose ex-date is on or before this session, already in the forward window. */
export function factorThrough(adjustments: readonly ParsedPriceAdjustment[], asOfDateKey: string): number {
  return adjustments
    .filter((item) => item.applied.exDate.slice(0, 10) <= asOfDateKey)
    .reduce((product, item) => product * item.factor, 1);
}
