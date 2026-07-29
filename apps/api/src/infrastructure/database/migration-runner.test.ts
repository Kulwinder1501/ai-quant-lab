import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { runMigrations, type Migration } from "./migration-runner.js";
import { migrations } from "./migrations/index.js";

function fakePool(existingMigrationIds: string[] = []): { pool: Pool; queries: string[] } {
  const queries: string[] = [];
  const client = {
    query: async (query: string): Promise<{ rows: { id: string }[] }> => {
      queries.push(query.trim());
      if (query.includes("SELECT id FROM schema_migrations")) {
        return { rows: existingMigrationIds.map((id) => ({ id })) };
      }
      return { rows: [] };
    },
    release: () => undefined,
  };
  return { pool: { connect: async () => client } as unknown as Pool, queries };
}

describe("database migrations", () => {
  it("keeps migration IDs ordered and the initial schema feature-complete", () => {
    expect(migrations.map((migration) => migration.id)).toEqual([
      "001-initial-schema",
      "002-trade-idea-proposal-identity",
      "003-model-prediction-identity",
    ]);
    expect(migrations[0].sql).toContain("CREATE TABLE candles");
    expect(migrations[0].sql).toContain("CREATE TABLE paper_trades");
    expect(migrations[0].sql).toContain("CREATE TABLE model_versions");
    expect(migrations[1].sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
    expect(migrations[2].sql).toContain("evidence_cutoff_at");
    expect(migrations[2].sql).toContain("model_predictions_model_candle_identity_idx");
  });

  it("records new migrations inside a transaction and skips applied migrations", async () => {
    const first = fakePool();
    const migrationsToRun: Migration[] = [{ id: "001-test", sql: "SELECT 1;" }];
    await expect(runMigrations(first.pool, migrationsToRun)).resolves.toEqual({ applied: ["001-test"], skipped: [] });
    expect(first.queries).toContain("BEGIN");
    expect(first.queries).toContain("COMMIT");

    const second = fakePool(["001-test"]);
    await expect(runMigrations(second.pool, migrationsToRun)).resolves.toEqual({ applied: [], skipped: ["001-test"] });
    expect(second.queries).not.toContain("BEGIN");
  });
});
