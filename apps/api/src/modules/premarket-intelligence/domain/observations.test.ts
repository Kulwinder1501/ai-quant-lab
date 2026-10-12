import { describe, expect, it } from "vitest";
import { baselineAccuracy, buildObservations, type StoredBiasRow, type StoredOutcome } from "./observations.js";
import { buildDeterministicBaselines } from "./snapshot.js";
import type { ValidatedAssessment } from "./assessment-contract.js";

function assessment(instrument: "NIFTY50" | "BANKNIFTY", opening: string, intraday: string, full: string, refs: string[] = []): ValidatedAssessment {
  return {
    instrument, assessmentDate: "2026-10-12",
    opening_context: { expectation: opening as never, reasoning: "r" },
    intraday_context: { target_horizon: "FIRST_60_MINUTES", expected_direction: intraday as never, evidence_alignment: "MIXED", subjective_confidence: 0.5, reasoning: "r" },
    full_session_context: { target_horizon: "FULL_SESSION", expected_direction: full as never, evidence_alignment: "MIXED", subjective_confidence: 0.5, reasoning: "r" },
    key_levels: refs.map((levelRef) => ({ levelRef, role: "SUPPORT" as const, price: 1, label: "l" })),
    evidence_ids: ["market-evidence-001"],
  };
}

const outcome = (instrument: "NIFTY50" | "BANKNIFTY", gap: StoredOutcome["gapOutcome"], f60: StoredOutcome["first60Outcome"], full: StoredOutcome["fullSessionOutcome"]): StoredOutcome => ({
  instrument, sessionDate: "2026-10-12", gapOutcome: gap, first60Outcome: f60, fullSessionOutcome: full,
  levelTouches: [{ levelRef: "level-a", price: 1, touched: true, firstTouchAt: null }, { levelRef: "level-b", price: 2, touched: false, firstTouchAt: null }],
});

const bias = (llmStatus: StoredBiasRow["llmStatus"], assessments: ValidatedAssessment[] | null): StoredBiasRow => ({
  assessmentDate: "2026-10-12", runSlot: "ASIA_INDIA_PREMARKET_2026-10-12_0850_V1", llmStatus, assessments, baselines: buildDeterministicBaselines(0.5),
});

describe("buildObservations", () => {
  it("joins validated assessments to outcomes, mapping UNCERTAIN to an abstention", () => {
    const { observations } = buildObservations(
      [bias("VALIDATED", [assessment("NIFTY50", "GAP_UP", "UNCERTAIN", "BEARISH"), assessment("BANKNIFTY", "FLAT", "BULLISH", "NEUTRAL")])],
      [outcome("NIFTY50", "UP", "FLAT", "DOWN"), outcome("BANKNIFTY", "FLAT", "UP", "FLAT")],
    );
    const find = (instrument: string, target: string) => observations.find((o) => o.instrument === instrument && o.target === target)!;
    expect(find("NIFTY50", "OPENING_GAP")).toMatchObject({ llmCall: "UP", actual: "UP" });
    expect(find("NIFTY50", "FIRST_60_MINUTES").llmCall).toBeNull();
    expect(find("NIFTY50", "FULL_SESSION")).toMatchObject({ llmCall: "DOWN", actual: "DOWN" });
    expect(find("BANKNIFTY", "FIRST_60_MINUTES")).toMatchObject({ llmCall: "UP", actual: "UP" });
    expect(observations).toHaveLength(6);
  });

  it("scores nothing for a snapshot where the model failed or was not configured", () => {
    const outcomes = [outcome("NIFTY50", "UP", "UP", "UP"), outcome("BANKNIFTY", "UP", "UP", "UP")];
    expect(buildObservations([bias("FAILED", null)], outcomes).observations).toEqual([]);
    expect(buildObservations([bias("NOT_CONFIGURED", null)], outcomes).observations).toEqual([]);
  });

  it("skips targets with no measured outcome", () => {
    const { observations } = buildObservations(
      [bias("VALIDATED", [assessment("NIFTY50", "GAP_UP", "BULLISH", "BULLISH"), assessment("BANKNIFTY", "GAP_UP", "BULLISH", "BULLISH")])],
      [outcome("NIFTY50", "UP", null, null)],
    );
    expect(observations.map((o) => o.target)).toEqual(["OPENING_GAP"]);
  });

  it("marks levels the model chose against the rest of the candidates", () => {
    const { levels } = buildObservations(
      [bias("VALIDATED", [assessment("NIFTY50", "FLAT", "FLAT", "FLAT", ["level-a"]), assessment("BANKNIFTY", "FLAT", "FLAT", "FLAT")])],
      [outcome("NIFTY50", "FLAT", "FLAT", "FLAT")],
    );
    expect(levels).toEqual([
      { instrument: "NIFTY50", selectedByModel: true, touched: true },
      { instrument: "NIFTY50", selectedByModel: false, touched: false },
    ]);
  });
});

describe("baselineAccuracy", () => {
  it("accrues from every snapshot with an outcome, whether or not a model ran", () => {
    const rows = baselineAccuracy(
      [bias("NOT_CONFIGURED", null)],
      [outcome("NIFTY50", "UP", "FLAT", "UP"), outcome("BANKNIFTY", "FLAT", "FLAT", "FLAT")],
    );
    const pick = (target: string, instrument: string, baseline: string) => rows.find((r) => r.target === target && r.instrument === instrument && r.baseline === baseline);
    // GIFT +0.5%: NIFTY 0.25 -> UP (right), BANKNIFTY 0.35 -> UP (wrong, actual FLAT)
    expect(pick("OPENING_GAP", "NIFTY50", "GIFT_THRESHOLD")).toMatchObject({ sessions: 1, accuracy: 1 });
    expect(pick("OPENING_GAP", "BANKNIFTY", "GIFT_THRESHOLD")).toMatchObject({ sessions: 1, accuracy: 0 });
    expect(pick("OPENING_GAP", "ALL", "GIFT_THRESHOLD")).toMatchObject({ sessions: 2, accuracy: 0.5 });
    expect(pick("FIRST_60_MINUTES", "ALL", "ALWAYS_FLAT")).toMatchObject({ sessions: 2, accuracy: 1 });
  });
});
