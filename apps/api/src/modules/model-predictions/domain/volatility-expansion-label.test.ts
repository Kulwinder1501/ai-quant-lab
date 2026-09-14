import { describe, expect, it } from "vitest";
import {
  VOLATILITY_LABELS,
  gradeVolatilityOutcome,
  isVolatilityLabel,
  type RangeBar,
} from "./volatility-expansion-label.js";
import goldenVectors from "./volatility-expansion-golden.json" with { type: "json" };

/** A window whose high-low envelope is exactly `range`, centred on 100. */
function windowWithRange(range: number, bars = 5): RangeBar[] {
  const half = range / 2;
  const flat: RangeBar[] = Array.from({ length: bars - 1 }, () => ({ high: 100, low: 100 }));
  return [...flat, { high: 100 + half, low: 100 - half }];
}

const BAND = 0.25;

describe("gradeVolatilityOutcome", () => {
  it("labels EXPANSION at exactly the 1 + band threshold", () => {
    const grade = gradeVolatilityOutcome({
      trailingBars: windowWithRange(10),
      forwardBars: windowWithRange(12.5), // ratio 1.25 == 1 + 0.25
      horizonBars: 5,
      band: BAND,
    });

    expect(grade).toMatchObject({ measurable: true, label: "EXPANSION" });
    if (grade.measurable) expect(grade.rangeRatio).toBeCloseTo(1.25, 10);
  });

  // The reciprocal threshold, not 1 - band. A range ratio is multiplicative, so 2x
  // wider and 2x narrower are the symmetric pair; 1 - band would make CONTRACTION a
  // materially smaller target and skew the class balance.
  it("labels CONTRACTION at the reciprocal threshold, not at 1 - band", () => {
    const reciprocal = gradeVolatilityOutcome({
      trailingBars: windowWithRange(10),
      forwardBars: windowWithRange(10 / 1.25), // ratio 0.8 == 1 / 1.25
      horizonBars: 5,
      band: BAND,
    });
    expect(reciprocal).toMatchObject({ measurable: true, label: "CONTRACTION" });

    // 1 - band would be 0.75. A ratio of 0.79 sits below 0.8 and so is already a
    // CONTRACTION under the correct rule, but would be STABLE under the wrong one.
    const between = gradeVolatilityOutcome({
      trailingBars: windowWithRange(10),
      forwardBars: windowWithRange(7.9),
      horizonBars: 5,
      band: BAND,
    });
    expect(between).toMatchObject({ measurable: true, label: "CONTRACTION" });
  });

  it("labels STABLE strictly between the thresholds", () => {
    for (const forwardRange of [8.1, 10, 12.4]) {
      const grade = gradeVolatilityOutcome({
        trailingBars: windowWithRange(10),
        forwardBars: windowWithRange(forwardRange),
        horizonBars: 5,
        band: BAND,
      });
      expect(grade, `forwardRange=${forwardRange}`).toMatchObject({ measurable: true, label: "STABLE" });
    }
  });

  // Right-censoring. Grading an incomplete forward window would manufacture
  // CONTRACTION at the most recent end of the series, where a narrow envelope is an
  // artefact of missing bars rather than a market fact.
  it("reports an incomplete forward window as unmeasurable, never STABLE", () => {
    const grade = gradeVolatilityOutcome({
      trailingBars: windowWithRange(10),
      forwardBars: windowWithRange(10, 3).slice(0, 3),
      horizonBars: 5,
      band: BAND,
    });

    expect(grade.measurable).toBe(false);
    if (!grade.measurable) expect(grade.reason).toMatch(/not yet matured/);
  });

  it("reports a flat trailing window as unmeasurable rather than infinite expansion", () => {
    const grade = gradeVolatilityOutcome({
      trailingBars: Array.from({ length: 5 }, () => ({ high: 100, low: 100 })),
      forwardBars: windowWithRange(10),
      horizonBars: 5,
      band: BAND,
    });

    expect(grade.measurable).toBe(false);
    if (!grade.measurable) expect(grade.reason).toMatch(/trailing range is not positive/);
  });

  it("uses only the K bars nearest the source bar from each side", () => {
    // A wide bar far back in the trailing window must not enlarge the trailing range.
    const grade = gradeVolatilityOutcome({
      trailingBars: [{ high: 500, low: 0 }, ...windowWithRange(10)],
      forwardBars: [...windowWithRange(12.5), { high: 900, low: 0 }],
      horizonBars: 5,
      band: BAND,
    });

    expect(grade).toMatchObject({ measurable: true, label: "EXPANSION" });
    if (grade.measurable) {
      expect(grade.trailingRange).toBeCloseTo(10, 10);
      expect(grade.forwardRange).toBeCloseTo(12.5, 10);
    }
  });

  it("rejects an absent or non-positive band instead of assuming a default", () => {
    const bars = { trailingBars: windowWithRange(10), forwardBars: windowWithRange(10), horizonBars: 5 };
    for (const band of [0, -0.25, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => gradeVolatilityOutcome({ ...bars, band })).toThrow(/positive, finite/);
    }
  });

  it("rejects a non-integer horizon", () => {
    expect(() => gradeVolatilityOutcome({
      trailingBars: windowWithRange(10),
      forwardBars: windowWithRange(10),
      horizonBars: 2.5,
      band: BAND,
    })).toThrow(/positive integer/);
  });

  // A different band must reclassify the same realised ratio. This is why the band is
  // read from the model's recorded protocol and never defaulted.
  it("reclassifies the same ratio under a different band", () => {
    const bars = { trailingBars: windowWithRange(10), forwardBars: windowWithRange(12.5), horizonBars: 5 };
    expect(gradeVolatilityOutcome({ ...bars, band: 0.25 })).toMatchObject({ label: "EXPANSION" });
    expect(gradeVolatilityOutcome({ ...bars, band: 0.5 })).toMatchObject({ label: "STABLE" });
  });
});

