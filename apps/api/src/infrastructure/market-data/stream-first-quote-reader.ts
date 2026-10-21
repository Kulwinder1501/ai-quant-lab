import type { MarketQuote, MarketQuoteReader } from "../../modules/market-data/domain/market-quote.js";
import { resolveFyersSymbol } from "../../modules/market-data/domain/fyers-symbol-resolver.js";

/**
 * Serves spot prices from the live websocket's ticks, and goes to Fyers REST only to refresh the parts a tick does not
 * carry (previous close, open, volume).
 *
 * The API already holds the latest tick per symbol in memory. The market-watch and live-agent streams asked REST for
 * the same few symbols every 2.5 seconds per open tab -- up to ~24 requests a minute each against a 5,000-a-day
 * quota that ran out at 11:04 IST on 2026-10-16. Here a symbol with a fresh tick and a recent REST base is answered
 * with no request at all: the base quote with its price replaced by the tick and the change recomputed against the
 * base's previous close.
 *
 * Anything it cannot answer this way -- no tick yet (the first call subscribes the symbol), a tick that has gone
 * quiet, a base older than `baseMaxAgeMs` -- is answered by the wrapped reader exactly as before, so the worst case
 * is today's behaviour, not a missing price.
 */
export interface StreamTickSource {
  lastPrice(symbol: string, maxAgeMs: number, now?: number): { price: number; observedAt: Date } | null;
}

export interface StreamSubscriber {
  subscribe(symbols: string[]): void;
}

export interface StreamFirstQuoteReaderOptions {
  inner: MarketQuoteReader;
  ticks: StreamTickSource;
  subscriber?: StreamSubscriber | null;
  /** Canonical symbol to the symbol the socket is keyed by. */
  resolveProviderSymbol?: (symbol: string) => string;
  /** A tick older than this is not a price. */
  maxTickAgeMs?: number;
  /** How long a REST quote stays good as the base for tick-derived ones. */
  baseMaxAgeMs?: number;
  /**
   * A request for more symbols than this goes straight to the wrapped reader and subscribes nothing.
   *
   * The socket holds a limited number of symbols, and a subscription is never given back. The index-drivers heatmap
   * asks for a whole index's constituents in one call (about 114 symbols across the supported indices) at a cost of
   * one REST request, so streaming it would spend most of the socket's slots to save a call that is cached for two
   * seconds anyway. On 2026-10-19 that filled the API's socket until the BANKNIFTY option chain could subscribe only
   * its last three contracts.
   */
  maxStreamedSymbols?: number;
  /**
   * Whether the exchange is in session. While it is not, a quote is the last close and cannot change, so a quote
   * already held is served for up to `closedSessionBaseMaxAgeMs` instead of asking REST again. Without this, every
   * open dashboard stream sent a request each 2.5 seconds all night and on holidays: the API spent 4,779 of the
   * 5,000-a-day quota by mid-afternoon on 2026-10-20 (Dussehra) with nothing new to show. Absent means always open.
   */
  isSessionOpen?: () => boolean;
  closedSessionBaseMaxAgeMs?: number;
  /**
   * A cap on what the browser may spend. When it says no, held quotes are served (up to `budgetSpentBaseMaxAgeMs`
   * old, with a fresh tick laid over them) and REST is not called for anything already held. A symbol never held is
   * still fetched once, so a new panel is not left blank.
   */
  restBudget?: { allow(): boolean };
  budgetSpentBaseMaxAgeMs?: number;
  /**
   * The least time between two REST calls for the same set of symbols. Inside it, held quotes are served (with a fresh
   * tick laid over them when there is one). It matters when the socket is down or quiet: every request then falls to
   * REST, and open dashboard tabs ask about once a second, so on 2026-10-21 the API sent 64 to 76 requests in a minute
   * against a limit of 50 each time Fyers dropped every socket for a few seconds, and was refused for the next minute.
   * Absent means no floor.
   */
  minRestIntervalMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_TICK_AGE_MS = 10_000;
const DEFAULT_BASE_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_MAX_STREAMED_SYMBOLS = 8;
const DEFAULT_CLOSED_SESSION_BASE_MAX_AGE_MS = 30 * 60_000;
const DEFAULT_BUDGET_SPENT_BASE_MAX_AGE_MS = 12 * 60 * 60_000;

/** The base quote with the live price laid over it. */
export function overlayTick(base: MarketQuote, price: number, observedAt: Date): MarketQuote {
  const previousClose = base.regularMarketPreviousClose;
  const change = previousClose === null ? base.regularMarketChange : price - previousClose;
  return {
    ...base,
    regularMarketPrice: price,
    regularMarketChange: change,
    regularMarketChangePercent: previousClose === null || previousClose === 0 || change === null
      ? base.regularMarketChangePercent
      : (change / previousClose) * 100,
    regularMarketDayHigh: base.regularMarketDayHigh === null ? price : Math.max(base.regularMarketDayHigh, price),
    regularMarketDayLow: base.regularMarketDayLow === null ? price : Math.min(base.regularMarketDayLow, price),
    regularMarketTime: observedAt,
  };
}

export class StreamFirstQuoteReader implements MarketQuoteReader {
  private readonly bases = new Map<string, { quote: MarketQuote; at: number }>();
  private readonly subscribed = new Set<string>();
  private readonly resolveProviderSymbol: (symbol: string) => string;
  private readonly maxTickAgeMs: number;
  private readonly baseMaxAgeMs: number;
  private readonly maxStreamedSymbols: number;
  private readonly closedSessionBaseMaxAgeMs: number;
  private readonly budgetSpentBaseMaxAgeMs: number;
  private readonly now: () => number;
  private readonly lastRestAt = new Map<string, number>();

