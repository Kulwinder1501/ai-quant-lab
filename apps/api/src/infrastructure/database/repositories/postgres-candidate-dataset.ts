import type { DatabasePool } from "../database.js";
import { assertSnapshotRef } from "../../../modules/platform/snapshot/snapshot-ref.js";
import type { CandidateDatasetEntry, SideRefusal } from "../../../modules/autonomous-v2/domain/thesis-builder.js";
import type { ThesisSide } from "../../../modules/autonomous-v2/domain/thesis-producer.js";

/**
 * Stores and reads P6b's Candidate Dataset: rows recording which thesis side was rejected, and why.
 *
 * ## Idempotent by primary key, not by check-then-insert
 *
 * `CandidateDatasetEntry.entryId` is already a content hash over the row's identifying fields, so
 * `ON CONFLICT (entry_id) DO NOTHING` is sufficient -- two thesis-builder runs over the same rejected
 * side produce the identical id and collapse to one row, the same "the constraint arbitrates, the
 * application does not" rule `postgres-differential-observations.ts` follows.
 *
 * ## The domain check runs before the write, not instead of it
 *
 * `assertSnapshotRef` catches a malformed reference before it reaches the database; the table's FK to
 * `decision_snapshots` catches a well-formed reference to a snapshot nobody stored. They are different
 * faults, and calling the domain check here means the FK stays a backstop rather than the only guard.
 */

interface CandidateDatasetRow {
  entry_id: string;
  instrument_symbol: string;
  decision_at: Date;
  side: string;
  refusal: string;
  context_encoding_version: string;
  context_snapshot_id: string;
}

function toDomain(row: CandidateDatasetRow): CandidateDatasetEntry {
  return {
    entryId: row.entry_id,
    instrumentSymbol: row.instrument_symbol,
    decisionAt: row.decision_at,
    side: row.side as ThesisSide,
    refusal: row.refusal as SideRefusal,
    observedIn: {
      snapshotId: row.context_snapshot_id,
      encodingVersion: row.context_encoding_version,
    },
  };
}

export class PostgresCandidateDataset {
  constructor(private readonly database: DatabasePool) {}

  /** Returns true when this entry was newly recorded, false when it already existed. */
  async record(entry: CandidateDatasetEntry): Promise<boolean> {
    assertSnapshotRef(entry.observedIn);
    const result = await this.database.query<{ entry_id: string }>(`
      INSERT INTO candidate_dataset_entries (
        entry_id, instrument_symbol, decision_at, side, refusal,
        context_encoding_version, context_snapshot_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (entry_id) DO NOTHING
      RETURNING entry_id
    `, [
      entry.entryId,
      entry.instrumentSymbol,
      entry.decisionAt,
      entry.side,
      entry.refusal,
      entry.observedIn.encodingVersion,
      entry.observedIn.snapshotId,
    ]);
    return result.rows.length > 0;
  }

  /** Every entry recorded for one instrument, newest decision first. */
  async listFor(input: {
    readonly instrumentSymbol: string;
    readonly limit: number;
  }): Promise<readonly CandidateDatasetEntry[]> {
    const result = await this.database.query<CandidateDatasetRow>(`
      SELECT entry_id, instrument_symbol, decision_at, side, refusal,
             context_encoding_version, context_snapshot_id
      FROM candidate_dataset_entries
      WHERE instrument_symbol = $1
      ORDER BY decision_at DESC
      LIMIT $2
    `, [input.instrumentSymbol, input.limit]);

    return result.rows.map(toDomain);
  }
}
