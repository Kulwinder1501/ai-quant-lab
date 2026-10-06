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
  // DXY itself is deliberately absent: Twelve Data does not carry the US Dollar Index under any
  // symbol (confirmed 2026-10-06 against their live /indices catalog -- 1,308 entries, zero
  // matches). `compute-synthetic-dxy.ts` reconstructs it from these 6 real component pairs via
  // the public ICE formula instead; resolving "DXY" here would just reintroduce the HTTP 404
  // every `XAU_CANDLE_COLLECTION` run used to hit.
  EUR_USD: "EUR/USD",
  USD_JPY: "USD/JPY",
  GBP_USD: "GBP/USD",
  USD_CAD: "USD/CAD",
  USD_SEK: "USD/SEK",
  USD_CHF: "USD/CHF",
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
