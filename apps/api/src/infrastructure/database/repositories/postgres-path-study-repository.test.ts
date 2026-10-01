import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresPathStudyRepository } from "./postgres-path-study-repository.js";
import type { DatabaseClient } from "../database.js";

/**
 * `findLatestDeclaredAt`, against a real database.
 *
 * Built alongside `scalp-research-scheduler.ts`'s startup catch-up check, which needs to know
 * whether `PATH_STUDY_V2` is overdue -- see `weekly-study-catch-up.ts` for why. `research_scalp`
 * forbids `UPDATE`/`DELETE` by trigger on its recorded tables in production, but `study_trials`
 * itself is not one of the append-only-guarded tables (`study_registrations` and the result tables
 * are), so a plain rollback is enough here; no special cleanup trigger to work around.
 */
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("PostgresPathStudyRepository.findLatestDeclaredAt (live DB)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  let client: PoolClient;

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  /** `trial_key`/`run_key`/`study_definition_hash`/`code_version` are all CHECK-constrained to `^[0-9a-f]{64}$`. */
  function hex64(): string {
    return Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  }

  /** `study_key` is CHECK-constrained to `^[A-Z0-9_]+_V[0-9]+$`. */
  function testStudyKey(): string {
    return `TEST_STUDY_${Math.random().toString(16).slice(2).toUpperCase()}_V1`;
  }

  /** `study_trials.study_key` FKs to `study_registrations.study_key`, so a trial needs one first. */
  async function insertStudyRegistration(studyKey: string): Promise<void> {
    await client.query(`
      INSERT INTO research_scalp.study_registrations (
        study_key, study_definition_hash, question, provenance, provenance_note, specification,
        registry_encoding_version
      ) VALUES ($1, $2, 'test question', 'PRE_SPECIFIED', 'test provenance note', '{}'::jsonb, 'v1')
    `, [studyKey, hex64()]);
  }

  async function insertTrial(input: { studyKey: string; declaredAt: Date }): Promise<void> {
    // Only the columns findLatestDeclaredAt reads, plus every NOT NULL column, are populated with
    // otherwise-arbitrary (but constraint-satisfying) values -- this test does not exercise trial
    // semantics, only the max-by-key read.
    await client.query(`
      INSERT INTO research_scalp.study_trials (
        trial_key, run_key, study_key, study_definition_hash, code_version, cohort_key,
        instrument_symbol, timeframe, direction, parameter_family, parameter_values,
        dataset_cutoff, session_range_start, session_range_end, session_count, evidence_state,
        subjects_declared, declared_at, evidence_policy_version
      ) VALUES (
        $1, $2, $3, $4, $5, 'cohort', 'NIFTY50', '1m', 'LONG', 'test', '{}'::jsonb,
        $6::timestamptz, '2026-09-01', '2026-09-01', 1, 'EARLY_DIAGNOSTIC', 1, $6::timestamptz, 'v1'
      )
    `, [hex64(), hex64(), input.studyKey, hex64(), hex64(), input.declaredAt.toISOString()]);
  }

  it("returns null when the study has never been declared", async () => {
    const repository = new PostgresPathStudyRepository(client as unknown as DatabaseClient);
    expect(await repository.findLatestDeclaredAt("NEVER_DECLARED_TEST_STUDY")).toBeNull();
  });

  it("returns the most recent declaredAt across multiple trials for the same study", async () => {
    const studyKey = testStudyKey();
    await insertStudyRegistration(studyKey);
    const older = new Date("2026-08-25T15:45:00.000Z");
    const newer = new Date("2026-09-01T15:45:00.000Z");
    await insertTrial({ studyKey, declaredAt: older });
    await insertTrial({ studyKey, declaredAt: newer });

    const repository = new PostgresPathStudyRepository(client as unknown as DatabaseClient);
    expect(await repository.findLatestDeclaredAt(studyKey)).toEqual(newer);
  });

  it("does not see another study's trials", async () => {
    const studyKey = testStudyKey();
    const otherStudyKey = testStudyKey();
    await insertStudyRegistration(studyKey);
    await insertStudyRegistration(otherStudyKey);
    await insertTrial({ studyKey, declaredAt: new Date("2026-09-01T00:00:00.000Z") });
    await insertTrial({ studyKey: otherStudyKey, declaredAt: new Date("2026-09-14T00:00:00.000Z") });

    const repository = new PostgresPathStudyRepository(client as unknown as DatabaseClient);
    expect(await repository.findLatestDeclaredAt(studyKey)).toEqual(new Date("2026-09-01T00:00:00.000Z"));
  });
});
