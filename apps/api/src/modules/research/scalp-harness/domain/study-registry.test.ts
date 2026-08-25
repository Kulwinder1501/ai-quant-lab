import { describe, expect, it } from "vitest";
import {
  assertStudyRegistrable,
  cellGateStanding,
  decisionGrade,
  decisionGradeSessionMinimum,
  evidenceState,
  registeredStudies,
  studyDefinitionHash,
  type StudyDefinition,
} from "./study-registry.js";
import { canonicalFrictionRungsBps } from "./canonical-friction.js";
import { degenerateIntervalSessionCeiling } from "./directional-information-curve.js";

const byKey = (key: string): StudyDefinition => {
  const found = registeredStudies.find((study) => study.studyKey === key);
  if (!found) throw new Error(`${key} is not registered.`);
  return found;
};

describe("study registry", () => {
  it("registers every study under a unique, explicitly versioned key", () => {
    const keys = registeredStudies.map((study) => study.studyKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const study of registeredStudies) assertStudyRegistrable(study);
  });

  /*
   * The hashes are pinned deliberately.
   *
   * Pre-registration is worth exactly as much as the difficulty of quietly editing it. A literal hash
   * means any change to a horizon ladder, a grid bound or a provenance flag fails this test by name,
   * and the only way past it is to add a V2 -- which is the accounting the multiplicity correction
   * needs. Updating a value here without adding a version is the failure mode, not the fix.
   */
  it("pins each frozen definition to its content hash", () => {
    expect(studyDefinitionHash(byKey("PATH_STUDY_V1")))
      .toBe("ffc7a1c96a6259fb772b4b83a3129e68caba1134fc51cad77f335c8538e5dc1d");
    expect(studyDefinitionHash(byKey("GEOMETRY_MATRIX_V1")))
      .toBe("16524723204bdfe7ed9e0bd3bdbc616b1abc231584143f8e011d6e4d2be67ef9");
    expect(studyDefinitionHash(byKey("FIXED_POINTS_V1")))
      .toBe("55a68330b10ae2b9ceddb4415b92cc5933ea95d731c02ec920f8abcd6b23ae4b");
  });

  it("moves the hash when the specification changes, and not when key order does", () => {
    const study = byKey("GEOMETRY_MATRIX_V1");
    const reordered: StudyDefinition = {
      provenanceNote: study.provenanceNote,
      specification: study.specification,
      studyKey: study.studyKey,
      provenance: study.provenance,
      question: study.question,
    };
    expect(studyDefinitionHash(reordered)).toBe(studyDefinitionHash(study));

    const widened: StudyDefinition = {
      ...study,
      specification: { ...study.specification, stopAtrMultiples: [0.5, 0.75, 1.0, 1.25, 1.5, 2.0] },
    };
    expect(studyDefinitionHash(widened)).not.toBe(studyDefinitionHash(study));
  });

  it("keeps the geometry grid's declared cell count equal to its axes", () => {
    // A stale cellCount would misstate the trial count the multiplicity correction consumes, which is
    // the one number pre-registration exists to get right.
    const specification = byKey("GEOMETRY_MATRIX_V1").specification;
    const stops = specification.stopAtrMultiples as number[];
    const targets = specification.targetAtrMultiples as number[];
    expect(stops.length * targets.length).toBe(specification.cellCount);
    expect(new Set(stops).size).toBe(stops.length);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("contains the incumbent production geometry as one of its cells", () => {
    // Without the incumbent inside the grid there is nothing to compare a winner against, and "the
    // sweep beat the current configuration" becomes an untested claim.
    const specification = byKey("GEOMETRY_MATRIX_V1").specification;
    const incumbent = specification.incumbentCell as { stopAtrMultiple: number; targetAtrMultiple: number };
    expect(specification.stopAtrMultiples as number[]).toContain(incumbent.stopAtrMultiple);
    expect(specification.targetAtrMultiples as number[]).toContain(incumbent.targetAtrMultiple);
  });

  it("charges the geometry grid against the canonical friction ladder", () => {
    expect(byKey("GEOMETRY_MATRIX_V1").specification.frictionRungsBps).toEqual(canonicalFrictionRungsBps);
  });

  it("keeps the path study's horizon ladder ascending and unique", () => {
    const horizons = byKey("PATH_STUDY_V1").specification.horizonsMinutes as number[];
    expect(horizons).toEqual([...new Set(horizons)].sort((left, right) => left - right));
    expect(horizons.every((value) => Number.isInteger(value) && value > 0)).toBe(true);
  });

  it("declares the path study barrier-free", () => {
    // The whole point of G1: a study that terminates at a stop or target cannot inform the choice of
    // that stop or target without circularity.
    expect(byKey("PATH_STUDY_V1").specification.barrierPolicy).toContain("NONE");
  });

  it("keeps the fixed-point family flagged as data-inspected", () => {
    // Flipping this to PRE_SPECIFIED would let levels chosen from two observed sessions be counted as
    // though they had been named in advance. The hash pin above makes the flip fail loudly.
    const study = byKey("FIXED_POINTS_V1");
    expect(study.provenance).toBe("DATA_INSPECTED");
    expect(study.provenanceNote).toContain("2026-08-24");
  });

  it("gates both downstream studies behind the path study", () => {
    expect(byKey("GEOMETRY_MATRIX_V1").specification.gatedBehind).toBe("PATH_STUDY_V1");
    expect(byKey("FIXED_POINTS_V1").specification.gatedBehind).toBe("PATH_STUDY_V1");
  });

  it("partitions every study by strategy definition rather than pooling cohorts", () => {
    for (const study of registeredStudies) {
      expect(study.specification.groupBy as string[]).toContain("STRATEGY_DEFINITION_HASH");
    }
  });
});

describe("evidence state", () => {
  it("separates a mechanically possible interval from a decision-grade one", () => {
    expect(evidenceState(0)).toBe("EARLY_DIAGNOSTIC");
    expect(evidenceState(2)).toBe("EARLY_DIAGNOSTIC");
    expect(evidenceState(5)).toBe("PROVISIONAL");
    expect(evidenceState(19)).toBe("PROVISIONAL");
    expect(evidenceState(20)).toBe("RESEARCH_USABLE");
    expect(evidenceState(59)).toBe("RESEARCH_USABLE");
    expect(evidenceState(60)).toBe("STRONGER_VALIDATION");
  });

  it("refuses a decision below the frozen session minimum", () => {
    expect(decisionGrade(decisionGradeSessionMinimum - 1)).toBe(false);
    expect(decisionGrade(decisionGradeSessionMinimum)).toBe(true);
    // Two days clears the bootstrap's mechanical floor and is nowhere near decision grade. That gap is
    // the entire reason this function exists separately from the estimator's interval check.
    expect(decisionGrade(2)).toBe(false);
  });

  it("rejects a session count that cannot be a count", () => {
    expect(() => evidenceState(-1)).toThrow(/non-negative/);
    expect(() => evidenceState(2.5)).toThrow(/whole number/);
  });
});

describe("cell gate standing", () => {
  it("bands a cell by its own session support", () => {
    expect(cellGateStanding(0)).toBe("INSUFFICIENT_DAYS");
    expect(cellGateStanding(1)).toBe("INSUFFICIENT_DAYS");
    expect(cellGateStanding(2)).toBe("DEGENERATE_INTERVAL");
    expect(cellGateStanding(4)).toBe("DEGENERATE_INTERVAL");
    expect(cellGateStanding(5)).toBe("PROVISIONAL");
    expect(cellGateStanding(19)).toBe("PROVISIONAL");
    expect(cellGateStanding(20)).toBe("DECISION_ELIGIBLE");
  });

  it("lets a dense cell advance while a sparse one stays unresolved", () => {
    // The whole point of a cell-local gate. Requiring the universe to advance together would either
    // hold a well-supported cell hostage or invite merging cells to reach a threshold -- and timeframe
    // is exactly the distinction the 1m-versus-5m question turns on.
    expect(cellGateStanding(24)).toBe("DECISION_ELIGIBLE");
    expect(cellGateStanding(2)).toBe("DEGENERATE_INTERVAL");
  });

  it("agrees with the degenerate-interval ceiling used by the verdict", () => {
    // Two modules, one boundary. If these drift, a cell can be called PROVISIONAL while its interval is
    // still the minimum day mean.
    expect(cellGateStanding(degenerateIntervalSessionCeiling)).toBe("PROVISIONAL");
    expect(cellGateStanding(degenerateIntervalSessionCeiling - 1)).toBe("DEGENERATE_INTERVAL");
  });

  it("rejects a session count that cannot be a count", () => {
    expect(() => cellGateStanding(-1)).toThrow(/non-negative/);
    expect(() => cellGateStanding(1.5)).toThrow(/whole number/);
  });
});

describe("registration guards", () => {
  const base = byKey("PATH_STUDY_V1");

  it("requires an explicit version suffix on the key", () => {
    expect(() => assertStudyRegistrable({ ...base, studyKey: "PATH_STUDY" }))
      .toThrow(/explicit version/);
    expect(() => assertStudyRegistrable({ ...base, studyKey: "path-study-v1" }))
      .toThrow(/upper snake case/);
  });

  it("requires a question and a provenance note", () => {
    expect(() => assertStudyRegistrable({ ...base, question: "  " })).toThrow(/question/);
    expect(() => assertStudyRegistrable({ ...base, provenanceNote: "" })).toThrow(/provenance note/);
  });

  it("refuses a study that freezes nothing", () => {
    expect(() => assertStudyRegistrable({ ...base, specification: {} })).toThrow(/empty specification/);
  });
});
