import { describe, expect, it } from "vitest";
import {
  assertPointInTime,
  findLookaheadViolations,
  inspectPointInTime,
  LookaheadViolationError,
  LOOKAHEAD_VIOLATION,
} from "./lookahead-guard.js";

const DECIDED_AT = new Date("2026-08-21T04:30:00.000Z");

describe("lookahead guard", () => {
  it("accepts evidence that predates the decision", () => {
    expect(inspectPointInTime({
      label: "ofi",
      featureAsOf: new Date(DECIDED_AT.getTime() - 1_000),
      decidedAt: DECIDED_AT,
    })).toBeNull();
  });

  it("accepts evidence dated exactly at the decision", () => {
    // A feature computed from the bar that just closed, used on that close. Legal and common; a
    // strict inequality here would reject the ordinary case.
    expect(inspectPointInTime({
      label: "microprice",
      featureAsOf: new Date(DECIDED_AT.getTime()),
      decidedAt: DECIDED_AT,
    })).toBeNull();
  });

  it("refuses evidence from the future and reports how far ahead it is", () => {
    const violation = inspectPointInTime({
      label: "ofi",
      featureAsOf: new Date(DECIDED_AT.getTime() + 250),
      decidedAt: DECIDED_AT,
    });

    expect(violation).not.toBeNull();
    expect(violation!.reason).toBe("EVIDENCE_FROM_FUTURE");
    expect(violation!.aheadByMs).toBe(250);
    expect(violation!.code).toBe(LOOKAHEAD_VIOLATION);
  });

  it("refuses an unverifiable timestamp instead of passing it", () => {
    // The failure this guard exists to avoid: an invalid Date compares false against every bound,
    // so a naive `featureAsOf > decidedAt` check reports compliance precisely when it knows nothing.
    const violation = inspectPointInTime({
      label: "ofi",
      featureAsOf: new Date("not a date"),
      decidedAt: DECIDED_AT,
    });

    expect(violation).not.toBeNull();
    expect(violation!.reason).toBe("UNVERIFIABLE_TIMESTAMP");
    expect(violation!.aheadByMs).toBeNull();
  });

  it("refuses an unverifiable decision timestamp too", () => {
    const violation = inspectPointInTime({
      label: "ofi",
      featureAsOf: DECIDED_AT,
      decidedAt: new Date(Number.NaN),
    });

    expect(violation!.reason).toBe("UNVERIFIABLE_TIMESTAMP");
  });

  it("throws a typed error carrying the violation", () => {
    expect(() => assertPointInTime({
      label: "depth-imbalance",
      featureAsOf: new Date(DECIDED_AT.getTime() + 1),
      decidedAt: DECIDED_AT,
    })).toThrow(LookaheadViolationError);

    try {
      assertPointInTime({
        label: "depth-imbalance",
        featureAsOf: new Date(DECIDED_AT.getTime() + 1),
        decidedAt: DECIDED_AT,
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(LookaheadViolationError);
      expect((error as LookaheadViolationError).code).toBe(LOOKAHEAD_VIOLATION);
      expect((error as LookaheadViolationError).violation.label).toBe("depth-imbalance");
    }
  });

  it("does not throw on a compliant claim", () => {
    expect(() => assertPointInTime({
      label: "ofi",
      featureAsOf: new Date(DECIDED_AT.getTime() - 5),
      decidedAt: DECIDED_AT,
    })).not.toThrow();
  });

  it("collects every violation in a batch rather than stopping at the first", () => {
    const violations = findLookaheadViolations([
      { label: "a", featureAsOf: new Date(DECIDED_AT.getTime() - 1), decidedAt: DECIDED_AT },
      { label: "b", featureAsOf: new Date(DECIDED_AT.getTime() + 1), decidedAt: DECIDED_AT },
      { label: "c", featureAsOf: new Date("nope"), decidedAt: DECIDED_AT },
      { label: "d", featureAsOf: new Date(DECIDED_AT.getTime() + 99), decidedAt: DECIDED_AT },
    ]);

    expect(violations).toHaveLength(3);
    expect(violations.map((violation) => violation.label)).toEqual(["b", "c", "d"]);
  });

  it("labels an unlabelled claim rather than emitting a bare message", () => {
    const violation = inspectPointInTime({
      label: "   ",
      featureAsOf: new Date(DECIDED_AT.getTime() + 1),
      decidedAt: DECIDED_AT,
    });
    expect(violation!.label).toBe("(unlabelled claim)");
  });
});
