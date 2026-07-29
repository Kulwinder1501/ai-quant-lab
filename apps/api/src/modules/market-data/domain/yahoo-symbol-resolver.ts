export function resolveYahooSymbol(symbol: string): string {
  let yfSymbol = symbol;
  if (yfSymbol === "NIFTY50") yfSymbol = "^NSEI";
  else if (yfSymbol === "BANKNIFTY") yfSymbol = "^NSEBANK";
  else if (yfSymbol === "INDIAVIX") yfSymbol = "^INDIAVIX";
  else if (!yfSymbol.includes(".")) yfSymbol = `${yfSymbol}.NS`;
  return yfSymbol;
}
