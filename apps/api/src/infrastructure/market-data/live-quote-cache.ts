import type { Tick } from "./fyers-live-streamer.js";

/**
 * The latest bid and ask the live socket has shown for each symbol, kept in memory.
 *
 * Why it exists: the option-chain page streams every strike of a chain to the browser, so the Manual Trade ticket
 * can show a live price for any contract on it. The tick table the exit sweep reads is written only for the
 * contracts the collector subscribes (a delta-targeted subset around the money), so a perfectly visible
 * out-of-the-money call had no executable quote and its buy was refused. Filling from the same stream the screen
 * is showing means the price paid is the price seen -- for any strike on the chain.
 *
 * A side is only as fresh as the last tick that carried it: a tick without a bid does not refresh the bid, and a
 * quote needs both sides fresh. Receipt time is used, not the feed's own clock, because the receipt clock is the
 * one that says how long ago *this process* last heard the market.
 */
interface Entry {
  ltp: number;
  ltpAt: number;
  bid: number | null;
  bidAt: number;
  ask: number | null;
  askAt: number;
}

export interface LiveQuote {
  bid: number;
  ask: number;
  ltp: number;
  /** The older of the two sides' receipt times, i.e. how stale the quote as a whole is. */
  observedAt: Date;
}

export class LiveQuoteCache {
  private readonly entries = new Map<string, Entry>();

  /** Records one tick. A side the tick does not carry is left exactly as it was, with its own age. */
  record(tick: Tick, receivedAt: number = Date.now()): void {
    const previous = this.entries.get(tick.symbol);
    this.entries.set(tick.symbol, {
      ltp: tick.ltp,
      ltpAt: receivedAt,
      bid: tick.bid ?? previous?.bid ?? null,
      bidAt: tick.bid !== null ? receivedAt : previous?.bidAt ?? 0,
      ask: tick.ask ?? previous?.ask ?? null,
      askAt: tick.ask !== null ? receivedAt : previous?.askAt ?? 0,
    });
  }

  /** Starts listening to a streamer's `tick` events. Returns the function that stops. */
  attach(source: { on(event: "tick", listener: (tick: Tick) => void): unknown; off(event: "tick", listener: (tick: Tick) => void): unknown }): () => void {
    const listener = (tick: Tick) => this.record(tick);
    source.on("tick", listener);
    return () => { source.off("tick", listener); };
  }

  /**
   * A two-sided quote, or null: both sides must exist, be positive and uncrossed, and each have been heard within
   * `maxAgeMs`. A one-sided or stale book has no price anyone was prepared to deal at.
   */
  quote(symbol: string, maxAgeMs: number, now: number = Date.now()): LiveQuote | null {
    const entry = this.entries.get(symbol);
    if (!entry || entry.bid === null || entry.ask === null) return null;
    if (!(entry.bid > 0) || !(entry.ask > 0) || entry.ask < entry.bid) return null;
    const oldest = Math.min(entry.bidAt, entry.askAt);
    if (now - oldest > maxAgeMs || oldest - now > 5_000) return null;
    return { bid: entry.bid, ask: entry.ask, ltp: entry.ltp, observedAt: new Date(oldest) };
  }

  /** The last traded price of a symbol (an index, say) if it was heard within `maxAgeMs`. */
  lastPrice(symbol: string, maxAgeMs: number, now: number = Date.now()): { price: number; observedAt: Date } | null {
    const entry = this.entries.get(symbol);
    if (!entry || !(entry.ltp > 0)) return null;
    if (now - entry.ltpAt > maxAgeMs) return null;
    return { price: entry.ltp, observedAt: new Date(entry.ltpAt) };
  }
}
