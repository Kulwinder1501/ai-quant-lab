import { describe, expect, it, vi } from "vitest";
import { CheckMacroEventsService } from "./check-macro-events.js";

describe("CheckMacroEventsService", () => {
  it("treats dated calendar rows as hasMacroEvent and headlines as soft heat", async () => {
    const repository = {
      findRecent: vi.fn(async () => [
        { title: "RBI holds repo rate", description: "policy decision", },
      ]),
    };
    const database = {
      query: vi.fn(async () => ({
        rows: [
          {
            event_date: "2026-08-11",
            name: "RBI MPC policy decision",
            region: "IN",
            source: "seed",
          },
        ],
      })),
    };

    const result = await new CheckMacroEventsService(repository as never, database as never).execute(
      new Date("2026-08-11T05:00:00.000Z"),
    );

    expect(result.hasMacroEvent).toBe(true);
    expect(result.hasScheduledEvent).toBe(true);
    expect(result.events).toEqual(["RBI MPC policy decision"]);
    expect(result.scheduledEvents).toHaveLength(1);
    expect(result.hasHeadlineHeat).toBe(true);
    expect(result.headlineEvents[0]).toContain("RBI");
  });

  it("keeps hasMacroEvent false when only headline heat is present", async () => {
    const repository = {
      findRecent: vi.fn(async () => [
        { title: "Fed speakers discuss inflation", description: "", },
      ]),
    };
    const database = {
      query: vi.fn(async () => ({ rows: [] })),
    };

    const result = await new CheckMacroEventsService(repository as never, database as never).execute(
      new Date("2026-08-11T05:00:00.000Z"),
    );

    expect(result.hasMacroEvent).toBe(false);
    expect(result.hasScheduledEvent).toBe(false);
    expect(result.hasHeadlineHeat).toBe(true);
    expect(result.headlineEvents.length).toBeGreaterThan(0);
  });
});
