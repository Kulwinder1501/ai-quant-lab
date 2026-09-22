import type { ProtectiveStopPolicy } from "../../paper-trading/domain/protective-stop.js";
import type { TradeSide } from "../../strategy-engine/domain/strategy.js";

/**
 * Backtest-only measurement of the live premium-space break-even/trail policy
 * (`paper-trading/domain/protective-stop.ts`), re-derived for underlying-index price bars instead
 * of option premium ticks.
 *
 * The live mechanism is LONG-only, premium space (a bearish view bought as a PE is still LONG
 * premium). This version is side-aware and works in underlying-index points directly, because the
 * question this answers -- "does trailing help `momentum-scalp`, at all" -- is a strategy-level
 * question about the same directional R-multiple dynamic, and this project's existing backtest
 * cohort (real 1m candles, real per-order costs, both instruments) already answers exactly that
 * question for every other lever tested this month. Building a second, options-tick-accurate
 * backtest harness to re-ask it would be new, untested surface for a question this already answers.
 *
 * Same schema-safe convention as the live fix: a break-even or trailed stop that would reach or
 * cross entry floors/ceilings at one tick short of it, never onto or past it.
 */
export function advanceUnderlyingProtectiveStop(input: {
  readonly side: TradeSide;
  readonly entryPrice: number;
  readonly initialStopLoss: number;
  readonly currentStopLoss: number;
  readonly peakFavorable: number;
  readonly policy: ProtectiveStopPolicy;
  readonly tickSize: number;
}): number | null {
  const { side, entryPrice, initialStopLoss, currentStopLoss, peakFavorable, policy, tickSize } = input;

  const risk = side === "LONG" ? entryPrice - initialStopLoss : initialStopLoss - entryPrice;
  if (!(risk > 0) || !Number.isFinite(peakFavorable)) return null;

  const progressR = side === "LONG"
    ? (peakFavorable - entryPrice) / risk
    : (entryPrice - peakFavorable) / risk;

  let candidate: number | null = null;
  if (policy.trail !== null && progressR >= policy.trail.triggerR) {
    candidate = side === "LONG"
      ? peakFavorable - policy.trail.distanceR * risk
      : peakFavorable + policy.trail.distanceR * risk;
  } else if (policy.breakEvenTriggerR !== null && progressR >= policy.breakEvenTriggerR) {
    candidate = side === "LONG" ? entryPrice - tickSize : entryPrice + tickSize;
  }
  if (candidate === null) return null;

  /*
   * The entry-price clamp applies to break-even always, and to a trail only when it is not asked to
   * lock profit. Leaving it on unconditionally is what made every trailing arm this project measured
   * a restatement of break-even -- see migration 117. `lockProfit` is omitted by every existing
   * config, so those arms are unchanged.
   */
  const locksProfit = policy.trail !== null && policy.trail.lockProfit === true && progressR >= policy.trail.triggerR;
  if (!locksProfit) {
    candidate = side === "LONG"
      ? Math.min(candidate, entryPrice - tickSize)
      : Math.max(candidate, entryPrice + tickSize);
  }

  // Monotonic: never widen the stop already in force.
  if (side === "LONG" ? candidate <= currentStopLoss : candidate >= currentStopLoss) return null;

  return candidate;
}
