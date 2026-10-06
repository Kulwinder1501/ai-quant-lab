import { describe, expect, it } from "vitest";
import { scalpResearchSessionCloseBoundaryMigration } from "./075-scalp-research-session-close-boundary.js";

describe("scalp research close-boundary migration", () => {
  it("allows an exact-close decision without allowing a post-close decision", () => {
    expect(scalpResearchSessionCloseBoundaryMigration.id).toBe("075-scalp-research-session-close-boundary");
    expect(scalpResearchSessionCloseBoundaryMigration.sql).toContain("session_close_at >= canonical_decision_at");
    expect(scalpResearchSessionCloseBoundaryMigration.sql).toContain("session_close_at >= decision_at");
    expect(scalpResearchSessionCloseBoundaryMigration.sql).not.toContain("session_close_at > decision_at");
  });
});
