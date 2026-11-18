/**
 * The price a hand-taken option buy is filled at.
 *
 * A buyer pays the ask, and the ask has to be one the market was actually showing when the order is booked. The
 * manual route used to take the latest *stored chain snapshot*, accepting one up to 40 minutes old. Snapshots
 * are written every ~30 minutes, so a buy was routinely filled at a price from before the last 150-point move:
 * a BANKNIFTY call shown at Rs 562 on the ticket was booked at Rs 643 and opened Rs 2,455 under water.
 *
 * Same rule the bots trade by: the live premium tick for the exact contract (written every few seconds), else a
 * chain quote only if it is just as fresh, else no fill. A refusal is the right answer when there is no fresh
 * quote -- a modelled or stale premium is not an executable price.
 */
export const MAXIMUM_MANUAL_QUOTE_AGE_MS = 2 * 60 * 1000;

/**
 * How old the live-stream quote may be. Much tighter than the stored-tick limit, because the stream is what the
 * screen is showing: if it has gone quiet for more than a few seconds there is no live price to honour, and the
 * buy falls back to the stored series (which is allowed to be older) or is refused.
 */
export const MAXIMUM_LIVE_STREAM_QUOTE_AGE_MS = 10 * 1000;

/** A quote stamped slightly ahead of this process's clock is clock skew; further ahead is not trusted. */
const MAXIMUM_QUOTE_FUTURE_SKEW_MS = 5 * 1000;

export interface ManualFillQuote {
  bid: number | null;
  ask: number | null;
  observedAt: Date;
  /** The underlying's level in the same observation, when the source carries one. */
  underlyingValue?: number | null;
}

export type ManualOptionFill =
  | {
    ok: true;
    fillPrice: number;
    observedAt: Date;
    source: "LIVE_STREAM_ASK" | "OPTION_PREMIUM_TICK_ASK" | "OPTION_CHAIN_QUOTE";
    /** The underlying at the fill instant, only when the winning quote carried it. */
    underlyingValue: number | null;
  }
  | { ok: false; error: string };

function usableQuote(quote: ManualFillQuote | null | undefined, now: Date, maxAgeMs: number): quote is ManualFillQuote & { ask: number; bid: number } {
  if (!quote) return false;
  const { bid, ask } = quote;
  // Two-sided: a one-sided market has no price anyone was prepared to deal at.
  if (bid === null || ask === null || !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) return false;
  const ageMs = now.getTime() - quote.observedAt.getTime();
  return ageMs >= -MAXIMUM_QUOTE_FUTURE_SKEW_MS && ageMs <= maxAgeMs;
}

export interface ManualUnderlyingEntry {
  price: number;
  /**
   * The provenance tag `underlying_fill_price_source` accepts for this price, or null when the price is real and live
   * but has no recognised tag (it is then stored as the entry anchor only, never as a labelled fill price).
   */
  fillSource: "OPTION_PREMIUM_TICK_ASK" | "OPTION_CHAIN_QUOTE" | null;
}

function validSpot(value: number | null | undefined): value is number {
  return value !== undefined && value !== null && Number.isFinite(value) && value > 0;
}

/**
 * Where the underlying was when a hand-taken option was bought.
 *
 * 2026-11-18: a BANKNIFTY put bought at 09:37 was recorded with an entry spot of 62,239.1 while the index was at
 * about 62,100. That number was the 09:23 chain snapshot's underlying, 14 minutes old. The route preferred the
 * stored snapshot over a live quote, and `latestSnapshot` has no freshness limit, so any buy whose fill quote did not
 * carry a spot took the snapshot's, which is up to a full collection interval old (across the account's 22 earlier
 * trades the entry spot was off by up to 175 points; exits use a live price and were fine). That stale number feeds
 * trap detection (`liveSpot - underlyingEntryPrice`) and every later analysis of where the trade was taken.
 *
 * Order, freshest first: the spot the winning fill quote carried; the live stream's last index price (the caller has
 * already age-limited it); a stored chain snapshot only if it is as fresh as a stored tick may be. Null when none
 * qualifies, and the caller then asks for a live quote; a stale snapshot is never used.
 */
export function resolveManualUnderlyingEntry(input: {
  fillUnderlying: number | null | undefined;
  liveSpot: number | null | undefined;
  snapshot: { underlyingValue: number | null; observedAt: Date } | null | undefined;
  now: Date;
  maxSnapshotAgeMs?: number;
}): ManualUnderlyingEntry | null {
  if (validSpot(input.fillUnderlying)) return { price: input.fillUnderlying, fillSource: "OPTION_PREMIUM_TICK_ASK" };
  if (validSpot(input.liveSpot)) return { price: input.liveSpot, fillSource: null };
  const snapshot = input.snapshot;
  if (snapshot && validSpot(snapshot.underlyingValue)) {
    const ageMs = input.now.getTime() - snapshot.observedAt.getTime();
    if (ageMs >= -MAXIMUM_QUOTE_FUTURE_SKEW_MS && ageMs <= (input.maxSnapshotAgeMs ?? MAXIMUM_MANUAL_QUOTE_AGE_MS)) {
      return { price: snapshot.underlyingValue, fillSource: "OPTION_CHAIN_QUOTE" };
    }
  }
  return null;
}

export function chooseManualOptionFill(input: {
  /** The live socket's latest book for the exact contract, when this process is streaming it. Preferred. */
  stream?: ManualFillQuote | null;
  tick: ManualFillQuote | null;
  chainQuote: ManualFillQuote | null;
  now: Date;
  maxAgeMs?: number;
  streamMaxAgeMs?: number;
}): ManualOptionFill {
  const maxAgeMs = input.maxAgeMs ?? MAXIMUM_MANUAL_QUOTE_AGE_MS;
  if (usableQuote(input.stream, input.now, input.streamMaxAgeMs ?? MAXIMUM_LIVE_STREAM_QUOTE_AGE_MS)) {
    const underlying = input.stream.underlyingValue;
    return {
      ok: true,
      fillPrice: input.stream.ask,
      observedAt: input.stream.observedAt,
      source: "LIVE_STREAM_ASK",
      underlyingValue: underlying !== undefined && underlying !== null && Number.isFinite(underlying) && underlying > 0 ? underlying : null,
    };
  }
  if (usableQuote(input.tick, input.now, maxAgeMs)) {
    const underlying = input.tick.underlyingValue;
    return {
      ok: true,
      fillPrice: input.tick.ask,
      observedAt: input.tick.observedAt,
      source: "OPTION_PREMIUM_TICK_ASK",
      underlyingValue: underlying !== undefined && underlying !== null && Number.isFinite(underlying) && underlying > 0 ? underlying : null,
    };
  }
  if (usableQuote(input.chainQuote, input.now, maxAgeMs)) {
    return {
      ok: true,
      fillPrice: input.chainQuote.ask,
      observedAt: input.chainQuote.observedAt,
      source: "OPTION_CHAIN_QUOTE",
      underlyingValue: null,
    };
  }
  return {
    ok: false,
    error: "No fresh two-sided quote for this exact contract, so it was not bought (a stored or modelled premium is not an "
      + "executable price). Keep the option chain or this picker open so the live stream is running, then try again in a "
      + "moment. Outside market hours there is no live quote at all.",
  };
}
