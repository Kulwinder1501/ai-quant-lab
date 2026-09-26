import { describe, it, expect } from "vitest";
import { LiquidityGeometryScorer } from "./liquidity-geometry-scorer.js";

describe("LiquidityGeometryScorer", () => {
  const scorer = new LiquidityGeometryScorer();

  it("scores high probability for close SESSION_HIGH candidate", () => {
    const res = scorer.score({
      poolType: "SESSION_HIGH",
      side: "UP",
      distanceBps: 2.5,
      timeframe: "1m",
      minutesIntoSession: 120,
      horizonSeconds: 300,
    });

    expect(res.predictedContactProbability).toBeGreaterThan(0.80);
    expect(res.probabilityBucket).toBe("HIGH");
    expect(res.isFavorableForContact).toBe(true);
  });

  it("scores low probability for far SWING_LOW candidate", () => {
    const res = scorer.score({
      poolType: "SWING_LOW",
      side: "DOWN",
      distanceBps: 150.0,
      timeframe: "1m",
      minutesIntoSession: 60,
      horizonSeconds: 300,
    });

    expect(res.predictedContactProbability).toBeLessThan(0.35);
    expect(res.probabilityBucket).toBe("LOW");
    expect(res.isFavorableForContact).toBe(false);
  });
});
