import type { DatabasePool } from "../database.js";
import type { DivergenceEvidence } from "../../../modules/autonomous-v2/domain/differential-testing.js";

/**
 * Stores and reads P13's divergence classifications.
 *
 * ## The revision is computed in SQL, not read-then-incremented
 *
 * `INSERT … SELECT coalesce(max(revision), 0) + 1` inside one statement, so two classifiers racing on
 * the same divergence collide on the unique constraint instead of both writing revision 2 and one
 * silently winning. The same rule the ledger and the observation store follow: the constraint
 * arbitrates, the application does not.
 *
 * ## Reading takes the highest revision, and only that
 *
 * A corrected classification appends rather than edits, so the table holds the history and the
 * current view is the top of each stack. `DISTINCT ON` with an explicit `revision DESC` rather than
 * `classified_at DESC`: two rows written in the same clock tick would otherwise have no defined
 * order, which is exactly the ambiguity `revision` exists to remove.
 */

export interface StoredClassification {
  readonly comparisonKey: string;
  readonly revision: number;
  readonly evidence: DivergenceEvidence;
  readonly classifiedBy: string;
  readonly rationale: string;
}

export class PostgresDifferentialClassifications {
  constructor(private readonly database: DatabasePool) {}

  /**
   * Appends a classification, returning the revision it was written as.
   *
   * The database refuses a classification whose evidence does not match its kind, one on an
   * observation whose two sides agreed, and one on an observation that does not exist. None of those
   * is re-checked here: duplicating a constraint in the application is how the two drift, and the
   * database's version is the one that cannot be bypassed.
   */
  async record(input: {
    readonly comparisonKey: string;
    readonly comparisonVersion: string;
    readonly producerId: string;
    readonly evidence: DivergenceEvidence;
    readonly classifiedBy: string;
    readonly rationale: string;
  }): Promise<number> {
    const { kind, ...fields } = input.evidence;
    const result = await this.database.query<{ revision: number }>(`
      INSERT INTO differential_classifications (
        comparison_key, comparison_version, producer_id, revision,
        kind, evidence, classified_by, rationale
      )
      SELECT $1, $2, $3,
             coalesce(max(revision), 0) + 1,
             $4, $5::jsonb, $6, $7
      FROM differential_classifications
      WHERE comparison_key = $1 AND comparison_version = $2 AND producer_id = $3
      RETURNING revision
    `, [
      input.comparisonKey,
      input.comparisonVersion,
      input.producerId,
      kind,
      JSON.stringify(fields),
      input.classifiedBy,
      input.rationale,
    ]);

    const revision = result.rows[0]?.revision;
    if (revision === undefined) {
      throw new Error(
        `No classification was written for ${input.comparisonKey}. The insert returned no row, which `
        + "should be impossible -- an aggregate SELECT always produces one.",
      );
    }
    return revision;
  }

  /** The current classification for every classified divergence under one version and producer. */
  async latestFor(input: {
    readonly comparisonVersion: string;
    readonly producerId: string;
  }): Promise<ReadonlyMap<string, StoredClassification>> {
    const result = await this.database.query<{
      comparison_key: string;
      revision: number;
      kind: string;
      evidence: Record<string, unknown>;
      classified_by: string;
      rationale: string;
    }>(`
      SELECT DISTINCT ON (comparison_key)
             comparison_key, revision, kind, evidence, classified_by, rationale
      FROM differential_classifications
      WHERE comparison_version = $1 AND producer_id = $2
      ORDER BY comparison_key, revision DESC
    `, [input.comparisonVersion, input.producerId]);

    const latest = new Map<string, StoredClassification>();
    for (const row of result.rows) {
      latest.set(row.comparison_key, {
        comparisonKey: row.comparison_key,
        revision: row.revision,
        /*
         * Reassembled from the stored kind plus its fields. Safe because the database's per-kind
         * CHECK is what guarantees the required fields are present -- the cast is trusting a
         * constraint, not an assumption.
         */
        evidence: { kind: row.kind, ...row.evidence } as DivergenceEvidence,
        classifiedBy: row.classified_by,
        rationale: row.rationale,
      });
    }
    return latest;
  }
}