  constructor(private readonly options: StreamFirstQuoteReaderOptions) {
    this.resolveProviderSymbol = options.resolveProviderSymbol ?? resolveFyersSymbol;
    this.maxTickAgeMs = options.maxTickAgeMs ?? DEFAULT_MAX_TICK_AGE_MS;
    this.baseMaxAgeMs = options.baseMaxAgeMs ?? DEFAULT_BASE_MAX_AGE_MS;
    this.maxStreamedSymbols = options.maxStreamedSymbols ?? DEFAULT_MAX_STREAMED_SYMBOLS;
    this.closedSessionBaseMaxAgeMs = options.closedSessionBaseMaxAgeMs ?? DEFAULT_CLOSED_SESSION_BASE_MAX_AGE_MS;
    this.budgetSpentBaseMaxAgeMs = options.budgetSpentBaseMaxAgeMs ?? DEFAULT_BUDGET_SPENT_BASE_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Every requested symbol from the quotes already held, or null to go on to the normal path. Only answers when the
   * session is closed or the budget is spent; in an open session with budget left, the tick-and-base logic below
   * decides, exactly as before.
   */
  private answerFromHeldQuotes(canonical: readonly string[]): Map<string, MarketQuote> | null {
    const sessionOpen = this.options.isSessionOpen?.() ?? true;
    const budgetSpent = this.options.restBudget?.allow() === false;
    if (sessionOpen && !budgetSpent) return null;

    const nowMs = this.now();
    const maxAgeMs = budgetSpent ? this.budgetSpentBaseMaxAgeMs : this.closedSessionBaseMaxAgeMs;
    const answers = new Map<string, MarketQuote>();
    for (const symbol of canonical) {
      const base = this.bases.get(symbol);
      if (base === undefined || nowMs - base.at > maxAgeMs) return null;
      const tick = this.options.ticks.lastPrice(this.resolveProviderSymbol(symbol), this.maxTickAgeMs, nowMs);
      answers.set(symbol, tick === null ? base.quote : overlayTick(base.quote, tick.price, tick.observedAt));
    }
    return answers;
  }

  /** The held quotes, when the last REST call for this same set of symbols is newer than `minRestIntervalMs`. */
  private answerWithinRestFloor(canonical: readonly string[]): Map<string, MarketQuote> | null {
    const floorMs = this.options.minRestIntervalMs;
    if (floorMs === undefined) return null;
    const nowMs = this.now();
    const last = this.lastRestAt.get(this.restKey(canonical));
    if (last === undefined || nowMs - last >= floorMs) return null;
    const answers = new Map<string, MarketQuote>();
    for (const symbol of canonical) {
      const base = this.bases.get(symbol);
      if (base === undefined || nowMs - base.at > this.baseMaxAgeMs) return null;
      const tick = this.options.ticks.lastPrice(this.resolveProviderSymbol(symbol), this.maxTickAgeMs, nowMs);
      answers.set(symbol, tick === null ? base.quote : overlayTick(base.quote, tick.price, tick.observedAt));
    }
    return answers;
  }

  private restKey(canonical: readonly string[]): string {
    return [...canonical].sort().join("|");
  }

  async quoteSymbol(symbol: string): Promise<MarketQuote | null> {
    return (await this.quoteSymbols([symbol])).get(symbol) ?? null;
  }

  async quoteSymbols(symbols: readonly string[]): Promise<Map<string, MarketQuote>> {
    const canonical = [...new Set(symbols.map((symbol) => symbol.trim()).filter(Boolean))];
    if (canonical.length === 0) return new Map();

    const held = this.answerFromHeldQuotes(canonical);
    if (held !== null) return held;

    if (canonical.length > this.maxStreamedSymbols) {
      const withinFloor = this.answerWithinRestFloor(canonical);
      if (withinFloor !== null) return withinFloor;
      const fetchedAt = this.now();
      this.lastRestAt.set(this.restKey(canonical), fetchedAt);
      const fetched = await this.options.inner.quoteSymbols(canonical);
      // Kept so a closed session or a spent budget can serve the next request without REST.
      for (const [symbol, quote] of fetched) this.bases.set(symbol, { quote, at: fetchedAt });
      return fetched;
    }

    const nowMs = this.now();
    const answers = new Map<string, MarketQuote>();
    const unanswered: string[] = [];
    for (const symbol of canonical) {
      const tick = this.options.ticks.lastPrice(this.resolveProviderSymbol(symbol), this.maxTickAgeMs, nowMs);
      const base = this.bases.get(symbol);
      if (tick !== null && base !== undefined && nowMs - base.at <= this.baseMaxAgeMs) {
        answers.set(symbol, overlayTick(base.quote, tick.price, tick.observedAt));
      } else {
        unanswered.push(symbol);
      }
    }
    if (unanswered.length === 0) return answers;

    // Ask for the next call to be answerable from the socket. The streamer connects on its first subscription.
    const toSubscribe = unanswered.map(this.resolveProviderSymbol).filter((symbol) => !this.subscribed.has(symbol));
    if (toSubscribe.length > 0 && this.options.subscriber) {
      for (const symbol of toSubscribe) this.subscribed.add(symbol);
      try {
        this.options.subscriber.subscribe(toSubscribe);
      } catch {
        // A socket that will not subscribe leaves every call on REST, which is where it was.
        for (const symbol of toSubscribe) this.subscribed.delete(symbol);
      }
    }

    const withinFloor = this.answerWithinRestFloor(canonical);
    if (withinFloor !== null) return withinFloor;

    // One call for the whole request, not one for the missing symbols: a mixed request is rare, and a single call
    // keeps every returned quote the same age.
    this.lastRestAt.set(this.restKey(canonical), nowMs);
    const fetched = await this.options.inner.quoteSymbols(canonical);
    for (const [symbol, quote] of fetched) this.bases.set(symbol, { quote, at: nowMs });
    return fetched;
  }
}
