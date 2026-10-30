import { describe, expect, it, vi } from "vitest";
import {
  MARKET_CONTEXT_OBSERVATION_CODE,
  observeMarketContext,
} from "./market-context-observation.js";

const NOW = new Date("2026-10-13T05:30:00.000Z"); // 11:00 IST

function db(
  handlers: Array<(text: string, values: unknown[]) => { rows: Array<Record<string, unknown>> } | null>,
) {
  return {
    query: vi.fn(async (text: string, values: unknown[]) => {
      for (const handler of handlers) {
        const result = handler(text, values);
        if (result) return result;
      }
      return { rows: [] };
    }),
  };
}

describe("observeMarketContext", () => {
  it("stamps FAIL when the trade idea has no entry price", async () => {
    const database = db([
      (text) => (text.includes("trade_ideas") ? { rows: [{ entry_price: null }] } : null),
    ]);
    const note = await observeMarketContext({
      database,
      underlyingSymbol: "NIFTY50",
      tradeIdeaId: "idea-1",
      direction: "LONG",
      now: NOW,
    });
    expect(note).toContain(MARKET_CONTEXT_OBSERVATION_CODE);
    expect(note).toContain('"dq":"FAIL"');
  });

  it("returns null when the lookup throws (trade must still open)", async () => {
    const database = {
      query: vi.fn(async () => {
        throw new Error("db down");
      }),
    };
    const note = await observeMarketContext({
      database,
      underlyingSymbol: "NIFTY50",
      tradeIdeaId: "idea-1",
      direction: "LONG",
      now: NOW,
    });
    expect(note).toBeNull();
  });

  it("builds a PASS stamp with session bars and shadow veto fields", async () => {
    const swingQueries: string[] = [];
    const indexId = "11111111-1111-1111-1111-111111111111";
    // 09:15 IST = 03:45 UTC on 2026-10-13
    const bars = Array.from({ length: 40 }, (_, i) => {
      const minute = 45 + i;
      return {
        open_time: new Date(Date.UTC(2026, 9, 13, 3 + Math.floor(minute / 60), minute % 60)),
        open: 22_500,
        high: 22_510,
        low: 22_490,
        close: 22_505,
        volume: 100,
      };
    });

    const database = db([
      (text) => {
        if (text.includes("FROM trade_ideas")) return { rows: [{ entry_price: 22_505 }] };
        if (text.includes("instrument_type = 'INDEX'")) return { rows: [{ id: indexId }] };
        if (text.includes("session_date") && text.includes("GROUP BY")) {
          return { rows: [{ session_date: "2026-10-10" }] };
        }
        if (text.includes("FROM candles") && text.includes("::date = $2")) {
          return { rows: bars };
        }
        if (text.includes("instrument_type = 'FUTURE'")) return { rows: [] };
        if (text.includes("price_action_events")) {
          swingQueries.push(text);
          return { rows: [] };
        }
        return null;
      },
    ]);

    const note = await observeMarketContext({
      database,
      underlyingSymbol: "NIFTY50",
      tradeIdeaId: "idea-1",
      direction: "LONG",
      now: NOW,
    });

    // swing levels come from the current version only: the superseded versions (v2, v3) stay in the table as history
    expect(swingQueries).toHaveLength(1);
    expect(swingQueries[0]).toContain("pae.algorithm_version NOT IN ('price-action-v2', 'price-action-v2-atr', 'price-action-v3', 'price-action-v3-atr')");
    expect(note).toContain(MARKET_CONTEXT_OBSERVATION_CODE);
    expect(note).toContain('"dq":"PASS"');
    expect(note).toContain("wouldBlock");
    expect(note).toContain("sentence");
  });

  describe("higher-timeframe loader", () => {
    const indexId = "11111111-1111-1111-1111-111111111111";
    const bars = Array.from({ length: 40 }, (_, i) => ({
      open_time: new Date(Date.UTC(2026, 9, 13, 3, 45 + i)),
      open: 22_500, high: 22_510, low: 22_490, close: 22_505, volume: 100,
    }));
    const database = () => db([
      (text) => {
        if (text.includes("FROM trade_ideas")) return { rows: [{ entry_price: 22_505 }] };
        if (text.includes("instrument_type = 'INDEX'")) return { rows: [{ id: indexId }] };
        if (text.includes("session_date") && text.includes("GROUP BY")) return { rows: [{ session_date: "2026-10-10" }] };
        if (text.includes("FROM candles") && text.includes("::date = $2")) return { rows: bars };
        return null;
      },
    ]);
    const htfContext = (timeframe: string, closeTime: Date) => ({
      candle: {
        id: "c-" + timeframe, instrumentId: indexId, timeframe,
        openTime: new Date(closeTime.getTime() - 300_000), closeTime,
        open: 22_600, high: 22_610, low: 22_590, close: 22_600, volume: 1, tickSize: 0.05,
      },
      indicators: [
        { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 20 }, values: { value: 22_500 } },
        { code: "SUPERTREND", algorithmVersion: "ta-v1", parameters: { atrPeriod: 10, multiplier: 3 }, values: { value: 22_400, trend: "UP" } },
      ],
      patterns: [],
      priceActionEvents: [],
    }) as never;

    it("asks for the index's closed 5m, 15m and 60m bars and stamps a known trend", async () => {
      const loader = vi.fn(async (q: { instrumentId: string; timeframe: string; asOf: Date }) => htfContext(q.timeframe, q.asOf));
      const note = await observeMarketContext({
        database: database(), underlyingSymbol: "NIFTY50", tradeIdeaId: "idea-1", direction: "LONG", now: NOW,
        loadHigherTimeframeContext: loader,
      });
      expect(loader.mock.calls.map(([q]) => [q.instrumentId, q.timeframe])).toEqual([[indexId, "5m"], [indexId, "15m"], [indexId, "60m"]]);
      expect(note).not.toContain('"htf":"UNKNOWN"');
      expect(note).toContain('"t60":"UP"');
    });

    it("stays UNKNOWN, and still stamps, when the loader fails or returns a bar closing after the decision", async () => {
      const failing = await observeMarketContext({
        database: database(), underlyingSymbol: "NIFTY50", tradeIdeaId: "idea-1", direction: "LONG", now: NOW,
        loadHigherTimeframeContext: async () => { throw new Error("db"); },
      });
      expect(failing).toContain('"dq":"PASS"');
      const leaking = await observeMarketContext({
        database: database(), underlyingSymbol: "NIFTY50", tradeIdeaId: "idea-1", direction: "LONG", now: NOW,
        loadHigherTimeframeContext: async (q) => htfContext(q.timeframe, new Date(q.asOf.getTime() + 60_000)),
      });
      expect(leaking).toContain('"htf":"UNKNOWN"');
    });
  });
});
