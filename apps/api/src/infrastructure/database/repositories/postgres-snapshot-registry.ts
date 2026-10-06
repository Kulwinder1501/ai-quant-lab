import type { DatabasePool } from "../database.js";
import {
  assertSnapshotRef,
  snapshotBytesFor,
  snapshotRefFor,
  type SnapshotRef,
} from "../../../modules/platform/snapshot/snapshot-ref.js";
import {
  SnapshotContentConflictError,
  SnapshotNotFoundError,
  type SnapshotRegistry,
} from "../../../modules/platform/snapshot/snapshot-registry.js";

/**
 * The production snapshot store: Brain P2's implementation of the Platform P0 contract.
 *
 * Held to the same invariant suite as the in-memory reference -- `snapshot-registry-contract.ts` runs
 * against both, which is why that suite lives in a non-test file. The suite's centre is
 * `resolves identically after the source data has been healed`, and a registry that resolved by
 * re-querying its source would pass nine of its ten tests and fail only that one.
 *
 * ## Why the insert reads back on conflict
 *
 * `ON CONFLICT DO NOTHING` is the correct dedup for content addressing: the same address means the
 * same content, so keeping the existing row is right and re-writing it would be pointless. But "did
 * nothing" and "wrote it" are indistinguishable from the statement alone, and the reference
 * implementation throws `SnapshotContentConflictError` when an address already holds different bytes.
 *
 * That case cannot arise without a SHA-256 collision or a corrupted store, and it must be loud rather
 * than silent precisely because it cannot arise: a store that quietly served different bytes under an
 * existing address would break every reference already written into a decision record. So the insert
 * reads back and compares, at the cost of one extra round trip on a hit.
 */
export class PostgresSnapshotRegistry implements SnapshotRegistry {
  constructor(private readonly database: DatabasePool) {}

  async seal(content: unknown): Promise<SnapshotRef> {
    // Derived before touching the database, so an unencodable payload is refused by the canonical
    // encoder rather than reaching storage as something that cannot be addressed.
    const ref = snapshotRefFor(content);
    const bytes = snapshotBytesFor(content);

    const inserted = await this.database.query<{ snapshot_id: string }>(`
      INSERT INTO decision_snapshots (encoding_version, snapshot_id, bytes, byte_length)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (encoding_version, snapshot_id) DO NOTHING
      RETURNING snapshot_id
    `, [ref.encodingVersion, ref.snapshotId, bytes, bytes.length]);

    if ((inserted.rowCount ?? 0) === 0) {
      const existing = await this.database.query<{ bytes: string }>(`
        SELECT bytes FROM decision_snapshots WHERE encoding_version = $1 AND snapshot_id = $2
      `, [ref.encodingVersion, ref.snapshotId]);
      const stored = existing.rows[0]?.bytes;
      if (stored === undefined) {
        // The row lost a race with something that cannot exist, since nothing may delete from this
        // table. Reported rather than retried: a retry would paper over a broken guarantee.
        throw new SnapshotNotFoundError(ref);
      }
      if (stored !== bytes) throw new SnapshotContentConflictError(ref);
    }
    return ref;
  }

  async resolve(ref: SnapshotRef): Promise<string> {
    // Refuses a foreign encoding before querying: a different encoding is a different address space,
    // and the digest alone could otherwise match a row this registry cannot correctly interpret.
    assertSnapshotRef(ref);
    const result = await this.database.query<{ bytes: string }>(`
      SELECT bytes FROM decision_snapshots WHERE encoding_version = $1 AND snapshot_id = $2
    `, [ref.encodingVersion, ref.snapshotId]);
    const bytes = result.rows[0]?.bytes;
    if (bytes === undefined) throw new SnapshotNotFoundError(ref);
    return bytes;
  }

  async has(ref: SnapshotRef): Promise<boolean> {
    assertSnapshotRef(ref);
    const result = await this.database.query<{ present: boolean }>(`
      SELECT TRUE AS present FROM decision_snapshots
      WHERE encoding_version = $1 AND snapshot_id = $2
    `, [ref.encodingVersion, ref.snapshotId]);
    return (result.rowCount ?? 0) > 0;
  }
}
