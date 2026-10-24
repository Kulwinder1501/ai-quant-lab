import { describe, expect, it } from "vitest";
import { parseAsOf } from "./as-of.js";

const NOW = new Date("2026-10-26T06:00:00.000Z");

describe("parseAsOf", () => {
  it("is absent when not given, so the caller reads the newest", () => {
    expect(parseAsOf(undefined, NOW)).toEqual({ ok: true, value: null });
    expect(parseAsOf("  ", NOW)).toEqual({ ok: true, value: null });
  });

  it("reads a full ISO instant with an offset", () => {
    expect(parseAsOf("2026-10-23T10:23:01.583Z", NOW)).toEqual({ ok: true, value: new Date("2026-10-23T10:23:01.583Z") });
    expect(parseAsOf("2026-10-23T15:53:01+05:30", NOW)).toEqual({ ok: true, value: new Date("2026-10-23T10:23:01.000Z") });
  });

  it("refuses a bare date or a time with no offset: it would be read in the server's timezone", () => {
    for (const bad of ["2026-10-23", "2026-10-23T10:23:00", "yesterday"]) expect(parseAsOf(bad, NOW).ok, bad).toBe(false);
  });

  it("refuses an impossible instant and one in the future, with a few seconds of clock allowance", () => {
    expect(parseAsOf("2026-13-45T10:23:00Z", NOW)).toEqual({ ok: false, error: "`asOf` is not a real date and time." });
    expect(parseAsOf("2026-10-26T06:10:00Z", NOW)).toEqual({ ok: false, error: "`asOf` is in the future." });
    expect(parseAsOf("2026-10-26T06:00:04Z", NOW).ok).toBe(true);
  });
});
