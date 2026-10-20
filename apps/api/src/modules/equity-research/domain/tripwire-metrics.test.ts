import { describe, expect, it } from "vitest";
import { computeTripwireMetrics, type StockAlertCount } from "./tripwire-metrics.js";

describe("Live Tripwire Metrics (Gate Step 6)", () => {
  it("handles empty stock list gracefully", () => {
    const res = computeTripwireMetrics([], 20);
    expect(res.sampleSize).toBe(0);
    expect(res.median).toBe(0);
    expect(res.p95).toBe(0);
    expect(res.tripwireTriggered).toBe(false);
    expect(res.status).toBe("TRIPWIRE_CLEAR");
  });

  it("evaluates a compliant distribution as TRIPWIRE_CLEAR (median <= 3.0, p95 <= 8.0)", () => {
    // 20 stocks with alerts [1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 5, 6, 7, 8, 8]
    const counts: StockAlertCount[] = [
      1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 5, 6, 7, 8, 8,
    ].map((val, idx) => ({
      stockId: `stock-${idx}`,
      symbol: `SYM${idx}`,
      levelAlertsCount: val,
      totalAlertsCount: val,
    }));

    const res = computeTripwireMetrics(counts, 20);
    expect(res.sampleSize).toBe(20);
    expect(res.median).toBe(2.5);
    expect(res.p95).toBe(8);
    expect(res.tripwireTriggered).toBe(false);
    expect(res.status).toBe("TRIPWIRE_CLEAR");
    expect(res.message).toContain("satisfy frequency budget");
  });

  it("evaluates an elevated distribution as TRIPWIRE_TRIGGERED when p95 > 8.0", () => {
    // 20 stocks with elevated tail: p95 = 11.0 > 8.0
    const counts: StockAlertCount[] = [
      1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 5, 5, 6, 7, 8, 9, 10, 11, 14,
    ].map((val, idx) => ({
      stockId: `stock-${idx}`,
      symbol: `SYM${idx}`,
      levelAlertsCount: val,
      totalAlertsCount: val,
    }));

    const res = computeTripwireMetrics(counts, 20);
    expect(res.sampleSize).toBe(20);
    expect(res.p95).toBe(14);
    expect(res.tripwireTriggered).toBe(true);
    expect(res.status).toBe("TRIPWIRE_TRIGGERED");
    expect(res.message).toContain("exceeds budget limit of 8.0");
  });

  it("scales alert counts proportionally when tradingDays differs from 20", () => {
    // 10 trading days observed (half a trading month): counts should be scaled by 20/10 = 2.0
    const counts: StockAlertCount[] = [
      { stockId: "s1", symbol: "S1", levelAlertsCount: 2, totalAlertsCount: 2 },
      { stockId: "s2", symbol: "S2", levelAlertsCount: 3, totalAlertsCount: 3 },
      { stockId: "s3", symbol: "S3", levelAlertsCount: 4, totalAlertsCount: 4 },
      { stockId: "s4", symbol: "S4", levelAlertsCount: 5, totalAlertsCount: 5 },
    ];

    const res = computeTripwireMetrics(counts, 10);
    expect(res.scalingFactor).toBe(2.0);
    // Scaled counts: [4, 6, 8, 10]
    // Median of [4, 6, 8, 10] is (6 + 8)/2 = 7
    expect(res.median).toBe(7);
    expect(res.p95).toBe(10);
    expect(res.tripwireTriggered).toBe(true);
  });
});
