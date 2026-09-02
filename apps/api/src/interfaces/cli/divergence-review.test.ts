import { describe, expect, it } from "vitest";
import { classifyCommandFor, describeClassification, reviewRow } from "./divergence-review.js";
import type { DivergenceForReview } from "../../infrastructure/database/repositories/postgres-differential-observations.js";

function divergence(overrides: Partial<DivergenceForReview> = {}): DivergenceForReview {
  return {
    comparisonKey: "NIFTY50@5m@2026-09-08T04:00:00.000Z",
    producerId: "structural-gate-v1",
    legacyAction: "APPROVED SHORT entry=23860.00 stop=23890.00 target=23800.00",
    v2Action: "NO_TRADE",
    legacyReason: null,
    v2Reason: "REJECTED TAPE_FROZEN",
    contextSnapshotId: "a".repeat(64),
    recordedAt: new Date("2026-09-08T04:00:01.000Z"),
    classification: null,
    ...overrides,
  };
}

describe("the review row takes its blocking column from the gate", () => {
  it("blocks an unclassified divergence, in the gate's own words", () => {
    /*
     * Not a second opinion. `promotionBlocker` is the function P13 calls, so a reviewer's queue
     * cannot drift from what the gate actually refuses -- the drift would show up as someone working
     * through a list that no longer matches the verdict.
     */
    const row = reviewRow(divergence());

    expect(row.blocker).toMatch(/UNKNOWN/);
    expect(row.classification).toBe("(unclassified)");
  });

  it("stops blocking once a real classification is attached", () => {
    const row = reviewRow(divergence({
      classification: {
        evidence: { kind: "EXPECTED_ARCHITECTURAL_CHANGE", designDecision: "D3" },
        revision: 1, classifiedBy: "ks", rationale: "V1 proposed on a republished close.",
      },
    }));

    expect(row.blocker).toBeNull();
    expect(row.classification).toBe("EXPECTED_ARCHITECTURAL_CHANGE r1 by ks");
  });

  it("keeps an unresolved BUG blocking and says so in the label", () => {
    /*
     * Same kind, opposite situations: Section 6 makes only the unresolved one a blocker, so the
     * resolution belongs in the label rather than behind it.
     */
    const unresolved = reviewRow(divergence({
      classification: {
        evidence: { kind: "BUG", resolutionRef: null },
        revision: 2, classifiedBy: "ks", rationale: "found it",
      },
    }));
    const resolved = reviewRow(divergence({
      classification: {
        evidence: { kind: "BUG", resolutionRef: "abc1234" },
        revision: 3, classifiedBy: "ks", rationale: "fixed",
      },
    }));

    expect(unresolved.blocker).toMatch(/BUG with no resolution/);
    expect(unresolved.classification).toBe("BUG UNRESOLVED r2 by ks");
    expect(resolved.blocker).toBeNull();
    expect(resolved.classification).toBe("BUG resolved:abc1234 r3 by ks");
  });

  it("keeps an explicit UNKNOWN distinct from never having looked", () => {
    // Both block. Only one records that the work was attempted, and a reviewer should not redo it
    // blind.
    const looked = describeClassification(divergence({
      classification: {
        evidence: { kind: "UNKNOWN" }, revision: 1, classifiedBy: "ks",
        rationale: "cannot attribute this to any known difference yet",
      },
    }));

    expect(looked).toBe("UNKNOWN r1 by ks");
    expect(describeClassification(divergence())).toBe("(unclassified)");
  });

  it("shows each side's reason beside its action, since that is what a classification is chosen from", () => {
    const row = reviewRow(divergence());

    expect(row.v2).toBe("NO_TRADE (REJECTED TAPE_FROZEN)");
    // No reason recorded prints the action alone rather than an empty bracket.
    expect(row.legacy).toBe("APPROVED SHORT entry=23860.00 stop=23890.00 target=23800.00");
  });
});

describe("the copy-ready command", () => {
  it("fills in the key and producer and nothing else", () => {
    /*
     * The key is the one thing unobtainable elsewhere, and typing an instant by hand is how the wrong
     * bar gets classified. The kind and evidence stay placeholders: inferring them from the reason
     * strings would be a guessing classifier by another route.
     */
    const command = classifyCommandFor(divergence());

    expect(command).toContain("--comparison-key='NIFTY50@5m@2026-09-08T04:00:00.000Z'");
    expect(command).toContain("--producer='structural-gate-v1'");
    expect(command).toContain("--kind=<KIND>");
    expect(command).not.toContain("TAPE_FROZEN");
  });
});
