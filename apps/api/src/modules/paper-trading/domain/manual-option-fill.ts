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
