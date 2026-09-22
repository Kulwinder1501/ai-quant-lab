/**
 * Maps canonical lab symbols to Twelve Data tickers, mirroring `fyers-symbol-resolver.ts` and
 * `yahoo-symbol-resolver.ts`.
 *
 * Twelve Data's own notation uses a slash between the base and quote currency (`XAU/USD`), not
 * the underscore this lab's canonical symbol uses (`XAU_USD`) -- the underscore form was chosen
 * so the symbol survives unescaped through URL paths and `instruments.symbol` lookups the same
 * way `NIFTY50`/`BANKNIFTY` do, the same reasoning `fyers-symbol-resolver.ts` gives for keeping
 * canonical symbols plain and doing the provider-specific escaping only here.
 */
const twelveDataSymbols: Record<string, string> = {
  XAU_USD: "XAU/USD",
};

export function resolveTwelveDataSymbol(symbol: string): string {
  const trimmed = symbol.trim();
  if (!trimmed) {
    throw new Error("Cannot resolve an empty symbol to a Twelve Data symbol.");
  }
  const upper = trimmed.toUpperCase();
  const mapped = twelveDataSymbols[upper];
  if (mapped !== undefined) return mapped;
  // Already-qualified tickers (containing a slash) pass through, the same escape hatch
  // `resolveFyersSymbol`/`resolveYahooSymbol` give for a provider-native symbol the table
  // does not (yet) know by canonical name.
  if (upper.includes("/")) return upper;
  throw new Error(`No Twelve Data symbol mapping for "${symbol}". Add one to twelveDataSymbols.`);
}

/** The canonical symbols this resolver knows by name, for a quote router to decide "does
 * Twelve Data own this symbol" without duplicating the map. */
export const TWELVEDATA_MAPPED_SYMBOLS = Object.keys(twelveDataSymbols);
