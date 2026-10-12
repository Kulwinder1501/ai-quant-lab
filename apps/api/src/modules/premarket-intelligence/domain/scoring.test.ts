import { describe, expect, it } from "vitest";
import {
  holmAdjust,
  mcnemarOneSidedP,
  MIN_CALLS_FOR_VERDICT,
  scoreLevels,
  scoreObservations,
  type ScoredObservation,
} from "./scoring.js";

function obs(i: number, llmCall: ScoredObservation["llmCall"], actual: ScoredObservation["actual"], target: ScoredObservation["target"] = "FIRST_60_MINUTES", baseline: ScoredObservation["actual"] = "FLAT"): ScoredObservation {
  return {
    sessionDate: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`, runSlot: `slot-${i}`, instrument: i % 2 === 0 ? "NIFTY50" : "BANKNIFTY",
    target, llmCall, baselines: { FOLLOW_GAP: baseline, ALWAYS_FLAT: "FLAT" }, actual,
  };
}

describe("mcnemarOneSidedP", () => {
  it("is exact for small counts", () => {
    expect(mcnemarOneSidedP(5, 0)).toBeCloseTo(0.03125, 10); // 1/32
    expect(mcnemarOneSidedP(3, 3)).toBeCloseTo(0.65625, 10); // P(X>=3 | n=6) = 42/64
  });
  it("is 1 when the two never disagree", () => {
    expect(mcnemarOneSidedP(0, 0)).toBe(1);
  });
});

describe("holmAdjust", () => {
  it("steps up in order and never exceeds 1", () => {
    expect(holmAdjust([0.01, 0.04, 0.03])).toEqual([0.03, 0.06, 0.06]);
    expect(holmAdjust([0.6, 0.7])).toEqual([1, 1]);
  });
});

describe("scoreObservations", () => {
  it("issues no verdict below the minimum number of calls, however good the numbers look", () => {
    const rows = Array.from({ length: MIN_CALLS_FOR_VERDICT - 1 }, (_, i) => obs(i, "UP", "UP"));
    const target = scoreObservations(rows).targets.find((t) => t.target === "FIRST_60_MINUTES")!;
    expect(target.calls).toBe(MIN_CALLS_FOR_VERDICT - 1);
    expect(target.llmAccuracy).toBe(1);
    expect(target.verdict).toBe("INSUFFICIENT_SAMPLE");
  });

  it("excludes abstentions from accuracy and reports them as coverage", () => {
    const rows = [obs(0, "UP", "UP"), obs(1, null, "UP"), obs(2, null, "DOWN"), obs(3, "DOWN", "UP")];
    const target = scoreObservations(rows).targets.find((t) => t.target === "FIRST_60_MINUTES")!;
    expect(target.sessions).toBe(4);
    expect(target.calls).toBe(2);
    expect(target.abstentions).toBe(2);
    expect(target.coverage).toBe(0.5);
    expect(target.llmAccuracy).toBe(0.5);
  });

  it("names a candidate only when the model beats every baseline with Holm-adjusted significance", () => {
    // Model right and both baselines wrong on every session: baselines call FLAT, truth is UP.
    const rows = Array.from({ length: 40 }, (_, i) => obs(i, "UP", "UP", "FIRST_60_MINUTES", "FLAT"));
    const target = scoreObservations(rows).targets.find((t) => t.target === "FIRST_60_MINUTES")!;
    expect(target.verdict).toBe("LLM_CANDIDATE");
    expect(target.comparisons.every((c) => c.holmAdjustedP <= 0.05)).toBe(true);
  });

  it("reports no incremental value when the model merely ties a baseline", () => {
    // The model says FLAT, as ALWAYS_FLAT does; truth is split so neither is ahead.
    const rows = Array.from({ length: 40 }, (_, i) => obs(i, "FLAT", i % 2 === 0 ? "FLAT" : "UP", "FIRST_60_MINUTES", "FLAT"));
    const target = scoreObservations(rows).targets.find((t) => t.target === "FIRST_60_MINUTES")!;
    expect(target.verdict).toBe("NO_INCREMENTAL_VALUE");
  });

  it("does not count a session where the baseline could not predict", () => {
    const row: ScoredObservation = { ...obs(0, "UP", "UP"), baselines: { FOLLOW_GAP: null, ALWAYS_FLAT: "FLAT" } };
    const target = scoreObservations([row]).targets.find((t) => t.target === "FIRST_60_MINUTES")!;
    expect(target.comparisons.map((c) => c.baseline)).toEqual(["ALWAYS_FLAT"]);
  });
});

describe("scoreLevels", () => {
  it("compares the touch rate of selected levels with the rate of those passed over", () => {
    const scores = scoreLevels([
      { instrument: "NIFTY50", selectedByModel: true, touched: true },
      { instrument: "NIFTY50", selectedByModel: true, touched: false },
      { instrument: "NIFTY50", selectedByModel: false, touched: false },
    ]);
    const nifty = scores.find((s) => s.instrument === "NIFTY50")!;
    expect(nifty.selectedTouchRate).toBe(0.5);
    expect(nifty.unselectedTouchRate).toBe(0);
    expect(scores.find((s) => s.instrument === "BANKNIFTY")!.selectedTouchRate).toBeNull();
  });
});
