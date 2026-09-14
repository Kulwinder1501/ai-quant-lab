import type { DatabasePool } from "../database.js";
import {
  assertComparable,
  type DifferentialObservation,
  type DivergenceEvidence,
} from "../../../modules/autonomous-v2/domain/differential-testing.js";

/**
 * Stores and reads P13's paired observations.
 *
 * ## Idempotent by constraint, not by check-then-insert
 *
 * `ON CONFLICT DO NOTHING` on `(comparison_key, comparison_version, producer_id)`. The shadow pass may
 * legitimately re-evaluate a bar — a catch-up run, a restart mid-session — and P13 counts rows, so a
 * duplicated pair would inflate the coverage its verdict rests on.
 *
 * The producer is part of that key because it is part of the observation's identity, and leaving it out
 * was a real defect: two V2.2 producers evaluating one bar competed for a single row, the first writer
 * won, and the second was discarded in silence. See migration 094.
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

/** One divergence plus its current classification, if any: everything a reviewer needs. */
export interface DivergenceForReview {
  readonly comparisonKey: string;
  readonly producerId: string;
  readonly legacyAction: string;
  readonly v2Action: string;
  readonly legacyReason: string | null;
  readonly v2Reason: string | null;
  readonly contextSnapshotId: string;
  readonly recordedAt: Date;
  readonly classification: {
    readonly evidence: DivergenceEvidence;
    readonly revision: number;
    readonly classifiedBy: string;
    readonly rationale: string;
  } | null;
}

export interface StoredDifferentialObservation {
  readonly comparisonKey: string;
  readonly comparisonVersion: string;
  readonly producerId: string;
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
    /** Which V2.2 producer decided. Part of the row's identity -- see migration 094. */
    readonly producerId: string;
    /** Why each system acted. Recorded, never compared -- see migration 093. */
    readonly legacyDetail: string;
    readonly v2Detail: string;
  }): Promise<boolean> {
    assertComparable(input.observation);
    const result = await this.database.query<{ id: string }>(`
      INSERT INTO differential_observations (
        comparison_key, comparison_version, producer_id, context_encoding_version,
        context_snapshot_id, legacy_outcome, v2_outcome, legacy_detail, v2_detail
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (comparison_key, comparison_version, producer_id) DO NOTHING
      RETURNING id
    `, [
      input.observation.comparisonKey,
      input.comparisonVersion,
      input.producerId,
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
   * The divergences a reviewer has to act on, with everything needed to classify them.
   *
   * `legacy_detail` and `v2_detail` are selected here and nowhere else. Migration 093 added them
   * because "promotionBlocker prints both sides, and a reviewer classifying a divergence needs the
   * reason" -- and until this method existed they were written and never read, which made the reason
   * columns a promise rather than a feature.
   *
   * The latest classification comes from a lateral join ordered by `revision DESC`, the same rule
   * `latestFor` applies: a corrected classification appends rather than edits, so the current view is
   * the top of each stack.
   */
  async listDivergences(input: {
    readonly comparisonVersion: string;
    readonly producerId: string;
    /** When true, only rows nothing has classified yet -- an explicit UNKNOWN counts as classified. */
    readonly unclassifiedOnly: boolean;
    readonly limit: number;
  }): Promise<readonly DivergenceForReview[]> {
    const result = await this.database.query<{
      comparison_key: string;
      producer_id: string;
      legacy_outcome: string;
      v2_outcome: string;
      legacy_detail: string | null;
      v2_detail: string | null;
      context_snapshot_id: string;
      recorded_at: Date;
      kind: string | null;
      evidence: Record<string, unknown> | null;
      revision: number | null;
      classified_by: string | null;
      rationale: string | null;
    }>(`
      SELECT o.comparison_key, o.producer_id, o.legacy_outcome, o.v2_outcome,
             o.legacy_detail, o.v2_detail, o.context_snapshot_id, o.recorded_at,
             c.kind, c.evidence, c.revision, c.classified_by, c.rationale
      FROM differential_observations o
      LEFT JOIN LATERAL (
        SELECT kind, evidence, revision, classified_by, rationale
        FROM differential_classifications
        WHERE comparison_key = o.comparison_key
          AND comparison_version = o.comparison_version
          AND producer_id = o.producer_id
        ORDER BY revision DESC
        LIMIT 1
      ) c ON TRUE
      WHERE o.comparison_version = $1
        AND o.producer_id = $2
        AND NOT o.agreed
        AND ($3 IS NOT TRUE OR c.kind IS NULL)
      ORDER BY o.recorded_at DESC, o.comparison_key
      LIMIT $4
    `, [input.comparisonVersion, input.producerId, input.unclassifiedOnly, input.limit]);

    return result.rows.map((row) => ({
      comparisonKey: row.comparison_key,
      producerId: row.producer_id,
      legacyAction: row.legacy_outcome,
      v2Action: row.v2_outcome,
      // Empty string and null both mean "no reason recorded"; normalised so the caller has one case.
      legacyReason: row.legacy_detail === null || row.legacy_detail === "" ? null : row.legacy_detail,
      v2Reason: row.v2_detail === null || row.v2_detail === "" ? null : row.v2_detail,
      contextSnapshotId: row.context_snapshot_id,
      recordedAt: row.recorded_at,
      classification: row.kind === null ? null : {
        evidence: { kind: row.kind, ...(row.evidence ?? {}) } as DivergenceEvidence,
        revision: row.revision ?? 1,
        classifiedBy: row.classified_by ?? "",
        rationale: row.rationale ?? "",
      },
    }));
  }

  /**
   * Every observation recorded under one comparison version and one producer, newest first.
   *
   * Scoped by version because rows under different versions are different populations: the version
   * decides what counts as equal, so pooling them would compare outcomes canonicalised by different
   * rules and report the difference as disagreement.
   *
   * Scoped by producer for a sharper reason. The native producer claims no edge and abstains on every
   * bar; the ported one applies V1's rule and can approve. A verdict pooled across them would average
   * a rule that never trades with a rule that does, and `promotable` would describe no system that
   * exists. P13 grades one producer at a time.
   */
  async listFor(input: {
    readonly comparisonVersion: string;
    readonly producerId: string;
  }): Promise<readonly StoredDifferentialObservation[]> {
    const result = await this.database.query<{
      comparison_key: string;
      comparison_version: string;
      producer_id: string;
      context_snapshot_id: string;
      legacy_outcome: string;
      v2_outcome: string;
      agreed: boolean;
    }>(`
      SELECT comparison_key, comparison_version, producer_id, context_snapshot_id,
             legacy_outcome, v2_outcome, agreed
      FROM differential_observations
      WHERE comparison_version = $1 AND producer_id = $2
      ORDER BY recorded_at DESC
    `, [input.comparisonVersion, input.producerId]);

    return result.rows.map((row) => ({
      comparisonKey: row.comparison_key,
      comparisonVersion: row.comparison_version,
      producerId: row.producer_id,
      contextSnapshotId: row.context_snapshot_id,
      legacyOutcome: row.legacy_outcome,
      v2Outcome: row.v2_outcome,
      agreed: row.agreed,
    }));
  }
}
