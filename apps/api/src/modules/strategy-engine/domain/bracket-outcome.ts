import { decidePaperTradeExit, type CompletedPriceCandle } from "../../paper-trading/domain/paper-trade-exit-policy.js";
import type { PaperTrade } from "../../paper-trading/domain/paper-trading.js";
import type { TradeSide } from "./strategy.js";

/**
 * Resolves an ATR bracket forward over completed candles: did the target or the stop come first?
 *
 * Built on `decidePaperTradeExit` rather than beside it. That function already owns the three
 * rules that make this answer honest, and each of them changes the result:
 *
 * - A gap through a level fills at the **open**, not at the level.
 * - When one candle's range spans both the stop and the target, the ordering is unknowable from
 *   OHLC, so the **stop wins**. Reimplementing this optimistically is the single easiest way to
 *   manufacture an edge that does not exist.
 * - Nothing is resolved from an incomplete bar.
 *
 * A measurement that used its own looser version of those rules would report a better hit rate
 * than the paper-trading engine would actually book, which is worse than not measuring at all.
 */

export type BracketOutcome = "TARGET" | "STOP" | "UNRESOLVED";

export interface BracketResolution {
  outcome: BracketOutcome;
  /** Bars consumed before resolution. Null when unresolved within the horizon. */
  barsToResolution: number | null;
  /** Realised multiple of the risked distance: +reward:risk on a target, -1 on a stop. */
  rMultiple: number | null;
}

export interface BracketInput {
  side: TradeSide;
  entryPrice: number;
  stopLoss: number;
  targetPrice: number;
}

/**
 * Walks `forwardCandles` in chronological order until one resolves the bracket.
 *
 * `UNRESOLVED` is a real answer and is reported rather than dropped: a bracket that never
 * resolves inside the horizon is neither a win nor a loss, and folding it into either one is how
 * a hit rate gets quietly inflated. The caller decides what to do with them; the honest default
 * is to exclude them from the rate and report how many there were.
 */
export function resolveBracket(
  input: BracketInput,
  forwardCandles: readonly CompletedPriceCandle[],
): BracketResolution {
  const risk = Math.abs(input.entryPrice - input.stopLoss);
  const reward = Math.abs(input.targetPrice - input.entryPrice);
  if (!Number.isFinite(risk) || risk <= 0) {
    throw new Error("Bracket risk distance must be positive.");
  }
  if (!Number.isFinite(reward) || reward <= 0) {
    throw new Error("Bracket reward distance must be positive.");
  }

  // A synthetic open trade, purely to reuse the exit policy. Only the four fields it reads are
  // populated; the cast is contained here rather than in every caller.
  const trade = {
    status: "OPEN",
    side: input.side,
    stopLoss: input.stopLoss,
    targetPrice: input.targetPrice,
  } as unknown as PaperTrade;

  for (let index = 0; index < forwardCandles.length; index += 1) {
    const decision = decidePaperTradeExit(trade, forwardCandles[index]!);
    if (decision === null) continue;

    const bars = index + 1;
    if (decision.reason === "TARGET") {
      // Measured from the actual fill, so a favourable gap is credited at what it paid rather
      // than at the level that was asked for.
      const realised = input.side === "LONG"
        ? decision.exitPrice - input.entryPrice
        : input.entryPrice - decision.exitPrice;
      return { outcome: "TARGET", barsToResolution: bars, rMultiple: realised / risk };
    }
    // STOP_LOSS or TRAP_DETECTED. Both end the trade adversely; a gapped stop can exceed -1R,
    // which is exactly the tail a fixed -1 assumption hides.
    const realised = input.side === "LONG"
      ? decision.exitPrice - input.entryPrice
      : input.entryPrice - decision.exitPrice;
    return { outcome: "STOP", barsToResolution: bars, rMultiple: realised / risk };
  }

  return { outcome: "UNRESOLVED", barsToResolution: null, rMultiple: null };
}

/**
 * The target-hit rate a bracket must beat to break even, ignoring costs.
 *
 * At 2:1 this is 1/3. Stated as a function because it is the benchmark every hit rate in the
 * measurement is compared against, and hardcoding 0.333 next to a configurable reward multiple
 * is how the two drift apart.
 */
export function breakEvenHitRate(rewardRiskMultiple: number): number {
  if (!Number.isFinite(rewardRiskMultiple) || rewardRiskMultiple <= 0) {
    throw new Error("Reward-to-risk multiple must be positive.");
  }
  return 1 / (1 + rewardRiskMultiple);
}
