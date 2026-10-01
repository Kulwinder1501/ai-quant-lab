import type { StrategyMarketContext, TradeSide } from "../../strategy-engine/domain/strategy.js";
import { SMC_ALGORITHM_VERSION } from "../../technical-analysis/domain/technical-indicator.js";

/**
 * Backtest-only early-exit measurement: close an open position the bar an SMC `LIQUIDITY_SWEEP`
 * against its own side is detected, instead of riding it to the fixed stop.
 *
 * Prompted directly by a real live trade (AutoBot-Scalp1m, BANKNIFTY LONG, 2026-09-21 09:25 IST):
 * a `BULLISH_BOS` at 09:29 was immediately followed, one bar later, by a `BEARISH_SWEEP` at the same
 * level -- the SMC definition of a stop-hunt / bull trap -- and the trade rode the reversal down to
 * its stop eight minutes later for a loss that an earlier exit right at the sweep would have avoided
 * or shrunk. `momentum-scalp` does not currently read this signal while a position is open at all;
 * this is the first exit-side (as opposed to entry-side) measurement of an SMC signal in this
 * project, so it has no established prior the way the entry-side liquidity filters do.
 *
 * Deliberately narrow: same-bar detection only (no lookback buffer, unlike the entry-side lookback
 * strategies in `entry-filters.ts`), because an exit rule reacting to a stale sweep several bars old
 * is a different, weaker hypothesis than reacting to the sweep that is actually unfolding.
 */
export function detectOpposingLiquiditySweep(context: StrategyMarketContext, side: TradeSide): boolean {
  const opposingType = side === "LONG" ? "BEARISH_SWEEP" : "BULLISH_SWEEP";
  return context.indicators.some((indicator) => (
    indicator.algorithmVersion === SMC_ALGORITHM_VERSION
    && indicator.code === "LIQUIDITY_SWEEP"
    && indicator.values.type === opposingType
  ));
}
