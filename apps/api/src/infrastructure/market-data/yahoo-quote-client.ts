import yahooFinance from "yahoo-finance2";
import { resolveYahooSymbol } from "../../modules/market-data/domain/yahoo-symbol-resolver.js";

/**
 * One Yahoo quote client for the whole process, plus the narrow shape callers actually read.
 *
 * Two things this consolidates. First, `new (yahooFinance as any)()` was constructed **inside**
 * the poll body in six places, including two SSE handlers that fire every 1-2.5 seconds per
 * connected browser; the client is stateless from our side but rebuilding it per tick is pure
 * waste and defeats any connection reuse the library does. Second, every one of those sites
 * re-derived the Yahoo ticker inline, which is how `INDIAVIX` and Fin Nifty came to be looked
 * up under names that do not exist -- see `yahoo-symbol-resolver.ts`.
 *
 * The `as any` casts are contained here rather than sprayed across the routes: yahoo-finance2
 * ships a callable-module type that does not describe the class form this codebase uses.
 */

export interface YahooQuote {
  symbol: string;
  /** Provider-supplied display name and venue. Null when the provider omits them. */
  shortName: string | null;
  exchange: string | null;
  regularMarketPrice: number | null;
  regularMarketPreviousClose: number | null;
  regularMarketChange: number | null;
  regularMarketChangePercent: number | null;
  regularMarketOpen: number | null;
  regularMarketDayHigh: number | null;
  regularMarketDayLow: number | null;
  regularMarketVolume: number | null;
  regularMarketTime: Date | null;
}

/** Yahoo omits fields rather than nulling them, so absence and zero must not merge. */
function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toQuote(raw: Record<string, unknown>, fallbackSymbol: string): YahooQuote {
  const time = raw.regularMarketTime;
  return {
    symbol: typeof raw.symbol === "string" ? raw.symbol : fallbackSymbol,
    shortName: typeof raw.shortName === "string" && raw.shortName !== "" ? raw.shortName : null,
    exchange: typeof raw.exchange === "string" && raw.exchange !== "" ? raw.exchange : null,
    regularMarketPrice: numberOrNull(raw.regularMarketPrice),
    regularMarketPreviousClose: numberOrNull(raw.regularMarketPreviousClose),
    regularMarketChange: numberOrNull(raw.regularMarketChange),
    regularMarketChangePercent: numberOrNull(raw.regularMarketChangePercent),
    regularMarketOpen: numberOrNull(raw.regularMarketOpen),
    regularMarketDayHigh: numberOrNull(raw.regularMarketDayHigh),
    regularMarketDayLow: numberOrNull(raw.regularMarketDayLow),
    regularMarketVolume: numberOrNull(raw.regularMarketVolume),
    regularMarketTime: time instanceof Date ? time : null,
  };
}

let client: { quote(symbol: string | string[]): Promise<unknown> } | null = null;

function quoteClient(): { quote(symbol: string | string[]): Promise<unknown> } {
  client ??= new (yahooFinance as unknown as new () => {
    quote(symbol: string | string[]): Promise<unknown>;
  })();
  return client;
}

/**
 * Quotes one canonical lab symbol. Returns null when the provider has nothing usable,
 * so a caller can fall back to a stored bar rather than publish a synthetic tick.
 */
export async function quoteLabSymbol(symbol: string): Promise<YahooQuote | null> {
  const yahooSymbol = resolveYahooSymbol(symbol);
  try {
    const raw = await quoteClient().quote(yahooSymbol);
    if (raw === null || typeof raw !== "object") return null;
    const quote = toQuote(raw as Record<string, unknown>, yahooSymbol);
    // A quote with no price is not a quote. Treated as absent rather than as zero.
    return quote.regularMarketPrice === null || quote.regularMarketPrice <= 0 ? null : quote;
  } catch {
    return null;
  }
}

/**
 * Quotes many canonical lab symbols, keyed by the lab symbol the caller passed in.
 *
 * Batched, then retried per symbol if the batch fails, so one delisted or mistyped ticker
 * cannot blank an entire panel. Symbols with no usable quote are simply absent from the map;
 * that is deliberately distinguishable from a present entry holding a zero.
 */
export async function quoteLabSymbols(symbols: readonly string[]): Promise<Map<string, YahooQuote>> {
  const bySymbol = new Map<string, YahooQuote>();
  if (symbols.length === 0) return bySymbol;

  // Yahoo rejects oversized symbol lists, and a rejected batch costs every symbol in it.
  const chunkSize = 25;
  for (let index = 0; index < symbols.length; index += chunkSize) {
    const chunk = symbols.slice(index, index + chunkSize);
    const yahooToLab = new Map(chunk.map((lab) => [resolveYahooSymbol(lab), lab]));
    try {
      const raw = await quoteClient().quote([...yahooToLab.keys()]);
      const rows = Array.isArray(raw) ? raw : [raw];
      for (const row of rows) {
        if (row === null || typeof row !== "object") continue;
        const record = row as Record<string, unknown>;
        const yahooSymbol = typeof record.symbol === "string" ? record.symbol : "";
        const lab = yahooToLab.get(yahooSymbol);
        if (lab === undefined) continue;
        const quote = toQuote(record, yahooSymbol);
        if (quote.regularMarketPrice !== null && quote.regularMarketPrice > 0) bySymbol.set(lab, quote);
      }
    } catch {
      // Batch failed wholesale; fall back so one bad ticker does not cost the others.
      await Promise.all(chunk.map(async (lab) => {
        const quote = await quoteLabSymbol(lab);
        if (quote !== null) bySymbol.set(lab, quote);
      }));
    }
  }
  return bySymbol;
}
