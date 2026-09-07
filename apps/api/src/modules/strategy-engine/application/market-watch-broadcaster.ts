import type { MarketQuoteReader } from "../../market-data/domain/market-quote.js";

export interface MarketWatchTile {
  readonly label: string;
  readonly symbol: string;
}

/**
 * Nullable prices are deliberate: `MarketQuote` allows them and the route this replaces forwarded
 * them to the client untouched. Filtering or coercing here would change the payload the UI already
 * handles, which is a separate decision from where the polling happens.
 */
export interface MarketWatchRow {
  readonly symbol: string;
  readonly price: number | null;
  readonly changePercent: number | null;
  readonly aiStance: string;
}

export type MarketWatchListener = (rows: readonly MarketWatchRow[]) => void;

/**
 * Told when a poll fails, so a transport can keep its connection provably alive.
 *
 * Separate from the row listener on purpose: there is no row payload to deliver, and inventing one
 * (`[]`) would claim an empty market rather than unavailable quotes -- distinct facts the UI cannot
 * tell apart.
 */
export type MarketWatchUnavailableListener = (consecutiveFailures: number) => void;

interface Subscriber {
  readonly onRows: MarketWatchListener;
  readonly onUnavailable: MarketWatchUnavailableListener | undefined;
}

export interface MarketWatchBroadcasterOptions {
  readonly quotes: MarketQuoteReader;
  readonly tiles: readonly MarketWatchTile[];
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly logError?: (line: string) => void;
}

const DEFAULT_INTERVAL_MS = 2_500;
const FAILURE_LOG_THROTTLE_MS = 30_000;

/**
 * One provider poll per process, fanned out to every connected market-watch stream.
 *
 * ## Why this exists
 *
 * The SSE route used to own its own `setInterval`, so the provider was polled once every 2.5s
 * **per connected browser tab**. Four tabs meant four times the quote traffic for identical data,
 * and the quote budget is shared with the collectors and the agent. On 2026-08-27 the provider
 * rate-limited the whole app at its edge and answered 429 with a `retry-after` of 2374 seconds;
 * every live panel went blank for the duration. Capping the backoff stopped a rate limit from
 * becoming a multi-hour outage, but it did nothing about the traffic that earned the limit. This
 * does: subscriber count no longer affects provider load at all.
 *
 * ## Three behaviours worth stating
 *
 * - **A new subscriber gets the cached snapshot immediately.** Previously every tab waited a full
 *   poll before its first frame, showing "Connecting to live feed..." even when the data was
 *   already in memory from another tab.
 * - **A failed poll keeps the last good snapshot.** Stale-but-labelled beats blank: the panel has
 *   no way to distinguish "no rows" from "quotes unavailable", so discarding the snapshot on a
 *   transient failure would turn a 2.5s blip into an apparently empty market.
 * - **Polling stops when the last subscriber leaves.** A shared poller outlives any one request,
 *   so unlike the per-connection interval it must be shut down explicitly or it would keep
 *   spending the quote budget with nobody watching.
 */
export class MarketWatchBroadcaster {
  private readonly subscribers = new Set<Subscriber>();
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly logError: (line: string) => void;

  private timer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private latest: readonly MarketWatchRow[] | null = null;
  private consecutiveFailures = 0;
  private lastFailureLogAt = 0;
  private providerCalls = 0;

  constructor(private readonly options: MarketWatchBroadcasterOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((line: string) => console.info(line));
    this.logError = options.logError ?? ((line: string) => console.error(line));
  }

  /** Last successful snapshot, or null if no poll has succeeded yet. */
  get snapshot(): readonly MarketWatchRow[] | null {
    return this.latest;
  }

  /** Provider round-trips made. Exposed so a test can prove N subscribers cost one call. */
  get stats(): { subscribers: number; consecutiveFailures: number; providerCalls: number } {
    return {
      subscribers: this.subscribers.size,
      consecutiveFailures: this.consecutiveFailures,
      providerCalls: this.providerCalls,
    };
  }

  /**
   * Register a listener and return its unsubscribe.
   *
   * The first subscriber starts the poll loop and triggers an immediate poll, so the first tab on
   * a cold process does not wait one interval for data that could already be on the wire.
   */
  subscribe(
    listener: MarketWatchListener,
    onUnavailable?: MarketWatchUnavailableListener,
  ): () => void {
    const subscriber: Subscriber = { onRows: listener, onUnavailable };
    this.subscribers.add(subscriber);
    if (this.latest !== null) listener(this.latest);

    if (this.timer === null) {
      this.timer = setInterval(() => void this.pollOnce(), this.intervalMs);
      // Never let the poll loop hold the process open at shutdown.
      this.timer.unref?.();
      void this.pollOnce();
    }

    let released = false;
    return () => {
      // Idempotent: a stream can be closed and errored, and double-removal would otherwise
      // decrement past the real subscriber count and stop a loop others still need.
      if (released) return;
      released = true;
      this.subscribers.delete(subscriber);
      if (this.subscribers.size === 0) this.stop();
    };
  }

  /** Stops the poll loop. Retains the snapshot, so a later subscriber still gets a first frame. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async pollOnce(): Promise<void> {
    // Without this a slow provider round-trip lets ticks stack up.
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      this.providerCalls += 1;
      // One batched request per tick for every connected tab, rather than one per tab.
      const quotes = await this.options.quotes.quoteSymbols(this.options.tiles.map((tile) => tile.symbol));
      const rows = this.options.tiles.flatMap((tile) => {
        const quote = quotes.get(tile.symbol);
        if (quote === undefined) return [];
        return [{
          symbol: tile.label,
          price: quote.regularMarketPrice,
          changePercent: quote.regularMarketChangePercent,
          aiStance: "NEUT", // Kept for UI compatibility, could be dynamic later
        }];
      });

      if (this.consecutiveFailures > 0) {
        this.log(JSON.stringify({
          level: "info",
          message: "Market watch quotes recovered",
          source: "market-watch",
          afterConsecutiveFailures: this.consecutiveFailures,
        }));
        this.consecutiveFailures = 0;
      }

      this.latest = rows;
      for (const subscriber of this.subscribers) subscriber.onRows(rows);
    } catch (error) {
      /*
       * Logged, not swallowed. The route's `catch` used to be empty, and because the stream wrote
       * nothing before its first success, a provider outage was indistinguishable from a healthy
       * connection that had not ticked yet. Diagnosing one needed a hand-rolled request against the
       * provider to discover a 429.
       *
       * Throttled because the loop runs every 2.5s and an outage measured in minutes would
       * otherwise bury the log in thousands of identical lines.
       */
      this.consecutiveFailures += 1;
      const now = this.now();
      if (this.consecutiveFailures === 1 || now - this.lastFailureLogAt >= FAILURE_LOG_THROTTLE_MS) {
        this.lastFailureLogAt = now;
        this.logError(JSON.stringify({
          level: "error",
          message: "Market watch stream could not fetch quotes",
          source: "market-watch",
          consecutiveFailures: this.consecutiveFailures,
          subscribers: this.subscribers.size,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      // `latest` is deliberately left alone -- see the class comment.
      /*
       * Tell every transport the poll failed. Without this a failing stream sends zero bytes, which
       * is the state that made the original outage undiagnosable: an open socket delivering nothing
       * looks exactly like a healthy connection that has not ticked yet, and idle proxies are free
       * to drop it.
       */
      for (const subscriber of this.subscribers) subscriber.onUnavailable?.(this.consecutiveFailures);
    } finally {
      this.pollInFlight = false;
    }
  }
}
