import type { DatabaseQueryable } from "../../../infrastructure/database/database.js";
import { describe, expect, it } from "vitest";
import { PostgresBacktestMarketDataRepository } from "./postgres-backtest-market-data-repository.js";

interface QueryCall {
  text: string;
  values: unknown[] | undefined;
}

interface QueryResponses {
  candles?: unknown[];
  indicators?: unknown[];
  patterns?: unknown[];
  priceActionEvents?: unknown[];
}

function fakeQueryable(responses: QueryResponses): { database: DatabaseQueryable; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const query = async (text: string, values?: unknown[]): Promise<{ rows: unknown[] }> => {
    calls.push({ text, values });
    if (text.includes("FROM candles")) {
      return { rows: responses.candles ?? [] };
    }
    if (text.includes("FROM indicator_snapshots")) {
      return { rows: responses.indicators ?? [] };
    }
    if (text.includes("FROM pattern_detections")) {
      return { rows: responses.patterns ?? [] };
    }
    if (text.includes("FROM price_action_events")) {
      return { rows: responses.priceActionEvents ?? [] };
    }
    throw new Error(`Unexpected query: ${text}`);
  };

  return { database: { query } as unknown as DatabaseQueryable, calls };
}

describe("PostgresBacktestMarketDataRepository", () => {
  it("reconstructs chronological completed-candle evidence and applies the stored-evidence cutoff", async () => {
    const firstOpen = new Date("2026-01-05T03:45:00.000Z");
    const firstClose = new Date("2026-01-05T10:00:00.000Z");
    const secondOpen = new Date("2026-01-06T03:45:00.000Z");
    const secondClose = new Date("2026-01-06T10:00:00.000Z");
    const { database, calls } = fakeQueryable({
      candles: [
        {
          id: "candle-1",
          instrument_id: "instrument-1",
          timeframe: "1d",
          open_time: firstOpen,
          close_time: firstClose,
          open: "100.00",
          high: "104.50",
          low: "99.50",
          close: "102.25",
          volume: "12345.5",
          tick_size: "0.05",
        },
        {
          id: "candle-2",
          instrument_id: "instrument-1",
          timeframe: "1d",
          open_time: secondOpen,
          close_time: secondClose,
          open: "102.25",
          high: "105.00",
          low: "101.75",
          close: "104.00",
          volume: "9000",
          tick_size: "0.05",
        },
      ],
      indicators: [
        {
          candle_id: "candle-1",
          indicator_code: "EMA",
          algorithm_version: "ta-v1",
          parameters: { period: 20 },
          values: { value: 101.5 },
        },
        {
          candle_id: "candle-2",
          indicator_code: "RSI",
          algorithm_version: "ta-v1",
          parameters: { period: 14 },
          values: { value: 58.25 },
        },
      ],
      patterns: [
        {
          candle_id: "candle-1",
          pattern_code: "HAMMER",
          algorithm_version: "candlestick-v1",
          direction: "BULLISH",
          confidence: "0.82",
          context_candle_ids: ["candle-1"],
          details: { bodyRatio: 0.15 },
        },
      ],
      priceActionEvents: [
        {
          candle_id: "candle-2",
          event_type: "BREAKOUT",
          algorithm_version: "price-action-v1",
          direction: "BULLISH",
          level: "103.75",
          confidence: "0.77",
          details: { lookback: 20 },
        },
      ],
    });
    const dataWindowStart = new Date("2026-01-01T00:00:00.000Z");
    const dataWindowEnd = new Date("2026-02-01T00:00:00.000Z");
    const dataCutoffAt = new Date("2026-02-05T00:00:00.000Z");

    const contexts = await new PostgresBacktestMarketDataRepository(database).listContexts({
      instrumentId: "instrument-1",
      timeframe: "1d",
      dataWindowStart,
      dataWindowEnd,
      dataCutoffAt,
    });

    expect(contexts).toEqual([
      {
        candle: {
          id: "candle-1",
          instrumentId: "instrument-1",
          timeframe: "1d",
          openTime: firstOpen,
          closeTime: firstClose,
          open: 100,
          high: 104.5,
          low: 99.5,
          close: 102.25,
          volume: 12345.5,
          tickSize: 0.05,
        },
        indicators: [{
          code: "EMA",
          algorithmVersion: "ta-v1",
          parameters: { period: 20 },
          values: { value: 101.5 },
        }],
        patterns: [{
          code: "HAMMER",
          algorithmVersion: "candlestick-v1",
          direction: "BULLISH",
          confidence: 0.82,
          contextCandleIds: ["candle-1"],
          details: { bodyRatio: 0.15 },
        }],
        priceActionEvents: [],
      },
      {
        candle: {
          id: "candle-2",
          instrumentId: "instrument-1",
          timeframe: "1d",
          openTime: secondOpen,
          closeTime: secondClose,
          open: 102.25,
          high: 105,
          low: 101.75,
          close: 104,
          volume: 9000,
          tickSize: 0.05,
        },
        indicators: [{
          code: "RSI",
          algorithmVersion: "ta-v1",
          parameters: { period: 14 },
          values: { value: 58.25 },
        }],
        patterns: [],
        priceActionEvents: [{
          eventCode: "BREAKOUT",
          algorithmVersion: "price-action-v1",
          direction: "BULLISH",
          level: 103.75,
          confidence: 0.77,
          details: { lookback: 20 },
        }],
      },
    ]);

    expect(calls).toHaveLength(4);
    const candleQuery = calls[0];
    const indicatorQuery = calls[1];
    const patternQuery = calls[2];
    const priceActionQuery = calls[3];
    expect(candleQuery?.text).toContain("candles.is_complete = TRUE");
    expect(candleQuery?.text).toContain("candles.received_at <= $5");
    expect(candleQuery?.values).toEqual(["instrument-1", "1d", dataWindowStart, dataWindowEnd, dataCutoffAt]);
    expect(indicatorQuery?.text).toContain("indicator_snapshots.calculated_at <= $2");
    expect(patternQuery?.text).toContain("pattern_detections.detected_at <= $2");
    expect(priceActionQuery?.text).toContain("AND detected_at <= $2");
    expect(indicatorQuery?.values).toEqual([["candle-1", "candle-2"], dataCutoffAt]);
    expect(patternQuery?.values).toEqual([["candle-1", "candle-2"], dataCutoffAt]);
    expect(priceActionQuery?.values).toEqual([["candle-1", "candle-2"], dataCutoffAt]);
  });

  it("does not query derived evidence when the cutoff leaves no completed candles", async () => {
    const { database, calls } = fakeQueryable({ candles: [] });

    await expect(new PostgresBacktestMarketDataRepository(database).listContexts({
      instrumentId: "instrument-1",
      timeframe: "1d",
      dataWindowStart: new Date("2026-01-01T00:00:00.000Z"),
      dataWindowEnd: new Date("2026-02-01T00:00:00.000Z"),
      dataCutoffAt: new Date("2026-02-05T00:00:00.000Z"),
    })).resolves.toEqual([]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("FROM candles");
  });
});
