import type { ObservedOptionQuote } from "./paper-trade-live-valuation.js";

/**
 * Which quote may mark (or sell) an open option position.
 *
 * The buy is filled at the live ask and refuses anything older than 10 seconds (2 minutes for a stored tick). The mark
 * used to accept a stored chain snapshot up to 40 minutes old, so a call bought at the live ask of Rs 575 was marked at
 * Rs 556.63 -- the mid of a snapshot taken nine minutes *before* the fill -- and opened Rs 551 under water. The same
 * stale quote's bid was also what a manual close sold at. A mark is held to the same freshness as the fill.
 *
 * Order: the live stream's book (what the screen shows), the stored tick, then the chain snapshot -- each only if it
 * is fresh. None fresh -> null, and the valuation falls back to the model rather than a stale price.
 */
export const MAXIMUM_MARK_QUOTE_AGE_MS = 2 * 60 * 1000;
export const MAXIMUM_MARK_STREAM_AGE_MS = 10 * 1000;

/** A quote stamped slightly ahead of this process's clock is skew; further ahead is not trusted. */
const MAXIMUM_QUOTE_FUTURE_SKEW_MS = 5 * 1000;

export interface MarkQuoteCandidate {
  bid: number | null;
  ask: number | null;
  observedAt: Date;
  impliedForward?: number | null;
}

function fresh(quote: MarkQuoteCandidate | null | undefined, now: Date, maxAgeMs: number): quote is MarkQuoteCandidate & { bid: number; ask: number } {
  if (!quote) return false;
  const { bid, ask } = quote;
  // Two-sided only: a one-sided book has no mid anyone was prepared to deal at.
  if (bid === null || ask === null || !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) return false;
  const ageMs = now.getTime() - quote.observedAt.getTime();
  return ageMs >= -MAXIMUM_QUOTE_FUTURE_SKEW_MS && ageMs <= maxAgeMs;
}

export function chooseMarkQuote(input: {
  stream?: MarkQuoteCandidate | null;
  tick?: MarkQuoteCandidate | null;
  chain?: MarkQuoteCandidate | null;
  now: Date;
  maxAgeMs?: number;
  streamMaxAgeMs?: number;
}): ObservedOptionQuote | null {
  const maxAgeMs = input.maxAgeMs ?? MAXIMUM_MARK_QUOTE_AGE_MS;
  const streamMaxAgeMs = input.streamMaxAgeMs ?? MAXIMUM_MARK_STREAM_AGE_MS;
  const candidates: Array<[MarkQuoteCandidate | null | undefined, number]> = [
    [input.stream, streamMaxAgeMs],
    [input.tick, maxAgeMs],
    [input.chain, maxAgeMs],
  ];
  for (const [quote, limit] of candidates) {
    if (!fresh(quote, input.now, limit)) continue;
    return {
      mid: (quote.bid + quote.ask) / 2,
      bid: quote.bid,
      ask: quote.ask,
      observedAt: quote.observedAt,
      impliedForward: quote.impliedForward ?? null,
    };
  }
  return null;
}
