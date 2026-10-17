import type { LiveMarketDataProvider, LiveMarketQuote } from "../../modules/market-data/domain/live-market-data-provider.js";
import type { Tick } from "./fyers-live-streamer.js";

/**
 * Feeds the live collectors from the websocket and goes to Fyers REST only to re-anchor.
 *
 * The collectors polled `/data/quotes` every 15 and 30 seconds all session -- about 1,500 and 750 requests a day
 * against a 5,000-a-day quota that ran out at 11:04 IST on 2026-10-16. The same symbols were already streaming over
 * the socket. Here a REST quote is an *anchor*: it is fetched when there is none, when the last one is older than
 * `anchorMs`, or when the socket cannot be trusted, and every poll in between is answered from the anchor and the
 * ticks that have arrived since.
 *
 * Price is the newest tick that arrived after the anchor, or the anchor's own price when nothing has traded since.
 * That is not a guess: a quiet symbol's last traded price is exactly what REST would return.
 *
 * Volume is the part that has to be right, because the collector turns successive cumulative volumes into per-bar
 * deltas. The two sources do not share a baseline, so the stream's volume is never used on its own. It is
 * `anchor volume + (tick volume now - tick volume when the anchor was taken)`: the stream only supplies how much
 * traded since, and the REST figure supplies the level, so the collector sees one consistent series. A quote the
 * anchor reported with no volume (an index) stays without volume.
 *
 * Anything it cannot answer exactly -- no anchor yet, anchor too old, a socket that has gone quiet, a tick that
 * carries no volume where the anchor has one, a stream volume that went backwards -- is answered by one REST call
 * for the whole set, which is the behaviour before this class existed. Rate-limit errors from that call propagate
 * unchanged.
 */
export interface LiveTickSource {
  on(event: "tick", listener: (tick: Tick) => void): unknown;
  off(event: "tick", listener: (tick: Tick) => void): unknown;
  subscribe(symbols: string[]): void;
}

/** What the stream would have answered against what REST said, taken whenever an anchor is refreshed. */
export interface StreamFirstParity {
  providerInstrumentId: string;
  streamPrice: number;
  restPrice: number;
  priceDiffBps: number;
  /** Stream-composed cumulative volume minus the REST one, when both exist. */
  volumeDifference: number | null;
  anchorAgeSeconds: number;
}

export interface StreamFirstLiveMarketDataProviderOptions {
  rest: LiveMarketDataProvider;
  ticks: LiveTickSource;
  /** How long a REST quote stays the anchor. */
  anchorMs?: number;
  /** The socket is trusted while any subscribed symbol has ticked within this long. */
  socketAliveMs?: number;
  now?: () => number;
  onParity?: (parity: StreamFirstParity) => void;
}

interface TickState {
  price: number;
  volume: number | null;
  at: number;
}

interface Anchor {
  quote: LiveMarketQuote;
  at: number;
  /** The stream's cumulative volume when the anchor was taken, or null if the symbol had not ticked yet. */
  tickVolume: number | null;
}

const DEFAULT_ANCHOR_MS = 60_000;
const DEFAULT_SOCKET_ALIVE_MS = 15_000;

export class StreamFirstLiveMarketDataProvider implements LiveMarketDataProvider {
  readonly id: string;
  private readonly ticks = new Map<string, TickState>();
  private readonly anchors = new Map<string, Anchor>();
  private readonly subscribed = new Set<string>();
  private lastAnyTickAt: number | null = null;
  private readonly anchorMs: number;
  private readonly socketAliveMs: number;
  private readonly now: () => number;
  private readonly onTick = (tick: Tick): void => {
    const at = this.now();
    this.lastAnyTickAt = at;
    this.ticks.set(tick.symbol.toUpperCase(), { price: tick.ltp, volume: tick.volume, at });
  };

  constructor(private readonly options: StreamFirstLiveMarketDataProviderOptions) {
    this.id = options.rest.id;
    this.anchorMs = options.anchorMs ?? DEFAULT_ANCHOR_MS;
    this.socketAliveMs = options.socketAliveMs ?? DEFAULT_SOCKET_ALIVE_MS;
    this.now = options.now ?? Date.now;
    options.ticks.on("tick", this.onTick);
  }

