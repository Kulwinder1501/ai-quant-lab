import { describe, expect, it } from "vitest";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { G2_NOT_FUNCTIONAL_MESSAGE, shadowDecisionsTableExists } from "./gold-shadow-audit-availability.js";

/**
 * Proves the G2 audit's honest-failure wiring: it must refuse loudly when `shadow_decisions` is
 * absent, not quietly report a zero-row "clean" result the way it used to (a swallowed query error
 * printing "No shadow decisions found" and exiting 0 -- indistinguishable from a real, empty audit).
 */
describe("shadowDecisionsTableExists", () => {
  it("returns false when to_regclass resolves to NULL (table absent)", async () => {
    const fakePool = {
      query: async () => ({ rows: [{ reg: null }] }) as never,
    };
    expect(await shadowDecisionsTableExists(fakePool as never)).toBe(false);
  });

  it("returns true when to_regclass resolves to the table's oid-bearing name", async () => {
    const fakePool = {
      query: async () => ({ rows: [{ reg: "shadow_decisions" }] }) as never,
    };
    expect(await shadowDecisionsTableExists(fakePool as never)).toBe(true);
  });

  it("returns false rather than throwing when the query returns no rows at all", async () => {
    const fakePool = {
      query: async () => ({ rows: [] }) as never,
    };
    expect(await shadowDecisionsTableExists(fakePool as never)).toBe(false);
  });
});

describe("G2_NOT_FUNCTIONAL_MESSAGE", () => {
  it("names the two missing things and says plainly that the tool does not work yet", () => {
    expect(G2_NOT_FUNCTIONAL_MESSAGE).toMatch(/NOT YET FUNCTIONAL/);
    expect(G2_NOT_FUNCTIONAL_MESSAGE).toMatch(/shadow_decisions/);
    expect(G2_NOT_FUNCTIONAL_MESSAGE).toMatch(/gold-shadow-g2-001\.json/);
    // It must not read like a clean, empty result.
    expect(G2_NOT_FUNCTIONAL_MESSAGE).not.toMatch(/^No shadow decisions found/);
  });
});

const databaseUrl = process.env.DATABASE_URL;

/**
 * Against the real, live database rather than a mock: this is the exact fact the whole fix is
 * built on (`shadow_decisions` has never been migrated), and a mock could drift from reality
 * without this ever catching it.
 */
describe.skipIf(!databaseUrl)("shadowDecisionsTableExists (live DB)", () => {
  it("confirms shadow_decisions does not exist on the live database", async () => {
    const pool = createDatabasePool(databaseUrl!);
    try {
      expect(await shadowDecisionsTableExists(pool)).toBe(false);
    } finally {
      await pool.end();
    }
  });
});
