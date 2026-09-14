import { describe, expect, it, vi } from "vitest";
import { FyersHistoricalDataProvider } from "./fyers-historical-data-provider.js";

const NOW = new Date("2026-08-03T06:00:00.000Z");

function okBody(candles: Array<[number, number, number, number, number, number]>) {
  return new Response(JSON.stringify({ s: "ok", candles }), { status: 200 });
}

function build(options: {
  fetch: typeof fetch;
  maxDaysPerRequest?: number;
  getAccessToken?: () => Promise<string>;
  now?: Date;
}) {
  const getAccessToken = vi.fn(options.getAccessToken ?? (async () => "access-token"));
  const provider = new FyersHistoricalDataProvider({
    tokenService: { getAccessToken },
    appId: "APPID-100",
    fetch: options.fetch,
    maxDaysPerRequest: options.maxDaysPerRequest,
    now: () => options.now ?? NOW,
  });
  return { provider, getAccessToken };
}

describe("FyersHistoricalDataProvider", () => {
  it("converts epoch-second candles and derives close time from the timeframe", async () => {
    const requested: string[] = [];
    const { provider } = build({
      fetch: async (input) => {
        requested.push(String(input));
        // 2026-07-01T09:15:00+05:30 → 03:45 UTC
        return okBody([[1782012600, 100.5, 101.25, 99.75, 100.9, 4321]]);
      },
    });

    const result = await provider.fetchCandles({
      providerInstrumentId: "NIFTY50",
      timeframe: "5m",
      from: new Date("2026-07-01T00:00:00Z"),
      to: new Date("2026-07-02T00:00:00Z"),
    });

    expect(requested[0]).toContain("symbol=NSE%3ANIFTY50-INDEX");
    expect(requested[0]).toContain("resolution=5");
    expect(result).toHaveLength(1);
    expect(result[0].openTime).toEqual(new Date(1782012600 * 1000));
    expect(result[0].closeTime.getTime() - result[0].openTime.getTime()).toBe(5 * 60_000);
    expect(result[0]).toMatchObject({ open: "100.5", high: "101.25", low: "99.75", close: "100.9", volume: "4321" });
  });

  // cont_flag=1 makes Fyers invent bars for periods a contract never traded and
  // back-adjust the ones it did, by an undocumented method. Both are disqualifying:
  // the invented bars are fabricated evidence, and a back-adjusted price embeds roll
  // factors fixed after its own timestamp.
  it("never requests Fyers' pre-stitched continuous series", async () => {
    let contFlag: string | null = null;
    const { provider } = build({
      fetch: async (input) => {
        contFlag = new URL(String(input)).searchParams.get("cont_flag");
        return okBody([]);
      },
    });

    await provider.fetchCandles({
      providerInstrumentId: "NSE:NIFTY26AUGFUT",
      timeframe: "5m",
      from: new Date("2026-07-01T00:00:00Z"),
      to: new Date("2026-07-02T00:00:00Z"),
    });

    expect(contFlag).toBe("0");
  });

  it("chunks a long intraday range and resolves the access token only once", async () => {
    const ranges: Array<[string, string]> = [];
    const { provider, getAccessToken } = build({
      maxDaysPerRequest: 100,
      fetch: async (input) => {
        const url = new URL(String(input));
        ranges.push([url.searchParams.get("range_from")!, url.searchParams.get("range_to")!]);
        return okBody([]);
      },
    });

    await provider.fetchCandles({
      providerInstrumentId: "SBIN",
      timeframe: "1m",
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-06-30T00:00:00Z"),
    });

    expect(ranges).toEqual([
      ["2026-01-01", "2026-04-10"],
      ["2026-04-11", "2026-06-30"],
    ]);
    // One refresh must serve every chunk, not one per chunk.
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it("requests the current NSE date so completed intraday bars are not delayed a day", async () => {
    const ranges: string[] = [];
    const { provider } = build({
      fetch: async (input) => {
        ranges.push(new URL(String(input)).searchParams.get("range_to")!);
        return okBody([]);
      },
    });

    await provider.fetchCandles({
      providerInstrumentId: "SBIN",
      timeframe: "15m",
      from: new Date("2026-07-30T00:00:00Z"),
      to: new Date("2026-12-31T00:00:00Z"),
    });

    expect(ranges).toEqual(["2026-08-03"]);
  });

  it("includes today's daily candle only after the NSE cash close", async () => {
    const ranges: string[] = [];
    const { provider } = build({
      now: new Date("2026-08-03T11:00:00.000Z"), // 16:30 IST
      fetch: async (input) => {
        ranges.push(new URL(String(input)).searchParams.get("range_to")!);
        return okBody([]);
      },
    });

    await provider.fetchCandles({
      providerInstrumentId: "SBIN",
      timeframe: "1d",
      from: new Date("2026-08-01T00:00:00Z"),
      to: new Date("2026-12-31T00:00:00Z"),
    });

    expect(ranges).toEqual(["2026-08-03"]);
  });

  it("returns nothing rather than calling out when the whole range is in the future", async () => {
    const fetchSpy = vi.fn(async () => okBody([]));
    const { provider, getAccessToken } = build({ fetch: fetchSpy });

    const result = await provider.fetchCandles({
      providerInstrumentId: "SBIN",
      timeframe: "5m",
      from: new Date("2026-09-01T00:00:00Z"),
      to: new Date("2026-09-30T00:00:00Z"),
    });

    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  // Fyers reports failures in the body with HTTP 200; trusting response.ok alone
  // would turn an error payload into zero silently-missing candles.
  it("treats an error body as a failure even when the status is 200", async () => {
    const { provider } = build({
      fetch: async () => new Response(
        JSON.stringify({ s: "error", code: -300, message: "invalid symbol" }),
        { status: 200 },
      ),
    });

    await expect(provider.fetchCandles({
      providerInstrumentId: "NOSUCH",
      timeframe: "5m",
      from: new Date("2026-07-01T00:00:00Z"),
      to: new Date("2026-07-02T00:00:00Z"),
    })).rejects.toThrow(/code -300.*invalid symbol/s);
  });

  it("sends the colon-joined Fyers authorization header, not Kite's token prefix", async () => {
    let authorization: string | undefined;
    const { provider } = build({
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? undefined;
        return okBody([]);
      },
    });

    await provider.fetchCandles({
      providerInstrumentId: "NIFTY50",
      timeframe: "5m",
      from: new Date("2026-07-01T00:00:00Z"),
      to: new Date("2026-07-02T00:00:00Z"),
    });

    expect(authorization).toBe("APPID-100:access-token");
  });

  // Fyers answers 429 after a burst of roughly a dozen requests, and a multi-year 1m
  // backfill is thousands. Without backoff the campaign dies partway and leaves a
  // half-filled series indistinguishable from a provider gap.
  it("retries a 429 with backoff and then succeeds", async () => {
    const waits: number[] = [];
    let calls = 0;
    const provider = new FyersHistoricalDataProvider({
      tokenService: { getAccessToken: async () => "access-token" },
      appId: "APPID-100",
      now: () => NOW,
      sleep: async (ms) => { waits.push(ms); },
      fetch: async () => {
        calls += 1;
        if (calls <= 2) {
          return new Response(JSON.stringify({ s: "error", code: 429, message: "request limit reached" }), { status: 429 });
        }
        return okBody([[1782012600, 1, 2, 0.5, 1.5, 10]]);
      },
    });

    const result = await provider.fetchCandles({
      providerInstrumentId: "NIFTY50",
      timeframe: "5m",
      from: new Date("2026-07-01T00:00:00Z"),
      to: new Date("2026-07-02T00:00:00Z"),
    });

    expect(calls).toBe(3);
    expect(waits).toEqual([1000, 2000]);
    expect(result).toHaveLength(1);
  });

  it("retries a transient network failure before succeeding", async () => {
    const waits: number[] = [];
    let calls = 0;
    const provider = new FyersHistoricalDataProvider({
      tokenService: { getAccessToken: async () => "access-token" },
      appId: "APPID-100",
      now: () => NOW,
      sleep: async (ms) => { waits.push(ms); },
      fetch: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed");
        return okBody([[1782012600, 1, 2, 0.5, 1.5, 10]]);
      },
    });

    const result = await provider.fetchCandles({
      providerInstrumentId: "NIFTY50",
      timeframe: "5m",
      from: new Date("2026-07-01T00:00:00Z"),
      to: new Date("2026-07-02T00:00:00Z"),
    });

    expect(calls).toBe(2);
    expect(waits).toEqual([1000]);
    expect(result).toHaveLength(1);
  });

  it("honours Retry-After when Fyers supplies it", async () => {
    const waits: number[] = [];
    let calls = 0;
    const provider = new FyersHistoricalDataProvider({
      tokenService: { getAccessToken: async () => "access-token" },
      appId: "APPID-100",
      now: () => NOW,
      sleep: async (ms) => { waits.push(ms); },
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ s: "error", code: 429 }), {
            status: 429,
            headers: { "retry-after": "7" },
          });
        }
        return okBody([]);
      },
    });

    await provider.fetchCandles({
      providerInstrumentId: "NIFTY50",
      timeframe: "5m",
      from: new Date("2026-07-01T00:00:00Z"),
      to: new Date("2026-07-02T00:00:00Z"),
    });

    expect(waits).toEqual([7000]);
  });

  it("gives up after the retry budget and reports the rate limit", async () => {
    const provider = new FyersHistoricalDataProvider({
      tokenService: { getAccessToken: async () => "access-token" },
      appId: "APPID-100",
      now: () => NOW,
      sleep: async () => undefined,
      maxRetries: 2,
      fetch: async () => new Response(
        JSON.stringify({ s: "error", code: 429, message: "request limit reached" }),
        { status: 429 },
      ),
    });

    await expect(provider.fetchCandles({
      providerInstrumentId: "NIFTY50",
      timeframe: "5m",
      from: new Date("2026-07-01T00:00:00Z"),
      to: new Date("2026-07-02T00:00:00Z"),
    })).rejects.toThrow(/429|request limit/);
  });

  it("maps a daily candle to the NSE cash session span", async () => {
    const { provider } = build({ fetch: async () => okBody([[1782012600, 1, 2, 0.5, 1.5, 10]]) });

    const result = await provider.fetchCandles({
      providerInstrumentId: "NIFTY50",
      timeframe: "1d",
      from: new Date("2026-07-01T00:00:00Z"),
      to: new Date("2026-07-02T00:00:00Z"),
    });

    expect(result[0].openTime.getUTCHours()).toBe(3);
    expect(result[0].openTime.getUTCMinutes()).toBe(45);
    expect(result[0].closeTime.getTime() - result[0].openTime.getTime()).toBe(6 * 60 * 60_000 + 15 * 60_000);
  });
});
