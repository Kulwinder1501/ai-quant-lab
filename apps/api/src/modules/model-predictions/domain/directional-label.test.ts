import { describe, expect, it } from "vitest";
import { directionalLabelFromForwardReturnBps } from "./directional-label.js";

describe("directionalLabelFromForwardReturnBps", () => {
  it("commits to a direction only strictly beyond the band", () => {
    expect(directionalLabelFromForwardReturnBps(50.01, 50)).toBe("BULLISH");
    expect(directionalLabelFromForwardReturnBps(-50.01, 50)).toBe("BEARISH");
    expect(directionalLabelFromForwardReturnBps(49.99, 50)).toBe("NEUTRAL");
    expect(directionalLabelFromForwardReturnBps(-49.99, 50)).toBe("NEUTRAL");
  });

  it("keeps the neutral band inclusive on both edges", () => {
    // The trainer's `label_from_future_close` documents this explicitly: a return exactly
    // on either threshold stays NEUTRAL. These two assertions are the whole reason this
    // function exists — an edit that "simplified" > to >= would silently relabel every
    // boundary case and no accuracy figure would look wrong.
    expect(directionalLabelFromForwardReturnBps(50, 50)).toBe("NEUTRAL");
    expect(directionalLabelFromForwardReturnBps(-50, 50)).toBe("NEUTRAL");
  });

  it("treats a zero band as committing on any non-zero move", () => {
    expect(directionalLabelFromForwardReturnBps(0, 0)).toBe("NEUTRAL");
    expect(directionalLabelFromForwardReturnBps(0.0001, 0)).toBe("BULLISH");
    expect(directionalLabelFromForwardReturnBps(-0.0001, 0)).toBe("BEARISH");
  });

  it("matches the boundary cases cross-checked against the trainer", () => {
    // Verified 2026-07-31 against `label_from_future_close` and against the settlement
    // SQL, all three agreeing: source 100 with these futures, at a 50bps band.
    const cases: Array<[number, number, string]> = [
      [50.0, 50, "NEUTRAL"],
      [49.99, 50, "NEUTRAL"],
      [50.01, 50, "BULLISH"],
      [-50.0, 50, "NEUTRAL"],
      [-50.01, 50, "BEARISH"],
      [-49.99, 50, "NEUTRAL"],
      [0, 50, "NEUTRAL"],
    ];
    for (const [bps, band, expected] of cases) {
      expect(directionalLabelFromForwardReturnBps(bps, band)).toBe(expected);
    }
  });

  it("rejects inputs it cannot label rather than defaulting to NEUTRAL", () => {
    // Silently returning NEUTRAL would mark a prediction wrong on bad data instead of
    // reporting that the data was bad.
    expect(() => directionalLabelFromForwardReturnBps(Number.NaN, 50)).toThrow(/finite/);
    expect(() => directionalLabelFromForwardReturnBps(Number.POSITIVE_INFINITY, 50)).toThrow(/finite/);
    expect(() => directionalLabelFromForwardReturnBps(10, -1)).toThrow(/non-negative/);
    expect(() => directionalLabelFromForwardReturnBps(10, Number.NaN)).toThrow(/finite/);
  });
});
