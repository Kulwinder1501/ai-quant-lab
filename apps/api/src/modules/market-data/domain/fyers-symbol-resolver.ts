/**
 * Maps canonical lab symbols to Fyers v3's `EXCHANGE:SYMBOL-SEGMENT` convention,
 * mirroring `yahoo-symbol-resolver.ts`.
 *
 * Indices carry the `-INDEX` segment and their own Fyers spellings — Bank Nifty is
 * `NIFTYBANK`, not `BANKNIFTY`. Everything else is assumed to be an NSE cash equity
 * and takes `-EQ`. A symbol that already contains a colon is treated as a fully
 * qualified Fyers symbol and passed through untouched, which is the escape hatch for
 * futures and options whose contract names this resolver deliberately does not model.
 */
const indexSymbols: Record<string, string> = {
  NIFTY50: "NSE:NIFTY50-INDEX",
  BANKNIFTY: "NSE:NIFTYBANK-INDEX",
  INDIAVIX: "NSE:INDIAVIX-INDEX",
  FINNIFTY: "NSE:FINNIFTY-INDEX",
  MIDCPNIFTY: "NSE:MIDCPNIFTY-INDEX",
  NIFTYNXT50: "NSE:NIFTYNXT50-INDEX",
  SENSEX: "BSE:SENSEX-INDEX",
};

export function resolveFyersSymbol(symbol: string): string {
  const trimmed = symbol.trim();
  if (!trimmed) {
    throw new Error("Cannot resolve an empty symbol to a Fyers symbol.");
  }
  if (trimmed.includes(":")) {
    return trimmed.toUpperCase();
  }
  const upper = trimmed.toUpperCase();
  return indexSymbols[upper] ?? `NSE:${upper}-EQ`;
}
