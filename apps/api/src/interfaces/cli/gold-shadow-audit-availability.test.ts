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
  it("names the missing table and points at migration 123 and the gold bot, not a permanent gap", () => {
    expect(G2_NOT_FUNCTIONAL_MESSAGE).toMatch(/shadow_decisions/);
    expect(G2_NOT_FUNCTIONAL_MESSAGE).toMatch(/migration 123/);
    expect(G2_NOT_FUNCTIONAL_MESSAGE).toMatch(/run-gold-paper-trading-bot\.ts/);
    // It must not read like a clean, empty result.
    expect(G2_NOT_FUNCTIONAL_MESSAGE).not.toMatch(/^No shadow decisions found/);
  });
});

const databaseUrl = process.env.DATABASE_URL;

/**
 * Against the real, live database rather than a mock, so a schema drift between this repo's
 * migrations and whatever is actually applied on a given database is caught rather than assumed.
 * Deliberately does not assert a fixed true/false: migration 123 may or may not have been run
 * against whichever database DATABASE_URL points at when this executes, and both are legitimate
 * states for `shadowDecisionsTableExists` to report honestly -- the property under test is that it
 * reports SOMETHING rather than throwing, matching whatever `to_regclass` actually says.
 */
describe.skipIf(!databaseUrl)("shadowDecisionsTableExists (live DB)", () => {
  it("resolves to a boolean without throwing, regardless of whether migration 123 has run", async () => {
    const pool = createDatabasePool(databaseUrl!);
    try {
      expect(typeof (await shadowDecisionsTableExists(pool))).toBe("boolean");
    } finally {
      await pool.end();
    }
  });
});
