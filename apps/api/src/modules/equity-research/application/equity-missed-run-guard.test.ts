import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import {
  EquityMissedRunGuard,
  addDays,
  isWeekend,
  getEligibleEndDate,
  type DatabaseQueryable,
} from "./equity-missed-run-guard.js";

/**
 * In-memory Mock Database for pure isolation:
 * Guarantees tests never write future/fake dates into live database tables.
 */
class MockDatabase implements DatabaseQueryable {
  public bars = new Set<string>();
  public evaluations = new Set<string>();
  public holidays = new Set<string>();
  public queries: Array<{ text: string; values?: unknown[] }> = [];

  async query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.queries.push({ text, values });
    const val = values?.[0] as string;

    if (text.includes("FROM nse_holidays")) {
      const isHol = this.holidays.has(val);
      return { rows: isHol ? ([{ name: "Mock Holiday" }] as unknown as T[]) : [] };
    }
    if (text.includes("FROM equity_research.price_bar")) {
      return { rows: [{ exists: this.bars.has(val) }] as unknown as T[] };
    }
    if (text.includes("FROM scheduled_job_runs") || text.includes("FROM equity_research.alert")) {
      return { rows: [{ exists: this.evaluations.has(val) }] as unknown as T[] };
    }
    if (text.includes("INSERT INTO scheduled_job_runs")) {
      if (val) this.evaluations.add(val);
      return { rows: [] };
    }
    return { rows: [] };
  }
}

