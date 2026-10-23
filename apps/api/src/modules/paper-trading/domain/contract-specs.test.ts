import { describe, expect, it } from "vitest";
import {
  assessContractSize,
  contractNotional,
  MINIMUM_CONTRACT_VALUE_INR,
  STALE_LOT_FLOOR_INR,
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

  it("accepts the exchange's NIFTY lot of 65 when the index has fallen under the revision-time minimum", () => {
    // 65 x 22,500 = 14.6 lakh: under the 15 lakh sizing target, yet exactly what the exchange lists
    // (Fyers symbol master, 2026-10-23). The index falling is not a stale lot, and `selectInstrument`
    // rejects any verdict but PLAUSIBLE, so grading this BELOW would stop every NIFTY entry.
    const assessment = assessContractSize(65, 22_500);
    expect(assessment.verdict).toBe("PLAUSIBLE");
    expect(Math.round(assessment.notional)).toBe(1_462_500);
    expect(assessment.explanation).toContain("index having fallen");
  });

  it("still flags a lot that is a whole revision behind once drift is allowed for", () => {
    // 65 would have to fall to 18,461 (a 18% drop) to leave the 12 lakh staleness floor.
    expect(assessContractSize(65, 18_000).verdict).toBe("BELOW_REGULATORY_MINIMUM");
    expect(assessContractSize(65, 18_600).verdict).toBe("PLAUSIBLE");
    // BANKNIFTY's stale 15 was 57% of the minimum, far past the allowance at any plausible level.
    expect(assessContractSize(15, 52_000).verdict).toBe("BELOW_REGULATORY_MINIMUM");
  });

  it("states the staleness floor and the minimum separately in its explanation", () => {
    const explanation = assessContractSize(15, 57_189.4).explanation;
    expect(explanation).toContain(STALE_LOT_FLOOR_INR.toLocaleString("en-IN"));
    expect(explanation).toContain(MINIMUM_CONTRACT_VALUE_INR.toLocaleString("en-IN"));
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
