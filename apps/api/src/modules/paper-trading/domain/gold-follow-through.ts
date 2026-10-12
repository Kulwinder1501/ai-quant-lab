import { resolveBracket } from "../../strategy-engine/domain/bracket-outcome.js";
import type { TradeSide } from "../../strategy-engine/domain/strategy.js";
import type { CompletedPriceCandle } from "./paper-trade-exit-policy.js";
import type { CandidateSettlement } from "./candidate-settlement.js";
import { measureExcursions } from "./excursions.js";

/**
 * Follows a shadow idea's bracket to its target or stop, with no time window.
 *
 * `settleCandidate` stops watching at the idea's own `expires_at` (about ten minutes for a gold scalp,
 * judged on three 5m bars), so a bracket that simply needs longer than that is recorded as UNRESOLVED even
 * though a live position would still be open. On 2026-10-12 six of eight such "expired" gold ideas went on
 * to hit a level within the next 11-87 minutes. A paper position is held until its target or stop; the
 * shadow ledger should measure the same thing.
 *
 * Three honest answers, and only the first is ever written:
 *
 *  - RESOLVED -- a completed 1m bar touched the target or the stop. Settled by `resolveBracket`, the same
 *    rules the live exit uses (a gap fills at the open; a bar spanning both levels is a stop; nothing
 *    resolves from an incomplete bar).
 *  - OPEN -- every bar since the signal is present and none touched a level. Still running; try again
 *    when more bars exist.
 *  - DEFERRED_GAP -- bars are missing from inside the trading session (the machine was asleep) before any
 *    level was touched. The touch may be in the hole, and so may its order against the other level, so no
 *    verdict is given until the hole is healed. A level touched on bars BEFORE the first hole is final:
 *    the stop cannot be un-hit by what is missing afterwards.
 */
export const goldFollowThroughResolverVersion = "gold-follow-through-v1";

const MINUTE_MS = 60_000;

export type FollowThroughResult =
  | { readonly status: "RESOLVED"; readonly settlement: CandidateSettlement }
  | { readonly status: "OPEN"; readonly barsObserved: number }
  | { readonly status: "DEFERRED_GAP"; readonly gapFrom: Date; readonly barsObserved: number };

export interface FollowThroughInput {
  readonly side: TradeSide;
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly targetPrice: number;
  /** Completed 1m bars after the signal bar, chronological. */
  readonly forwardCandles: readonly CompletedPriceCandle[];
  /** First minute that has to exist: the minute after the signal bar closed. */
  readonly firstExpectedOpen: Date;
  /** Whether the market was trading that minute, so a weekend or the daily break is not a hole. */
  readonly isSessionActive: (minute: Date) => boolean;
}

/** The leading bars with no in-session minute missing before them, and the first missing minute if any. */
function contiguousPrefix(input: FollowThroughInput): { bars: CompletedPriceCandle[]; gapFrom: Date | null } {
  const bars: CompletedPriceCandle[] = [];
  let expected = input.firstExpectedOpen.getTime();
  for (const candle of input.forwardCandles) {
    for (let minute = expected; minute < candle.openTime.getTime(); minute += MINUTE_MS) {
      if (input.isSessionActive(new Date(minute))) return { bars, gapFrom: new Date(minute) };
    }
    bars.push(candle);
    expected = candle.openTime.getTime() + MINUTE_MS;
  }
  return { bars, gapFrom: null };
}

export function followThrough(input: FollowThroughInput): FollowThroughResult {
  const { bars, gapFrom } = contiguousPrefix(input);
  const bracket = { side: input.side, entryPrice: input.entryPrice, stopLoss: input.stopLoss, targetPrice: input.targetPrice };
  const resolution = bars.length === 0 ? null : resolveBracket(bracket, bars);

  if (resolution !== null && (resolution.outcome === "TARGET" || resolution.outcome === "STOP")) {
    const used = bars.slice(0, resolution.barsToResolution!);
    const excursions = measureExcursions({
      side: input.side,
      entryPrice: input.entryPrice,
      riskPerUnit: Math.abs(input.entryPrice - input.stopLoss),
      candles: used,
    });
    return {
      status: "RESOLVED",
      settlement: {
        outcome: resolution.outcome,
        rMultiple: resolution.rMultiple,
        barsToResolution: resolution.barsToResolution,
        maeR: excursions.status === "MEASURED" ? excursions.excursions.maximumAdverseR : null,
        mfeR: excursions.status === "MEASURED" ? excursions.excursions.maximumFavourableR : null,
        horizonEnd: used[used.length - 1]!.closeTime,
        resolvedTimeframe: "1m",
        barsAvailable: used.length,
        resolverVersion: goldFollowThroughResolverVersion,
      },
    };
  }

  return gapFrom === null
    ? { status: "OPEN", barsObserved: bars.length }
    : { status: "DEFERRED_GAP", gapFrom, barsObserved: bars.length };
}
