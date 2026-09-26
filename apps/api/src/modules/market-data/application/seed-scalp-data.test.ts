import { describe, expect, it, vi } from "vitest";
import { seedScalpData } from "./seed-scalp-data.js";
import { momentumScalpStrategyVersion } from "../../strategy-engine/domain/momentum-scalp-strategy.js";

/**
 * A fake client that records the statements the seed issues, so the ordering can be asserted.
 *
 * The bug this guards was an ordering bug, not a logic one: the seed activated the declared version
 * while a different version still held the only-one-active slot, so the partial unique index
 * `strategy_versions_one_active_per_strategy` raised a bare 23505 from inside a boot transaction.
 */
function fakeDatabase(options: { activeOtherVersions?: number[] } = {}) {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql.replace(/\s+/g, " ").trim());
      if (sql.includes("INSERT INTO strategies")) return { rows: [{ id: "strategy-1" }] };
      if (sql.includes("UPDATE strategy_versions SET is_active = FALSE")) {
        return { rows: (options.activeOtherVersions ?? []).map((version) => ({ version })) };
      }
      if (sql.includes("INSERT INTO strategy_versions")) return { rows: [{ id: "version-1" }] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client } as never, client, statements };
}

describe("seedScalpData", () => {
  it("stands other active versions down before activating the declared one", async () => {
    const db = fakeDatabase({ activeOtherVersions: [] });
    await seedScalpData(db.pool);

    const standDown = db.statements.findIndex((s) => s.includes("SET is_active = FALSE"));
    const activate = db.statements.findIndex((s) => s.includes("INSERT INTO strategy_versions"));
    expect(standDown).toBeGreaterThan(-1);
    // Ordering is the whole point: activating first is what raised 23505 and crash-looped the API.
    expect(standDown).toBeLessThan(activate);
    expect(db.statements[0]).toBe("BEGIN");
    expect(db.statements.at(-1)).toBe("COMMIT");
  });

  it("excludes the declared version from the stand-down, so a re-run is idempotent", async () => {
    const db = fakeDatabase();
    await seedScalpData(db.pool);
    const standDown = db.statements.find((s) => s.includes("SET is_active = FALSE"));
    expect(standDown).toContain("version <> $2");
  });

  it("warns loudly when it overrides a hand-activated version rather than doing it silently", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const db = fakeDatabase({ activeOtherVersions: [4] });
      await seedScalpData(db.pool);

      expect(warn).toHaveBeenCalledTimes(1);
      const line = JSON.parse(warn.mock.calls[0][0] as string);
      expect(line).toMatchObject({
        level: "warn",
        deactivatedVersion: 4,
        declaredVersion: momentumScalpStrategyVersion,
      });
      // The operator needs to be told what to do instead, since flipping is_active by hand is
      // exactly what caused the eighteen-hour crash-loop.
      expect(line.hint).toContain("bump the version");
    } finally {
      warn.mockRestore();
    }
  });

  it("says nothing when no override was needed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const db = fakeDatabase({ activeOtherVersions: [] });
      await seedScalpData(db.pool);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("rolls back rather than leaving the boot half-applied", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql.replace(/\s+/g, " ").trim());
        if (sql.includes("INSERT INTO strategies")) throw new Error("boom");
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    await expect(seedScalpData({ connect: async () => client } as never)).rejects.toThrow("boom");
    expect(statements).toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalled();
  });
});
