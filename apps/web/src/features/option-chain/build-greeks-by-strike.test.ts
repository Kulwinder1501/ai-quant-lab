import { describe, expect, it } from "vitest";
import {
  buildGreeksByStrike,
  formatGreekValue,
  GREEKS_MODEL_DERIVED_LABEL,
  greeksAxisDecimals,
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
    expect(point.putMetricPlot).toBe(0.01);
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

  it("keeps natural signs, with call and put on the same axis (no mirroring)", () => {
    const strikes = [
      row(
        100,
        leg({ impliedVolatility: 0.15, delta: 0.5, gamma: 0.01, theta: -12.5, vega: 8 }),
        leg({ impliedVolatility: 0.16, delta: -0.45, gamma: 0.01, theta: -11.2, vega: 7 }),
      ),
    ];

    const theta = buildGreeksByStrike(strikes, { metric: "theta" }).points[0]!;
    // The buyer pays theta on both sides: both bars must sit below zero.
    expect(theta.callMetricPlot).toBe(-12.5);
    expect(theta.putMetricPlot).toBe(-11.2);

    const delta = buildGreeksByStrike(strikes, { metric: "delta" }).points[0]!;
    // Put delta is negative and must not be flipped onto the call side.
    expect(delta.callMetricPlot).toBe(0.5);
    expect(delta.putMetricPlot).toBe(-0.45);

    for (const metric of ["iv", "gamma", "vega"] as const) {
      const point = buildGreeksByStrike(strikes, { metric }).points[0]!;
      // IV, gamma and vega are positive quantities on both sides; a negative plot would be impossible.
      expect(point.callMetricPlot).toBeGreaterThan(0);
      expect(point.putMetricPlot).toBeGreaterThan(0);
    }
  });

  it("plots a zero Greek as 0, distinct from a gap", () => {
    const point = buildGreeksByStrike(
      [row(100, leg({ impliedVolatility: 0.1, theta: 0 }), null)],
      { metric: "theta" },
    ).points[0]!;
    expect(point.callMetricPlot).toBe(0);
    expect(point.putMetricPlot).toBeNull();
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

  it("separates a missing contract from an unsolved one and counts reasons per side", () => {
    const strikes = [
      row(100, leg({ impliedVolatility: 0.1 }), leg({ impliedVolatility: 0.1 })),
      row(110, leg({ impliedVolatility: null, impliedVolatilityRefusal: "NO_TWO_SIDED_QUOTE" }), null),
      row(120, leg({ impliedVolatility: null, impliedVolatilityRefusal: "NO_TWO_SIDED_QUOTE" }), leg({ impliedVolatility: null })),
      row(130, leg({ impliedVolatility: null, impliedVolatilityRefusal: "BELOW_INTRINSIC" }), leg({ impliedVolatility: 0.2 })),
    ];
    const result = buildGreeksByStrike(strikes, { metric: "iv" });

    expect(result.points[1]!.callPresent).toBe(true);
    expect(result.points[1]!.putPresent).toBe(false);
    expect(result.unsolved.calls).toEqual({
      legs: 4,
      unsolved: 3,
      reasons: { NO_TWO_SIDED_QUOTE: 2, BELOW_INTRINSIC: 1 },
    });
    // Strike 110 has no put contract at all, so it is not an unsolved put.
    expect(result.unsolved.puts).toEqual({ legs: 3, unsolved: 1, reasons: { UNKNOWN: 1 } });
  });

  it("counts unsolved legs only inside the window", () => {
    const strikes = [100, 110, 120].map((strikePrice) =>
      row(strikePrice, leg({ impliedVolatility: null, impliedVolatilityRefusal: "EXPIRED_OR_ZERO_TIME" }), null),
    );
    const result = buildGreeksByStrike(strikes, { metric: "iv", atmStrike: 100, window: 1 });
    expect(result.unsolved.calls.legs).toBe(2);
    expect(result.unsolved.calls.unsolved).toBe(2);
  });

  it("reports the largest absolute plotted value and the matching axis precision", () => {
    const result = buildGreeksByStrike(
      [
        row(100, leg({ impliedVolatility: 0.15, gamma: 0.00108 }), leg({ impliedVolatility: 0.15, gamma: 0.00031 })),
      ],
      { metric: "gamma" },
    );
    expect(result.maxAbsPlot).toBeCloseTo(0.00108, 10);
    expect(result.axisDecimals).toBe(5);
  });
});

describe("greeksAxisDecimals", () => {
  it("gives gamma enough decimals to be readable at index-option magnitudes", () => {
    // 3 decimals would label every tick 0.000 / 0.001 at this scale.
    expect(greeksAxisDecimals("gamma", 0.0011)).toBe(5);
    expect(greeksAxisDecimals("gamma", 0.04)).toBe(4);
    expect(greeksAxisDecimals("gamma", 1.5)).toBe(3);
  });

  it("falls back safely when nothing is plotted", () => {
    expect(greeksAxisDecimals("gamma", 0)).toBe(4);
    expect(greeksAxisDecimals("gamma", Number.NaN)).toBe(4);
  });

  it("scales theta and vega precision with magnitude", () => {
    expect(greeksAxisDecimals("theta", 250)).toBe(0);
    expect(greeksAxisDecimals("vega", 42)).toBe(1);
    expect(greeksAxisDecimals("theta", 3.2)).toBe(2);
  });
});

describe("formatGreekValue", () => {
  it("shows a gap as an em dash, never as zero", () => {
    expect(formatGreekValue(null, "gamma", 5)).toBe("—");
    expect(formatGreekValue(Number.NaN, "theta", 2)).toBe("—");
    expect(formatGreekValue(0, "theta", 2)).toBe("0.00");
  });

  it("carries a percent sign for IV only", () => {
    expect(formatGreekValue(15.5, "iv", 1)).toBe("15.5%");
    expect(formatGreekValue(-11.2, "theta", 2)).toBe("-11.20");
    expect(formatGreekValue(0.00108, "gamma", 5)).toBe("0.00108");
  });
});
