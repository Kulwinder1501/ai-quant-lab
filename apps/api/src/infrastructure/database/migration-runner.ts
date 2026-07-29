import type { Pool } from "pg";

export interface Migration {
  id: string;
  sql: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const migrationLockName = "ai-quant-lab-schema-migrations";

function validateMigrations(migrations: readonly Migration[]): void {
  const ids = migrations.map((migration) => migration.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Migration IDs must be unique.");
  }
  if (ids.some((id, index) => index > 0 && id <= ids[index - 1])) {
    throw new Error("Migrations must be supplied in strictly increasing ID order.");
  }
  if (migrations.some((migration) => migration.sql.trim().length === 0)) {
    throw new Error("A migration cannot have empty SQL.");
  }
}

export async function runMigrations(pool: Pool, migrations: readonly Migration[]): Promise<MigrationResult> {
  validateMigrations(migrations);
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [migrationLockName]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const existing = await client.query<{ id: string }>("SELECT id FROM schema_migrations");
    const appliedIds = new Set(existing.rows.map((row) => row.id));

    for (const migration of migrations) {
      if (appliedIds.has(migration.id)) {
        skipped.push(migration.id);
        continue;
      }

      try {
        await client.query("BEGIN");
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id]);
        await client.query("COMMIT");
        applied.push(migration.id);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${migration.id} failed.`, { cause: error });
      }
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [migrationLockName]);
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}
