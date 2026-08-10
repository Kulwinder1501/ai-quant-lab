/**
 * Maps canonical lab symbols to Yahoo Finance tickers, mirroring `fyers-symbol-resolver.ts`.
 *
 * Indices carry Yahoo's own spellings, and they are not guessable: Nifty 50 is `^NSEI`,
 * India VIX is `^INDIAVIX`, and Fin Nifty is `NIFTY_FIN_SERVICE.NS` -- not `^CNXFIN` and
 * emphatically not `FINNIFTY.NS`. Everything else is assumed to be an NSE cash equity and
 * takes `.NS`. A symbol that already contains a dot or a caret is treated as a fully
 * qualified Yahoo ticker and passed through, which is the escape hatch for the foreign
 * indices the market-watch panel quotes (`^GSPC`, `^N225`, `^HSI`).
 *
 * Why this table is the only copy: four HTTP routes each carried their own inline
 * three-branch version of it, and none of them handled `INDIAVIX` -- so `/live-price`
 * asked Yahoo for `INDIAVIX.NS` and 500'd on the instrument that is the regime source
 * (`regimeSourceInstrumentSymbol`). The market-watch stream carried a fifth copy that
 * mapped Fin Nifty to `FINNIFTY.NS`, which is not a ticker; the quote rejected, the tile
 * was dropped by a `.filter(Boolean)`, and the panel simply rendered one row short with
 * no error anywhere. A lookup table in one place cannot drift against itself.
 *
 * Only spellings this repository has already established are listed. `MIDCPNIFTY` and
 * `NIFTYNXT50` are deliberately absent: migration 051 registers them `is_active = FALSE`
 * for ML breadth and `fyers-symbol-resolver.ts` owns their collection, so no verified
 * Yahoo ticker for them exists here. Guessing one is the bug this file was written to
 * remove -- an unverified ticker fails exactly like a correct one that is briefly down.
 */
const indexSymbols: Record<string, string> = {
  NIFTY50: "^NSEI",
  BANKNIFTY: "^NSEBANK",
  INDIAVIX: "^INDIAVIX",
  SENSEX: "^BSESN",
  // Yahoo publishes Fin Nifty under a `.NS` name, not a caret. Sourced from
  // INDEX_DRIVER_UNIVERSES, which quotes it successfully for the drivers heatmap.
  FINNIFTY: "NIFTY_FIN_SERVICE.NS",
};

export function resolveYahooSymbol(symbol: string): string {
  const trimmed = symbol.trim();
  if (!trimmed) {
    throw new Error("Cannot resolve an empty symbol to a Yahoo symbol.");
  }
  const upper = trimmed.toUpperCase();
  const mapped = indexSymbols[upper];
  if (mapped !== undefined) return mapped;
  // Already-qualified tickers pass through: `^GSPC`, `RELIANCE.NS`, `GIFT=F`.
  if (upper.startsWith("^") || upper.includes(".") || upper.includes("=")) return upper;
  return `${upper}.NS`;
}

/** The canonical symbols this resolver knows by name, for callers that enumerate them. */
export const YAHOO_MAPPED_SYMBOLS = Object.keys(indexSymbols);
