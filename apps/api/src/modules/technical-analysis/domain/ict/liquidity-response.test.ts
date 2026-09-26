import { describe, it, expect } from "vitest";
import { LiquidityResponseResolver } from "./liquidity-response.js";

describe("LiquidityResponseResolver", () => {
  const resolver = new LiquidityResponseResolver();

  it("classifies confirmed SWING_HIGH with clean wick and reclaim as SWEEP_REJECTION", () => {
    const result = resolver.evaluate({
      poolType: "SWING_HIGH",
      side: "UP",
      penetrationBps: 3.5,
      reclaimDistanceBps: 12.0,
      isClosedBackInside: true,
    });

    expect(result.verdict).toBe("SWEEP_REJECTION");
    expect(result.isFavorableForSweep).toBe(true);
    expect(result.isFavorableForBreakout).toBe(false);
    expect(result.rejectionProbability).toBeGreaterThanOrEqual(0.85);
  });

  it("classifies PDH breach without reclaim as BREAK_ACCEPTANCE and forbids sweep reversal", () => {
    const result = resolver.evaluate({
      poolType: "PDH",
      side: "UP",
      penetrationBps: 22.0,
      reclaimDistanceBps: 0.0,
      isClosedBackInside: false,
    });

    expect(result.verdict).toBe("BREAK_ACCEPTANCE");
    expect(result.isFavorableForSweep).toBe(false);
    expect(result.isFavorableForBreakout).toBe(true);
    expect(result.acceptanceProbability).toBeGreaterThanOrEqual(0.70);
    expect(result.rationale).toContain("Reversal entries strictly prohibited");
  });

  it("classifies ITL sweep with reclaim as SWEEP_REJECTION", () => {
    const result = resolver.evaluate({
      poolType: "ITL",
      side: "DOWN",
      penetrationBps: 4.0,
      reclaimDistanceBps: 8.0,
      isClosedBackInside: true,
    });

    expect(result.verdict).toBe("SWEEP_REJECTION");
    expect(result.isFavorableForSweep).toBe(true);
  });

  it("handles heavy penetration on SWING_HIGH gracefully by reducing sweep probability", () => {
    const result = resolver.evaluate({
      poolType: "SWING_HIGH",
      side: "UP",
      penetrationBps: 25.0, // heavy penetration
      reclaimDistanceBps: 0.0,
      isClosedBackInside: false,
    });

    // Should penalize rejection probability
    expect(result.rejectionProbability).toBeLessThan(0.70);
    expect(result.isFavorableForSweep).toBe(false);
  });
});
