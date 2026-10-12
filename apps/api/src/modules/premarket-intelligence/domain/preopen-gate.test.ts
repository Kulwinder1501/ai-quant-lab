import { describe, expect, it } from "vitest";
import { evaluatePreOpenGate, parseNseIndexTimestamp } from "./preopen-gate.js";

const rows = {
  NIFTY50: { indicativeClose: 22650, previousClose: 22520.45 },
  BANKNIFTY: { indicativeClose: 55400, previousClose: 55256.65 },
};
// 09:10 IST on 2026-10-12.
const now = new Date("2026-10-12T03:40:30.000Z");

describe("parseNseIndexTimestamp", () => {
  it("reads NSE's IST wall-clock timestamp as an instant", () => {
    expect(parseNseIndexTimestamp("12-Oct-2026 09:07")?.toISOString()).toBe("2026-10-12T03:37:00.000Z");
    expect(parseNseIndexTimestamp("12-Oct-2026 15:30")?.toISOString()).toBe("2026-10-12T10:00:00.000Z");
  });
  it("returns null for anything else", () => {
    expect(parseNseIndexTimestamp("garbage")).toBeNull();
    expect(parseNseIndexTimestamp(undefined)).toBeNull();
    expect(parseNseIndexTimestamp("12-Foo-2026 09:07")).toBeNull();
  });
});

describe("evaluatePreOpenGate", () => {
  it("passes a time-stamped print inside the pre-open window and computes the implied gap", () => {
    const result = evaluatePreOpenGate({ payloadTimestamp: "12-Oct-2026 09:08", rows, sessionDate: "2026-10-12", now });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.gaps.NIFTY50.impliedGapPct).toBeCloseTo(((22650 - 22520.45) / 22520.45) * 100, 8);
      expect(result.observedAt.toISOString()).toBe("2026-10-12T03:38:00.000Z");
    }
  });

  it("refuses a feed whose timestamp is the previous close, however non-zero the numbers", () => {
    const result = evaluatePreOpenGate({ payloadTimestamp: "12-Oct-2026 15:30", rows, sessionDate: "2026-10-12", now });
    expect(result).toEqual({ ok: false, reason: "TIMESTAMP_OUTSIDE_PREOPEN_WINDOW" });
  });

  it("refuses a pre-open print from another session", () => {
    const result = evaluatePreOpenGate({ payloadTimestamp: "09-Oct-2026 09:08", rows, sessionDate: "2026-10-12", now });
    expect(result).toEqual({ ok: false, reason: "TIMESTAMP_OUTSIDE_PREOPEN_WINDOW" });
  });

  it("refuses a stale print even inside the window", () => {
    const result = evaluatePreOpenGate({ payloadTimestamp: "12-Oct-2026 09:01", rows, sessionDate: "2026-10-12", now });
    expect(result).toEqual({ ok: false, reason: "INDICATIVE_PRINT_STALE" });
  });

  it("refuses zero or missing indicative values and a missing previous close", () => {
    const zero = evaluatePreOpenGate({ payloadTimestamp: "12-Oct-2026 09:08", rows: { ...rows, NIFTY50: { indicativeClose: 0, previousClose: 22520.45 } }, sessionDate: "2026-10-12", now });
    expect(zero).toEqual({ ok: false, reason: "NO_INDICATIVE_VALUE_NIFTY50" });
    const noPrev = evaluatePreOpenGate({ payloadTimestamp: "12-Oct-2026 09:08", rows: { ...rows, BANKNIFTY: { indicativeClose: 55400, previousClose: null } }, sessionDate: "2026-10-12", now });
    expect(noPrev).toEqual({ ok: false, reason: "NO_PREVIOUS_CLOSE_BANKNIFTY" });
  });

  it("refuses an unparseable timestamp", () => {
    expect(evaluatePreOpenGate({ payloadTimestamp: null, rows, sessionDate: "2026-10-12", now })).toEqual({ ok: false, reason: "NO_PARSEABLE_TIMESTAMP" });
  });
});