describe("isVolatilityLabel", () => {
  it("accepts the alphabet and rejects directional labels", () => {
    for (const label of VOLATILITY_LABELS) expect(isVolatilityLabel(label)).toBe(true);
    // The two alphabets are disjoint by design; a BULLISH here would mean a
    // volatility model's output had reached the directional path.
    for (const label of ["BULLISH", "BEARISH", "NEUTRAL", "", null, 3]) {
      expect(isVolatilityLabel(label)).toBe(false);
    }
  });
});

// Cross-language pinning. These vectors are also asserted by
// apps/ml/tests/test_volatility_expansion.py against the Python labeller. The rule
// has two implementations — training labels in Python, settlement grades in
// TypeScript — and nothing else forces them to agree. If a change makes one suite
// fail, the other is now wrong too.
describe("volatility-expansion golden vectors (shared with apps/ml)", () => {
  const golden = goldenVectors as {
    cases: Array<{
      name: string;
      band: number;
      trailingRange: number;
      forwardHighs: number[];
      forwardLows: number[];
      expectedLabel: string;
      expectedRatio: number;
    }>;
  };

  it.each(golden.cases.map((testCase) => [testCase.name, testCase] as const))(
    "%s",
    (_name, testCase) => {
      const trailingBars: RangeBar[] = [
        ...Array.from({ length: 4 }, () => ({ high: 100, low: 100 })),
        { high: 100 + testCase.trailingRange / 2, low: 100 - testCase.trailingRange / 2 },
      ];
      const forwardBars: RangeBar[] = testCase.forwardHighs.map((high, index) => ({
        high,
        low: testCase.forwardLows[index],
      }));

      const grade = gradeVolatilityOutcome({
        trailingBars,
        forwardBars,
        horizonBars: 5,
        band: testCase.band,
      });

      expect(grade.measurable).toBe(true);
      if (grade.measurable) {
        expect(grade.label).toBe(testCase.expectedLabel);
        expect(grade.rangeRatio).toBeCloseTo(testCase.expectedRatio, 8);
      }
    },
  );
});
