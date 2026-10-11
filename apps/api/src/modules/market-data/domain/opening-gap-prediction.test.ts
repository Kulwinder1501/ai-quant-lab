import { describe, expect, it } from "vitest";
import { buildOpeningGapPrediction, gradeOpeningGapOutcome } from "./opening-gap-prediction.js";

describe("buildOpeningGapPrediction", () => {
  it("applies the instrument's own threshold, not a shared one", () => {
    const niftyFlat = buildOpeningGapPrediction({
      instrumentSymbol: "NIFTY50",
      sessionDate: "2026-10-12",
      driverSymbol: "^GSPC",
      driverChangePct: 0.3,
      supplementaryCues: {},
    });
    expect(niftyFlat.thresholdPct).toBe(0.25);
    expect(niftyFlat.expectation).toBe("GAP_UP");

    const bankniftyFlat = buildOpeningGapPrediction({
      instrumentSymbol: "BANKNIFTY",
      sessionDate: "2026-10-12",
      driverSymbol: "^GSPC",
      driverChangePct: 0.3,
      supplementaryCues: {},
    });
    expect(bankniftyFlat.thresholdPct).toBe(0.35);
    expect(bankniftyFlat.expectation).toBe("FLAT");
  });

  it("carries supplementary cues through unchanged", () => {
    const prediction = buildOpeningGapPrediction({
      instrumentSymbol: "NIFTY50",
      sessionDate: "2026-10-12",
      driverSymbol: "^GSPC",
      driverChangePct: 0.1,
      supplementaryCues: { "^N225": 1.2, "^HSI": null },
    });
    expect(prediction.supplementaryCues).toEqual({ "^N225": 1.2, "^HSI": null });
  });
});

describe("gradeOpeningGapOutcome", () => {
  it("grades a correct GAP_UP prediction", () => {
    const grade = gradeOpeningGapOutcome({
      instrumentSymbol: "NIFTY50",
      predictedExpectation: "GAP_UP",
      previousClose: 25000,
      actualOpen: 25075, // +0.30%
    });
    expect(grade.actualGapPct).toBeCloseTo(0.3, 4);
    expect(grade.actualExpectation).toBe("GAP_UP");
    expect(grade.wasCorrect).toBe(true);
  });

  it("grades a wrong prediction (predicted up, realized flat)", () => {
    const grade = gradeOpeningGapOutcome({
      instrumentSymbol: "NIFTY50",
      predictedExpectation: "GAP_UP",
      previousClose: 25000,
      actualOpen: 25010, // +0.04%
    });
    expect(grade.actualExpectation).toBe("FLAT");
    expect(grade.wasCorrect).toBe(false);
  });

  it("rejects a non-positive previousClose or actualOpen", () => {
    expect(() =>
      gradeOpeningGapOutcome({
        instrumentSymbol: "NIFTY50",
        predictedExpectation: "FLAT",
        previousClose: 0,
        actualOpen: 25000,
      }),
    ).toThrow(/previousClose/);
    expect(() =>
      gradeOpeningGapOutcome({
        instrumentSymbol: "NIFTY50",
        predictedExpectation: "FLAT",
        previousClose: 25000,
        actualOpen: -1,
      }),
    ).toThrow(/actualOpen/);
  });
});
