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
  // Asserted structurally rather than as a literal list of IDs. The literal list
  // stopped at 003 while the project grew to 010, so it failed on every phase
  // that added a migration and stopped being read as a real signal. What
  // actually matters is that the sequence numbers are unique, ascending, and
  // gapless, because the runner applies them in array order and records them by
  // ID — a duplicate or out-of-order prefix silently applies the wrong schema.
  it("keeps migration IDs uniquely numbered, ascending, and gapless", () => {
    const ids = migrations.map((migration) => migration.id);
    expect(new Set(ids).size).toBe(ids.length);

    const sequenceNumbers = ids.map((id) => {
      const match = /^(\d{3})-[a-z0-9-]+$/.exec(id);
      expect(match, `migration ID "${id}" must look like "007-some-name"`).not.toBeNull();
      return Number(match![1]);
    });
    expect(sequenceNumbers).toEqual(sequenceNumbers.map((_, index) => index + 1));

    for (const migration of migrations) {
      expect(migration.sql.trim().length, `migration ${migration.id} has empty SQL`).toBeGreaterThan(0);
    }
  });

  it("keeps the initial schema feature-complete", () => {
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

  it("creates the stock intelligence append-only schema without replacing instruments.id", () => {
    const migration = migrations.find((m) => m.id === "099-stock-intelligence-canonical-model");
    expect(migration).toBeDefined();
    expect(migration!.sql).toContain("CREATE SCHEMA IF NOT EXISTS stock_intelligence");
    expect(migration!.sql).toContain("stock_intelligence.signals");
    expect(migration!.sql).toContain("fundamental_snapshots");
    expect(migration!.sql).toContain("current_roster_snapshot");
    expect(migration!.sql).not.toContain("IND_EQUITY_");
  });

  it("identifies corporate actions uniquely so ingest is idempotent", () => {
    const migration = migrations.find((m) => m.id === "100-stock-intelligence-corporate-action-identity");
    expect(migration).toBeDefined();
    expect(migration!.sql).toContain("stock_intelligence.corporate_actions");
    expect(migration!.sql).toContain("instrument_id, action_type, ex_date");
  });

  it("adds a resumable replay cursor and idempotent yahoo daily-bar identity", () => {
    const migration = migrations.find((m) => m.id === "101-stock-intelligence-replay-harness");
    expect(migration).toBeDefined();
    expect(migration!.sql).toContain("replay_pair_results");
    expect(migration!.sql).toContain("yahoo_daily_bar");
    expect(migration!.sql).toContain("monthly_data_replay");
    expect(migration!.sql).not.toContain("IND_EQUITY_");
  });

  it("identifies derived features so replay is idempotent", () => {
    const migration = migrations.find((m) => m.id === "102-stock-intelligence-feature-identity");
    expect(migration).toBeDefined();
    expect(migration!.sql).toContain("derived_features");
    expect(migration!.sql).toContain("feature_name, effective_at, feature_version");
    expect(migration!.sql).toContain("signal_name, effective_at, engine_version");
  });

  it("stores immutable prediction snapshots and decay marks without touching the scanner watchlist", () => {
    const migration = migrations.find((m) => m.id === "103-stock-intelligence-prediction-snapshots");
    expect(migration).toBeDefined();
    expect(migration!.sql).toContain("prediction_snapshots");
    expect(migration!.sql).toContain("prediction_decay_marks");
    expect(migration!.sql).toContain("investor_watchlist");
    expect(migration!.sql).toContain("reject_mutation_prediction_snapshots");
    expect(migration!.sql).not.toContain("CREATE TABLE watchlist");
  });

  it("stores append-only Gate 7 acceptance reports", () => {
    const migration = migrations.find((m) => m.id === "104-stock-intelligence-gate7-reports");
    expect(migration).toBeDefined();
    expect(migration!.sql).toContain("gate7_reports");
    expect(migration!.sql).toContain("reject_mutation_gate7_reports");
    expect(migration!.sql).toContain("REFERENCES stock_intelligence.replay_jobs");
  });

  it("verifies migration 065 expands check constraints additively for candlestick codes and chart patterns", () => {
    const migration065 = migrations.find((m) => m.id === "065-expand-additional-patterns");
    expect(migration065).toBeDefined();
    expect(migration065!.sql).toContain("INVERTED_HAMMER");
    expect(migration065!.sql).toContain("SPINNING_TOP");
    expect(migration065!.sql).toContain("HEAD_AND_SHOULDERS");
    expect(migration065!.sql).toContain("INVERSE_HEAD_AND_SHOULDERS");
    expect(migration065!.sql).toContain("RISING_WEDGE");
    expect(migration065!.sql).toContain("FALLING_WEDGE");
  });
});
