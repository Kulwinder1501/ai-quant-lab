import { afterEach, describe, expect, it, vi } from "vitest";
import { OandaHistoricalDataProvider } from "./oanda-historical-data-provider.js";
import type { HistoricalMarketDataRequest } from "../../modules/market-data/domain/historical-data-provider.js";

const TOKEN = "super-secret-token-value";

const request = {
  providerInstrumentId: "XAU_USD",
  timeframe: "1m",
  from: new Date("2026-10-13T07:00:00.000Z"),
  to: new Date("2026-10-13T07:01:00.000Z"),
} as unknown as HistoricalMarketDataRequest;

function candlesResponse(): Response {
  return new Response(JSON.stringify({
    candles: [{ time: "2026-10-13T07:00:00.000000000Z", mid: { o: "4000", h: "4001", l: "3999", c: "4000.5" }, volume: 12, complete: true }],
  }), { status: 200 });
}

function refusal(status: number, statusText: string, body = "", requestId?: string): Response {
  return new Response(body, { status, statusText, headers: requestId ? { "x-request-id": requestId } : {} });
}

/** A provider whose fetch plays back `responses` in order, and whose sleeps are recorded, not waited for. */
function build(responses: Array<Response | Error>, options: { maxRetries?: number; maxTransientRetries?: number } = {}) {
  const queue = [...responses];
  const fetchMock = vi.fn(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("fetch called more times than the test planned");
    if (next instanceof Error) throw next;
    return next;
  });
  const sleeps: number[] = [];
  const provider = new OandaHistoricalDataProvider({
    accessToken: TOKEN,
    environment: "practice",
    fetch: fetchMock as unknown as typeof fetch,
    sleep: async (ms) => { sleeps.push(ms); },
    ...options,
  });
  return { provider, fetchMock, sleeps };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("OandaHistoricalDataProvider retries", () => {
  it("retries a 401 and returns the candles once OANDA accepts the same token", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { provider, fetchMock, sleeps } = build([refusal(401, "Unauthorized"), refusal(401, "Unauthorized"), candlesResponse()]);

    const candles = await provider.fetchCandles(request);

    expect(candles).toHaveLength(1);
    expect(candles[0]!.close).toBe("4000.5");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("gives up after the retries when the token really is refused every time", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { provider, fetchMock } = build([refusal(401, "Unauthorized"), refusal(401, "Unauthorized"), refusal(401, "Unauthorized")]);

    await expect(provider.fetchCandles(request)).rejects.toThrow("OANDA candles failed: 401 Unauthorized");
    expect(fetchMock).toHaveBeenCalledTimes(3); // the first attempt and two retries, no more
  });

  it.each([502, 503, 504])("retries a %i gateway error", async (status) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { provider, fetchMock } = build([refusal(status, "Bad Gateway"), candlesResponse()]);

    await expect(provider.fetchCandles(request)).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a refusal that repeating cannot fix", async () => {
    const { provider, fetchMock } = build([refusal(403, "Forbidden")]);

    await expect(provider.fetchCandles(request)).rejects.toThrow("OANDA candles failed: 403 Forbidden");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still treats a bad range or symbol (400/404) as no candles rather than an error", async () => {
    for (const status of [400, 404]) {
      const { provider, fetchMock } = build([refusal(status, "Bad")]);
      await expect(provider.fetchCandles(request)).resolves.toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps backing off on a 429 up to maxRetries, as before", async () => {
    const { provider, fetchMock, sleeps } = build([
      refusal(429, "Too Many Requests"), refusal(429, "Too Many Requests"), refusal(429, "Too Many Requests"), refusal(429, "Too Many Requests"),
    ]);

    await expect(provider.fetchCandles(request)).rejects.toThrow("OANDA candles failed: 429");
    expect(fetchMock).toHaveBeenCalledTimes(4); // one attempt plus three retries
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it("retries a dropped connection, and rethrows once the retries are spent", async () => {
    const { provider, fetchMock } = build([new Error("socket hang up"), candlesResponse()]);
    await expect(provider.fetchCandles(request)).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const failing = build(Array.from({ length: 4 }, () => new Error("socket hang up")));
    await expect(failing.provider.fetchCandles(request)).rejects.toThrow("socket hang up");
  });

  it("gives each kind of failure its own budget", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // A 429, a 401 and a dropped connection in one request: none of them uses up another's retries.
    const { provider, fetchMock } = build([refusal(429, "Too Many Requests"), refusal(401, "Unauthorized"), new Error("reset"), candlesResponse()]);

    await expect(provider.fetchCandles(request)).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("OandaHistoricalDataProvider refusal reporting", () => {
  it("logs what OANDA said and its request id for every refused attempt, never the token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { provider } = build([
      refusal(401, "Unauthorized", '{"errorMessage":"Insufficient authorization to perform request."}', "req-abc-123"),
      candlesResponse(),
    ]);

    await provider.fetchCandles(request);

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    const logged = JSON.parse(line) as Record<string, unknown>;
    expect(logged).toMatchObject({ status: 401, requestId: "req-abc-123", message: "OANDA refused a request; retrying", attempt: 1, maxAttempts: 3 });
    expect(String(logged.body)).toContain("Insufficient authorization");
    expect(line).not.toContain(TOKEN);
  });

  it("says it is giving up on the last attempt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { provider } = build([refusal(504, "Gateway Timeout"), refusal(504, "Gateway Timeout"), refusal(504, "Gateway Timeout")]);

    await expect(provider.fetchCandles(request)).rejects.toThrow("504");

    const messages = warn.mock.calls.map((call) => (JSON.parse(String(call[0])) as { message: string }).message);
    expect(messages).toEqual([
      "OANDA refused a request; retrying",
      "OANDA refused a request; retrying",
      "OANDA refused a request; giving up",
    ]);
  });

  it("puts OANDA's explanation in the final error, after the text job history matches on", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const body = '{"errorMessage":"Insufficient authorization to perform request."}';
    const { provider } = build([
      refusal(401, "Unauthorized", body, "req-1"), refusal(401, "Unauthorized", body, "req-2"), refusal(401, "Unauthorized", body, "req-3"),
    ]);

    const error = (await provider.fetchCandles(request).then(() => null, (caught: unknown) => caught)) as Error;

    expect(error.message.startsWith("OANDA candles failed: 401 Unauthorized")).toBe(true);
    expect(error.message).toContain("request id req-3");
    expect(error.message).toContain("Insufficient authorization");
    expect(error.message).not.toContain(TOKEN);
  });

  it("does not log anything on the ordinary success path", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { provider } = build([candlesResponse()]);
    await provider.fetchCandles(request);
    expect(warn).not.toHaveBeenCalled();
  });
});
