import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../database.js";
import { PostgresFuturesBarRepository } from "./postgres-futures-bar-repository.js";

const from = new Date("2026-10-22T03:30:00.000Z");
const to = new Date("2026-10-22T10:30:00.000Z");

describe("PostgresFuturesBarRepository.bars", () => {
  it("reads one exact contract's complete 1-minute bars over a half-open window, oldest first", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await new PostgresFuturesBarRepository({ query } as unknown as DatabasePool).bars({ symbol: "banknifty26octfut", from, to });

    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("i.symbol = $1");
    expect(sql).toContain("c.timeframe = '1m'");
    // A bar still forming is never part of a profile.
    expect(sql).toContain("c.is_complete");
    expect(sql).toContain("c.open_time >= $2 AND c.open_time < $3");
    expect(sql).toMatch(/ORDER BY c\.open_time ASC/);
    expect(sql).not.toMatch(/LIKE/i);
    expect(values).toEqual(["BANKNIFTY26OCTFUT", from, to]);
  });

  it("converts the driver's NUMERIC strings to numbers without altering the values", async () => {
    const openTime = new Date("2026-10-22T03:45:00.000Z");
    const query = vi.fn(async () => ({
      rows: [{ open_time: openTime, open: "54729.000000", high: "54741.200000", low: "54727.800000", close: "54738.000000", volume: "810.0000" }],
    }));
    const bars = await new PostgresFuturesBarRepository({ query } as unknown as DatabasePool).bars({ symbol: "BANKNIFTY26OCTFUT", from, to });
    expect(bars).toEqual([{ openTime, open: 54_729, high: 54_741.2, low: 54_727.8, close: 54_738, volume: 810 }]);
  });

  it("keeps a zero volume as zero, since a flat zero-volume minute is a real no-trade minute", async () => {
    const query = vi.fn(async () => ({
      rows: [{ open_time: from, open: "1.000000", high: "1.000000", low: "1.000000", close: "1.000000", volume: "0.0000" }],
    }));
    const [bar] = await new PostgresFuturesBarRepository({ query } as unknown as DatabasePool).bars({ symbol: "X", from, to });
    expect(bar!.volume).toBe(0);
  });
});

describe("PostgresFuturesBarRepository.sessionDays", () => {
  it("groups a contract's complete bars by IST day, inside 09:15-15:30 IST and on weekdays only", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await new PostgresFuturesBarRepository({ query } as unknown as DatabasePool)
      .sessionDays({ symbol: "banknifty26octfut", fromDate: "2026-08-24", toDate: "2026-10-23" });

    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("i.symbol = $1");
    expect(sql).toContain("c.is_complete");
    expect(sql).toContain("Asia/Kolkata");
    expect(sql).toContain("TIME '09:15'");
    expect(sql).toContain("TIME '15:30'");
    expect(sql).toMatch(/ISODOW FROM .* < 6/);
    // The end date is inclusive: the window runs to the start of the next IST day.
    expect(sql).toMatch(/\(\$3::date \+ 1\)::timestamp AT TIME ZONE 'Asia\/Kolkata'/);
    expect(values).toEqual(["BANKNIFTY26OCTFUT", "2026-08-24", "2026-10-23"]);
  });

  it("returns days as IST date strings with the counts as numbers and the first and last bar times", async () => {
    const firstAt = new Date("2026-10-22T03:45:00.000Z");
    const lastAt = new Date("2026-10-22T09:59:00.000Z");
    const query = vi.fn(async () => ({ rows: [{ day: "2026-10-22", bars: "375", bars_with_volume: "374", first_at: firstAt, last_at: lastAt }] }));
    const days = await new PostgresFuturesBarRepository({ query } as unknown as DatabasePool)
      .sessionDays({ symbol: "BANKNIFTY26OCTFUT", fromDate: "2026-10-22", toDate: "2026-10-22" });
    expect(days).toEqual([{ date: "2026-10-22", bars: 375, barsWithVolume: 374, firstAt, lastAt }]);
  });
});
