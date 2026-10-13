import { istInstant, istMinuteOfDay, istSessionDate } from "../../platform/calendar/trading-session.js";
import { followThrough } from "../../paper-trading/domain/gold-follow-through.js";
import { measureExcursions } from "../../paper-trading/domain/excursions.js";
import type { CompletedPriceCandle } from "../../paper-trading/domain/paper-trade-exit-policy.js";
import type { TradeSide } from "./strategy.js";

/**
 * Follows a shadow signal's bracket on 1m bars to a target, a stop, or the 15:15 IST square-off.
 *
 * What it measures: the UNDERLYING's path, in R. No option premium, no fees, no slippage, and the
 * entry is the signal bar's close, which is earlier than the live bots fill (they fill about one bar
 * later, at the live quote). Both simplifications flatter the signal, so a result near zero here is
 * not a result worth acting on, and a positive one is an upper bound on what a bot would book.
 *
 * Reuses `followThrough`, so the exit rules are the live engine's: a gap fills at the open, a bar that
 * spans both levels is a stop, and nothing resolves from an incomplete bar. A position that has not
 * reached either level by 15:15 is closed at that bar's close, which is when the live bots flatten.
 */
export const ictShadowResolverVersion = "ict-shadow-follow-v1";

const MINUTE_MS = 60_000;
/** 15:15 IST as a minute of the day: the live entry cutoff and square-off. */
export const SQUARE_OFF_MINUTE = 15 * 60 + 15;
const OPEN_MINUTE = 9 * 60 + 15;
/** A signal whose bars are still missing this long after the session is given up on. */
const GAP_GIVE_UP_MS = 2 * 24 * 60 * MINUTE_MS;

export type ShadowResolution =
  | {
    readonly status: "RESOLVED";
    readonly outcome: "TARGET" | "STOP" | "SESSION_END";
    readonly rMultiple: number;
    readonly maeR: number | null;
    readonly mfeR: number | null;
    readonly minutesToResolution: number;
    readonly resolvedAt: Date;
  }
  | { readonly status: "OPEN" }
  | { readonly status: "DEFERRED_GAP" }
  | { readonly status: "UNMEASURABLE"; readonly reason: string };

export interface ShadowResolutionInput {
  readonly side: TradeSide;
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly targetPrice: number;
  /** When the signal bar closed: the first 1m bar that counts opens at this instant. */
  readonly barCloseTime: Date;
  /** 1m bars for the instrument, chronological; bars outside the window are ignored. */
  readonly bars: readonly CompletedPriceCandle[];
  readonly now: Date;
}

function isInSession(minute: Date): boolean {
  const minuteOfDay = istMinuteOfDay(minute);
  return minuteOfDay >= OPEN_MINUTE && minuteOfDay < SQUARE_OFF_MINUTE;
}

export function resolveShadowSignal(input: ShadowResolutionInput): ShadowResolution {
  const sessionDate = istSessionDate(new Date(input.barCloseTime.getTime() - 1));
  const squareOff = istInstant(sessionDate, SQUARE_OFF_MINUTE);
  if (input.barCloseTime.getTime() >= squareOff.getTime()) {
    return { status: "UNMEASURABLE", reason: "SIGNAL_AT_OR_AFTER_SQUARE_OFF" };
  }

  const forward = input.bars.filter((bar) =>
    bar.openTime.getTime() >= input.barCloseTime.getTime() && bar.openTime.getTime() < squareOff.getTime());

  const result = followThrough({
    side: input.side,
    entryPrice: input.entryPrice,
    stopLoss: input.stopLoss,
    targetPrice: input.targetPrice,
    forwardCandles: forward,
    firstExpectedOpen: input.barCloseTime,
    isSessionActive: isInSession,
  });

  if (result.status === "RESOLVED") {
    const s = result.settlement;
    return {
      status: "RESOLVED",
      outcome: s.outcome as "TARGET" | "STOP",
      rMultiple: s.rMultiple as number,
      maeR: s.maeR ?? null,
      mfeR: s.mfeR ?? null,
      minutesToResolution: s.barsToResolution as number,
      resolvedAt: s.horizonEnd as Date,
    };
  }

  const sessionOver = input.now.getTime() >= squareOff.getTime() + MINUTE_MS;
  const lastBar = forward[forward.length - 1];
  const reachedSquareOff = lastBar !== undefined && lastBar.openTime.getTime() >= squareOff.getTime() - MINUTE_MS;

  if (result.status === "OPEN" && sessionOver && reachedSquareOff) {
    const risk = Math.abs(input.entryPrice - input.stopLoss);
    const exit = lastBar!.close;
    const signed = input.side === "LONG" ? exit - input.entryPrice : input.entryPrice - exit;
    const excursions = measureExcursions({ side: input.side, entryPrice: input.entryPrice, riskPerUnit: risk, candles: forward });
    return {
      status: "RESOLVED",
      outcome: "SESSION_END",
      rMultiple: signed / risk,
      maeR: excursions.status === "MEASURED" ? excursions.excursions.maximumAdverseR : null,
      mfeR: excursions.status === "MEASURED" ? excursions.excursions.maximumFavourableR : null,
      minutesToResolution: forward.length,
      resolvedAt: lastBar!.closeTime,
    };
  }

  if (result.status === "DEFERRED_GAP" || (result.status === "OPEN" && sessionOver)) {
    // Either a hole inside the session, or the session is over and the last bars never arrived.
    if (input.now.getTime() >= squareOff.getTime() + GAP_GIVE_UP_MS) {
      return { status: "UNMEASURABLE", reason: "BARS_MISSING_AFTER_GRACE" };
    }
    return { status: "DEFERRED_GAP" };
  }

  return { status: "OPEN" };
}
