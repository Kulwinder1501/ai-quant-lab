import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../../../infrastructure/database/database.js";
import { scanCandleCoverage } from "./scan-candle-coverage.js";

describe("scanCandleCoverage", () => {
  it("flags an expected session even when it has no candle rows at all", async () => {
    const queries: string[] = [];
    const database = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (text.includes("generate_series")) {
          return { rows: [{ session: "2026-08-19" }, { session: "2026-08-20" }] };
        }
        return { rows: [{ close_time: new Date("2026-08-19T03:46:00.000Z") }] };
      }),
    } as unknown as DatabasePool;

    const result = await scanCandleCoverage(database, {
      instruments: ["NIFTY50"],
      timeframe: "1m",
      lookbackDays: 2,
    });

    expect(result.sessionsChecked).toBe(2);
    expect(result.tailShort.map((session) => session.session)).toEqual(["2026-08-19"]);
    expect(result.confirmed).toHaveLength(1);
    expect(result.confirmed[0]).toMatchObject({
      instrument: "NIFTY50",
      session: "2026-08-20",
      coverage: { kind: "CONFIRMED_GAP", barsPresent: 0, openMissing: true },
    });
    expect(queries[0]).toContain("nse_holidays");
    expect(queries[0]).toContain("TIME '15:30'");
  });
});
