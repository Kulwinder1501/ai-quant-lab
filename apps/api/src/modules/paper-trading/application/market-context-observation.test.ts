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
        if (text.includes("price_action_events")) return { rows: [] };
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

    expect(note).toContain(MARKET_CONTEXT_OBSERVATION_CODE);
    expect(note).toContain('"dq":"PASS"');
    expect(note).toContain("wouldBlock");
    expect(note).toContain("sentence");
  });
});
