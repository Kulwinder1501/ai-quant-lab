import type { DatabasePool } from "../database.js";
import {
  assertComparable,
  type DifferentialObservation,
} from "../../../modules/autonomous-v2/domain/differential-testing.js";

/**
 * Stores and reads P13's paired observations.
 *
 * ## Idempotent by constraint, not by check-then-insert
 *
 * `ON CONFLICT DO NOTHING` on `(comparison_key, comparison_version)`. The shadow pass may
 * legitimately re-evaluate a bar — a catch-up run, a restart mid-session — and P13 counts rows, so a
 * duplicated pair would inflate the coverage its verdict rests on.
 *
 * Deliberately not a read-then-write: two shadow passes overlapping would both read absent and both
 * insert. The same lesson the ledger recorded — the constraint arbitrates, the application does not.
 *
 * ## The domain check runs before the write, not instead of it
 *
 * `assertComparable` refuses a pair whose sides cite different snapshots, and the table's FK refuses
 * one whose snapshot nobody stored. They catch different faults: the first is a logic error in the
 * caller, the second a missing dependency. Calling the domain check here means a bad pair never
 * reaches the database, so the FK stays a backstop rather than the only guard.
 */

export interface StoredDifferentialObservation {
  readonly comparisonKey: string;
  readonly comparisonVersion: string;
  readonly contextSnapshotId: string;
  readonly legacyOutcome: string;
  readonly v2Outcome: string;
  readonly agreed: boolean;
}

const ENCODING_VERSION = "canonical-json-sha256-v1";

export class PostgresDifferentialObservations {
  constructor(private readonly database: DatabasePool) {}

  /** Returns true when this observation was newly recorded, false when it already existed. */
  async record(input: {
    readonly observation: DifferentialObservation;
    readonly comparisonVersion: string;
    /** Why each system acted. Recorded, never compared -- see migration 093. */
    readonly legacyDetail: string;
    readonly v2Detail: string;
  }): Promise<boolean> {
    assertComparable(input.observation);
    const result = await this.database.query<{ id: string }>(`
      INSERT INTO differential_observations (
        comparison_key, comparison_version, context_encoding_version, context_snapshot_id,
        legacy_outcome, v2_outcome, legacy_detail, v2_detail
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (comparison_key, comparison_version) DO NOTHING
      RETURNING id
    `, [
      input.observation.comparisonKey,
      input.comparisonVersion,
      ENCODING_VERSION,
      // Both refs are equal -- assertComparable has just established it -- so either names the shared
      // context. Reading the legacy side keeps the column's meaning "what V1 read", which is the half
      // a sceptic checks.
      input.observation.legacySnapshotRef,
      input.observation.legacyOutcome,
      input.observation.v2Outcome,
      input.legacyDetail,
      input.v2Detail,
    ]);
    return result.rows.length > 0;
  }

  /**
   * Every observation recorded under one comparison version, newest first.
   *
   * Scoped by version because rows under different versions are different populations: the version
   * decides what counts as equal, so pooling them would compare outcomes canonicalised by different
   * rules and report the difference as disagreement.
   */
  async listForVersion(comparisonVersion: string): Promise<readonly StoredDifferentialObservation[]> {
    const result = await this.database.query<{
      comparison_key: string;
      comparison_version: string;
      context_snapshot_id: string;
      legacy_outcome: string;
      v2_outcome: string;
      agreed: boolean;
    }>(`
      SELECT comparison_key, comparison_version, context_snapshot_id,
             legacy_outcome, v2_outcome, agreed
      FROM differential_observations
      WHERE comparison_version = $1
      ORDER BY recorded_at DESC
    `, [comparisonVersion]);

    return result.rows.map((row) => ({
      comparisonKey: row.comparison_key,
      comparisonVersion: row.comparison_version,
      contextSnapshotId: row.context_snapshot_id,
      legacyOutcome: row.legacy_outcome,
      v2Outcome: row.v2_outcome,
      agreed: row.agreed,
    }));
  }
}
