import { describe, expect, it } from "vitest";
import { requireIsolatedResearchDatabaseUrl } from "./scalp-research-database.js";

describe("requireIsolatedResearchDatabaseUrl", () => {
  it("accepts only a distinct database role", () => {
    expect(requireIsolatedResearchDatabaseUrl(
      "postgresql://operational:secret@database/research",
      "postgresql://research_writer:secret@database/research",
    )).toContain("research_writer");
    expect(() => requireIsolatedResearchDatabaseUrl(
      "postgresql://shared:one@database/research",
      "postgresql://shared:two@database/research",
    )).toThrow(/different, least-privilege database role/);
  });

  it("refuses a missing research database URL", () => {
    expect(() => requireIsolatedResearchDatabaseUrl(
      "postgresql://operational:secret@database/research", undefined,
    )).toThrow(/SCALP_RESEARCH_DATABASE_URL is required/);
  });
});
