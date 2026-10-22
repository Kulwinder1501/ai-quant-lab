import { describe, expect, it, vi } from "vitest";
import {
  describeSocketError,
  FyersLiveStreamer,
  parseTick,
  reconnectDelayMs,
  type FyersDataSocket,
  type Tick,
} from "./fyers-live-streamer.js";

describe("parseTick", () => {
  it("maps a well-formed quote", () => {
    expect(parseTick({
      symbol: "NSE:NIFTYBANK-INDEX", ltp: 57_739.95, bid_price: 57_739, ask_price: 57_741,
      vol_traded_today: 1_200,
    })).toEqual({
      symbol: "NSE:NIFTYBANK-INDEX", ltp: 57_739.95, bid: 57_739, ask: 57_741, volume: 1_200,
      exchangeFeedTimeSeconds: null, lastTradeTimeSeconds: null,
    });
  });

  it("keeps the feed's clocks, which were previously dropped at this boundary", () => {
    // Sampled live on 2026-08-24: the socket sends `exch_feed_time` and `last_traded_time` on every
    // message, never null, both carrying session times. This function narrowed the payload to five
    // fields, which is why every stored quote could only be timed by our own receipt clock.
    const tick = parseTick({
      symbol: "NSE:NIFTY26AUG24200PE", ltp: 61.5, bid_price: 61.2, ask_price: 61.8,
      vol_traded_today: 12_000, exch_feed_time: 1_787_564_384, last_traded_time: 1_787_564_380,
    });

    expect(tick?.exchangeFeedTimeSeconds).toBe(1_787_564_384);
    expect(tick?.lastTradeTimeSeconds).toBe(1_787_564_380);
  });

  it("treats a zero clock as absent, the same way it treats a zero price", () => {
    // The provider uses 0 for "no value". Epoch zero would date the quote to 1970 and would look
    // like a real timestamp to anything reading the column.
    const tick = parseTick({ symbol: "NSE:SBIN-EQ", ltp: 812, exch_feed_time: 0, last_traded_time: 0 });

    expect(tick?.exchangeFeedTimeSeconds).toBeNull();
    expect(tick?.lastTradeTimeSeconds).toBeNull();
  });

  it("accepts the provider's alternative field names", () => {
    const tick = parseTick({ symbol: "NSE:SBIN-EQ", last_price: 812, best_bid: 811, best_ask: 813, v: 40 });

    expect(tick?.ltp).toBe(812);
    expect(tick?.bid).toBe(811);
    expect(tick?.ask).toBe(813);
    expect(tick?.volume).toBe(40);
  });

  // The defect this replaces: `ltp: message.ltp ?? message.last_price` typed as `number`
  // emitted a Tick whose ltp was undefined. That reached the browser, made the chain's spot
  // undefined, and stopped repricing silently instead of reporting anything.
  it("refuses a message with no usable price rather than emitting undefined as a number", () => {
    expect(parseTick({ symbol: "NSE:SBIN-EQ" })).toBeNull();
    expect(parseTick({ symbol: "NSE:SBIN-EQ", ltp: null })).toBeNull();
    expect(parseTick({ symbol: "NSE:SBIN-EQ", ltp: "not-a-number" })).toBeNull();
  });

  it("refuses a zero or negative price, which the provider uses for 'no quote'", () => {
    expect(parseTick({ symbol: "NSE:SBIN-EQ", ltp: 0 })).toBeNull();
    expect(parseTick({ symbol: "NSE:SBIN-EQ", ltp: -5 })).toBeNull();
  });

  it("refuses a message with no symbol", () => {
    expect(parseTick({ ltp: 100 })).toBeNull();
    expect(parseTick({ symbol: "   ", ltp: 100 })).toBeNull();
  });

  it("refuses anything that is not an object", () => {
    for (const value of [null, undefined, 42, "tick", []]) {
      expect(parseTick(value)).toBeNull();
    }
  });

  it("reads a zero bid or ask as absent, not as a price of zero", () => {
    const tick = parseTick({ symbol: "NSE:SBIN-EQ", ltp: 812, bid: 0, ask: 0 });

    expect(tick?.bid).toBeNull();
    expect(tick?.ask).toBeNull();
  });

  it("parses numeric strings, because the socket sends both", () => {
    expect(parseTick({ symbol: "NSE:SBIN-EQ", ltp: "812.35" })?.ltp).toBe(812.35);
  });
});

