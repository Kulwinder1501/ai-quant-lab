import { parseActionEffects, factorThrough, productOfFactors } from "../domain/adjustment-engine.js";
import {
  actionsInForwardWindow,
  utcDateKey,
  type HorizonReturnInput,
  type HorizonReturnResult,
  type OutcomeType,
} from "../domain/returns.js";
import { STOCK_INTELLIGENCE_CORPORATE_ACTION_ADJUSTMENT_VERSION } from "../domain/versions.js";

function requirePositivePrice(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a finite positive price.`);
  }
  return value;
}

function maxDrawdown(adjustedCloses: readonly number[]): number {
  if (adjustedCloses.length === 0) return 0;
  let peak = adjustedCloses[0]!;
  let worst = 0;
  for (const price of adjustedCloses) {
    if (price > peak) peak = price;
    const drawdown = (price - peak) / peak;
    if (drawdown < worst) worst = drawdown;
  }
  return worst;
}

/**
 * Forward-only return. The recorded entry price is never rewritten. Splits, bonuses,
 * and rights in (prediction, horizon] restate the *terminal* print onto that entry basis.
 *
 * Yahoo `close` is already split-adjusted. Passing `priceSeriesBasis: "split_adjusted"`
 * skips price-divisor events so they cannot be double-counted; cash dividends are still
 * added to `forward_total_return` because Yahoo `close` does not include them.
 */
export function calculateAdjustedHorizonReturn(input: HorizonReturnInput): HorizonReturnResult {
  const entryPrice = requirePositivePrice(input.entryPrice, "entryPrice");
  const outcomeType: OutcomeType = input.outcomeType ?? "COMPLETE";
  const inWindow = actionsInForwardWindow(
    input.actions,
    input.predictionAsOf,
    input.horizonEnd,
    input.evaluationCutoff,
  );
  const applyPriceDivisors = input.priceSeriesBasis === "as_traded";
  const effects = parseActionEffects(inWindow, { applyPriceDivisors });
  const terminalFactor = productOfFactors(effects.priceAdjustments);

  const ordered = [...input.pricePath]
    .filter((point) => Number.isFinite(point.close) && point.close > 0)
    .sort((a, b) => a.asOf.getTime() - b.asOf.getTime());

  const inHorizon = ordered.filter((point) => {
    const key = utcDateKey(point.asOf);
    return key >= utcDateKey(input.predictionAsOf) && key <= utcDateKey(input.horizonEnd);
  });

  if (inHorizon.length === 0) {
    throw new Error("Price path has no valid close on or before the horizon date.");
  }

  const last = inHorizon[inHorizon.length - 1]!;
  const gapFilled = utcDateKey(last.asOf) < utcDateKey(input.horizonEnd) || outcomeType === "HALTED_GAP_FILL";
  const terminalAsTraded = last.close;
  const terminalComparable = terminalAsTraded * terminalFactor;
  const dividendCash = effects.dividends.reduce((sum, item) => sum + item.amountPerShare, 0);

  const adjustedPath = inHorizon.map((point) => point.close * (applyPriceDivisors
    ? factorThrough(effects.priceAdjustments, utcDateKey(point.asOf))
    : 1));

  return {
    outcomeType,
    entryPrice,
    terminalPriceAsTraded: terminalAsTraded,
    terminalPriceComparable: terminalComparable,
    forwardPriceReturn: terminalComparable / entryPrice - 1,
    forwardTotalReturn: (terminalComparable + dividendCash) / entryPrice - 1,
    maxDrawdown: maxDrawdown(adjustedPath),
    lastValidPriceAt: utcDateKey(last.asOf),
    gapFilled,
    methodology: {
      version: STOCK_INTELLIGENCE_CORPORATE_ACTION_ADJUSTMENT_VERSION,
      priceSeriesBasis: input.priceSeriesBasis,
      entryPriceUnchanged: true,
      terminalAdjustmentFactor: terminalFactor,
      priceAdjustmentsApplied: effects.priceAdjustments.map((item) => item.applied),
      dividendsIncludedInTotalReturn: effects.dividends.map((item) => item.applied),
      unresolvable: effects.unresolvable,
      splitsIgnoredBecauseSeriesIsSplitAdjusted: !applyPriceDivisors && inWindow.some((action) =>
        action.actionType === "SPLIT" || action.actionType === "BONUS" || action.actionType === "RIGHTS"
      ),
    },
  };
}
