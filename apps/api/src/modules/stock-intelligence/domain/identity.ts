import type { Instrument } from "../../market-data/domain/instrument.js";

/**
 * Canonical identity is `instruments.id` (UUID). The plan's `IND_EQUITY_000123` spelling
 * is not introduced: every candle, trade, and prediction in this lab already keys off
 * the UUID, and a parallel identifier would silently fork the universe.
 *
 * User-facing symbols, names, Yahoo tickers, and ISINs are aliases. They never become
 * the primary key.
 */
export interface ResolvedInstrument {
  readonly instrumentId: string;
  readonly exchange: Instrument["exchange"];
  readonly symbol: string;
  readonly yahooSymbol: string;
  readonly companyName: string;
  readonly isin: string | null;
  readonly instrumentType: Instrument["instrumentType"];
}

export type InstrumentResolveStatus = "RESOLVED" | "NOT_FOUND" | "AMBIGUOUS";

export interface InstrumentResolveResult {
  readonly query: string;
  readonly status: InstrumentResolveStatus;
  readonly instrument: ResolvedInstrument | null;
  readonly candidates: readonly ResolvedInstrument[];
  readonly matchedBy: "id" | "isin" | "symbol" | "alias" | "yahoo_symbol" | null;
}

export class InstrumentResolveError extends Error {
  readonly result: InstrumentResolveResult;

  constructor(result: InstrumentResolveResult) {
    const detail = result.status === "AMBIGUOUS"
      ? `matched ${result.candidates.map((item) => item.symbol).join(", ")}`
      : "no instrument";
    super(`Cannot resolve "${result.query}" to a single instrument (${result.status}: ${detail}).`);
    this.name = "InstrumentResolveError";
    this.result = result;
  }
}

export function normalizeInstrumentQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

export function isInstrumentUuid(query: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.trim());
}

export function isIsin(query: string): boolean {
  return /^INE[A-Z0-9]{9}$/i.test(query.trim());
}

export function aliasKey(query: string): string {
  return normalizeInstrumentQuery(query).toLowerCase();
}
