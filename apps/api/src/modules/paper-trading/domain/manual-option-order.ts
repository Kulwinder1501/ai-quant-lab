import { chooseManualOptionFill, type ManualFillQuote } from "./manual-option-fill.js";

/**
 * Rules for a hand-placed option limit order.
 *
 * A buyer's limit sits below the market: it fills only when the ask falls to it. A limit at or above the
 * current ask would just be a market order, so it is refused and the buyer is pointed at Market instead of
 * silently getting a different order than the one they typed.
 *
 * The order is stored as a PENDING paper trade whose `entry_price` is the limit and whose `fee_breakdown.order`
 * carries the rest (see `PendingOrderMeta`). It fills, or expires, in the exit sweep -- the same loop that
 * enforces stops, so a working order is checked as often as an open position is.
 */

/** NSE cash and derivatives close at 15:30 IST. A working order never outlives the session it was placed in. */
const MARKET_CLOSE_IST_MINUTES = 15 * 60 + 30;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What is stored in `fee_breakdown.order` for a limit order. */
export interface PendingOrderMeta {
  type: "LIMIT";
  limitPrice: number;
  placedAt: string;
  /** The ask when the order was placed, so the screen can say how far the limit sat below the market. */
  placedAsk: number;
  validUntil: string;
}

/**
 * When a limit order lapses: `validForMinutes` after placement, but never later than the 15:30 IST close of the
 * day it was placed. Null means "until the close".
 */
export function resolveOrderValidUntil(placedAt: Date, validForMinutes: number | null): Date {
  const istMs = placedAt.getTime() + IST_OFFSET_MS;
  const istDayStartMs = Math.floor(istMs / DAY_MS) * DAY_MS;
  const closeMs = istDayStartMs + MARKET_CLOSE_IST_MINUTES * 60_000 - IST_OFFSET_MS;
  if (validForMinutes === null) return new Date(closeMs);
  return new Date(Math.min(placedAt.getTime() + validForMinutes * 60_000, closeMs));
}

/** The validity choices the screen offers, in minutes; null is "until the close". */
export const ALLOWED_ORDER_VALIDITY_MINUTES: ReadonlyArray<number | null> = [15, 30, 60, 120, null];

export function parseOrderValidity(value: unknown): { ok: true; minutes: number | null } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "EOD") return { ok: true, minutes: null };
  const minutes = Number(value);
  if (Number.isFinite(minutes) && ALLOWED_ORDER_VALIDITY_MINUTES.includes(minutes)) return { ok: true, minutes };
  return { ok: false, error: "validForMinutes must be 15, 30, 60, 120, or omitted for the rest of the day." };
}

/** A buy limit must be a positive price strictly below the ask it is placed against. */
export function checkLimitAgainstAsk(limitPrice: number, ask: number): string | null {
  if (!Number.isFinite(limitPrice) || limitPrice <= 0) return "A limit price above zero is required.";
  if (limitPrice >= ask) {
    return `The limit (${limitPrice}) is not below the current ask (${ask}), so it would fill straight away. Use a Market order, or enter a lower limit.`;
  }
  return null;
}

export type PendingOrderDecision =
  | { action: "FILL"; fillPrice: number; observedAt: Date; underlyingValue: number | null }
  | { action: "EXPIRE"; reason: "ORDER_EXPIRED" }
  | { action: "WAIT" };

/**
 * What a working limit order should do right now.
 *
 * Expiry is decided first: an order past its time does not get one last fill. A fill needs a fresh two-sided
 * quote for the exact contract whose ask has come down to the limit, and is booked at that ask -- never above
 * the limit, but below it when the market gapped through. No fresh quote means wait: a stale or modelled price
 * is not evidence that the limit was reached.
 */
export function decidePendingOrder(input: {
  limitPrice: number;
  validUntil: Date | null;
  quote: ManualFillQuote | null;
  now: Date;
}): PendingOrderDecision {
  if (input.validUntil !== null && input.now.getTime() >= input.validUntil.getTime()) {
    return { action: "EXPIRE", reason: "ORDER_EXPIRED" };
  }
  const fill = chooseManualOptionFill({ tick: input.quote, chainQuote: null, now: input.now });
  if (fill.ok && fill.fillPrice <= input.limitPrice) {
    return { action: "FILL", fillPrice: fill.fillPrice, observedAt: fill.observedAt, underlyingValue: fill.underlyingValue };
  }
  return { action: "WAIT" };
}

/** Reads `fee_breakdown.order` back off a trade; null for any trade that is not a stored limit order. */
export function readPendingOrderMeta(feeBreakdown: Record<string, unknown> | undefined | null): PendingOrderMeta | null {
  const order = feeBreakdown?.order;
  if (!order || typeof order !== "object") return null;
  const meta = order as Record<string, unknown>;
  if (meta.type !== "LIMIT" || typeof meta.limitPrice !== "number" || typeof meta.validUntil !== "string") return null;
  return {
    type: "LIMIT",
    limitPrice: meta.limitPrice,
    placedAt: typeof meta.placedAt === "string" ? meta.placedAt : "",
    placedAsk: typeof meta.placedAsk === "number" ? meta.placedAsk : 0,
    validUntil: meta.validUntil,
  };
}
