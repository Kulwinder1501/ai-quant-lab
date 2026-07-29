import { describe, expect, it } from "vitest";
import { deriveVolatilityRegime, regimeStalenessMilliseconds } from "./regime.js";

describe("deriveVolatilityRegime", () => {
  it("classifies volatility against its own recent average", () => {
    expect(deriveVolatilityRegime(15, 12)).toEqual({ regime: "HIGH_VOL", valueRatio: 1.25 });
    expect(deriveVolatilityRegime(12, 15)).toEqual({ regime: "LOW_VOL", valueRatio: 0.8 });
  });

  it("treats volatility exactly at its average as low", () => {
    expect(deriveVolatilityRegime(12, 12)).toMatchObject({ regime: "LOW_VOL" });
  });

  it("reports an unusable reading as unknown rather than as a calm market", () => {
    expect(deriveVolatilityRegime(15, 0)).toBeNull();
    expect(deriveVolatilityRegime(15, -1)).toBeNull();
    expect(deriveVolatilityRegime(0, 12)).toBeNull();
    expect(deriveVolatilityRegime(Number.NaN, 12)).toBeNull();
    expect(deriveVolatilityRegime(15, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("regimeStalenessMilliseconds", () => {
  it("scales the window with the timeframe", () => {
    expect(regimeStalenessMilliseconds("1d")).toBe(5 * 86_400_000);
    expect(regimeStalenessMilliseconds("15m")).toBe(5 * 15 * 60_000);
    expect(regimeStalenessMilliseconds("1h")).toBe(5 * 3_600_000);
  });

  it("declines to guess a window for an unrecognised timeframe", () => {
    expect(regimeStalenessMilliseconds("1w")).toBeNull();
    expect(regimeStalenessMilliseconds("weekly")).toBeNull();
    expect(regimeStalenessMilliseconds("")).toBeNull();
  });
});
