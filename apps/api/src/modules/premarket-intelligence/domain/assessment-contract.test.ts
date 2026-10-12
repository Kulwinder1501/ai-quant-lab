import { describe, expect, it } from "vitest";
import { validateAssessmentContract } from "./assessment-contract.js";
import type { CandidateLevel } from "./snapshot.js";

const evidenceIds = new Set(["market-evidence-001", "market-evidence-002"]);
const levels: CandidateLevel[] = [
  { id: "level-nifty50-pdh", instrument: "NIFTY50", label: "Previous day high", price: 22600.5 },
  { id: "level-banknifty-pdl", instrument: "BANKNIFTY", label: "Previous day low", price: 54800 },
];

function entry(instrument: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instrument,
    opening_context: { expectation: "GAP_UP", reasoning: "GIFT Nifty is firmly higher." },
    intraday_context: { target_horizon: "FIRST_60_MINUTES", expected_direction: "BULLISH", evidence_alignment: "MIXED", subjective_confidence: 0.58, reasoning: "Asia is split." },
    full_session_context: { target_horizon: "FULL_SESSION", expected_direction: "UNCERTAIN", evidence_alignment: "CONFLICTING", subjective_confidence: 0.4, reasoning: "Mid-day stall likely." },
    key_levels: [],
    evidence_ids: ["market-evidence-001"],
    ...overrides,
  };
}

const validate = (raw: unknown) => validateAssessmentContract({ raw, assessmentDate: "2026-10-12", knownEvidenceIds: evidenceIds, candidateLevels: levels });

describe("validateAssessmentContract", () => {
  it("accepts exactly one assessment per instrument and stamps the application's date", () => {
    const result = validate({ assessments: [entry("NIFTY50"), entry("BANKNIFTY")] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.assessments.map((a) => a.assessmentDate)).toEqual(["2026-10-12", "2026-10-12"]);
  });

  it("drops a model-supplied assessment_date instead of trusting it", () => {
    const result = validate({ assessments: [entry("NIFTY50", { assessment_date: "1999-01-01" }), entry("BANKNIFTY")] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.assessments[0]!.assessmentDate).toBe("2026-10-12");
  });

  it("rejects a missing instrument", () => {
    const result = validate({ assessments: [entry("NIFTY50")] });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/missing assessment for BANKNIFTY/);
  });

  it("rejects a duplicated instrument", () => {
    const result = validate({ assessments: [entry("NIFTY50"), entry("NIFTY50"), entry("BANKNIFTY")] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/duplicate assessment for NIFTY50/);
  });

  it("rejects an unexpected instrument", () => {
    expect(validate({ assessments: [entry("NIFTY50"), entry("SENSEX")] }).ok).toBe(false);
  });

  it("rejects unknown keys rather than ignoring them", () => {
    expect(validate({ assessments: [entry("NIFTY50", { target_price: 25000 }), entry("BANKNIFTY")] }).ok).toBe(false);
    expect(validate({ assessments: [entry("NIFTY50"), entry("BANKNIFTY")], extra: 1 }).ok).toBe(false);
  });

  it("rejects an out-of-range confidence and a wrong horizon literal", () => {
    const badConfidence = entry("NIFTY50");
    (badConfidence.intraday_context as Record<string, unknown>).subjective_confidence = 1.4;
    expect(validate({ assessments: [badConfidence, entry("BANKNIFTY")] }).ok).toBe(false);

    const badHorizon = entry("NIFTY50");
    (badHorizon.full_session_context as Record<string, unknown>).target_horizon = "FIRST_60_MINUTES";
    expect(validate({ assessments: [badHorizon, entry("BANKNIFTY")] }).ok).toBe(false);
  });

  it("rejects an evidence id that is not in the manifest, and an empty list", () => {
    const unknownId = validate({ assessments: [entry("NIFTY50", { evidence_ids: ["market-evidence-999"] }), entry("BANKNIFTY")] });
    expect(unknownId.ok).toBe(false);
    if (!unknownId.ok) expect(unknownId.errors.join(" ")).toMatch(/unknown evidence id/);
    expect(validate({ assessments: [entry("NIFTY50", { evidence_ids: [] }), entry("BANKNIFTY")] }).ok).toBe(false);
  });

  it("resolves a level by reference and takes the price from the system's candidate, never the model", () => {
    const result = validate({
      assessments: [
        entry("NIFTY50", { key_levels: [{ level_ref: "level-nifty50-pdh", role: "RESISTANCE" }] }),
        entry("BANKNIFTY"),
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.assessments[0]!.key_levels).toEqual([
      { levelRef: "level-nifty50-pdh", role: "RESISTANCE", price: 22600.5, label: "Previous day high" },
    ]);
  });

  it("rejects an invented level, a level of the other instrument, a repeat, and a price field", () => {
    const invented = validate({ assessments: [entry("NIFTY50", { key_levels: [{ level_ref: "level-made-up", role: "SUPPORT" }] }), entry("BANKNIFTY")] });
    expect(invented.ok).toBe(false);
    const wrongInstrument = validate({ assessments: [entry("NIFTY50", { key_levels: [{ level_ref: "level-banknifty-pdl", role: "SUPPORT" }] }), entry("BANKNIFTY")] });
    expect(wrongInstrument.ok).toBe(false);
    const repeated = validate({ assessments: [entry("NIFTY50", { key_levels: [{ level_ref: "level-nifty50-pdh", role: "RESISTANCE" }, { level_ref: "level-nifty50-pdh", role: "SUPPORT" }] }), entry("BANKNIFTY")] });
    expect(repeated.ok).toBe(false);
    const withPrice = validate({ assessments: [entry("NIFTY50", { key_levels: [{ level_ref: "level-nifty50-pdh", role: "RESISTANCE", price: 99999 }] }), entry("BANKNIFTY")] });
    expect(withPrice.ok).toBe(false);
  });

  it("rejects more than four levels for an instrument", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ level_ref: `level-nifty50-x${i}`, role: "SUPPORT" }));
    expect(validate({ assessments: [entry("NIFTY50", { key_levels: many }), entry("BANKNIFTY")] }).ok).toBe(false);
  });

  it("rejects a non-object response", () => {
    expect(validate("nope").ok).toBe(false);
    expect(validate(null).ok).toBe(false);
    expect(validate({ assessments: "x" }).ok).toBe(false);
  });
});
