import { describe, expect, it, vi } from "vitest";
import { OandaLiveStreamer, type OandaTick } from "./oanda-live-streamer.js";

describe("OandaLiveStreamer", () => {
  it("parses price chunks and updates in-memory latest quote", async () => {
    const streamer = new OandaLiveStreamer({
      accountId: "test-account-123",
      accessToken: "test-token-abc",
      symbols: ["XAU_USD"],
    });

    const ticks: OandaTick[] = [];
    streamer.on("tick", (t) => ticks.push(t));

    // Simulate receiving a stream chunk
    const rawChunk = JSON.stringify({
      type: "PRICE",
      time: "2026-10-22T15:30:00.123456789Z",
      instrument: "XAU_USD",
      bids: [{ price: "2712.35", liquidity: 1000000 }],
      asks: [{ price: "2712.65", liquidity: 1000000 }],
      closeoutBid: "2712.35",
      closeoutAsk: "2712.65",
      status: "tradeable",
    }) + "\n";

    streamer.processStreamLine(rawChunk);

    expect(ticks).toHaveLength(1);
    const tick = ticks[0]!;
    expect(tick.symbol).toBe("XAU_USD");
    expect(tick.bid).toBe(2712.35);
    expect(tick.ask).toBe(2712.65);
    expect(tick.mid).toBe(2712.50);
    expect(tick.spread).toBeCloseTo(0.30, 4);
    expect(tick.isTradeable).toBe(true);

    // In-memory cache checks
    const cached = streamer.getLatestQuote("XAU_USD");
    expect(cached).not.toBeNull();
    expect(cached?.mid).toBe(2712.50);
    expect(streamer.getLastPrice("XAU_USD")).toBe(2712.50);
    expect(streamer.getSpread("XAU_USD")).toBeCloseTo(0.30, 4);
    expect(streamer.isFresh("XAU_USD", 5000)).toBe(true);
  });

  it("handles heartbeat messages without emitting ticks", () => {
    const streamer = new OandaLiveStreamer({
      accountId: "test-account-123",
      accessToken: "test-token-abc",
      symbols: ["XAU_USD"],
    });

    const ticks: OandaTick[] = [];
    let heartbeats = 0;
    streamer.on("tick", (t) => ticks.push(t));
    streamer.on("heartbeat", () => heartbeats++);

    const hbLine = JSON.stringify({
      type: "HEARTBEAT",
      time: "2026-10-22T15:30:05.000000000Z",
    }) + "\n";

    streamer.processStreamLine(hbLine);

    expect(ticks).toHaveLength(0);
    expect(heartbeats).toBe(1);
    expect(streamer.getLastHeartbeatTime()).not.toBeNull();
  });

  it("aggregates ticks into in-memory 1m completed candles on rollover", () => {
    const streamer = new OandaLiveStreamer({
      accountId: "test-account-123",
      accessToken: "test-token-abc",
      symbols: ["XAU_USD"],
      synthesize1mCandles: true,
    });

    const completedCandles: any[] = [];
    streamer.on("candle_1m", (c) => completedCandles.push(c));

    // Tick 1 at 15:30:10
    streamer.processStreamLine(JSON.stringify({
      type: "PRICE",
      time: "2026-10-22T15:30:10.000Z",
      instrument: "XAU_USD",
      closeoutBid: "2710.00",
      closeoutAsk: "2710.30",
      status: "tradeable",
    }));

    // Tick 2 at 15:30:25 (New high)
    streamer.processStreamLine(JSON.stringify({
      type: "PRICE",
      time: "2026-10-22T15:30:25.000Z",
      instrument: "XAU_USD",
      closeoutBid: "2715.00",
      closeoutAsk: "2715.30",
      status: "tradeable",
    }));

    // Tick 3 at 15:30:40 (New low)
    streamer.processStreamLine(JSON.stringify({
      type: "PRICE",
      time: "2026-10-22T15:30:40.000Z",
      instrument: "XAU_USD",
      closeoutBid: "2708.00",
      closeoutAsk: "2708.30",
      status: "tradeable",
    }));

    // No completed candle yet during the same minute
    expect(completedCandles).toHaveLength(0);

    // Tick 4 at 15:31:02 (Rolls into next minute)
    streamer.processStreamLine(JSON.stringify({
      type: "PRICE",
      time: "2026-10-22T15:31:02.000Z",
      instrument: "XAU_USD",
      closeoutBid: "2712.00",
      closeoutAsk: "2712.30",
      status: "tradeable",
    }));

    // 15:30 minute candle should now be emitted!
    expect(completedCandles).toHaveLength(1);
    const c = completedCandles[0]!;
    expect(c.symbol).toBe("XAU_USD");
    expect(c.open).toBe(2710.15); // (2710.00 + 2710.30) / 2
    expect(c.high).toBe(2715.15);
    expect(c.low).toBe(2708.15);
    expect(c.close).toBe(2708.15);
    expect(c.tickCount).toBe(3);
  });

  it("handles malformed JSON lines without crashing", () => {
    const streamer = new OandaLiveStreamer({
      accountId: "test-account-123",
      accessToken: "test-token-abc",
      symbols: ["XAU_USD"],
    });

    expect(() => streamer.processStreamLine("malformed JSON string{{{")).not.toThrow();
  });
});
