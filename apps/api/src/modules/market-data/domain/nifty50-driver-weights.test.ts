import { describe, expect, it } from "vitest";
import {
  BANKNIFTY_DRIVER_WEIGHTS,
  FINNIFTY_DRIVER_WEIGHTS,
  NIFTY50_DRIVER_WEIGHTS,
  SENSEX_DRIVER_WEIGHTS,
  estimateContributionPts,
  resolveIndexDriverUniverse,
  yahooEquitySymbol,
} from "./nifty50-driver-weights.js";

describe("index driver weights", () => {
  it("keeps approximate Nifty 50 weights near 100%", () => {
    const total = NIFTY50_DRIVER_WEIGHTS.reduce(
      (sum, row) => sum + row.weightPct,
      0,
    );
    expect(total).toBeGreaterThan(95);
    expect(total).toBeLessThan(105);
    expect(NIFTY50_DRIVER_WEIGHTS).toHaveLength(50);
  });

  it("keeps Bank / Fin / Sensex roster weights near 100%", () => {
    for (const roster of [
      BANKNIFTY_DRIVER_WEIGHTS,
      FINNIFTY_DRIVER_WEIGHTS,
      SENSEX_DRIVER_WEIGHTS,
    ]) {
      const total = roster.reduce((sum, row) => sum + row.weightPct, 0);
      expect(total).toBeGreaterThan(95);
      expect(total).toBeLessThan(105);
    }
  });

  it("resolves supported index keys from UI symbols", () => {
    expect(resolveIndexDriverUniverse("NIFTY50")?.key).toBe("NIFTY50");
    expect(resolveIndexDriverUniverse("BANKNIFTY")?.yahooIndexSymbol).toBe(
      "^NSEBANK",
    );
    expect(resolveIndexDriverUniverse("FINNIFTY")?.label).toBe("Fin Nifty");
    expect(resolveIndexDriverUniverse("SENSEX")?.key).toBe("SENSEX");
    expect(resolveIndexDriverUniverse("HANG SENG")).toBeNull();
    expect(resolveIndexDriverUniverse("S&P 500")).toBeNull();
  });

  it("estimates contribution points from weight × day% × index", () => {
    expect(estimateContributionPts(6.2, 3.88, 24_638.15)).toBeCloseTo(59.27, 1);
    expect(estimateContributionPts(9.2, -1.7, 24_638.15)).toBeCloseTo(-38.53, 1);
  });

  it("maps NSE cash symbols to Yahoo .NS", () => {
    expect(yahooEquitySymbol("INFY")).toBe("INFY.NS");
    expect(yahooEquitySymbol("M&M")).toBe("M&M.NS");
    expect(yahooEquitySymbol("BAJAJ-AUTO")).toBe("BAJAJ-AUTO.NS");
  });
});
