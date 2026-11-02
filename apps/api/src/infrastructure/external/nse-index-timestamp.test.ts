import { describe, expect, it } from "vitest";
import { parseNseIndexTimestamp } from "./nse-index-timestamp.js";

describe("parseNseIndexTimestamp", () => {
  it("reads NSE's IST wall-clock timestamp as an instant", () => {
    expect(parseNseIndexTimestamp("12-Oct-2026 09:07")?.toISOString()).toBe("2026-10-12T03:37:00.000Z");
    expect(parseNseIndexTimestamp("12-Oct-2026 15:30")?.toISOString()).toBe("2026-10-12T10:00:00.000Z");
  });

  it("reads seconds when NSE sends them", () => {
    expect(parseNseIndexTimestamp("12-Oct-2026 09:07:30")?.toISOString()).toBe("2026-10-12T03:37:30.000Z");
  });

  it("returns null for anything else", () => {
    expect(parseNseIndexTimestamp("garbage")).toBeNull();
    expect(parseNseIndexTimestamp(undefined)).toBeNull();
    expect(parseNseIndexTimestamp("12-Foo-2026 09:07")).toBeNull();
    expect(parseNseIndexTimestamp("12-Oct-2026 25:07")).toBeNull();
  });
});
