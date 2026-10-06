import { describe, expect, it } from "vitest";
import { scalpResearchHarnessMigration } from "./074-scalp-research-harness.js";

describe("scalp research harness migration", () => {
  it("uses a separate append-only schema with strict keys", () => {
    expect(scalpResearchHarnessMigration.id).toBe("074-scalp-research-harness");
    expect(scalpResearchHarnessMigration.sql).toContain("CREATE SCHEMA IF NOT EXISTS research_scalp");
    expect(scalpResearchHarnessMigration.sql).toContain("research_scalp.reject_mutation");
    expect(scalpResearchHarnessMigration.sql).toContain("BEFORE UPDATE OR DELETE");
    expect(scalpResearchHarnessMigration.sql).toContain("proposal_key CHAR(64) NOT NULL UNIQUE");
    expect(scalpResearchHarnessMigration.sql).toContain("terminal_settlement_key CHAR(64) NOT NULL UNIQUE");
  });

  it("does not write to execution tables", () => {
    expect(scalpResearchHarnessMigration.sql).not.toMatch(/INSERT\s+INTO\s+(?:public\.)?paper_trades/i);
    expect(scalpResearchHarnessMigration.sql).not.toMatch(/UPDATE\s+(?:public\.)?trade_ideas/i);
  });
});
