import { describe, expect, it, vi } from "vitest";
import {
  FyersTbtDepthStreamer,
  type FyersTbtSocketLike,
} from "./fyers-tbt-depth-streamer.js";
import type { DepthFrame } from "../../modules/market-data/domain/depth-frame.js";

class FakeSocket implements FyersTbtSocketLike {
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly subscribed: Array<{ symbols: string[]; channel: string; mode: string }> = [];
  readonly resumedChannels: string[][] = [];
  connectCalls = 0;
  closed = false;
  private connected = false;

  on(event: string, listener: (...args: unknown[]) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  connect(): void {
    this.connectCalls += 1;
    this.connected = true;
  }

  close(): void {
    this.closed = true;
    this.connected = false;
  }

  subscribe(symbols: string[], channel: string, mode: string): void {
    this.subscribed.push({ symbols: [...symbols], channel, mode });
  }

  switchChannel(_paused: string[], resumed: string[]): void {
    this.resumedChannels.push([...resumed]);
  }

  isConnected(): boolean {
    return this.connected;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function depthPayload(overrides: Record<string, unknown> = {}) {
  const pad = (values: number[]) => {
    const out = new Array<number>(50).fill(0);
    values.forEach((value, index) => { out[index] = value; });
    return out;
  };
  return {
    bidprice: pad([100, 99.5]),
    bidqty: pad([10, 20]),
    bidordn: pad([1, 2]),
    askprice: pad([101, 101.5]),
    askqty: pad([15, 25]),
    askordn: pad([1, 3]),
    tbq: 1_000,
    tsq: 2_000,
    snapshot: false,
    timestamp: 1_787_300_311,
    sendtime: 1_787_300_311,
    seqNo: 5,
    ...overrides,
  };
}

function build(options: {
  tokenDelayMs?: number;
  levelsToStore?: number;
  token?: string;
} = {}) {
  const sockets: FakeSocket[] = [];
  const seenTokens: string[] = [];
  const streamer = new FyersTbtDepthStreamer({
    tokenService: {
      getAccessToken: async () => {
        if (options.tokenDelayMs) {
          await new Promise((resolve) => { setTimeout(resolve, options.tokenDelayMs); });
        }
        return options.token ?? "raw-access-token";
      },
    },
    levelsToStore: options.levelsToStore ?? 10,
    createSocket: (accessToken) => {
      seenTokens.push(accessToken);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    // Runs the reconnect immediately rather than after the real backoff, which is the whole
    // point of the injection. Safe here because no fake socket closes itself.
    setTimeoutFn: (handler) => { handler(); return undefined; },
    now: () => new Date("2026-08-21T09:15:00.500Z"),
  });
  return { streamer, sockets, seenTokens };
}

describe("FyersTbtDepthStreamer", () => {
  it("authenticates with the bare access token, not appId:token", () => {
    // Convention 1. Passing the HSM form connects and then delivers nothing, with no error event --
    // so only a test can hold this property.
    const { streamer, seenTokens } = build();
    streamer.subscribe(["NSE:BANKNIFTY26AUGFUT"]);

    return vi.waitFor(() => {
      expect(seenTokens).toEqual(["raw-access-token"]);
    });
  });

  it("subscribes with a string channel and then resumes it", async () => {
    // Conventions 2-4: a subscription that is never resumed is silently inert.
    const { streamer, sockets } = build();
    streamer.subscribe(["NSE:BANKNIFTY26AUGFUT"]);
    await vi.waitFor(() => { expect(sockets).toHaveLength(1); });

    sockets[0]!.emit("open");

    expect(sockets[0]!.subscribed).toEqual([
      { symbols: ["NSE:BANKNIFTY26AUGFUT"], channel: "1", mode: "depth" },
    ]);
    expect(sockets[0]!.resumedChannels).toEqual([["1"]]);
  });

  it("opens only one socket when subscribe and connect race", async () => {
    // The bug this guard exists for, observed live: subscribe() starts a connect for a newly wanted
    // symbol, the caller awaits connect() itself, getAccessToken() suspends, and both callers see a
    // null socket. Two sockets bound to one emitter would double-count and double-persist frames.
    const { streamer, sockets } = build({ tokenDelayMs: 20 });

    streamer.subscribe(["NSE:BANKNIFTY26AUGFUT"]);
    await streamer.connect();
    await new Promise((resolve) => { setTimeout(resolve, 60); });

    expect(sockets).toHaveLength(1);
  });

  it("emits a parsed frame with our own receive clock", async () => {
    const { streamer, sockets } = build();
    const frames: DepthFrame[] = [];
    streamer.on("frame", (frame: DepthFrame) => { frames.push(frame); });

    streamer.subscribe(["NSE:X"]);
    await vi.waitFor(() => { expect(sockets).toHaveLength(1); });
    sockets[0]!.emit("open");
    sockets[0]!.emit("depth", "NSE:X", depthPayload());

    expect(frames).toHaveLength(1);
    expect(frames[0]!.providerSymbol).toBe("NSE:X");
    expect(frames[0]!.sequenceNo).toBe(5);
    expect(frames[0]!.bidQty[0]).toBe(10);
    expect(frames[0]!.receivedAt.toISOString()).toBe("2026-08-21T09:15:00.500Z");
    expect(streamer.stats().framesReceived).toBe(1);
  });

  it("counts an unusable payload instead of emitting or logging it per message", async () => {
    const { streamer, sockets } = build();
    const frames: DepthFrame[] = [];
    streamer.on("frame", (frame: DepthFrame) => { frames.push(frame); });

    streamer.subscribe(["NSE:X"]);
    await vi.waitFor(() => { expect(sockets).toHaveLength(1); });
    sockets[0]!.emit("open");
    sockets[0]!.emit("depth", "NSE:X", { bidprice: new Array(50).fill(0), askprice: new Array(50).fill(0) });
    sockets[0]!.emit("depth", "", depthPayload());

    expect(frames).toHaveLength(0);
    expect(streamer.stats().droppedMessages).toBe(2);
  });

  it("truncates to the requested level count", async () => {
    const { streamer, sockets } = build({ levelsToStore: 1 });
    const frames: DepthFrame[] = [];
    streamer.on("frame", (frame: DepthFrame) => { frames.push(frame); });

    streamer.subscribe(["NSE:X"]);
    await vi.waitFor(() => { expect(sockets).toHaveLength(1); });
    sockets[0]!.emit("open");
    sockets[0]!.emit("depth", "NSE:X", depthPayload());

    expect(frames[0]!.levelsStored).toBe(1);
    expect(frames[0]!.levelsAvailable).toBe(2);
  });

  it("resubscribes everything it still wants after a reconnect", async () => {
    const { streamer, sockets } = build();
    streamer.subscribe(["NSE:A", "NSE:B"]);
    await vi.waitFor(() => { expect(sockets).toHaveLength(1); });
    sockets[0]!.emit("open");

    sockets[0]!.emit("close");
    await vi.waitFor(() => { expect(sockets).toHaveLength(2); });
    sockets[1]!.emit("open");

    expect(sockets[1]!.subscribed[0]!.symbols.sort()).toEqual(["NSE:A", "NSE:B"]);
    expect(sockets[1]!.resumedChannels).toEqual([["1"]]);
  });

  it("stays closed once closed, so shutdown is not read as a dropped connection", async () => {
    const { streamer, sockets } = build();
    streamer.subscribe(["NSE:X"]);
    await vi.waitFor(() => { expect(sockets).toHaveLength(1); });

    streamer.close();
    expect(sockets[0]!.closed).toBe(true);

    await streamer.connect();
    expect(sockets).toHaveLength(1);
  });

  it("ignores a blank or duplicate subscription request", async () => {
    const { streamer, sockets } = build();
    streamer.subscribe(["NSE:X"]);
    await vi.waitFor(() => { expect(sockets).toHaveLength(1); });
    sockets[0]!.emit("open");

    streamer.subscribe(["NSE:X"]);
    streamer.subscribe(["   "]);
    streamer.subscribe([]);

    // Only the original activation; re-subscribing a held symbol would gap its series for no reason.
    expect(sockets[0]!.subscribed).toHaveLength(1);
  });
});
