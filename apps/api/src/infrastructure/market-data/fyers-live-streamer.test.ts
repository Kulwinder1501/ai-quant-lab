import { describe, expect, it, vi } from "vitest";
import {
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
    });
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

  it("does not send to a socket whose handshake has not completed", async () => {
    // Sending to an unopened socket throws inside the vendor library.
    const socket = fakeSocket();
    const streamer = build(socket, scheduler());

    await streamer.connect();
    streamer.subscribe(["NSE:SBIN-EQ"]);

    expect(socket.subscribed).toEqual([]);
  });
});
