import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { LiveMarketDataProvider, LiveMarketQuote } from "../../modules/market-data/domain/live-market-data-provider.js";
import type { Tick } from "./fyers-live-streamer.js";
import { FyersRateLimitedError } from "../../modules/market-data/domain/fyers-rate-limit.js";
import { StreamFirstLiveMarketDataProvider, type StreamFirstParity } from "./stream-first-live-provider.js";

const ETF = "NSE:NIFTYBEES-EQ";
const INDEX = "NSE:NIFTY50-INDEX";

function tick(symbol: string, ltp: number, volume: number | null): Tick {
  return { symbol, ltp, bid: null, ask: null, volume, exchangeFeedTimeSeconds: null, lastTradeTimeSeconds: null };
}

function setup(options: { anchorMs?: number; restVolume?: string | null } = {}) {
  let now = 1_000_000;
  const emitter = new EventEmitter();
  const subscribe = vi.fn();
  const restCalls: string[][] = [];
  let restPrice = 250;
  let restVolume: string | null = options.restVolume === undefined ? "1000" : options.restVolume;
  const rest: LiveMarketDataProvider = {
    id: "fyers-api-v3",
    fetchQuotes: async (ids) => {
      restCalls.push([...ids]);
      return ids.map((id): LiveMarketQuote => ({
        providerInstrumentId: id,
        lastPrice: String(restPrice),
        cumulativeVolume: restVolume,
        observedAt: new Date(now),
        exchangeTimestamp: null,
      }));
    },
  };
  const parities: StreamFirstParity[] = [];
  const provider = new StreamFirstLiveMarketDataProvider({
    rest,
    ticks: { on: (e, l) => emitter.on(e, l), off: (e, l) => emitter.off(e, l), subscribe },
    now: () => now,
    onParity: (p) => parities.push(p),
    ...(options.anchorMs === undefined ? {} : { anchorMs: options.anchorMs }),
  });
  return {
    provider,
    restCalls,
    subscribe,
    parities,
    emit: (t: Tick) => emitter.emit("tick", t),
    advance: (ms: number) => { now += ms; },
    setRest: (price: number, volume: string | null) => { restPrice = price; restVolume = volume; },
  };
}

