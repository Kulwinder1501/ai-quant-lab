import { describe, expect, it } from "vitest";
import { XAUUSD_OANDA_PROFILE } from "../../../platform/calendar/instrument-profile.js";
import { GOLD_MIN_GAP_MINUTES, GOLD_RECOVERY_BARS, ictGapGuardFor, measureGap } from "./series-gaps.js";

const at = (iso: string): Date => new Date(iso);

describe("measureGap on gold's calendar (January: New York is UTC-5, the break is 22:00-22:55 UTC)", () => {
  it("finds nothing between adjacent bars", () => {
    expect(measureGap(at("2026-01-13T14:00:00Z"), at("2026-01-13T14:05:00Z"), 5, XAUUSD_OANDA_PROFILE)).toBeNull();
  });

  it("does not count the weekend close as missing data", () => {
    // Friday's last 5m bar opens 21:55Z (16:55 New York); Sunday's first opens 23:00Z (18:00 New York)
    expect(measureGap(at("2026-01-09T21:55:00Z"), at("2026-01-11T23:00:00Z"), 5, XAUUSD_OANDA_PROFILE)).toBeNull();
  });

  it("does not count the daily New York break as missing data", () => {
    expect(measureGap(at("2026-01-12T21:55:00Z"), at("2026-01-12T23:00:00Z"), 5, XAUUSD_OANDA_PROFILE)).toBeNull();
  });

  it("measures a hole inside a session, with the session it belongs to", () => {
    // bars at 13:55 and 18:00 UTC: 14:00 to 17:55 is missing, 48 five-minute slots
    const gap = measureGap(at("2026-01-13T13:55:00Z"), at("2026-01-13T18:00:00Z"), 5, XAUUSD_OANDA_PROFILE);

    expect(gap?.missingMinutes).toBe(240);
    expect([...(gap?.sessionDates ?? [])]).toEqual(["2026-01-13"]);
  });

  it("counts only the open part of a hole that spans the break and the session roll, and names both sessions", () => {
    // 20:00Z Tue to 02:00Z Wed: 20:05-21:55 (23 slots, session 01-13), the 22:00-22:55 break (not counted), 23:00-01:55 (36 slots, session 01-14)
    const gap = measureGap(at("2026-01-13T20:00:00Z"), at("2026-01-14T02:00:00Z"), 5, XAUUSD_OANDA_PROFILE);

    expect(gap?.missingMinutes).toBe((23 + 36) * 5);
    expect([...(gap?.sessionDates ?? [])].sort()).toEqual(["2026-01-13", "2026-01-14"]);
  });

  it("measures in the timeframe's own bar size", () => {
    // 15m bars at 13:45 and 18:00: 14:00 to 17:45 is missing, 16 slots
    expect(measureGap(at("2026-01-13T13:45:00Z"), at("2026-01-13T18:00:00Z"), 15, XAUUSD_OANDA_PROFILE)?.missingMinutes).toBe(240);
  });

  it("follows the daylight-saving change: in July the break is 21:00-21:55 UTC, so a hole there is not data", () => {
    expect(measureGap(at("2026-07-14T20:55:00Z"), at("2026-07-14T22:00:00Z"), 5, XAUUSD_OANDA_PROFILE)).toBeNull();
    // and the same wall-clock span in January is open time that is missing: 21:00 to 21:55, twelve slots
    expect(measureGap(at("2026-01-13T20:55:00Z"), at("2026-01-13T22:00:00Z"), 5, XAUUSD_OANDA_PROFILE)?.missingMinutes).toBe(60);
  });
});

describe("ictGapGuardFor", () => {
  it("builds a guard for gold on a minute timeframe, with the documented thresholds", () => {
    expect(ictGapGuardFor("XAU_USD", "5m")).toEqual({ barMinutes: 5, minGapMinutes: GOLD_MIN_GAP_MINUTES, recoveryBars: GOLD_RECOVERY_BARS });
    expect(ictGapGuardFor("XAU_USD", "15m")?.barMinutes).toBe(15);
  });

  it("states its thresholds: a sixty-minute hole is a gap, and structure stays unavailable for thirty-six bars after one", () => {
    expect(GOLD_MIN_GAP_MINUTES).toBe(60);
    expect(GOLD_RECOVERY_BARS).toBe(36);
  });

  it("builds none for any NSE instrument, so their snapshots and cache identity are unchanged", () => {
    for (const symbol of ["NIFTY50", "BANKNIFTY", "INDIAVIX", undefined]) expect(ictGapGuardFor(symbol, "5m")).toBeNull();
  });

  it("builds none for a timeframe label it cannot read as minutes", () => {
    for (const timeframe of ["1d", "1h", "garbage", "", "0m"]) expect(ictGapGuardFor("XAU_USD", timeframe)).toBeNull();
  });
});