describe("EquityMissedRunGuard", () => {
  describe("Root package.json script assertion", () => {
    it("asserts every script the guard invokes exists in root package.json", () => {
      // Find repo root package.json
      const rootPkgPath = path.resolve(process.cwd(), "../../package.json");
      const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));

      expect(rootPkg.scripts).toBeDefined();
      expect(rootPkg.scripts["equity:collect:eod"]).toBeDefined();
      expect(rootPkg.scripts["equity:alerts:eval"]).toBeDefined();
    });
  });

  describe("Pure Date Calculations", () => {
    it("addDays correctly adds positive and negative days across month boundaries", () => {
      expect(addDays("2026-10-23", 1)).toBe("2026-10-24");
      expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
      expect(addDays("2026-11-01", -1)).toBe("2026-10-31");
      expect(addDays("2026-02-28", 1)).toBe("2026-03-01"); // 2026 non-leap year
    });

    it("isWeekend detects Saturday and Sunday, returns false for weekdays", () => {
      expect(isWeekend("2026-10-23")).toBe(false); // Friday
      expect(isWeekend("2026-10-24")).toBe(true);  // Saturday
      expect(isWeekend("2026-10-25")).toBe(true);  // Sunday
      expect(isWeekend("2026-10-26")).toBe(false); // Monday
    });

    it("getEligibleEndDate handles 17:05 cutoff in IST", () => {
      // 2026-10-23 11:34:00 UTC = 2026-10-23 17:04:00 IST (before 17:05) -> yesterday (2026-10-22)
      const beforeCutoff = new Date("2026-10-23T11:34:00Z");
      expect(getEligibleEndDate(beforeCutoff)).toBe("2026-10-22");

      // 2026-10-23 11:36:00 UTC = 2026-10-23 17:06:00 IST (after 17:05) -> today (2026-10-23)
      const afterCutoff = new Date("2026-10-23T11:36:00Z");
      expect(getEligibleEndDate(afterCutoff)).toBe("2026-10-23");
    });
  });

  describe("Review Conditions & Guard Capabilities", () => {
    it("recovers a day-skipped run on the next check across lookback window", async () => {
      const mockDb = new MockDatabase();
      // Monday 2026-11-02 has bars and evaluation
      mockDb.bars.add("2026-11-02");
      mockDb.evaluations.add("2026-11-02");

      // Tuesday 2026-11-03 has NO bars and NO evaluation
      const executedCommands: string[] = [];
      const runner = async (_cmd: string, args: string[]) => {
        executedCommands.push(args.join(" "));
        if (args.includes("equity:collect:eod")) {
          // Simulation: collection populates bars for 2026-11-03
          mockDb.bars.add("2026-11-03");
        }
      };

      const guard = new EquityMissedRunGuard(mockDb, {
        commandRunner: runner,
        lookbackDays: 5,
      });

      // Checked Wednesday 2026-11-04 at 10:00 IST (eligible end date: 2026-11-03)
      const asOfWednesday = new Date("2026-11-04T04:30:00Z");
      const missing = await guard.findMissingDates({
        startDate: "2026-11-02",
        asOfDate: asOfWednesday,
      });

      expect(missing).toEqual(["2026-11-03"]);

      const result = await guard.runCatchup(missing);
      expect(result.collected).toBe(true);
      expect(result.evaluatedDates).toEqual(["2026-11-03"]);

      // Verify commands
      expect(executedCommands).toEqual([
        "run equity:collect:eod",
        "run equity:alerts:eval -- --date 2026-11-03",
      ]);

      // Evaluation is now recorded
      expect(mockDb.evaluations.has("2026-11-03")).toBe(true);

      // Next check: missing dates is empty
      const nextMissing = await guard.findMissingDates({
        startDate: "2026-11-02",
        asOfDate: asOfWednesday,
      });
      expect(nextMissing).toEqual([]);
    });

    it("evaluates two missed days in chronological order (oldest first)", async () => {
      const mockDb = new MockDatabase();
      mockDb.bars.add("2026-11-03");
      mockDb.evaluations.add("2026-11-03");

      // Wednesday 11-04 and Thursday 11-05 are missing
      const executedCommands: string[] = [];
      const runner = async (_cmd: string, args: string[]) => {
        executedCommands.push(args.join(" "));
        if (args.includes("equity:collect:eod")) {
          mockDb.bars.add("2026-11-04");
          mockDb.bars.add("2026-11-05");
        }
      };

      const guard = new EquityMissedRunGuard(mockDb, { commandRunner: runner });

      // Friday morning 2026-11-06 09:00 IST
      const asOfFriday = new Date("2026-11-06T03:30:00Z");
      const missing = await guard.findMissingDates({
        startDate: "2026-11-04",
        asOfDate: asOfFriday,
      });

      expect(missing).toEqual(["2026-11-04", "2026-11-05"]);

      const result = await guard.runCatchup(missing);
      expect(result.collected).toBe(true);
      expect(result.evaluatedDates).toEqual(["2026-11-04", "2026-11-05"]);

      // Oldest first: 11-04 before 11-05
      expect(executedCommands).toEqual([
        "run equity:collect:eod",
        "run equity:alerts:eval -- --date 2026-11-04",
        "run equity:alerts:eval -- --date 2026-11-05",
      ]);
    });

    it("skips holidays and weekends without evaluating them", async () => {
      const mockDb = new MockDatabase();
      mockDb.holidays.add("2026-11-13"); // Friday 11-13 is holiday

      const runner = vi.fn();
      const guard = new EquityMissedRunGuard(mockDb, { commandRunner: runner });

      // Range: Friday 11-13 (holiday), Saturday 11-14 (weekend), Sunday 11-15 (weekend), Monday 11-16 (trading day)
      // As of Monday 11-16 18:00 IST
      const asOfMondayEvening = new Date("2026-11-16T12:30:00Z");
      const missing = await guard.findMissingDates({
        startDate: "2026-11-13",
        asOfDate: asOfMondayEvening,
      });

      expect(missing).toEqual(["2026-11-16"]);
      expect(missing).not.toContain("2026-11-13");
      expect(missing).not.toContain("2026-11-14");
      expect(missing).not.toContain("2026-11-15");
    });

    it("a gap behind a later evaluated date is recovered", async () => {
      const mockDb = new MockDatabase();
      // Tuesday 10-21 has bars and eval
      mockDb.bars.add("2026-10-21");
      mockDb.evaluations.add("2026-10-21");

      // Wednesday 10-22 has bars but was UNEVALUATED
      mockDb.bars.add("2026-10-22");

      // Thursday 10-23 was evaluated
      mockDb.bars.add("2026-10-23");
      mockDb.evaluations.add("2026-10-23");

      const runner = async (_cmd: string, _args: string[]) => {};
      const guard = new EquityMissedRunGuard(mockDb, {
        commandRunner: runner,
        lookbackDays: 5,
      });

      // As of Friday 10-24 10:00 IST (eligible end date: 10-23)
      const asOfSaturday = new Date("2026-10-24T04:30:00Z");
      const missing = await guard.findMissingDates({
        startDate: "2026-10-21",
        asOfDate: asOfSaturday,
      });

      // 10-22 is detected even though 10-23 was already evaluated!
      expect(missing).toEqual(["2026-10-22"]);
    });

    it("a missing bar is retried, not written off", async () => {
      const mockDb = new MockDatabase();
      // Missing date 2026-11-18 has NO bars in mockDb
      const executedCommands: string[] = [];
      const runner = async (_cmd: string, args: string[]) => {
        executedCommands.push(args.join(" "));
        // Simulate: Yahoo does NOT have the bar yet! collection runs but bar is still not in DB
      };

      const guard = new EquityMissedRunGuard(mockDb, { commandRunner: runner });

      // Run catchup on 2026-11-18
      const result = await guard.runCatchup(["2026-11-18"]);
      expect(result.collected).toBe(true);
      // Because bars were missing, evaluation was NOT run and NOT marked completed
      expect(result.evaluatedDates).toEqual([]);
      expect(mockDb.evaluations.has("2026-11-18")).toBe(false);

      // Attempt state was recorded (attempt 1)
      const state = guard.getAttemptState("2026-11-18");
      expect(state).toBeDefined();
      expect(state?.attempts).toBe(1);

      // Only equity:collect:eod was called, equity:alerts:eval was NOT called
      expect(executedCommands).toEqual(["run equity:collect:eod"]);
    });

    it("a failing runner stops after the attempt cap with backoff", async () => {
      const mockDb = new MockDatabase();
      mockDb.bars.add("2026-11-19"); // Bars exist

      const errorLogger = vi.fn();
      const failingRunner = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes("equity:alerts:eval")) {
          throw new Error("Simulated evaluation crash");
        }
      });

      const guard = new EquityMissedRunGuard(mockDb, {
        commandRunner: failingRunner,
        maxAttemptsPerDate: 3,
        backoffMs: 15 * 60_000,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: errorLogger,
        },
      });

      const t0 = 1000000;

      // Attempt 1 at t0
      const res1 = await guard.runCatchup(["2026-11-19"], t0);
      expect(res1.evaluatedDates).toEqual([]);
      expect(guard.getAttemptState("2026-11-19")?.attempts).toBe(1);

      // Check 5 minutes later (t0 + 5m < 15m backoff) -> skipped due to backoff cooldown!
      const missingInCooldown = await guard.findMissingDates({
        startDate: "2026-11-19",
        asOfDate: new Date("2026-11-20T10:00:00Z"),
        nowMs: t0 + 5 * 60_000,
      });
      expect(missingInCooldown).toEqual([]);

      // Attempt 2 after 15m (t0 + 16m)
      const t1 = t0 + 16 * 60_000;
      const res2 = await guard.runCatchup(["2026-11-19"], t1);
      expect(guard.getAttemptState("2026-11-19")?.attempts).toBe(2);

      // Attempt 3 after another 15m (t1 + 16m)
      const t2 = t1 + 16 * 60_000;
      const res3 = await guard.runCatchup(["2026-11-19"], t2);
      expect(guard.getAttemptState("2026-11-19")?.attempts).toBe(3);

      // After 3 failed attempts, subsequent check stops retrying and logs an error
      const t3 = t2 + 16 * 60_000;
      const missingCapped = await guard.findMissingDates({
        startDate: "2026-11-19",
        asOfDate: new Date("2026-11-20T10:00:00Z"),
        nowMs: t3,
      });
      expect(missingCapped).toEqual([]);
      expect(errorLogger).toHaveBeenCalledWith(
        "Attempt cap reached for missed date; stopping retries",
        expect.objectContaining({ date: "2026-11-19", attempts: 3, maxAttempts: 3 }),
      );
    });

    it("running the guard twice on completed state makes no duplicate alerts or runs", async () => {
      const mockDb = new MockDatabase();
      mockDb.bars.add("2026-11-20");

      const runner = vi.fn();
      const guard = new EquityMissedRunGuard(mockDb, { commandRunner: runner });

      // Run 1: catches up 11-20
      const pass1 = await guard.runCatchup(["2026-11-20"]);
      expect(pass1.evaluatedDates).toEqual(["2026-11-20"]);
      expect(mockDb.evaluations.has("2026-11-20")).toBe(true);
      expect(runner).toHaveBeenCalledTimes(2); // collect once, eval once

      // Run 2: finds 0 missing dates
      const pass2 = await guard.findMissingDates({
        startDate: "2026-11-20",
        asOfDate: new Date("2026-11-21T10:00:00Z"),
      });
      expect(pass2).toEqual([]);

      const pass2Catchup = await guard.runCatchup(pass2);
      expect(pass2Catchup.evaluatedDates).toEqual([]);
      expect(runner).toHaveBeenCalledTimes(2); // runner was NOT called again
    });

    it("clamps lookback to guardStartDate (defaults to 2026-10-21) and ignores pre-launch backfill days", async () => {
      const mockDb = new MockDatabase();
      // Live state simulation:
      // Bars exist from 10-14 through 10-26
      const barDates = [
        "2026-10-14",
        "2026-10-15",
        "2026-10-16",
        "2026-10-19",
        "2026-10-20",
        "2026-10-21",
        "2026-10-22",
        "2026-10-23",
        "2026-10-26",
      ];
      for (const d of barDates) mockDb.bars.add(d);

      // Holiday on Tuesday 10-20
      mockDb.holidays.add("2026-10-20");

      // Evaluation rows exist for: 10-19, 10-21, 10-22, 10-23
      mockDb.evaluations.add("2026-10-19");
      mockDb.evaluations.add("2026-10-21");
      mockDb.evaluations.add("2026-10-22");
      mockDb.evaluations.add("2026-10-23");

      // Notice: 10-16 (Friday) has bars but was NOT evaluated.
      // Monday 10-26 has bars but was NOT evaluated.

      const runner = vi.fn();
      const guard = new EquityMissedRunGuard(mockDb, {
        commandRunner: runner,
        lookbackDays: 10, // 10 days back from 10-26 would reach 10-16
      });

      // As of Monday 2026-10-26 18:00 IST (12:30 UTC)
      const asOfMondayEvening = new Date("2026-10-26T12:30:00.000Z");
      const missing = await guard.findMissingDates({
        asOfDate: asOfMondayEvening,
      });

      // 10-16 is strictly excluded because it precedes guardStartDate (2026-10-21)
      expect(missing).toEqual(["2026-10-26"]);
      expect(missing).not.toContain("2026-10-16");

      // Verify that if guardStartDate is overridden via option, it respects the override
      const customGuard = new EquityMissedRunGuard(mockDb, {
        commandRunner: runner,
        guardStartDate: "2026-10-15",
        lookbackDays: 10,
      });
      const missingWithEarlierGuard = await customGuard.findMissingDates({
        asOfDate: asOfMondayEvening,
      });
      // Now 10-16 is included because guardStartDate was moved earlier
      expect(missingWithEarlierGuard).toContain("2026-10-16");
      expect(missingWithEarlierGuard).toContain("2026-10-26");
    });

    it("resets attempt counts at IST midnight so exhausted dates get retried the next day", async () => {
      const mockDb = new MockDatabase();
      mockDb.bars.add("2026-10-23");

      const failingRunner = vi.fn().mockRejectedValue(new Error("Downstream eval error"));
      const guard = new EquityMissedRunGuard(mockDb, {
        commandRunner: failingRunner,
        maxAttemptsPerDate: 3,
        backoffMs: 15 * 60_000,
      });

      // Friday 2026-10-23 at 18:00 IST (12:30 UTC)
      const t0 = new Date("2026-10-23T12:30:00.000Z").getTime();
      const asOfFridayNight = new Date("2026-10-23T14:00:00.000Z"); // 19:30 IST

      // Run 3 attempts with 15m intervals on 2026-10-23
      await guard.runCatchup(["2026-10-23"], t0);
      await guard.runCatchup(["2026-10-23"], t0 + 16 * 60_000);
      await guard.runCatchup(["2026-10-23"], t0 + 32 * 60_000);

      expect(guard.getAttemptState("2026-10-23")?.attempts).toBe(3);

      // Same day at 23:00 IST (17:30 UTC) -> skipped because max attempts reached
      const sameDayCheck = await guard.findMissingDates({
        startDate: "2026-10-23",
        asOfDate: asOfFridayNight,
        nowMs: new Date("2026-10-23T17:30:00.000Z").getTime(),
      });
      expect(sameDayCheck).toEqual([]);

      // Advance clock past IST midnight:
      // In IST, midnight occurs at 18:30 UTC.
      // Saturday morning 2026-10-24 at 09:00 IST (03:30 UTC)
      const nextDayMs = new Date("2026-10-24T03:30:00.000Z").getTime();
      const asOfSaturdayMorning = new Date("2026-10-24T03:30:00.000Z");

      const nextDayCheck = await guard.findMissingDates({
        startDate: "2026-10-23",
        asOfDate: asOfSaturdayMorning,
        nowMs: nextDayMs,
      });

      // The attempt counter reset! 2026-10-23 is eligible again for retry
      expect(nextDayCheck).toEqual(["2026-10-23"]);
    });
  });
});
