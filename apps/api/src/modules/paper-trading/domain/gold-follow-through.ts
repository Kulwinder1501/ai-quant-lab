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

export interface BracketLevels {
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly targetPrice: number;
}

/**
 * The bracket the resolver actually judges: entered at `fillPrice`, with the idea's own risk and reward
 * DISTANCES kept from that fill. The idea's printed levels can sit minutes behind the market, so the
 * stop and target move with the fill rather than staying where the idea put them. One function for the
 * resolver and the ledger page, so the levels shown beside a verdict are the levels that produced it.
 */
export function reanchorBracket(
  idea: BracketLevels & { readonly side: TradeSide },
  fillPrice: number,
): BracketLevels {
  const risk = Math.abs(idea.entryPrice - idea.stopLoss);
  const reward = Math.abs(idea.targetPrice - idea.entryPrice);
  const long = idea.side === "LONG";
  return {
    entryPrice: fillPrice,
    stopLoss: long ? fillPrice - risk : fillPrice + risk,
    targetPrice: long ? fillPrice + reward : fillPrice - reward,
  };
}

export interface SettledLevels extends BracketLevels {
  /** REANCHORED: shifted to the fill. AS_SHOWN: the resolver used the idea's own printed levels. */
  readonly basis: "REANCHORED" | "AS_SHOWN";
}

/**
 * The levels a stored settlement was judged on, for display beside the idea's printed ones.
 * Only the follow-through resolver re-anchors; the older bracket resolver judged the printed levels.
 * Returns null when the settlement was re-anchored but the fill bar is no longer readable, because
 * guessing would put a level on screen that nothing was ever judged against.
 */
export function settledLevels(
  idea: BracketLevels & { readonly side: TradeSide },
  resolverVersion: string,
  fillPrice: number | null,
): SettledLevels | null {
  if (resolverVersion !== goldFollowThroughResolverVersion) {
    return { basis: "AS_SHOWN", entryPrice: idea.entryPrice, stopLoss: idea.stopLoss, targetPrice: idea.targetPrice };
  }
  if (fillPrice === null || !Number.isFinite(fillPrice)) return null;
  return { basis: "REANCHORED", ...reanchorBracket(idea, fillPrice) };
}

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
