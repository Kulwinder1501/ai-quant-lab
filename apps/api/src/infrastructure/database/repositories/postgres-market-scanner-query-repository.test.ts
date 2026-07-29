import { describe, expect, it, vi } from "vitest";
import type { DatabaseQueryable } from "../database.js";
import { PostgresMarketScannerQueryRepository } from "./postgres-market-scanner-query-repository.js";

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
      parameters: { period: 14, smoothing: "WILDER" },
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

function fakeDatabase(rows: unknown[]): { database: DatabaseQueryable; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  return {
    database: {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return { rows };
      }),
    } as unknown as DatabaseQueryable,
    calls,
  };
}

describe("PostgresMarketScannerQueryRepository", () => {
  it("lists only the active local instrument registry with a parameterized keyset cursor", async () => {
    const { database, calls } = fakeDatabase([watchlistRow()]);
    const repository = new PostgresMarketScannerQueryRepository(database);

    await expect(repository.listWatchlist({
      exchange: "NSE",
      instrumentType: "INDEX",
      cursor: { exchange: "NSE", symbol: "NIFTY50", id: instrumentId },
      limit: 21,
    })).resolves.toEqual([{
      researchOnly: true,
      id: instrumentId,
      exchange: "NSE",
      symbol: "NIFTY50",
      displayName: "NIFTY 50",
      instrumentType: "INDEX",
      currency: "INR",
      timezone: "Asia/Kolkata",
      tickSize: 0.05,
      lotSize: 1,
      registryStatus: "ACTIVE",
    }]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("FROM instruments i");
    expect(calls[0]?.text).toContain("WHERE i.is_active = TRUE");
    expect(calls[0]?.text).toContain("ORDER BY i.exchange ASC, i.symbol ASC, i.id ASC");
    expect(calls[0]?.text).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(calls[0]?.text).not.toMatch(/metadata|source_metadata|provider/i);
    expect(calls[0]?.values).toEqual(["NSE", "INDEX", "NSE", "NIFTY50", instrumentId, 21]);
  });

  it("projects completed-candle evidence from one exact candle without trade, provider, or artifact data", async () => {
    const { database, calls } = fakeDatabase([scannerRow()]);
    const repository = new PostgresMarketScannerQueryRepository(database);
    const cursor = {
      closeTime: new Date("2026-07-02T09:45:00.000Z"),
      instrumentId: secondInstrumentId,
    };

    await expect(repository.listScannerRows({
      timeframe: "1d",
      instrumentSymbol: "NIFTY50",
      exchange: "NSE",
      prediction: "BULLISH",
      cursor,
      limit: 51,
    })).resolves.toEqual([{
      researchOnly: true,
      instrument: {
        id: instrumentId,
        exchange: "NSE",
        symbol: "NIFTY50",
        displayName: "NIFTY 50",
        instrumentType: "INDEX",
      },
      latestCompletedCandle: {
        id: "dbbb9bd3-4d1a-4f8d-80a9-6be441bfcc4e",
        timeframe: "1d",
        openTime: new Date("2026-07-01T03:45:00.000Z"),
        closeTime: new Date("2026-07-01T09:45:00.123Z"),
        open: 25000.25,
        high: 25100.5,
        low: 24950.25,
        close: 25075.75,
        volume: 1_000_000,
      },
      indicators: [{
        code: "RSI",
        algorithmVersion: "ta-v1",
        parameters: { period: 14, smoothing: "WILDER" },
        values: { value: 58.2 },
      }],
      patterns: [{
        code: "HAMMER",
        algorithmVersion: "patterns-v1",
        direction: "BULLISH",
        confidence: 0.72,
      }],
      priceActionEvents: [{
        eventType: "SUPPORT",
        algorithmVersion: "price-action-v1",
        direction: "BULLISH",
        level: 24950.25,
        confidence: 0.63,
      }],
      modelPrediction: {
        id: "afc74e6e-4e5b-4ed5-99d7-373cb4a21eb7",
        prediction: "BULLISH",
        confidence: 0.7234,
        createdAt: new Date("2026-07-01T10:00:00.000Z"),
        evidenceCutoffAt: new Date("2026-07-01T09:45:00.000Z"),
        model: {
          key: "nifty50-1d-classifier",
          version: 2,
          algorithm: "sklearn-logistic-regression-v1",
          currentStage: "PRODUCTION",
        },
      },
    }]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("WITH latest_completed_candles AS");
    expect(calls[0]?.text).toContain("c.is_complete = TRUE");
    expect(calls[0]?.text).toContain("indicator_snapshots.candle_id = c.id");
    expect(calls[0]?.text).toContain("pattern_detections.candle_id = c.id");
    expect(calls[0]?.text).toContain("price_action_events.candle_id = c.id");
    expect(calls[0]?.text).toContain("mp.source_candle_id = c.id");
    expect(calls[0]?.text).toContain("date_trunc('milliseconds', c.close_time) < $5");
    expect(calls[0]?.text).toContain("ORDER BY date_trunc('milliseconds', c.close_time) DESC, c.instrument_id DESC");
    expect(calls[0]?.text).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(calls[0]?.text).not.toMatch(/trade_ideas|paper_|artifact_uri|metadata|source_metadata|provider/i);
    expect(calls[0]?.values).toEqual([
      "1d",
      "NIFTY50",
      "NSE",
      "BULLISH",
      cursor.closeTime,
      secondInstrumentId,
      51,
    ]);
  });

  it("uses the same millisecond-normalized close-time key for cursor comparison and ordering", async () => {
    const { database, calls } = fakeDatabase([
      scannerRow({ candle_close_time: "2026-07-01T09:45:00.123999Z" }),
      scannerRow({
        instrument_id: secondInstrumentId,
        instrument_symbol: "BANKNIFTY",
        candle_close_time: "2026-07-01T09:45:00.123001Z",
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
    ]);

    const rows = await new PostgresMarketScannerQueryRepository(database).listScannerRows({
      timeframe: "1d",
      limit: 2,
    });

    expect(rows.map((row) => row.latestCompletedCandle.closeTime.toISOString())).toEqual([
      "2026-07-01T09:45:00.123Z",
      "2026-07-01T09:45:00.123Z",
    ]);
    expect(calls[0]?.text).toContain("date_trunc('milliseconds', c.close_time) = $5");
    expect(calls[0]?.text).toContain("ORDER BY date_trunc('milliseconds', c.close_time) DESC, c.instrument_id DESC");
  });

  it("excludes future-dated candle availability and same-candle derived evidence in SQL before projection", async () => {
    const { database, calls } = fakeDatabase([]);

    await expect(new PostgresMarketScannerQueryRepository(database).listScannerRows({
      timeframe: "1d",
      limit: 1,
    })).resolves.toEqual([]);

    const query = calls[0]?.text ?? "";
    const latestCandleOrdering = query.indexOf("ORDER BY c.instrument_id ASC, c.close_time DESC, c.id DESC");
    expect(query).toContain("c.close_time <= CURRENT_TIMESTAMP");
    expect(query).toContain("c.received_at <= CURRENT_TIMESTAMP");
    expect(query.indexOf("c.close_time <= CURRENT_TIMESTAMP")).toBeLessThan(latestCandleOrdering);
    expect(query.indexOf("c.received_at <= CURRENT_TIMESTAMP")).toBeLessThan(latestCandleOrdering);

    expect(query).toContain("indicator_snapshots.calculated_at <= CURRENT_TIMESTAMP");
    expect(query).toContain("pattern_detections.detected_at <= CURRENT_TIMESTAMP");
    expect(query).toContain("price_action_events.detected_at <= CURRENT_TIMESTAMP");
    expect(query).toContain("mp.created_at <= CURRENT_TIMESTAMP");
    expect(query).toContain("mp.evidence_cutoff_at <= CURRENT_TIMESTAMP");
  });

  it("reads only safe active-strategy catalogue labels, not configuration", async () => {
    const { database, calls } = fakeDatabase([{
      strategy_key: "trend-breakout",
      strategy_name: "Trend breakout",
      strategy_version: "3",
    }]);

    await expect(new PostgresMarketScannerQueryRepository(database).listActiveResearchStrategies())
      .resolves.toEqual([{ key: "trend-breakout", name: "Trend breakout", version: 3 }]);

    expect(calls[0]?.text).toContain("FROM strategies");
    expect(calls[0]?.text).toContain("strategy_versions.is_active = TRUE");
    expect(calls[0]?.text).not.toContain("configuration");
    expect(calls[0]?.text).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });

  it("rejects malformed persisted scanner evidence instead of projecting it", async () => {
    const invalidPattern = fakeDatabase([scannerRow({
      patterns: [{ code: "HAMMER", algorithmVersion: "patterns-v1", direction: "BULLISH", confidence: 1.1 }],
    })]);
    await expect(new PostgresMarketScannerQueryRepository(invalidPattern.database).listScannerRows({
      timeframe: "1d",
      limit: 1,
    })).rejects.toThrow("invalid pattern confidence");

    const provisionalCandle = fakeDatabase([scannerRow({ candle_volume: "-1" })]);
    await expect(new PostgresMarketScannerQueryRepository(provisionalCandle.database).listScannerRows({
      timeframe: "1d",
      limit: 1,
    })).rejects.toThrow("invalid candle volume");
  });
});
