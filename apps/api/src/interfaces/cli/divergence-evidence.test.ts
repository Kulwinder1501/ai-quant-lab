import { describe, expect, it } from "vitest";
import { divergenceEvidenceFromOptions, formatEvidenceUsage } from "./divergence-evidence.js";

/**
 * The flag-to-union mapping is where a wrong field becomes a mislabelled classification.
 *
 * P13's whole value is that a divergence carries the evidence its kind requires -- otherwise the
 * classification is a label, and a label can be applied to anything. The database enforces the same
 * rules via a per-kind CHECK; these tests cover the half that produces a usable message instead of a
 * constraint violation.
 */
describe("divergence evidence from flags", () => {
  it("builds each kind with its own required fields", () => {
    expect(divergenceEvidenceFromOptions(["--kind=EXPECTED_ARCHITECTURAL_CHANGE", "--design-decision=D3"]))
      .toEqual({ kind: "EXPECTED_ARCHITECTURAL_CHANGE", designDecision: "D3" });
    expect(divergenceEvidenceFromOptions([
      "--kind=DATA_DIFFERENCE", "--legacy-boundary=15:30", "--v2-boundary=15:40",
    ])).toEqual({ kind: "DATA_DIFFERENCE", legacyBoundary: "15:30", v2Boundary: "15:40" });
    expect(divergenceEvidenceFromOptions(["--kind=RISK_DIFFERENCE", "--risk-rule=daily cap"]))
      .toEqual({ kind: "RISK_DIFFERENCE", riskRule: "daily cap" });
    expect(divergenceEvidenceFromOptions(["--kind=UNKNOWN"])).toEqual({ kind: "UNKNOWN" });
  });

  it("refuses a kind it does not recognise instead of guessing the nearest one", () => {
    /*
     * The module note on the domain type is explicit that nothing here infers: a guessing classifier
     * would absorb real defects into the nearest plausible category, and the two categories a guess
     * would avoid are exactly the two that block promotion.
     */
    expect(() => divergenceEvidenceFromOptions(["--kind=EXPECTED"]))
      .toThrow(/does not infer between them/);
    expect(() => divergenceEvidenceFromOptions([])).toThrow(/--kind is required/);
  });

  it("names the missing flag rather than failing generically", () => {
    expect(() => divergenceEvidenceFromOptions(["--kind=DATA_DIFFERENCE", "--legacy-boundary=x"]))
      .toThrow(/--v2-boundary/);
    expect(() => divergenceEvidenceFromOptions(["--kind=EXPECTED_ARCHITECTURAL_CHANGE"]))
      .toThrow(/rather than a claim/);
  });

  it("rejects a blank value for a field that must say something", () => {
    // A present-but-empty designDecision would pass a naive "was the flag given" check and store a
    // classification that asserts nothing. The database's CHECK trims too.
    expect(() => divergenceEvidenceFromOptions([
      "--kind=EXPECTED_ARCHITECTURAL_CHANGE", "--design-decision=   ",
    ])).toThrow(/cannot be blank/);
  });

  it("keeps a BUG's null resolution distinct from an absent one", () => {
    /*
     * Section 6 turns on whether a BUG is *resolved*. An explicit empty flag records "identified, not
     * yet fixed" -- which blocks promotion; omitting the flag means the question was never asked, and
     * that must fail rather than default.
     */
    expect(divergenceEvidenceFromOptions(["--kind=BUG", "--resolution-ref="]))
      .toEqual({ kind: "BUG", resolutionRef: null });
    expect(divergenceEvidenceFromOptions(["--kind=BUG", "--resolution-ref=abc1234"]))
      .toEqual({ kind: "BUG", resolutionRef: "abc1234" });
    expect(() => divergenceEvidenceFromOptions(["--kind=BUG"]))
      .toThrow(/different claim from omitting it/);
  });

  it("lists every kind in the usage line, so the error is actionable", () => {
    const usage = formatEvidenceUsage();

    for (const kind of [
      "EXPECTED_ARCHITECTURAL_CHANGE", "DATA_DIFFERENCE", "POLICY_DIFFERENCE", "RISK_DIFFERENCE",
      "EXECUTION_DIFFERENCE", "BUG", "UNKNOWN",
    ]) {
      expect(usage).toContain(kind);
    }
  });
});
