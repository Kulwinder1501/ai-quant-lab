import { describe, expect, it } from "vitest";
import { PostgresStrategyVersionRepository } from "./postgres-strategy-version-repository.js";

interface Row {
  id: string;
  version: number;
  configuration: string;
  isActive: boolean;
}

/**
 * Just enough of Postgres for `ensure()`: one strategy, its version rows, and migration 098's rule
 * that only one row per strategy may be active -- enforced on INSERT and UPDATE like the real partial
 * unique index, because the bug this guards against was exactly that rule rejecting an insert.
 */
function fakeDatabase(initial: Row[]) {
  const rows = [...initial];
  const assertOneActive = (): void => {
    if (rows.filter((row) => row.isActive).length > 1) {
      throw new Error('duplicate key value violates unique constraint "strategy_versions_one_active_per_strategy"');
    }
  };
  const calls: string[] = [];
  const database = {
    query: async (text: string, params: unknown[] = []) => {
      const sql = text.replace(/\s+/g, " ").trim();
      calls.push(sql);
      if (sql.startsWith("INSERT INTO strategies")) return { rows: [{ id: "strategy-1" }] };
      if (sql.startsWith("INSERT INTO strategy_versions")) {
        const [, version, configuration] = params as [string, number, string];
        if (!rows.some((row) => row.version === version)) {
          // Omitting is_active takes the column default, TRUE, exactly as the real table does.
          const isActive = /is_active\)/.test(sql) ? !/FALSE\)/.test(sql) : true;
          rows.push({ id: `row-${version}`, version, configuration, isActive });
          assertOneActive();
        }
        return { rows: [] };
      }
      if (sql.startsWith("SELECT strategy_versions.id")) {
        const [, version, configuration] = params as [string, number, string];
        const row = rows.find((candidate) => candidate.version === version);
        return {
          rows: row ? [{
            id: row.id, strategy_id: "strategy-1", strategy_key: "demo", name: "Demo", description: "",
            version: row.version, configuration: JSON.parse(row.configuration), is_active: row.isActive,
            is_archived: false, configuration_matches: row.configuration === configuration,
          }] : [],
        };
      }
      if (sql.startsWith("SELECT count(*)::text AS stale")) {
        const [, version] = params as [string, number];
        return { rows: [{ stale: String(rows.filter((row) => row.isActive && row.version !== version).length) }] };
      }
      if (sql.startsWith("UPDATE strategy_versions SET is_active = FALSE")) {
        const [, version] = params as [string, number];
        for (const row of rows) if (row.version !== version) row.isActive = false;
        return { rows: [] };
      }
      if (sql.startsWith("UPDATE strategy_versions SET is_active = TRUE")) {
        const [, version] = params as [string, number];
        for (const row of rows) if (row.version === version) row.isActive = true;
        assertOneActive();
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in test: ${sql.slice(0, 80)}`);
    },
  };
  return { database, rows, calls };
}

const registration = (version: number) => ({
  strategyKey: "demo",
  name: "Demo",
  description: "",
  version,
  configuration: { threshold: version },
});
const stored = (version: number): Row => ({
  id: `row-${version}`, version, configuration: JSON.stringify({ threshold: version }), isActive: true,
});

describe("PostgresStrategyVersionRepository.ensure", () => {
  it("registers a NEW version while the previous one is still active, and cuts over to it", async () => {
    const { database, rows } = fakeDatabase([stored(1)]);
    const repository = new PostgresStrategyVersionRepository(database as never);

    const result = await repository.ensure(registration(2));

    expect(result.version).toBe(2);
    expect(rows.filter((row) => row.isActive).map((row) => row.version)).toEqual([2]);
    expect(rows.find((row) => row.version === 1)!.isActive).toBe(false);
  });

  it("reports the version as active on the pass that activates it, so that pass is not skipped as STRATEGY_INACTIVE", async () => {
    // Version bump: version 2 is inserted inactive and activated inside this call. The returned row used to be the
    // pre-activation read (isActive false), which made the generator skip the first scan of every new version.
    const bump = fakeDatabase([stored(1)]);
    const afterBump = await new PostgresStrategyVersionRepository(bump.database as never).ensure(registration(2));
    expect(afterBump.isActive).toBe(true);
    expect(bump.rows.find((row) => row.version === 2)!.isActive).toBe(true);

    // First registration of a strategy.
    const first = fakeDatabase([]);
    expect((await new PostgresStrategyVersionRepository(first.database as never).ensure(registration(1))).isActive).toBe(true);

    // An existing but inactive version being re-declared (e.g. a rollback to version 1 while version 2 is active).
    const rollback = fakeDatabase([{ ...stored(1), isActive: false }, stored(2)]);
    const rolledBack = await new PostgresStrategyVersionRepository(rollback.database as never).ensure(registration(1));
    expect(rolledBack.isActive).toBe(true);
    expect(rollback.rows.filter((row) => row.isActive).map((row) => row.version)).toEqual([1]);
  });

  it("returns an already-active version as active without writing", async () => {
    const { database, calls } = fakeDatabase([stored(3)]);
    const result = await new PostgresStrategyVersionRepository(database as never).ensure(registration(3));
    expect(result.isActive).toBe(true);
    expect(calls.some((sql) => sql.startsWith("UPDATE"))).toBe(false);
  });

  it("registers the first version of a strategy that has none", async () => {
    const { database, rows } = fakeDatabase([]);
    await new PostgresStrategyVersionRepository(database as never).ensure(registration(1));
    expect(rows.map((row) => [row.version, row.isActive])).toEqual([[1, true]]);
  });

  it("is a no-op when the declared version is already the only active one", async () => {
    const { database, calls } = fakeDatabase([stored(3)]);
    await new PostgresStrategyVersionRepository(database as never).ensure(registration(3));
    expect(calls.some((sql) => sql.startsWith("UPDATE"))).toBe(false);
  });

  it("deactivates before it activates, so two rows are never active at once", async () => {
    const { database, calls } = fakeDatabase([stored(1)]);
    await new PostgresStrategyVersionRepository(database as never).ensure(registration(2));
    const deactivate = calls.findIndex((sql) => sql.startsWith("UPDATE strategy_versions SET is_active = FALSE"));
    const activate = calls.findIndex((sql) => sql.startsWith("UPDATE strategy_versions SET is_active = TRUE"));
    expect(deactivate).toBeGreaterThan(-1);
    expect(activate).toBeGreaterThan(deactivate);
  });

  it("still refuses a changed configuration under an existing version number", async () => {
    const { database } = fakeDatabase([stored(1)]);
    await expect(new PostgresStrategyVersionRepository(database as never).ensure({
      ...registration(1), configuration: { threshold: 999 },
    })).rejects.toThrow(/different immutable configuration/);
  });
});
