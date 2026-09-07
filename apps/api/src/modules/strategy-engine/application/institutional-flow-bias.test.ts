import { describe, expect, it } from "vitest";
import { institutionalFlowBias } from "./ai-autonomous-agent.js";

describe("institutionalFlowBias", () => {
  // Absent data is not a flat market. Coercing a null to 0 would tell the scorer
  // "institutions were balanced today" when the truth is that nobody collected.
  it("stays silent when no figures were collected", () => {
    expect(institutionalFlowBias(null, null)).toEqual({ adjustment: 0, reasoning: null });
  });

  it("reports balanced flows without moving confidence", () => {
    const bias = institutionalFlowBias(200, -100);
    expect(bias.adjustment).toBe(0);
    expect(bias.reasoning).toContain("balanced");
  });

  it("grades the adjustment by magnitude instead of firing a flat step", () => {
    // The original scorer gave 1001 Cr and 12000 Cr the identical ±10.
    const mild = institutionalFlowBias(1_000, 200);
    const strong = institutionalFlowBias(2_500, 500);
    const extreme = institutionalFlowBias(6_000, 1_000);

    expect(mild.adjustment).toBe(5);
    expect(strong.adjustment).toBe(10);
    expect(extreme.adjustment).toBe(18);
  });

  // "Heavily discounting bullish trades on extreme FII outflows" is what the
  // phase-22 doc asks for, and it matches the asymmetry this scorer already
  // applies to negative news.
  it("penalises outflows harder than it rewards equivalent inflows", () => {
    const inflow = institutionalFlowBias(6_000, 1_000);
    const outflow = institutionalFlowBias(-6_000, -1_000);

    expect(outflow.adjustment).toBeLessThan(-inflow.adjustment);
    expect(outflow.adjustment).toBe(-27);
    expect(outflow.reasoning).toContain("Extreme net institutional outflows");
  });

  // DII was queried and parsed but never read. It matters because DII routinely
  // absorbs FII selling: heavy FII outflow against heavy DII buying is a rotation,
  // and scoring it as an exodus is simply the wrong reading of the tape.
  it("nets DII against FII rather than ignoring it", () => {
    const fiiOnly = institutionalFlowBias(-3_000, null);
    const absorbed = institutionalFlowBias(-3_000, 2_800);

    expect(fiiOnly.adjustment).toBeLessThan(0);
    expect(absorbed.adjustment).toBe(0);
    expect(absorbed.reasoning).toContain("balanced");
  });

  it("names a counter-flow session as rotation", () => {
    const bias = institutionalFlowBias(-4_000, 1_500);
    expect(bias.reasoning).toContain("rotation");
  });

  it("does not treat a one-sided null as a zero on that side", () => {
    // 2500 alone is "strong"; if the null DII were read as 0 the combined figure
    // would be unchanged, but the reasoning must not claim a DII observation.
    const bias = institutionalFlowBias(2_500, null);
    expect(bias.adjustment).toBe(10);
    expect(bias.reasoning).toContain("Strong net institutional inflows");
  });

  it("keeps the adjustment inside a range the rest of the scorer can absorb", () => {
    for (const [fii, dii] of [
      [50_000, 50_000],
      [-50_000, -50_000],
      [0, 0],
    ] as const) {
      const { adjustment } = institutionalFlowBias(fii, dii);
      expect(Math.abs(adjustment)).toBeLessThanOrEqual(27);
    }
  });
});
