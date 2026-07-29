import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseQueryable } from "../../infrastructure/database/database.js";
import { createApp } from "./app.js";

interface QueryCall {
  text: string;
  values: unknown[] | undefined;
}

const instrumentId = "8ce74e6e-4e5b-4ed5-99d7-373cb4a21eb7";
const secondInstrumentId = "19101f7c-6543-4a31-8d68-20d36732556b";

function watchlistRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instrument_id: instrumentId,
    instrument_exchange: "NSE",
    instrument_symbol: "NIFTY50",
    instrument_display_name: "NIFTY 50",
    instrument_type: "INDEX",
    instrument_currency: "INR",
    instrument_timezone: "Asia/Kolkata",
    instrument_tick_size: "0.05",
    instrument_lot_size: "1",
    ...overrides,
  };
}

function scannerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instrument_id: instrumentId,
    instrument_exchange: "NSE",
    instrument_symbol: "NIFTY50",
    instrument_display_name: "NIFTY 50",
    instrument_type: "INDEX",
    candle_id: "dbbb9bd3-4d1a-4f8d-80a9-6be441bfcc4e",
    candle_timeframe: "1d",
    candle_open_time: "2026-07-01T03:45:00.000Z",
    candle_close_time: "2026-07-01T09:45:00.123999Z",
    candle_open: "25000.25",
    candle_high: "25100.5",
    candle_low: "24950.25",
    candle_close: "25075.75",
    candle_volume: "1000000",
    indicators: [{
      code: "RSI",
      algorithmVersion: "ta-v1",
      parameters: { period: 14 },
      values: { value: 58.2 },
    }],
    patterns: [{
      code: "HAMMER",
      algorithmVersion: "patterns-v1",
      direction: "BULLISH",
      confidence: 0.72,
    }],
    price_action_events: [{
      eventType: "SUPPORT",
      algorithmVersion: "price-action-v1",
      direction: "BULLISH",
      level: 24950.25,
      confidence: 0.63,
    }],
    prediction_id: "afc74e6e-4e5b-4ed5-99d7-373cb4a21eb7",
    prediction_label: "BULLISH",
    prediction_confidence: "0.7234",
    prediction_created_at: "2026-07-01T10:00:00.000Z",
    prediction_evidence_cutoff_at: "2026-07-01T09:45:00.000Z",
    model_key: "nifty50-1d-classifier",
    model_version: "2",
    model_algorithm: "sklearn-logistic-regression-v1",
    model_current_stage: "PRODUCTION",
    ...overrides,
  };
}

function scannerDatabase(): { database: DatabaseQueryable; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  return {
    database: {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (text.includes("WITH latest_completed_candles AS")) {
          return {
            rows: [
              scannerRow(),
              scannerRow({
                instrument_id: secondInstrumentId,
                instrument_symbol: "BANKNIFTY",
                prediction_id: null,
                prediction_label: null,
                prediction_confidence: null,
                prediction_created_at: null,
                prediction_evidence_cutoff_at: null,
                model_key: null,
                model_version: null,
                model_algorithm: null,
                model_current_stage: null,
              }),
            ],
          };
        }
        if (text.includes("FROM strategies")) {
          return {
            rows: [{ strategy_key: "trend-breakout", strategy_name: "Trend breakout", strategy_version: "3" }],
          };
        }
        if (text.includes("FROM instruments i")) {
          return {
            rows: [
              watchlistRow(),
              watchlistRow({ instrument_id: secondInstrumentId, instrument_symbol: "BANKNIFTY" }),
            ],
          };
        }
        return { rows: [] };
      }),
    } as unknown as DatabaseQueryable,
    calls,
  };
}

async function getJson(path: string, method = "GET"): Promise<{
  status: number;
  body: unknown;
  calls: QueryCall[];
}> {
  const { database, calls } = scannerDatabase();
  const app = createApp({ database });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method });
    return { status: response.status, body: await response.json(), calls };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("market scanner and watchlist HTTP routes", () => {
  it("lists the active local registry through a bounded, read-only watchlist route", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await getJson("/api/v1/watchlist?exchange=nse&instrumentType=index&limit=1");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      data: [{
        researchOnly: true,
        id: instrumentId,
        exchange: "NSE",
        symbol: "NIFTY50",
        registryStatus: "ACTIVE",
      }],
      page: {
        limit: 1,
        nextCursor: { exchange: "NSE", symbol: "NIFTY50", id: instrumentId },
      },
    });
    expect(response.calls).toHaveLength(1);
    expect(response.calls[0]?.values).toEqual(["NSE", "INDEX", null, null, null, 2]);
    expect(JSON.stringify(response.body)).not.toMatch(/metadata|provider|trade|paper|broker/i);
  });

  it("returns only persisted completed-candle scanner evidence and its safe strategy catalogue context", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await getJson("/api/v1/market-scanner?timeframe=1d&instrument=nifty50&prediction=bullish&limit=1");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      data: [{
        researchOnly: true,
        instrument: { symbol: "NIFTY50", exchange: "NSE" },
        latestCompletedCandle: {
          timeframe: "1d",
          close: 25075.75,
          closeTime: "2026-07-01T09:45:00.123Z",
        },
        indicators: [{ code: "RSI", values: { value: 58.2 } }],
        patterns: [{ code: "HAMMER", direction: "BULLISH" }],
        priceActionEvents: [{ eventType: "SUPPORT", direction: "BULLISH" }],
        modelPrediction: {
          prediction: "BULLISH",
          model: { key: "nifty50-1d-classifier", currentStage: "PRODUCTION" },
        },
      }],
      page: {
        limit: 1,
        nextCursor: {
          closeTime: "2026-07-01T09:45:00.123Z",
          instrumentId,
        },
      },
      context: {
        researchOnly: true,
        timeframe: "1d",
        activeStrategies: [{ key: "trend-breakout", name: "Trend breakout", version: 3 }],
      },
    });
    expect(response.calls).toHaveLength(2);
    const scannerCall = response.calls.find((call) => call.text.includes("WITH latest_completed_candles AS"));
    expect(scannerCall?.values).toEqual(["1d", "NIFTY50", null, "BULLISH", null, null, 2]);
    expect(JSON.stringify(response.body)).not.toMatch(/artifact|metadata|provider|trade.?idea|paper|broker|order/i);
  });

  it("rejects malformed cursor input and leaves write attempts without a route", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const invalidCursor = await getJson("/api/v1/market-scanner?cursorCloseTime=2026-07-01T09:45:00.000Z");
    const invalidCursorDate = await getJson(
      "/api/v1/market-scanner?cursorCloseTime=2026-02-31T09:45:00.000Z&cursorInstrumentId=8ce74e6e-4e5b-4ed5-99d7-373cb4a21eb7",
    );
    const mutationAttempt = await getJson("/api/v1/watchlist", "POST");

    expect(invalidCursor).toMatchObject({
      status: 400,
      body: { error: "cursorCloseTime and cursorInstrumentId must be supplied together." },
      calls: [],
    });
    expect(invalidCursorDate).toMatchObject({
      status: 400,
      body: { error: "cursorCloseTime must be an ISO-8601 timestamp." },
      calls: [],
    });
    expect(mutationAttempt).toMatchObject({
      status: 404,
      body: { error: "Route not found" },
      calls: [],
    });
  });
});
