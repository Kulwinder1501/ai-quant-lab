/**
 * Maps canonical lab symbols to OANDA tickers.
 *
 * OANDA natively uses an underscore format (e.g., `XAU_USD`), which perfectly matches
 * this lab's canonical symbol format. This resolver exists primarily to track which 
 * symbols OANDA supports so the router knows when to route to OANDA.
 */
const oandaSymbols: Record<string, string> = {
  XAU_USD: "XAU_USD",
  EUR_USD: "EUR_USD",
  USD_JPY: "USD_JPY",
  GBP_USD: "GBP_USD",
  USD_CAD: "USD_CAD",
  USD_SEK: "USD_SEK",
  USD_CHF: "USD_CHF",
};

export function resolveOandaSymbol(symbol: string): string {
  const trimmed = symbol.trim();
  if (!trimmed) {
    throw new Error("Cannot resolve an empty symbol to an OANDA symbol.");
  }
  const upper = trimmed.toUpperCase();
  const mapped = oandaSymbols[upper];
  if (mapped !== undefined) return mapped;
  // If not mapped, pass through to let OANDA's API reject it if invalid
  if (upper.includes("_")) return upper;
  throw new Error(`No OANDA symbol mapping for "${symbol}". Add one to oandaSymbols.`);
}

/** The canonical symbols this resolver knows by name, for a quote router to decide "does
 * OANDA own this symbol" without duplicating the map. */
export const OANDA_MAPPED_SYMBOLS = Object.keys(oandaSymbols);
