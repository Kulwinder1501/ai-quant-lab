import { describe, expect, it } from "vitest";
import {
  legacyThesisComparison,
  ThesisAdapterError,
  thesisComparisonVersion,
  type LegacyThesis,
} from "./thesis-adapter.js";
import { evaluateDifferentialRun } from "../domain/differential-testing.js";

const decisionAt = new Date("2026-09-02T09:25:00.000Z");

function thesis(overrides: Partial<LegacyThesis> = {}): LegacyThesis {
  return {
    instrumentSymbol: "NIFTY50",
    decisionAt,
    verdict: "APPROVED",
    geometry: { side: "LONG", entryPrice: 23_850.5, stopLoss: 23_820.25, targetPrice: 23_910.75 },
    ...overrides,
  };
}

describe("the output cannot drive a decision", () => {
  it("returns only strings, with no side, price or quantity", () => {
    /*
     * §6 permits this adapter for differential analysis and forbids it from driving live decisions.
     * The enforcement is that there is nothing to execute: the value carries a label, not a decision,
     * so it is unusable for trading the way a filename is -- not by rule, but by content.
     */
    const comparison = legacyThesisComparison(thesis());

    expect(Object.keys(comparison).sort())
      .toEqual(["canonicalOutcome", "comparisonKey", "comparisonVersion"]);
    for (const value of Object.values(comparison)) {
      expect(typeof value).toBe("string");
    }
  });

  it("exposes no field an order router could read", () => {
    // Routed through `unknown` because tsc refuses the direct cast -- ThesisComparison has no index
    // signature and does not overlap an arbitrary record, which is itself the point being asserted.
    const comparison = legacyThesisComparison(thesis()) as unknown as Record<string, unknown>;

    for (const executable of ["side", "entryPrice", "stopLoss", "targetPrice", "quantity", "geometry"]) {
      expect(comparison[executable], executable).toBeUndefined();
    }
  });

  it("feeds P13 directly, which is the only consumer it is for", () => {
    // The adapter's whole purpose: one side of a differential observation.
    const legacy = legacyThesisComparison(thesis());
    const verdict = evaluateDifferentialRun({
      observations: [{
        comparisonKey: legacy.comparisonKey,
        legacySnapshotRef: "snap-1",
        v2SnapshotRef: "snap-1",
        legacyOutcome: legacy.canonicalOutcome,
        v2Outcome: legacy.canonicalOutcome,
      }],
      divergences: [],
    });

    expect(verdict.agreements).toBe(1);
    expect(verdict.promotable).toBe(true);
  });
});

describe("the canonical outcome is legible and stable", () => {
  it("reads as a sentence a reviewer can diagnose, not a digest", () => {
    /*
     * `promotionBlocker` prints both sides. A hash would satisfy equality and destroy the message,
     * leaving a reviewer with two digests and a blocked promotion.
     */
    const { canonicalOutcome } = legacyThesisComparison(thesis());

    expect(canonicalOutcome).toBe("APPROVED LONG entry=23850.50 stop=23820.25 target=23910.75");
    expect(canonicalOutcome).not.toMatch(/^[a-f0-9]{64}$/);
  });

  it("quantises prices so float noise is not reported as a divergence", () => {
    /*
     * The comparison is string equality, so two theses agreeing to fifteen decimals but formatted
     * differently would land in UNKNOWN -- the blocking bucket -- dozens of times per real finding.
     * That is how a parity check becomes unusable: this system already had one where 483 of 748
     * reported mismatches were key-order artifacts.
     */
    const noisy = legacyThesisComparison(thesis({
      geometry: { side: "LONG", entryPrice: 23_850.499999999, stopLoss: 23_820.25, targetPrice: 23_910.75 },
    }));

    expect(noisy.canonicalOutcome).toBe(legacyThesisComparison(thesis()).canonicalOutcome);
  });

  it("still separates prices that genuinely differ at the declared precision", () => {
    // The quantisation must not be so coarse that it hides real disagreement.
    const different = legacyThesisComparison(thesis({
      geometry: { side: "LONG", entryPrice: 23_850.54, stopLoss: 23_820.25, targetPrice: 23_910.75 },
    }));

    expect(different.canonicalOutcome).not.toBe(legacyThesisComparison(thesis()).canonicalOutcome);
  });

  it("versions the comparison, because precision decides what counts as equal", () => {
    expect(legacyThesisComparison(thesis()).comparisonVersion).toBe(thesisComparisonVersion);
    expect(thesisComparisonVersion).toBe("THESIS_COMPARISON_V1");
  });

  it("distinguishes side, so two mirror-image approvals never compare equal", () => {
    const short = legacyThesisComparison(thesis({
      geometry: { side: "SHORT", entryPrice: 23_850.5, stopLoss: 23_820.25, targetPrice: 23_910.75 },
    }));

    expect(short.canonicalOutcome).not.toBe(legacyThesisComparison(thesis()).canonicalOutcome);
  });
});

describe("no composite score is carried", () => {
  it("omits it deliberately, because including it would diverge on every row", () => {
    /*
     * V1's composite confidence is quarantined, and V2.2 has no composite by design -- it evaluates
     * gate by gate. A comparison carrying the score would therefore diverge on every single row,
     * each filed as EXPECTED_ARCHITECTURAL_CHANGE. Hundreds of expected divergences is not a
     * finding; it is noise hiding the few rows that matter.
     */
    const { canonicalOutcome } = legacyThesisComparison(thesis());

    expect(canonicalOutcome).not.toMatch(/score|confidence|composite/i);
  });
});

describe("verdict and geometry must agree", () => {
  it("refuses an APPROVED thesis with no geometry", () => {
    expect(() => legacyThesisComparison(thesis({ geometry: null })))
      .toThrow(/must carry the geometry it approved/);
  });

  it("refuses a rejection that carries geometry", () => {
    /*
     * Levels V1 computed and then declined to act on are real and interesting, but they are not part
     * of what was decided -- folding them in would make two identical rejections compare as
     * different.
     */
    expect(() => legacyThesisComparison(thesis({ verdict: "REJECTED" })))
      .toThrow(/must not carry geometry/);
  });

  it("compares a rejection by its verdict alone", () => {
    const rejected = legacyThesisComparison(thesis({ verdict: "REJECTED", geometry: null }));
    const noAction = legacyThesisComparison(thesis({ verdict: "NO_ACTION", geometry: null }));

    expect(rejected.canonicalOutcome).toBe("REJECTED");
    // REJECTED and NO_ACTION are different decisions and must not collapse together.
    expect(noAction.canonicalOutcome).not.toBe(rejected.canonicalOutcome);
  });

  it("refuses an unusable decision instant or a missing instrument", () => {
    expect(() => legacyThesisComparison(thesis({ decisionAt: new Date("nope") })))
      .toThrow(ThesisAdapterError);
    expect(() => legacyThesisComparison(thesis({ instrumentSymbol: "  " })))
      .toThrow(/needs the instrument/);
  });

  it("refuses a non-finite price", () => {
    expect(() => legacyThesisComparison(thesis({
      geometry: { side: "LONG", entryPrice: Number.POSITIVE_INFINITY, stopLoss: 1, targetPrice: 2 },
    }))).toThrow(/finite number/);
  });
});