  /** Stops listening. The caller owns the socket and closes it. */
  dispose(): void {
    this.options.ticks.off("tick", this.onTick);
  }

  async fetchQuotes(providerInstrumentIds: string[]): Promise<LiveMarketQuote[]> {
    const ids = [...new Set(providerInstrumentIds.filter((id) => id.trim().length > 0))];
    if (ids.length === 0) return [];
    this.subscribe(ids);

    const answered = this.answerFromStream(ids);
    if (answered !== null) return answered;
    return this.refreshAnchors(ids);
  }

  private subscribe(ids: string[]): void {
    const fresh = ids.map((id) => id.toUpperCase()).filter((id) => !this.subscribed.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) this.subscribed.add(id);
    try {
      this.options.ticks.subscribe(fresh);
    } catch {
      // A socket that will not subscribe leaves every poll on REST, which is where it was.
      for (const id of fresh) this.subscribed.delete(id);
    }
  }

  private socketAlive(at: number): boolean {
    return this.lastAnyTickAt !== null && at - this.lastAnyTickAt <= this.socketAliveMs;
  }

  /** The quotes for every id from anchors and ticks, or null if even one cannot be answered exactly. */
  private answerFromStream(ids: string[]): LiveMarketQuote[] | null {
    const at = this.now();
    if (!this.socketAlive(at)) return null;
    const quotes: LiveMarketQuote[] = [];
    for (const id of ids) {
      const anchor = this.anchors.get(id.toUpperCase());
      if (anchor === undefined || at - anchor.at > this.anchorMs) return null;
      const composed = this.compose(id, anchor, at);
      if (composed === null) return null;
      quotes.push(composed);
    }
    return quotes;
  }

  private compose(id: string, anchor: Anchor, at: number): LiveMarketQuote | null {
    const tick = this.ticks.get(id.toUpperCase());
    // A tick from before the anchor says nothing the anchor does not: the anchor is newer.
    const newer = tick !== undefined && tick.at > anchor.at ? tick : undefined;
    const anchorVolume = anchor.quote.cumulativeVolume;

    let cumulativeVolume = anchorVolume;
    if (newer !== undefined && anchorVolume !== null) {
      if (newer.volume === null || anchor.tickVolume === null) return null;
      const traded = newer.volume - anchor.tickVolume;
      if (traded < 0) return null;
      cumulativeVolume = String(Number(anchorVolume) + traded);
    }

    return {
      providerInstrumentId: anchor.quote.providerInstrumentId,
      lastPrice: newer === undefined ? anchor.quote.lastPrice : String(newer.price),
      cumulativeVolume,
      observedAt: new Date(at),
      exchangeTimestamp: null,
    };
  }

  private async refreshAnchors(ids: string[]): Promise<LiveMarketQuote[]> {
    const fetched = await this.options.rest.fetchQuotes(ids);
    const at = this.now();
    for (const quote of fetched) {
      const key = quote.providerInstrumentId.toUpperCase();
      this.reportParity(key, quote, at);
      this.anchors.set(key, { quote, at, tickVolume: this.ticks.get(key)?.volume ?? null });
    }
    return fetched;
  }

  private reportParity(key: string, rest: LiveMarketQuote, at: number): void {
    const previous = this.anchors.get(key);
    if (this.options.onParity === undefined || previous === undefined || !this.socketAlive(at)) return;
    const composed = this.compose(key, previous, at);
    if (composed === null) return;
    const restPrice = Number(rest.lastPrice);
    const streamPrice = Number(composed.lastPrice);
    if (!(restPrice > 0)) return;
    this.options.onParity({
      providerInstrumentId: rest.providerInstrumentId,
      streamPrice,
      restPrice,
      priceDiffBps: Number((((streamPrice - restPrice) / restPrice) * 10_000).toFixed(3)),
      volumeDifference: composed.cumulativeVolume !== null && rest.cumulativeVolume !== null
        ? Number(composed.cumulativeVolume) - Number(rest.cumulativeVolume)
        : null,
      anchorAgeSeconds: Math.round((at - previous.at) / 1000),
    });
  }
}
