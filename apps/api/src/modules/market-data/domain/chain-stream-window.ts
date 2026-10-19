/**
 * Which option contracts a live chain stream subscribes: the strikes nearest the money, both sides.
 *
 * The API's Fyers socket holds only about 65 symbols for good (measured 2026-10-19: with a full 63-contract chain
 * subscribed, a second chain received only the last packet's three symbols, and unsubscribing did not give the slots
 * back). A full chain per page therefore left room for exactly one underlying. Thirteen strikes either side of the
 * money is 26 contracts plus the underlying, so NIFTY50 and BANKNIFTY fit together with headroom for the quote readers.
 *
 * Strikes outside the window are not lost: the chain page shows the stored snapshot for them, refreshed every
 * twelve minutes, and live ticks only for the window.
 */
export const DEFAULT_CHAIN_STREAM_STRIKES_EACH_SIDE = 6;
export const MAX_CHAIN_STREAM_STRIKES_EACH_SIDE = 15;

export interface ChainStreamQuote {
  strikePrice: number;
  providerSymbol: string | null | undefined;
}

/** The provider symbols of the `eachSide` strikes below and above `spot` (and the nearest strike itself). */
export function chainStreamSymbols(
  quotes: readonly ChainStreamQuote[],
  spot: number | null | undefined,
  eachSide: number | "all",
): string[] {
  const usable = quotes.filter((quote) => quote.providerSymbol);
  if (eachSide === "all" || spot === null || spot === undefined || !Number.isFinite(spot)) {
    return usable.map((quote) => quote.providerSymbol as string);
  }
  const strikes = [...new Set(usable.map((quote) => quote.strikePrice))].sort((a, b) => a - b);
  if (strikes.length === 0) return [];

  let nearest = 0;
  for (let index = 1; index < strikes.length; index += 1) {
    if (Math.abs(strikes[index]! - spot) < Math.abs(strikes[nearest]! - spot)) nearest = index;
  }
  const from = Math.max(0, nearest - eachSide);
  const to = Math.min(strikes.length - 1, nearest + eachSide);
  const wanted = new Set(strikes.slice(from, to + 1));
  return usable.filter((quote) => wanted.has(quote.strikePrice)).map((quote) => quote.providerSymbol as string);
}

/** `strikes` from the query string: a number of strikes each side, or "all". Anything else is the default. */
export function parseChainStreamStrikes(value: string | undefined): number | "all" {
  if (value === "all") return "all";
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_CHAIN_STREAM_STRIKES_EACH_SIDE;
  return Math.min(parsed, MAX_CHAIN_STREAM_STRIKES_EACH_SIDE);
}