describe("StreamFirstLiveMarketDataProvider", () => {
  it("asks REST for the first anchor and subscribes the symbol once", async () => {
    const { provider, restCalls, subscribe, advance, emit } = setup();
    emit(tick(INDEX, 22_000, null)); // the socket is alive
    const first = await provider.fetchQuotes([ETF]);
    advance(1_000);
    await provider.fetchQuotes([ETF]);

    expect(restCalls).toEqual([[ETF]]);
    expect(first[0]?.lastPrice).toBe("250");
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith([ETF]);
  });

  it("answers later polls from the anchor and the ticks since, with no request", async () => {
    const { provider, restCalls, emit, advance } = setup();
    emit(tick(ETF, 249, 5_000)); // socket alive; this tick predates the anchor
    await provider.fetchQuotes([ETF]);

    advance(5_000);
    emit(tick(ETF, 251.5, 5_300));
    advance(5_000);
    const [quote] = await provider.fetchQuotes([ETF]);

    expect(restCalls).toHaveLength(1);
    expect(quote?.lastPrice).toBe("251.5");
    // anchor volume 1000 plus the 300 the stream says traded since the anchor
    expect(quote?.cumulativeVolume).toBe("1300");
    expect(quote?.exchangeTimestamp).toBeNull();
  });

  it("keeps the anchor's price and volume when nothing has traded since", async () => {
    const { provider, restCalls, emit, advance } = setup();
    emit(tick(ETF, 249, 5_000));
    await provider.fetchQuotes([ETF]);
    advance(8_000);
    emit(tick(INDEX, 22_000, null)); // the socket is alive, this symbol is just quiet

    const [quote] = await provider.fetchQuotes([ETF]);
    expect(restCalls).toHaveLength(1);
    expect(quote?.lastPrice).toBe("250");
    expect(quote?.cumulativeVolume).toBe("1000");
  });

  it("re-anchors from REST once the anchor is older than its limit", async () => {
    const { provider, restCalls, emit, advance } = setup({ anchorMs: 60_000 });
    emit(tick(ETF, 249, 5_000));
    await provider.fetchQuotes([ETF]);
    advance(61_000);
    emit(tick(ETF, 251, 5_400));

    await provider.fetchQuotes([ETF]);
    expect(restCalls).toHaveLength(2);
  });

  it("goes back to REST for every poll while the socket is quiet or absent", async () => {
    const { provider, restCalls, advance } = setup();
    await provider.fetchQuotes([ETF]);
    advance(1_000);
    await provider.fetchQuotes([ETF]);
    expect(restCalls).toHaveLength(2);
  });

  it("goes to REST when a tick carries no volume but the anchor has one", async () => {
    const { provider, restCalls, emit, advance } = setup();
    emit(tick(ETF, 249, 5_000));
    await provider.fetchQuotes([ETF]);
    advance(2_000);
    emit(tick(ETF, 251, null));

    await provider.fetchQuotes([ETF]);
    expect(restCalls).toHaveLength(2);
  });

  it("goes to REST when the stream's volume went backwards", async () => {
    const { provider, restCalls, emit, advance } = setup();
    emit(tick(ETF, 249, 5_000));
    await provider.fetchQuotes([ETF]);
    advance(2_000);
    emit(tick(ETF, 251, 4_000));

    await provider.fetchQuotes([ETF]);
    expect(restCalls).toHaveLength(2);
  });

  it("goes to REST when the symbol had not ticked at anchor time but has since", async () => {
    const { provider, restCalls, emit, advance } = setup();
    emit(tick(INDEX, 22_000, null));
    await provider.fetchQuotes([ETF]);
    advance(2_000);
    emit(tick(ETF, 251, 5_300));

    await provider.fetchQuotes([ETF]);
    expect(restCalls).toHaveLength(2);
    // ... and the second anchor now carries the baseline, so the next poll needs no request.
    advance(2_000);
    emit(tick(ETF, 252, 5_500));
    const [quote] = await provider.fetchQuotes([ETF]);
    expect(restCalls).toHaveLength(2);
    expect(quote?.cumulativeVolume).toBe("1200");
  });

  it("leaves volume absent for a quote the anchor reported without one", async () => {
    const { provider, restCalls, emit, advance } = setup({ restVolume: null });
    emit(tick(INDEX, 22_000, 9_999));
    await provider.fetchQuotes([INDEX]);
    advance(2_000);
    emit(tick(INDEX, 22_010, 12_000));

    const [quote] = await provider.fetchQuotes([INDEX]);
    expect(restCalls).toHaveLength(1);
    expect(quote?.lastPrice).toBe("22010");
    expect(quote?.cumulativeVolume).toBeNull();
  });

  it("sends one request for the whole set when any one symbol cannot be answered", async () => {
    const { provider, restCalls, emit, advance } = setup();
    emit(tick(ETF, 249, 5_000));
    await provider.fetchQuotes([ETF]);
    advance(2_000);
    emit(tick(ETF, 251, 5_100));

    await provider.fetchQuotes([ETF, INDEX]);
    expect(restCalls).toEqual([[ETF], [ETF, INDEX]]);
  });

  it("reports how far the stream was from REST whenever the anchor is refreshed", async () => {
    const { provider, parities, emit, advance, setRest } = setup({ anchorMs: 60_000 });
    emit(tick(ETF, 249, 5_000));
    await provider.fetchQuotes([ETF]);
    advance(30_000);
    emit(tick(ETF, 251, 5_300));
    advance(31_000);
    emit(tick(ETF, 251, 5_300));
    setRest(251.05, "1302");

    await provider.fetchQuotes([ETF]);
    expect(parities).toHaveLength(1);
    expect(parities[0]?.priceDiffBps).toBeCloseTo(((251 - 251.05) / 251.05) * 10_000, 2);
    expect(parities[0]?.volumeDifference).toBe(-2);
    expect(parities[0]?.anchorAgeSeconds).toBe(61);
  });

  it("still answers from REST if the socket refuses a subscription", async () => {
    const { provider, subscribe } = setup();
    subscribe.mockImplementation(() => { throw new Error("socket down"); });
    const quotes = await provider.fetchQuotes([ETF]);
    expect(quotes[0]?.lastPrice).toBe("250");
  });

  describe("when Fyers refuses REST", () => {
    function limited() {
      let refuse = false;
      const emitter = new EventEmitter();
      let now = 1_000_000;
      const carries: Array<{ carrying: boolean; kind: string }> = [];
      const provider = new StreamFirstLiveMarketDataProvider({
        rest: {
          id: "fyers-api-v3",
          fetchQuotes: async (ids) => {
            if (refuse) throw new FyersRateLimitedError("daily cap", "DAILY", now + 600_000);
            return ids.map((id): LiveMarketQuote => ({
              providerInstrumentId: id, lastPrice: "250", cumulativeVolume: "1000", observedAt: new Date(now), exchangeTimestamp: null,
            }));
          },
        },
        ticks: { on: (e, l) => emitter.on(e, l), off: (e, l) => emitter.off(e, l), subscribe: () => undefined },
        now: () => now,
        anchorMs: 60_000,
        onCarryChange: (carrying, detail) => carries.push({ carrying, kind: detail.kind }),
      });
      return {
        provider, carries,
        emit: (t: Tick) => emitter.emit("tick", t),
        advance: (ms: number) => { now += ms; },
        refuseRest: () => { refuse = true; },
        allowRest: () => { refuse = false; },
      };
    }

    it("carries the old anchor past its age limit, so a spent daily quota does not stop the bars", async () => {
      const { provider, carries, emit, advance, refuseRest } = limited();
      emit(tick(ETF, 249, 5_000));
      await provider.fetchQuotes([ETF]);
      refuseRest();
      advance(10 * 60_000);
      emit(tick(ETF, 255, 5_450));

      const [quote] = await provider.fetchQuotes([ETF]);
      expect(quote?.lastPrice).toBe("255");
      // anchor volume 1000 plus the 450 the stream says traded since it, however old the anchor is
      expect(quote?.cumulativeVolume).toBe("1450");
      expect(carries).toEqual([{ carrying: true, kind: "DAILY" }]);
    });

    it("says so once when REST comes back, and re-anchors", async () => {
      const { provider, carries, emit, advance, refuseRest, allowRest } = limited();
      emit(tick(ETF, 249, 5_000));
      await provider.fetchQuotes([ETF]);
      refuseRest();
      advance(2 * 60_000);
      emit(tick(ETF, 255, 5_450));
      await provider.fetchQuotes([ETF]);
      await provider.fetchQuotes([ETF]);
      allowRest();
      advance(1_000);
      emit(tick(ETF, 256, 5_460));

      const [quote] = await provider.fetchQuotes([ETF]);
      expect(quote?.lastPrice).toBe("250");
      expect(carries.map((entry) => entry.carrying)).toEqual([true, false]);
    });

    it("still fails when there is no anchor to carry", async () => {
      const { provider, emit, refuseRest } = limited();
      emit(tick(ETF, 249, 5_000));
      refuseRest();
      await expect(provider.fetchQuotes([ETF])).rejects.toBeInstanceOf(FyersRateLimitedError);
    });

    it("still fails when the socket is quiet, because ticks are what the carried anchor relies on", async () => {
      const { provider, emit, advance, refuseRest } = limited();
      emit(tick(ETF, 249, 5_000));
      await provider.fetchQuotes([ETF]);
      refuseRest();
      advance(5 * 60_000);
      await expect(provider.fetchQuotes([ETF])).rejects.toBeInstanceOf(FyersRateLimitedError);
    });
  });

  it("lets a REST failure through unchanged", async () => {
    const failing = new StreamFirstLiveMarketDataProvider({
      rest: { id: "fyers-api-v3", fetchQuotes: async () => { throw new Error("rate limited"); } },
      ticks: { on: () => undefined, off: () => undefined, subscribe: () => undefined },
    });
    await expect(failing.fetchQuotes([ETF])).rejects.toThrow("rate limited");
  });
});
