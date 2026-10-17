/**
 * Symbol and exchange validator for Equity Research.
 *
 * Hard rule (Section 2 & Section 5):
 * Symbols are strictly validated against ^[A-Z0-9&-]{1,20}$ before being used in any URL.
 * Free-form text, punctuation, SQL injection attempts, lowercase characters, and symbols
 * over 20 characters are rejected before any network call.
 */

export type EquityExchange = "NSE" | "BSE";

const SYMBOL_REGEX = /^[A-Z0-9&-]{1,20}$/;

export interface ValidatedEquityIdentity {
  symbol: string;
  exchange: EquityExchange;
  yahooSymbol: string;
}

export function isValidSymbol(symbol: string): boolean {
  if (typeof symbol !== "string") return false;
  return SYMBOL_REGEX.test(symbol);
}

export function isValidExchange(exchange: string): exchange is EquityExchange {
  return exchange === "NSE" || exchange === "BSE";
}

export function validateEquityIdentity(symbol: string, exchange: string): ValidatedEquityIdentity {
  if (!isValidSymbol(symbol)) {
    throw new Error(
      `Invalid symbol '${symbol}'. Equity symbols must be uppercase alphanumeric (with optional & or -) up to 20 characters.`,
    );
  }

  if (!isValidExchange(exchange)) {
    throw new Error(`Invalid exchange '${exchange}'. Supported exchanges are 'NSE' and 'BSE'.`);
  }

  const suffix = exchange === "NSE" ? ".NS" : ".BO";
  const yahooSymbol = `${symbol}${suffix}`;

  return {
    symbol,
    exchange,
    yahooSymbol,
  };
}