describe("reconnectDelayMs", () => {
  it("backs off exponentially from five seconds", () => {
    expect(reconnectDelayMs(1)).toBe(5_000);
    expect(reconnectDelayMs(2)).toBe(10_000);
    expect(reconnectDelayMs(3)).toBe(20_000);
  });

  it("caps at five minutes so a lapsed credential cannot be retried forever at speed", () => {
    // Fyers auth lapses every 15 days with no non-interactive path. At a fixed 5s, an
    // overnight failure was thousands of `getAccessToken()` calls, each taking a row lock
    // and able to spend a refresh against the provider.
    expect(reconnectDelayMs(20)).toBe(300_000);
    expect(reconnectDelayMs(1_000)).toBe(300_000);
  });

  it("treats a non-positive attempt as the first", () => {
    expect(reconnectDelayMs(0)).toBe(5_000);
    expect(reconnectDelayMs(-3)).toBe(5_000);
  });
});

/** A stand-in for the vendor socket, so the reconnect path needs no network. */
function fakeSocket(): FyersDataSocket & {
  fire: (event: string, payload?: unknown) => void;
  subscribed: string[][];
  connected: boolean;
} {
  const listeners = new Map<string, Array<(payload?: unknown) => void>>();
  const socket = {
    connected: false,
    subscribed: [] as string[][],
    on(event: string, listener: (payload?: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    connect() { /* the handshake is confirmed by the "connect" event */ },
    close() { socket.connected = false; },
    subscribe(symbols: string[]) { socket.subscribed.push(symbols); },
    unsubscribe() { /* not asserted here */ },
    isConnected() { return socket.connected; },
    fire(event: string, payload?: unknown) {
      // Only the event flips the flag, as with the real socket: calling connect starts a
      // handshake and the event confirms it. Setting it inside connect() made isConnected()
      // true before any handshake and hid whether the streamer guards its sends.
      if (event === "connect") socket.connected = true;
      if (event === "close") socket.connected = false;
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
  };
  return socket;
}

/** Captures scheduled reconnects so a test can advance them deliberately. */
interface Scheduled { delays: number[]; run: () => Promise<void> }

function scheduler(): Scheduled {
  return { delays: [], run: async () => undefined };
}

function build(socket: FyersDataSocket, scheduled: Scheduled) {
  return new FyersLiveStreamer({
    appId: "APPID-100",
    tokenService: { getAccessToken: vi.fn(async () => "access-token") },
    createSocket: () => socket,
    // Packets are sent inline here; the pacing has its own tests below.
    subscribeSpacingMs: 0,
    setTimeoutFn: (handler, ms) => {
      scheduled.delays.push(ms);
      // Held rather than run inline, which would recurse through connect on every close.
      scheduled.run = async () => { handler(); await Promise.resolve(); };
      return 0;
    },
  });
}

describe("FyersLiveStreamer", () => {
  it("emits only ticks that parsed, and counts the rest", async () => {
    const socket = fakeSocket();
    const streamer = build(socket, scheduler());
    const ticks: Tick[] = [];
    streamer.on("tick", (tick: Tick) => ticks.push(tick));

    await streamer.connect();
    socket.fire("message", { symbol: "NSE:SBIN-EQ", ltp: 812 });
    socket.fire("message", { symbol: "NSE:SBIN-EQ" });
    socket.fire("message", "garbage");

    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.ltp).toBe(812);
    expect(streamer.droppedMessageCount()).toBe(2);
  });

  it("backs off further on each successive close", async () => {
    const sched = scheduler();
    const socket = fakeSocket();
    const streamer = build(socket, sched);

    await streamer.connect();
    socket.fire("close");
    // Advance the scheduled reconnect; no "connect" event follows, so it fails again.
    await sched.run();
    socket.fire("close");

    expect(sched.delays).toEqual([5_000, 10_000]);
  });

  it("resets the backoff only once a connection actually succeeds", async () => {
    const sched = scheduler();
    const socket = fakeSocket();
    const streamer = build(socket, sched);

    await streamer.connect();
    socket.fire("close");
    await sched.run();
    socket.fire("connect");
    socket.fire("close");

    // The second close is attempt 1 again, because "connect" landed in between.
    expect(sched.delays).toEqual([5_000, 5_000]);
  });

  it("resubscribes on reconnect, so a dropped socket does not silently stop the stream", async () => {
    const sched = scheduler();
    const socket = fakeSocket();
    const streamer = build(socket, sched);

    await streamer.connect();
    socket.fire("connect");
    streamer.subscribe(["NSE:SBIN-EQ", "NSE:NIFTYBANK-INDEX"]);
    socket.fire("close");
    await sched.run();
    socket.fire("connect");

    // Last resubscribe carries both symbols.
    expect(socket.subscribed.at(-1)).toEqual(["NSE:SBIN-EQ", "NSE:NIFTYBANK-INDEX"]);
  });

  it("schedules a reconnect when the token cannot be read at all", async () => {
    const delays: number[] = [];
    const streamer = new FyersLiveStreamer({
      appId: "APPID-100",
      tokenService: { getAccessToken: vi.fn(async () => { throw new Error("refresh token expired"); }) },
      createSocket: () => fakeSocket(),
      setTimeoutFn: (_handler, ms) => { delays.push(ms); return 0; },
    });

    // Must not reject: a scheduler-owned stream that throws on connect takes the process down.
    await expect(streamer.connect()).resolves.toBeUndefined();
    expect(delays).toEqual([5_000]);
  });

  it("stays closed after close(), rather than reading its own shutdown as a drop", async () => {
    // close() fires the vendor's "close" event -- the same one a network drop fires. Without a
    // deliberate-shutdown flag the streamer dialled back in forever, and each attempt asked an
    // already-ended pool for a token.
    const socket = fakeSocket();
    const scheduled = scheduler();
    const streamer = build(socket, scheduled);

    await streamer.connect();
    socket.fire("connect");
    streamer.close();
    socket.fire("close");

    expect(scheduled.delays).toEqual([]);

    // And a later connect() cannot revive it.
    await streamer.connect();
    expect(scheduled.delays).toEqual([]);
  });

  it("does not send to a socket whose handshake has not completed", async () => {
    // Sending to an unopened socket throws inside the vendor library.
    const socket = fakeSocket();
    const streamer = build(socket, scheduler());

    await streamer.connect();
    streamer.subscribe(["NSE:SBIN-EQ"]);

    expect(socket.subscribed).toEqual([]);
  });

  it("sends subscription packets one at a time, spaced apart, even when two callers queue at once", async () => {
    const socket = fakeSocket();
    const timers: Array<() => void> = [];
    const delays: number[] = [];
    const streamer = new FyersLiveStreamer({
      appId: "APPID-100",
      tokenService: { getAccessToken: vi.fn(async () => "access-token") },
      createSocket: () => socket,
      subscribeSpacingMs: 300,
      setTimeoutFn: (handler, ms) => { timers.push(handler); delays.push(ms); return 0; },
    });
    await streamer.connect();
    socket.fire("connect");

    const chainA = Array.from({ length: 45 }, (_, i) => `NSE:NIFTY26OCT${22000 + i * 50}CE`);
    const chainB = Array.from({ length: 45 }, (_, i) => `NSE:BANKNIFTY26OCT${54000 + i * 100}CE`);
    streamer.subscribe(chainA);
    streamer.subscribe(chainB);

    // Only the first packet leaves at once; the other five wait their turn.
    expect(socket.subscribed).toHaveLength(1);
    expect(socket.subscribed[0]).toEqual(chainA.slice(0, 20));

    while (timers.length > 0) timers.shift()!();
    expect(socket.subscribed.map((packet) => packet.length)).toEqual([20, 20, 5, 20, 20, 5]);
    // Order is preserved: A's packets, then B's, never interleaved.
    expect(socket.subscribed[3]).toEqual(chainB.slice(0, 20));
    expect(delays.every((ms) => ms === 300)).toBe(true);
  });

  it("drops what was queued for a socket that has gone and sends everything wanted again on reconnect", async () => {
    const socket = fakeSocket();
    const timers: Array<() => void> = [];
    const streamer = new FyersLiveStreamer({
      appId: "APPID-100",
      tokenService: { getAccessToken: vi.fn(async () => "access-token") },
      createSocket: () => socket,
      subscribeSpacingMs: 300,
      setTimeoutFn: (handler) => { timers.push(handler); return 0; },
    });
    await streamer.connect();
    socket.fire("connect");
    streamer.subscribe(Array.from({ length: 45 }, (_, i) => `NSE:S${i}`));
    expect(socket.subscribed).toHaveLength(1);

    socket.fire("close");
    // The pending packets run against a socket that is gone and send nothing.
    while (timers.length > 0) timers.shift()!();
    expect(socket.subscribed).toHaveLength(1);
  });

  it("chunks large subscription batches into sizes under Fyers frame limits", async () => {
    const socket = fakeSocket();
    const streamer = build(socket, scheduler());

    await streamer.connect();
    socket.fire("connect");

    const manySymbols = Array.from({ length: 45 }, (_, i) => `NSE:BANKNIFTY26OCT${50000 + i * 100}CE`);
    streamer.subscribe(manySymbols);

    // 45 symbols chunked into 20, 20, 5
    expect(socket.subscribed).toHaveLength(3);
    expect(socket.subscribed[0]).toHaveLength(20);
    expect(socket.subscribed[1]).toHaveLength(20);
    expect(socket.subscribed[2]).toHaveLength(5);
  });
});

describe("describeSocketError", () => {
  it("prints an object error's content instead of [object Object]", () => {
    expect(describeSocketError({ s: "error", code: -300, message: "bad symbol" })).toBe('{"s":"error","code":-300,"message":"bad symbol"}');
  });

  it("uses an Error's message and passes a string through", () => {
    expect(describeSocketError(new Error("boom"))).toBe("boom");
    expect(describeSocketError("plain")).toBe("plain");
  });
});

describe("describeSocketError with an event-like object", () => {
  it("reads non-enumerable fields instead of answering {}", () => {
    const event = Object.create({}, { message: { value: "ECONNRESET", enumerable: false }, type: { value: "error", enumerable: false } });
    expect(describeSocketError(event)).toContain("ECONNRESET");
  });

  it("names the object when nothing is readable", () => {
    expect(describeSocketError(new (class Closed {})())).toBe("Closed with no readable fields");
  });
});

describe("FyersLiveStreamer socket slot recycling", () => {
  function setup(limit: number) {
    const sockets: Array<ReturnType<typeof fakeSocket>> = [];
    const timers: Array<() => void> = [];
    let nowMs = 1_000_000;
    const streamer = new FyersLiveStreamer({
      appId: "APPID-100",
      tokenService: { getAccessToken: vi.fn(async () => "access-token") },
      createSocket: () => { const s = fakeSocket(); sockets.push(s); return s; },
      subscribeSpacingMs: 0,
      socketSlotLimit: limit,
      nowFn: () => nowMs,
      setTimeoutFn: (handler) => { timers.push(handler); return 0; },
    });
    const symbols = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `NSE:${prefix}${i}`);
    const flush = async () => { while (timers.length > 0) { timers.shift()!(); await Promise.resolve(); await Promise.resolve(); } };
    return { streamer, sockets, symbols, flush, advance: (ms: number) => { nowMs += ms; } };
  }

  it("replaces the socket when churned strikes have used the slots, and resubscribes only what is wanted now", async () => {
    const { streamer, sockets, symbols, flush } = setup(60);
    await streamer.connect();
    sockets[0]!.fire("connect");
    streamer.subscribe(symbols("A", 27));
    streamer.unsubscribe(symbols("A", 27));
    streamer.subscribe(symbols("B", 27));
    streamer.unsubscribe(symbols("B", 27));
    // 54 slots are used and nothing is wanted. Asking for 27 more would pass 60 on the old connection.
    streamer.subscribe(symbols("C", 27));
    expect(sockets[0]!.connected).toBe(false); // closed to recycle
    expect(sockets[0]!.subscribed.flat().filter((s) => s.startsWith("NSE:C"))).toEqual([]); // not sent to the full socket

    sockets[0]!.fire("close");
    await flush();
    expect(sockets).toHaveLength(2);
    sockets[1]!.fire("connect");
    expect(sockets[1]!.subscribed.flat().sort()).toEqual(symbols("C", 27).sort());
  });

  it("does not replace the socket while the slots are not exhausted", async () => {
    const { streamer, sockets, symbols } = setup(60);
    await streamer.connect();
    sockets[0]!.fire("connect");
    streamer.subscribe(symbols("A", 27));
    streamer.subscribe(symbols("B", 27));
    expect(sockets[0]!.connected).toBe(true);
    expect(sockets[0]!.subscribed.flat()).toHaveLength(54);
  });

  it("does not count a symbol twice when it is requested again on the same connection", async () => {
    const { streamer, sockets, symbols } = setup(60);
    await streamer.connect();
    sockets[0]!.fire("connect");
    for (let i = 0; i < 10; i += 1) streamer.subscribe(symbols("A", 27));
    expect(sockets[0]!.connected).toBe(true);
  });

  it("does not reconnect in a loop when what is wanted cannot fit on one socket", async () => {
    const { streamer, sockets, symbols } = setup(60);
    await streamer.connect();
    sockets[0]!.fire("connect");
    streamer.subscribe(symbols("A", 61));
    expect(sockets[0]!.connected).toBe(true);
    streamer.subscribe(symbols("B", 5));
    expect(sockets).toHaveLength(1);
  });

  it("replaces the socket at most once a minute", async () => {
    const { streamer, sockets, symbols, flush, advance } = setup(60);
    await streamer.connect();
    sockets[0]!.fire("connect");
    streamer.subscribe(symbols("A", 50));
    streamer.unsubscribe(symbols("A", 50));
    streamer.subscribe(symbols("B", 30)); // 80 > 60: recycle
    sockets[0]!.fire("close");
    await flush();
    sockets[1]!.fire("connect");
    streamer.unsubscribe(symbols("B", 30));
    streamer.subscribe(symbols("C", 40));
    streamer.unsubscribe(symbols("C", 40));
    streamer.subscribe(symbols("D", 40)); // would pass 60 again, but only seconds after the last recycle
    expect(sockets[1]!.connected).toBe(true);
    advance(61_000);
    streamer.unsubscribe(symbols("D", 40));
    streamer.subscribe(symbols("E", 40));
    expect(sockets[1]!.connected).toBe(false);
  });
});
