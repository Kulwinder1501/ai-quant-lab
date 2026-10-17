import { describe, expect, it } from "vitest";
import { deriveQuoteLabel, deriveStockState, isIndianMarketOpen } from "./state-rules.js";

describe("Equity State and Label derivation rules (Hard rules Section 2, Gates G3, S8)", () => {
  it("determines Indian equity market session hours accurately (09:15-15:30 IST Mon-Fri)", () => {
    // Monday at 10:30 IST (05:00 UTC) -> OPEN
    expect(isIndianMarketOpen(new Date("2026-10-19T05:00:00Z"))).toBe(true);

    // Monday at 08:30 IST (03:00 UTC) -> CLOSED (pre-market)
    expect(isIndianMarketOpen(new Date("2026-10-19T03:00:00Z"))).toBe(false);

    // Monday at 16:00 IST (10:30 UTC) -> CLOSED (post-market)
    expect(isIndianMarketOpen(new Date("2026-10-19T10:30:00Z"))).toBe(false);

    // Saturday at 11:00 IST (05:30 UTC) -> CLOSED (weekend)
    expect(isIndianMarketOpen(new Date("2026-10-17T05:30:00Z"))).toBe(false);

    // Sunday at 11:00 IST (05:30 UTC) -> CLOSED (weekend)
    expect(isIndianMarketOpen(new Date("2026-10-18T05:30:00Z"))).toBe(false);
  });

  it("derives honest quote labels (DELAYED, LAST-TRADED, PREVIOUS-CLOSE, never REAL-TIME)", () => {
    // 1. During active market hours on trading day with today's quote -> DELAYED
    const mondayMidday = new Date("2026-10-19T05:30:00Z"); // 11:00 IST
    const labelOpen = deriveQuoteLabel({
      marketTime: new Date("2026-10-19T05:15:00Z"), // 10:45 IST
      now: mondayMidday,
    });
    expect(labelOpen).toBe("DELAYED");

    // 2. Just after close (15:45 IST = 10:15 UTC) on trading day -> LAST-TRADED
    const mondayPostClose = new Date("2026-10-19T10:15:00Z"); // 15:45 IST
    const labelLastTraded = deriveQuoteLabel({
      marketTime: new Date("2026-10-19T10:00:00Z"), // 15:30 IST
      now: mondayPostClose,
    });
    expect(labelLastTraded).toBe("LAST-TRADED");

    // 3. Evening (18:00 IST = 12:30 UTC) or weekend -> PREVIOUS-CLOSE
    const mondayEvening = new Date("2026-10-19T12:30:00Z"); // 18:00 IST
    const labelClosed = deriveQuoteLabel({
      marketTime: new Date("2026-10-19T10:00:00Z"),
      now: mondayEvening,
    });
    expect(labelClosed).toBe("PREVIOUS-CLOSE");

    // 4. Over the weekend -> PREVIOUS-CLOSE
    const saturday = new Date("2026-10-17T10:00:00Z");
    const labelWeekend = deriveQuoteLabel({
      marketTime: new Date("2026-10-16T10:00:00Z"),
      now: saturday,
    });
    expect(labelWeekend).toBe("PREVIOUS-CLOSE");
  });

  it("derives NEVER_FETCHED when stock has no price history or fetch records", () => {
    const res = deriveStockState({ hasBars: false, lastFetchedAt: null });
    expect(res.state).toBe("NEVER_FETCHED");
    expect(res.reason).toBeDefined();
  });

  it("derives UNAVAILABLE when source health is marked UNAVAILABLE", () => {
    const res = deriveStockState({
      hasBars: true,
      sourceHealthStatus: "UNAVAILABLE",
      lastBarDate: "2026-10-16",
    });
    expect(res.state).toBe("UNAVAILABLE");
  });

  it("derives RATE_LIMITED when source health reports RATE_LIMITED", () => {
    const res = deriveStockState({
      hasBars: true,
      sourceHealthStatus: "RATE_LIMITED",
      lastBarDate: "2026-10-16",
    });
    expect(res.state).toBe("RATE_LIMITED");
    expect(res.reason).toContain("rate limit");
  });

  it("isolates per-stock failures (Gate S8): failing stock shows UNAVAILABLE with reason while healthy stock shows OK", () => {
    // Failing stock: latest raw record failed
    const failedStock = deriveStockState({
      hasBars: true,
      sourceHealthStatus: "OK",
      lastRawOutcome: "ERROR",
      lastRawWarning: "HTTP 500: Internal server error on symbol XYZ",
      lastBarDate: "2026-10-16",
    });
    expect(failedStock.state).toBe("UNAVAILABLE");
    expect(failedStock.reason).toBe("HTTP 500: Internal server error on symbol XYZ");

    // Healthy stock: latest raw record succeeded
    const healthyStock = deriveStockState({
      hasBars: true,
      sourceHealthStatus: "OK",
      lastRawOutcome: "OK",
      lastBarDate: "2026-10-16",
      now: new Date("2026-10-17T12:00:00Z"),
    });
    expect(healthyStock.state).toBe("OK");
    expect(healthyStock.reason).toBeNull();
  });

  it("derives STALE when last bar is older than threshold", () => {
    const now = new Date("2026-10-17T12:00:00Z");
    const res = deriveStockState({
      hasBars: true,
      lastBarDate: "2026-10-01",
      now,
      staleThresholdDays: 4,
    });
    expect(res.state).toBe("STALE");
    expect(res.reason).toContain("2026-10-01");
  });

  it("derives OK when recently fetched and source is healthy", () => {
    const now = new Date("2026-10-17T12:00:00Z");
    const res = deriveStockState({
      hasBars: true,
      lastBarDate: "2026-10-16",
      now,
      sourceHealthStatus: "OK",
    });
    expect(res.state).toBe("OK");
    expect(res.reason).toBeNull();
  });
});
