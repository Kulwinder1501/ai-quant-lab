import { describe, expect, it } from "vitest";
import {
  deriveVolatilityRegime,
  highVolRatioThreshold,
  priorMeanExcludingCurrent,
  regimeStalenessMilliseconds,
} from "./regime.js";

describe("deriveVolatilityRegime", () => {
  it("classifies volatility against its own recent average", () => {
    expect(deriveVolatilityRegime(15, 12)).toEqual({ regime: "HIGH_VOL", valueRatio: 1.25 });
    expect(deriveVolatilityRegime(12, 15)).toEqual({ regime: "LOW_VOL", valueRatio: 0.8 });
  });

  it("treats volatility exactly at its average as low", () => {
    expect(deriveVolatilityRegime(12, 12)).toMatchObject({ regime: "LOW_VOL" });
  });

  it("recovers the prior-19-day mean exactly from the inclusive SMA(20)", () => {
    // 19 prior closes averaging 12, then a close of 15: SMA20 = (19*12 + 15) / 20 = 12.15.
    expect(priorMeanExcludingCurrent(15, 12.15)).toBeCloseTo(12, 12);
    expect(priorMeanExcludingCurrent(1, 0.01)).toBeNull();
  });

  it("does not call a close that is only slightly above its own prior mean HIGH_VOL", () => {
    // Prior mean 12, close 12.9 (+7.5%): SMA20 = (19*12 + 12.9) / 20 = 12.045, so the old rule
    // (close / SMA20 > 1) said HIGH_VOL. Under the 1.10 band it is LOW_VOL.
    const sma = (19 * 12 + 12.9) / 20;
    expect(12.9 / sma).toBeGreaterThan(1);
    expect(deriveVolatilityRegime(12.9, sma)).toMatchObject({ regime: "LOW_VOL" });
    // Just past the band is HIGH_VOL: +10.5% over the prior mean.
    const smaHigh = (19 * 12 + 13.26) / 20;
    expect(deriveVolatilityRegime(13.26, smaHigh)).toMatchObject({ regime: "HIGH_VOL" });
    expect(highVolRatioThreshold).toBe(1.1);
  });

  it("excludes the current bar: one spike cannot lift its own baseline into a LOW_VOL verdict", () => {
    // Prior mean 12, a spike to 20. The inclusive SMA is 12.4, so close/SMA = 1.61; against the
    // prior mean it is 1.67. Both HIGH, but the verdict follows the prior mean.
    const sma = (19 * 12 + 20) / 20;
    expect(deriveVolatilityRegime(20, sma)).toMatchObject({ regime: "HIGH_VOL", valueRatio: 20 / sma });
  });

  it("keeps a calm oscillating series LOW_VOL instead of calling half of it HIGH_VOL", () => {
    // Closes oscillating +/-3% around 14 never exceed the +10% band.
    const closes = Array.from({ length: 60 }, (_unused, index) => 14 * (1 + (index % 2 === 0 ? 0.03 : -0.03)));
    let high = 0;
    for (let index = 19; index < closes.length; index += 1) {
      const window = closes.slice(index - 19, index + 1);
      const sma = window.reduce((sum, value) => sum + value, 0) / 20;
      if (deriveVolatilityRegime(closes[index]!, sma)?.regime === "HIGH_VOL") high += 1;
      // The old rule classifies every up-tick of the oscillation HIGH_VOL: half the days.
    }
    expect(high).toBe(0);
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
