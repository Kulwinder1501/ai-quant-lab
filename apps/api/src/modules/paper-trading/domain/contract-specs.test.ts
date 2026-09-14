import { describe, expect, it } from "vitest";
import {
  assessContractSize,
  contractNotional,
  MINIMUM_CONTRACT_VALUE_INR,
} from "./contract-specs.js";

describe("assessContractSize", () => {
  it("catches the stale BANKNIFTY lot size that shipped", () => {
    // 15 x 57,189 is a 8.58 lakh contract against a 15 lakh floor -- the pre-revision
    // lot size, left in place while the index nearly quadrupled.
    const assessment = assessContractSize(15, 57_189.4);

    expect(assessment.verdict).toBe("BELOW_REGULATORY_MINIMUM");
    expect(Math.round(assessment.notional)).toBe(857_841);
    expect(assessment.minimumViableLotSize).toBe(27);
    expect(assessment.explanation).toContain("stale");
  });

  it("accepts the revised BANKNIFTY and NIFTY lot sizes", () => {
    expect(assessContractSize(30, 57_189.4).verdict).toBe("PLAUSIBLE");
    expect(assessContractSize(75, 24_371).verdict).toBe("PLAUSIBLE");
  });

  it("flags a lot size a whole revision too large", () => {
    expect(assessContractSize(150, 24_371).verdict).toBe("IMPLAUSIBLY_LARGE");
  });

  it("does not flag a contract that has merely drifted above the sizing target", () => {
    // An index can run well past its last revision without the lot being wrong; the
    // check must not fire on ordinary drift.
    expect(assessContractSize(75, 30_000).verdict).toBe("PLAUSIBLE");
  });

  it("reports the lot size that would reach the regulatory floor", () => {
    const assessment = assessContractSize(1, MINIMUM_CONTRACT_VALUE_INR / 100);
    expect(assessment.minimumViableLotSize).toBe(100);
  });

  it("rejects nonsensical inputs rather than returning a verdict about them", () => {
    expect(() => contractNotional(0, 100)).toThrow(/Lot size/);
    expect(() => contractNotional(1.5, 100)).toThrow(/Lot size/);
    expect(() => contractNotional(75, 0)).toThrow(/Underlying price/);
  });
});
