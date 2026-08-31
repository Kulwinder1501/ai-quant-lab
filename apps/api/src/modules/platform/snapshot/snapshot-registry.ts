import {
  assertSnapshotRef,
  snapshotBytesFor,
  snapshotRefFor,
  type SnapshotRef,
} from "./snapshot-ref.js";

/**
 * The immutable-storage contract Brain P2 and the Scalp runtime implement against.
 *
 * Platform P0 owns the *contract* and the invariants, not the production store — the readiness plan is
 * explicit that P0 does not build the full replay system. What P0 must deliver is a specification
 * precise enough that a real implementation cannot satisfy it while still violating I21, which is what
 * `testing/snapshot-registry-contract.ts` enforces: any implementation, in-memory or Postgres-backed,
 * runs the same suite.
 *
 * ## `resolve` returns bytes, not a parsed object
 *
 * Deliberate, and the whole point. I21's guarantee is that the *same data* comes back, and a parsed
 * object cannot express that — two different canonical encodings can parse to structurally equal
 * values, and a deep-equality assertion would pass while the sealed bytes had changed. Returning the
 * canonical string makes "byte-identical" literal, so the auto-heal invariant is checkable rather
 * than merely plausible.
 */
export interface SnapshotRegistry {
  /**
   * Persists content under its content address and returns the reference.
   *
   * Idempotent by construction: sealing identical content twice yields one address and stores one
   * copy. That deduplication is what makes copy-on-seal affordable when hundreds of decisions a
   * session reference overlapping bar sets.
   */
  seal(content: unknown): Promise<SnapshotRef>;
  /**
   * Returns the exact canonical bytes sealed under this reference.
   *
   * Must throw for an unknown reference. Returning `null` or an empty value would let a caller treat
   * "this snapshot does not exist" as "this snapshot was empty", and a decision replayed against an
   * empty context looks like a legitimate no-op rather than a missing dependency.
   */
  resolve(ref: SnapshotRef): Promise<string>;
  has(ref: SnapshotRef): Promise<boolean>;
}

export class SnapshotNotFoundError extends Error {
  constructor(readonly ref: SnapshotRef) {
    super(
      `Snapshot ${ref.snapshotId} is not in this registry. A sealed decision cannot be replayed `
      + "without it, and treating the absence as an empty context would make a missing dependency "
      + "look like a decision that legitimately saw nothing.",
    );
    this.name = "SnapshotNotFoundError";
  }
}

export class SnapshotContentConflictError extends Error {
  constructor(readonly ref: SnapshotRef) {
    super(
      `Snapshot ${ref.snapshotId} already holds different bytes under the same address. That is a `
      + "hash collision or a corrupted store, never a legitimate update -- content addressing means "
      + "the address is derived from the bytes.",
    );
    this.name = "SnapshotContentConflictError";
  }
}

/**
 * Reference implementation, for the contract suite and for tests that need a real registry.
 *
 * Not for production: it holds everything in memory and forgets on restart. It exists so the
 * invariants have something to be proved against before Brain P2 exists, and so P2's own
 * implementation has a known-good comparison.
 */
export class InMemorySnapshotRegistry implements SnapshotRegistry {
  private readonly bytesById = new Map<string, string>();

  async seal(content: unknown): Promise<SnapshotRef> {
    const ref = snapshotRefFor(content);
    const bytes = snapshotBytesFor(content);
    const existing = this.bytesById.get(ref.snapshotId);
    if (existing !== undefined && existing !== bytes) {
      // Cannot happen without a SHA-256 collision, and must be loud rather than an overwrite: a store
      // that silently replaced bytes under an existing address would break every reference to it.
      throw new SnapshotContentConflictError(ref);
    }
    this.bytesById.set(ref.snapshotId, bytes);
    return ref;
  }

  async resolve(ref: SnapshotRef): Promise<string> {
    assertSnapshotRef(ref);
    const bytes = this.bytesById.get(ref.snapshotId);
    if (bytes === undefined) throw new SnapshotNotFoundError(ref);
    return bytes;
  }

  async has(ref: SnapshotRef): Promise<boolean> {
    assertSnapshotRef(ref);
    return this.bytesById.has(ref.snapshotId);
  }

  /** Test affordance: how many distinct payloads are stored, for asserting deduplication. */
  get size(): number {
    return this.bytesById.size;
  }
}
