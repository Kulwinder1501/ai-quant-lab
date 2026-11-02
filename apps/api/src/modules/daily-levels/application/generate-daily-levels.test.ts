import { describe, expect, it, vi } from "vitest";
import { generateDailyLevels, type DailyLevelsRepository } from "./generate-daily-levels.js";
import type { DailyBar } from "../domain/levels.js";

const bars: DailyBar[] = [
  { date: "2026-10-28", high: 23_000, low: 22_700, close: 22_900 },
  { date: "2026-10-29", high: 23_100, low: 22_800, close: 22_950 },
  { date: "2026-10-30", high: 23_150, low: 22_900, close: 23_050 },
];

function fakeRepository(overrides: Partial<DailyLevelsRepository> = {}): DailyLevelsRepository & { saved: unknown[] } {
  const saved: unknown[] = [];
  return {
    saved,
    dailyBars: vi.fn(async () => bars),
    oiBeforeOpen: vi.fn(async () => null),
    holidayName: vi.fn(async () => null),
    hasSheet: vi.fn(async () => false),
    saveSheet: vi.fn(async (sheet) => { saved.push(sheet); return { version: saved.length, generatedAt: "2026-11-03T03:25:00.000Z" }; }),
    ...overrides,
  };
}

describe("generateDailyLevels", () => {
  it("stores a sheet for each index on a trading day", async () => {
    const repository = fakeRepository();
    const results = await generateDailyLevels(repository, "2026-11-03", ["NIFTY50", "BANKNIFTY"]);
    expect(results.map((result) => result.status)).toEqual(["STORED", "STORED"]);
    expect(repository.saved).toHaveLength(2);
  });

  it("skips a weekend without touching the database", async () => {
    const repository = fakeRepository();
    const results = await generateDailyLevels(repository, "2026-11-01", ["NIFTY50"]);
    expect(results[0].status).toBe("WEEKEND");
    expect(repository.holidayName).not.toHaveBeenCalled();
    expect(repository.saved).toHaveLength(0);
  });

  it("skips an NSE holiday and names it", async () => {
    const repository = fakeRepository({ holidayName: vi.fn(async () => "Diwali Balipratipada") });
    const [result] = await generateDailyLevels(repository, "2026-11-10", ["NIFTY50"]);
    expect(result.status).toBe("HOLIDAY");
    expect(result.detail).toBe("Diwali Balipratipada");
    expect(repository.saved).toHaveLength(0);
  });

  it("leaves an existing sheet alone, and makes a new version only when forced", async () => {
    const repository = fakeRepository({ hasSheet: vi.fn(async () => true) });
    const [skipped] = await generateDailyLevels(repository, "2026-11-03", ["NIFTY50"]);
    expect(skipped.status).toBe("ALREADY_STORED");
    expect(repository.saved).toHaveLength(0);
    const [forced] = await generateDailyLevels(repository, "2026-11-03", ["NIFTY50"], { force: true });
    expect(forced.status).toBe("STORED");
    expect(forced.version).toBe(1);
  });

  it("builds but does not store on a dry run", async () => {
    const repository = fakeRepository();
    const [result] = await generateDailyLevels(repository, "2026-11-03", ["NIFTY50"], { dryRun: true });
    expect(result.status).toBe("DRY_RUN");
    expect(result.sheet?.referencePrice).toBe(23_050);
    expect(repository.saved).toHaveLength(0);
  });

  it("reports NO_DATA when there is no completed daily bar before the session", async () => {
    const repository = fakeRepository({ dailyBars: vi.fn(async () => []) });
    const [result] = await generateDailyLevels(repository, "2026-11-03", ["NIFTY50"]);
    expect(result.status).toBe("NO_DATA");
    expect(repository.saved).toHaveLength(0);
  });

  it("carries the option-chain walls and their provenance into the stored sheet", async () => {
    const repository = fakeRepository({
      oiBeforeOpen: vi.fn(async () => ({
        strikes: [{ strike: 23_300, callOi: 9_000_000, putOi: 10 }, { strike: 22_800, callOi: 10, putOi: 8_000_000 }],
        observedAt: "2026-10-30T09:58:00.000Z", expiry: "2026-11-03",
      })),
    });
    const [result] = await generateDailyLevels(repository, "2026-11-03", ["NIFTY50"]);
    expect(result.sheet?.oi).toEqual({ observedAt: "2026-10-30T09:58:00.000Z", expiry: "2026-11-03" });
    const keys = result.sheet?.zones.flatMap((zone) => zone.levels.map((level) => level.key)) ?? [];
    expect(keys).toContain("call-oi-wall");
    expect(keys).toContain("put-oi-wall");
  });
});
