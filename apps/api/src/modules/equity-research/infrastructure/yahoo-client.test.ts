import { describe, expect, it, vi } from "vitest";
import { YahooClient } from "./yahoo-client.js";

describe("YahooClient rate gate, budget, breaker and call discipline (Gates G9, S1, S5, S7)", () => {
  it("rejects invalid symbols prior to any network call (Gate S1)", async () => {
    const fetchMock = vi.fn();
    const client = new YahooClient({ fetchFn: fetchMock as any });

    await expect(client.fetchChart("SUZLON;DROP", "NSE")).rejects.toThrow(/failed validation/);
    await expect(client.fetchChart("lowercase", "NSE")).rejects.toThrow(/failed validation/);
    await expect(client.fetchChart("", "NSE")).rejects.toThrow(/failed validation/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces rate gate with minimum interval between calls", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ chart: { result: [] } }), { status: 200 });
    });

    const client = new YahooClient({
      fetchFn: fetchMock as any,
      minIntervalMs: 50, // Short interval for unit test
    });

    const t0 = Date.now();
    await client.fetchChart("SUZLON", "NSE");
    await client.fetchChart("TCS", "NSE");
    const elapsed = Date.now() - t0;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeGreaterThanOrEqual(45);
  });

  it("enforces daily budget cap without hitting network once budget exhausted", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ chart: { result: [] } }), { status: 200 });
    });

    const client = new YahooClient({
      fetchFn: fetchMock as any,
      maxDailyBudget: 2,
      minIntervalMs: 0,
    });

    await client.fetchChart("SUZLON", "NSE");
    await client.fetchChart("TCS", "NSE");
    expect(client.getCallsToday()).toBe(2);

    await expect(client.fetchChart("RELIANCE", "NSE")).rejects.toThrow(/budget exceeded/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("handles HTTP 429 with NO RETRY and activates per-endpoint cooldown (Gate S7)", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      return new Response("Too Many Requests", { status: 429 });
    });

    const client = new YahooClient({
      fetchFn: fetchMock as any,
      minIntervalMs: 0,
      cooldownPeriodMs: 60_000,
    });

    // First request receives 429
    const result = await client.fetchChart("SUZLON", "NSE");
    expect(result.outcome).toBe("RATE_LIMITED");
    expect(result.httpStatus).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1); // Exactly one request, NO retry!

    // Subsequent request to the cooled-down endpoint fails fast without hitting network
    await expect(client.fetchChart("TCS", "NSE")).rejects.toThrow(/cooling down/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // Still exactly 1 network call
  });

  it("isolates cooldown per-endpoint so other endpoints keep working (Gate S7)", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/v8/finance/chart/")) {
        return new Response("Too Many Requests", { status: 429 });
      }
      return new Response(JSON.stringify({ timeseries: { result: [] } }), { status: 200 });
    });

    const client = new YahooClient({
      fetchFn: fetchMock as any,
      minIntervalMs: 0,
      cooldownPeriodMs: 60_000,
    });

    // Chart endpoint gets 429
    const chartResult = await client.fetchChart("SUZLON", "NSE");
    expect(chartResult.outcome).toBe("RATE_LIMITED");

    // Fundamentals endpoint still works!
    const fundResult = await client.fetchFundamentals("SUZLON", "NSE");
    expect(fundResult.outcome).toBe("OK");
    expect(fundResult.httpStatus).toBe(200);
  });

  it("records call logs and source health via repo", async () => {
    const mockRepo = {
      recordCallLog: vi.fn().mockResolvedValue(undefined),
      updateHealth: vi.fn().mockResolvedValue(undefined),
    };

    const fetchMock = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ chart: { result: [] } }), { status: 200 });
    });

    const client = new YahooClient({
      fetchFn: fetchMock as any,
      minIntervalMs: 0,
      sourceHealthRepo: mockRepo as any,
    });

    await client.fetchChart("SUZLON", "NSE");

    expect(mockRepo.recordCallLog).toHaveBeenCalledTimes(1);
    expect(mockRepo.recordCallLog).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "YAHOO",
        endpoint: "chart",
        status: 200,
      }),
    );
    expect(mockRepo.updateHealth).toHaveBeenCalledTimes(1);
    expect(mockRepo.updateHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "YAHOO",
        endpoint: "chart",
        success: true,
      }),
    );
  });

  it("persists daily budget across client instances / restarts (Condition 2)", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ chart: { result: [{ meta: { dataGranularity: "1d" } }] } }), {
        status: 200,
      });
    });

    // Mock repo reporting 300 calls already made today by previous process runs
    const mockRepo = {
      getTotalCallsToday: vi.fn().mockResolvedValue(300),
      getHealth: vi.fn().mockResolvedValue(null),
      recordCallLog: vi.fn().mockResolvedValue(undefined),
      updateHealth: vi.fn().mockResolvedValue(undefined),
    };

    // Brand new client instance with zero in-memory calls
    const freshClient = new YahooClient({
      fetchFn: fetchMock as any,
      minIntervalMs: 0,
      maxDailyBudget: 300,
      sourceHealthRepo: mockRepo as any,
    });

    expect(freshClient.getCallsToday()).toBe(0);

    // Call must fail fast because persistent budget is exhausted
    await expect(freshClient.fetchChart("SUZLON", "NSE")).rejects.toThrow(/budget exceeded: 300\/300/);

    // Network was never hit
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockRepo.getTotalCallsToday).toHaveBeenCalled();
  });

  it("honours 429 cooldown across client instances / restarts (Condition 2)", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ chart: { result: [] } }), { status: 200 });
    });

    // Mock repo reporting that a previous process triggered 429 just 1 minute ago
    const oneMinuteAgo = new Date(Date.now() - 60_000);
    const mockRepo = {
      getTotalCallsToday: vi.fn().mockResolvedValue(10),
      getHealth: vi.fn().mockImplementation(async (_src: string, endpoint: string) => {
        if (endpoint === "chart") {
          return {
            source: "YAHOO",
            endpoint: "chart",
            status: "RATE_LIMITED",
            last_failure_at: oneMinuteAgo,
            last_success_at: null,
            consecutive_failures: 1,
            calls_today: 10,
            budget_today: 300,
            date_key: "2026-10-17",
          };
        }
        return null;
      }),
      recordCallLog: vi.fn().mockResolvedValue(undefined),
      updateHealth: vi.fn().mockResolvedValue(undefined),
    };

    // Brand new client instance with completely clean memory
    const freshClient = new YahooClient({
      fetchFn: fetchMock as any,
      minIntervalMs: 0,
      cooldownPeriodMs: 5 * 60 * 1000, // 5 min cooldown
      sourceHealthRepo: mockRepo as any,
    });

    // Call to chart must immediately fail fast due to persistent cooldown in DB
    await expect(freshClient.fetchChart("SUZLON", "NSE")).rejects.toThrow(
      /is cooling down in database after rate-limit/,
    );

    // Network was never hit
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockRepo.getHealth).toHaveBeenCalledWith("YAHOO", "chart");
  });
});
