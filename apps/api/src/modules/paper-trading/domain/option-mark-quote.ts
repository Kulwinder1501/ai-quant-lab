import type { ObservedOptionQuote } from "./paper-trade-live-valuation.js";

/**
 * The best quote available to mark (or sell) an open option position.
 *
 * The buy is filled at the live ask and refuses anything older than 10 seconds (2 minutes for a stored tick). The mark
 * used to accept a stored chain snapshot up to 40 minutes old, so a call bought at the live ask of Rs 575 was marked at
 * Rs 556.63 -- the mid of a snapshot taken nine minutes *before* the fill -- and opened Rs 551 under water. The same
 * stale quote's bid was also what a manual close sold at. A mark is held to the same freshness as the fill.
 *
 * Order: the live stream's book (what the screen shows), the stored tick, then the chain snapshot -- each only if it
 * is fresh. If none is fresh, the newest two-sided quote on record is returned anyway, carrying the index level it
 * was taken at: the valuation keeps it as the mark only while the index is still there (after the close, overnight),
 * and otherwise calibrates its model to the volatility that quote implied. Without this the screen fell to the model
 * at India VIX the moment trading stopped, and showed Rs 2,890 of loss on a position that was down Rs 250.
 */
export const MAXIMUM_MARK_QUOTE_AGE_MS = 2 * 60 * 1000;
export const MAXIMUM_MARK_STREAM_AGE_MS = 10 * 1000;
/** How far back the newest recorded quote is still worth handing to the valuation: past a night and a morning. */
export const MAXIMUM_ANCHORED_QUOTE_AGE_MS = 20 * 60 * 60 * 1000;

/** A quote stamped slightly ahead of this process's clock is skew; further ahead is not trusted. */
const MAXIMUM_QUOTE_FUTURE_SKEW_MS = 5 * 1000;

export interface MarkQuoteCandidate {
  bid: number | null;
  ask: number | null;
  observedAt: Date;
  impliedForward?: number | null;
  /** The index level in the same observation, when the source carries one. */
  underlyingValue?: number | null;
}

function usable(quote: MarkQuoteCandidate | null | undefined, now: Date, maxAgeMs: number): quote is MarkQuoteCandidate & { bid: number; ask: number } {
  if (!quote) return false;
  const { bid, ask } = quote;
  // Two-sided only: a one-sided book has no mid anyone was prepared to deal at.
  if (bid === null || ask === null || !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) return false;
  const ageMs = now.getTime() - quote.observedAt.getTime();
  return ageMs >= -MAXIMUM_QUOTE_FUTURE_SKEW_MS && ageMs <= maxAgeMs;
}

function toObserved(quote: MarkQuoteCandidate & { bid: number; ask: number }): ObservedOptionQuote {
  const underlying = quote.underlyingValue;
  return {
    mid: (quote.bid + quote.ask) / 2,
    bid: quote.bid,
    ask: quote.ask,
    observedAt: quote.observedAt,
    impliedForward: quote.impliedForward ?? null,
    underlyingValue: typeof underlying === "number" && Number.isFinite(underlying) && underlying > 0 ? underlying : null,
  };
}

export function chooseMarkQuote(input: {
  stream?: MarkQuoteCandidate | null;
  tick?: MarkQuoteCandidate | null;
  chain?: MarkQuoteCandidate | null;
  now: Date;
  maxAgeMs?: number;
  streamMaxAgeMs?: number;
  anchoredMaxAgeMs?: number;
}): ObservedOptionQuote | null {
  const maxAgeMs = input.maxAgeMs ?? MAXIMUM_MARK_QUOTE_AGE_MS;
  const streamMaxAgeMs = input.streamMaxAgeMs ?? MAXIMUM_MARK_STREAM_AGE_MS;
  const anchoredMaxAgeMs = input.anchoredMaxAgeMs ?? MAXIMUM_ANCHORED_QUOTE_AGE_MS;

  const fresh: Array<[MarkQuoteCandidate | null | undefined, number]> = [
    [input.stream, streamMaxAgeMs],
    [input.tick, maxAgeMs],
    [input.chain, maxAgeMs],
  ];
  for (const [quote, limit] of fresh) {
    if (usable(quote, input.now, limit)) return toObserved(quote);
  }

  // Nothing is fresh: hand over the newest recorded two-sided quote, for the valuation to judge against the index.
  let newest: (MarkQuoteCandidate & { bid: number; ask: number }) | null = null;
  for (const quote of [input.tick, input.chain]) {
    if (!usable(quote, input.now, anchoredMaxAgeMs)) continue;
    if (newest === null || quote.observedAt.getTime() > newest.observedAt.getTime()) newest = quote;
  }
  return newest === null ? null : toObserved(newest);
}
