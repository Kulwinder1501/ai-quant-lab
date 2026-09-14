import { describe, expect, it } from "vitest";
import { scalpResearchLeastPrivilegeRoleMigration } from "./076-scalp-research-least-privilege-role.js";

describe("scalp research least-privilege role migration", () => {
  it("creates the capability role and grants write only to research_scalp", () => {
    const sql = scalpResearchLeastPrivilegeRoleMigration.sql;
    expect(scalpResearchLeastPrivilegeRoleMigration.id).toBe("076-scalp-research-least-privilege-role");
    expect(sql).toContain("CREATE ROLE scalp_research_writer NOLOGIN");
    expect(sql).toContain("GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA research_scalp");
    // Write to production/public is SELECT-only, and mutation is revoked everywhere.
    expect(sql).toContain("GRANT SELECT ON ALL TABLES IN SCHEMA public");
    expect(sql).toContain("REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER");
    expect(sql).not.toContain("INSERT ON ALL TABLES IN SCHEMA public");
  });
});
