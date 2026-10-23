import { describe, expect, it } from "vitest";
import {
  buildGreeksByStrike,
  GREEKS_MODEL_DERIVED_LABEL,
  type GreeksStrikeInput,
  type GreeksStrikeLegInput,
} from "./build-greeks-by-strike";

function leg(
  partial: Partial<GreeksStrikeLegInput> & Pick<GreeksStrikeLegInput, "impliedVolatility">,
): GreeksStrikeLegInput {
  return {
    impliedVolatilityRefusal: partial.impliedVolatilityRefusal ?? null,
    delta: partial.delta ?? null,
    gamma: partial.gamma ?? null,
    theta: partial.theta ?? null,
    vega: partial.vega ?? null,
    impliedVolatility: partial.impliedVolatility,
  };
}

function row(
  strikePrice: number,
  call: GreeksStrikeLegInput | null,
  put: GreeksStrikeLegInput | null,
): GreeksStrikeInput {
  return { strikePrice, call, put };
}

describe("buildGreeksByStrike", () => {
  it("leaves a gap (null plot) when IV could not be solved, and keeps the refusal reason", () => {
    const result = buildGreeksByStrike(
      [
        row(
          100,
          leg({
            impliedVolatility: null,
            impliedVolatilityRefusal: "NO_TWO_SIDED_QUOTE",
            // Poison values that must never plot when IV is null.
            delta: 0.5,
            gamma: 0.01,
            theta: -10,
            vega: 5,
          }),
          leg({ impliedVolatility: 0.2, delta: -0.4, gamma: 0.01, theta: -8, vega: 4 }),
        ),
      ],
      { metric: "gamma" },
    );

    const point = result.points[0]!;
    expect(point.callIv).toBeNull();
    expect(point.callIvRefusal).toBe("NO_TWO_SIDED_QUOTE");
    expect(point.callGamma).toBeNull();
    expect(point.callDelta).toBeNull();
    expect(point.callTheta).toBeNull();
    expect(point.callVega).toBeNull();
    expect(point.callMetricPlot).toBeNull();
    expect(point.putMetricPlot).toBe(-0.01);
  });

  it("never invents a Greek when IV is null across all metrics", () => {
    const strikes = [
      row(
        100,
        leg({
          impliedVolatility: null,
          impliedVolatilityRefusal: "BELOW_INTRINSIC",
          delta: 0.9,
          gamma: 0.02,
          theta: -1,
          vega: 2,
        }),
        null,
      ),
    ];

    for (const metric of ["iv", "delta", "gamma", "theta", "vega"] as const) {
      const point = buildGreeksByStrike(strikes, { metric }).points[0]!;
      expect(point.callMetricPlot).toBeNull();
      expect(point.callDelta).toBeNull();
      expect(point.callGamma).toBeNull();
      expect(point.callTheta).toBeNull();
      expect(point.callVega).toBeNull();
    }
  });

  it("keeps theta negative for long call and long put (buyer pays)", () => {
    const result = buildGreeksByStrike(
      [
        row(
          100,
          leg({ impliedVolatility: 0.15, delta: 0.5, gamma: 0.01, theta: -12.5, vega: 8 }),
          leg({ impliedVolatility: 0.16, delta: -0.45, gamma: 0.01, theta: -11.2, vega: 7 }),
        ),
      ],
      { metric: "theta" },
    );

    expect(result.points[0]!.callTheta).toBeLessThan(0);
    expect(result.points[0]!.putTheta).toBeLessThan(0);
    expect(result.points[0]!.callMetricPlot).toBe(-12.5);
    expect(result.points[0]!.putMetricPlot).toBe(11.2); // mirrored: -(-11.2)
  });

  it("windows ±N around ATM and centres on median when ATM is missing", () => {
    const strikes = [100, 110, 120, 130, 140, 150, 160].map((strikePrice) =>
      row(strikePrice, leg({ impliedVolatility: 0.1, gamma: 0.01 }), null),
    );

    const centred = buildGreeksByStrike(strikes, { metric: "gamma", atmStrike: 130, window: 2 });
    expect(centred.windowCenter).toBe("atm");
    expect(centred.points.map((p) => p.strike)).toEqual([110, 120, 130, 140, 150]);

    const median = buildGreeksByStrike(strikes, { metric: "gamma", atmStrike: null, window: 2 });
    expect(median.windowCenter).toBe("median");
    expect(median.points.map((p) => p.strike)).toEqual([110, 120, 130, 140, 150]);
  });

  it("plots IV as percent and carries the model-derived label", () => {
    const result = buildGreeksByStrike(
      [row(100, leg({ impliedVolatility: 0.155, delta: 0.5 }), null)],
      { metric: "iv" },
    );
    expect(result.points[0]!.callMetricPlot).toBeCloseTo(15.5, 8);
    expect(result.modelDerivedLabel).toBe(GREEKS_MODEL_DERIVED_LABEL);
  });
});
