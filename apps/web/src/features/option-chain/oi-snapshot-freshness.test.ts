import { describe, expect, it } from "vitest";
import {
  assessOiSnapshotFreshness,
  isOiCollectionHours,
  isPreOpenOiCarryover,
  OI_IN_SESSION_STALE_AFTER_MS,
} from "./oi-snapshot-freshness";

/** 2026-10-12 is Monday. IST = UTC+5:30. */
const MON_0910_IST = Date.parse("2026-10-12T03:40:00.000Z");
const MON_0911_IST = Date.parse("2026-10-12T03:41:00.000Z");
const MON_0914_IST = Date.parse("2026-10-12T03:44:00.000Z");
const MON_0915_IST = Date.parse("2026-10-12T03:45:00.000Z");
const MON_0923_IST = Date.parse("2026-10-12T03:53:00.000Z");
const MON_1200_IST = Date.parse("2026-10-12T06:30:00.000Z");
/** 2026-10-16 is Friday. */
const FRI_1553_IST = Date.parse("2026-10-16T10:23:00.000Z");
const FRI_1554_IST = Date.parse("2026-10-16T10:24:00.000Z");
const SAT_1200_IST = Date.parse("2026-10-17T06:30:00.000Z");

describe("isOiCollectionHours", () => {
  it("is false just before the first cron minute", () => {
    expect(isOiCollectionHours(MON_0910_IST)).toBe(false);
  });

  it("is true at the first cron minute 09:11 IST", () => {
    expect(isOiCollectionHours(MON_0911_IST)).toBe(true);
  });

  it("is true at the last cron minute 15:53 IST", () => {
    expect(isOiCollectionHours(FRI_1553_IST)).toBe(true);
  });

  it("is false one minute after the last cron minute", () => {
    expect(isOiCollectionHours(FRI_1554_IST)).toBe(false);
  });

  it("is false on Saturday midday", () => {
    expect(isOiCollectionHours(SAT_1200_IST)).toBe(false);
  });
});

describe("assessOiSnapshotFreshness", () => {
  it("marks in-session fresh when age is within 20 minutes", () => {
    const observedAtMs = MON_1200_IST - 19 * 60_000;
    const result = assessOiSnapshotFreshness({ observedAtMs, nowMs: MON_1200_IST });
    expect(result.state).toBe("in_session_fresh");
    expect(result.nowInCollectionHours).toBe(true);
    expect(result.ageMs).toBe(19 * 60_000);
  });

  it("marks in-session stale when age exceeds 20 minutes during collection hours", () => {
    const observedAtMs = MON_1200_IST - (OI_IN_SESSION_STALE_AFTER_MS + 60_000);
    const result = assessOiSnapshotFreshness({ observedAtMs, nowMs: MON_1200_IST });
    expect(result.state).toBe("in_session_stale");
  });

  it("marks outside_collection_hours overnight even when the snapshot is old", () => {
    const result = assessOiSnapshotFreshness({
      observedAtMs: FRI_1553_IST,
      nowMs: SAT_1200_IST,
    });
    expect(result.state).toBe("outside_collection_hours");
    expect(result.nowInCollectionHours).toBe(false);
    expect(result.ageMs).toBeGreaterThan(OI_IN_SESSION_STALE_AFTER_MS);
  });

  it("marks outside_collection_hours before the first weekday slot", () => {
    const result = assessOiSnapshotFreshness({
      observedAtMs: MON_0910_IST - 24 * 3_600_000,
      nowMs: MON_0910_IST,
    });
    expect(result.state).toBe("outside_collection_hours");
  });

  it("treats a missing observedAt as in-session stale during collection hours", () => {
    const result = assessOiSnapshotFreshness({ observedAtMs: null, nowMs: MON_1200_IST });
    expect(result.state).toBe("in_session_stale");
    expect(result.ageMs).toBeNull();
    expect(result.preOpenOiCarryover).toBe(false);
  });

  it("flags the 09:11 snapshot as pre-open OI carryover even when freshness is in-session fresh", () => {
    const result = assessOiSnapshotFreshness({
      observedAtMs: MON_0911_IST,
      nowMs: MON_0911_IST + 60_000,
    });
    expect(result.state).toBe("in_session_fresh");
    expect(result.preOpenOiCarryover).toBe(true);
    expect(isPreOpenOiCarryover(MON_0911_IST)).toBe(true);
  });
});

describe("isPreOpenOiCarryover", () => {
  it("is true before 09:15 IST and false from 09:15 onward", () => {
    expect(isPreOpenOiCarryover(MON_0911_IST)).toBe(true);
    expect(isPreOpenOiCarryover(MON_0914_IST)).toBe(true);
    expect(isPreOpenOiCarryover(MON_0915_IST)).toBe(false);
    expect(isPreOpenOiCarryover(MON_0923_IST)).toBe(false);
    expect(isPreOpenOiCarryover(MON_1200_IST)).toBe(false);
  });
});
