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
    /*
     * The repository gained an ICT snapshot path after this fake was written: it reads cached
     * snapshots and writes any it had to compute. The fake threw on both, so this test has been red
     * since that path landed -- and the thrown message looked empty because the query is a template
     * literal beginning with a newline, which the reporter truncated at.
     *
     * An empty read is the honest response: it forces the repository down the compute-and-persist
     * branch, which is the behaviour the assertions below actually care about.
     */
    if (text.includes("ict_state_snapshots")) {
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${JSON.stringify(text)}`);
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

    /*
     * `toMatchObject`, not `toEqual`: the repository attaches an `ictSnapshot` to each context now,
     * so a whole-object equality assertion fails on a key it was never written to know about. What
     * this test is actually about is the candle/indicator/pattern reconstruction and the cutoff, so
     * it asserts those and tolerates additional context keys rather than re-pinning the ICT payload
     * -- which changes whenever the engine version or config hash moves.
     */
    expect(contexts).toMatchObject([
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

    /*
     * The evidence queries are found by content, not by index or by an exact call count.
     *
     * This asserted exactly four calls, which broke when the repository gained the ICT snapshot
     * path (it now reads cached snapshots and writes any it computes -- eight calls here). Pinning
     * a count made an unrelated feature fail a test about cutoff reconstruction, and pinning indices
     * would silently compare the wrong query the moment call order shifted.
     */
    const findQuery = (fragment: string): QueryCall | undefined =>
      calls.find((call) => call.text.includes(fragment));
    const candleQuery = findQuery("FROM candles");
    const indicatorQuery = findQuery("FROM indicator_snapshots");
    const patternQuery = findQuery("FROM pattern_detections");
    const priceActionQuery = findQuery("FROM price_action_events");
    for (const [name, q] of [["candle", candleQuery], ["indicator", indicatorQuery],
      ["pattern", patternQuery], ["priceAction", priceActionQuery]] as const) {
      expect(q, `${name} query was not issued`).toBeDefined();
    }
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
