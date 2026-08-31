import { canonicalJson, researchIdentityEncodingVersion, sha256CanonicalJson } from "../identity/identity.js";

/**
 * Content-addressed identity for a sealed point-in-time snapshot (invariant I21).
 *
 * ## Why content addressing is the only option here, not the tidy one
 *
 * I21 requires a `SnapshotRef` to resolve to immutable data. Two cheaper designs were considered and
 * both fail against mechanisms this system actually runs:
 *
 * - **A range predicate** — "every bar through T" — cannot work, because index candle gaps self-heal
 *   nightly at 16:18 and the heal is an *append into a historical range*. Re-resolving the same
 *   reference after a heal returns a different row set. The reference would be stable while the data
 *   under it moved, which is precisely the failure I21 names.
 * - **A manifest of row ids** survives appends but not mutation, and candle rows are mutated: each is
 *   written once mid-bar and updated once after the bar seals. Resolution would then be able to
 *   *detect* that content changed but not to *return* what was sealed. I21 says resolve, not detect.
 *
 * So the identity is a hash of the content itself, and the store keeps the bytes. Identical content
 * seals to one identity no matter how many snapshots reference it, which is what keeps copying
 * affordable.
 *
 * ## The digest reuses the pinned identity encoder deliberately
 *
 * `sha256CanonicalJson` is the encoder whose digests are golden-pinned and whose behaviour was
 * verified against 1,500 live research keys. Introducing a second hash here would put a fifth
 * canonicalizer in the repository, which is the mistake D1 exists to prevent. It also inherits the
 * encoder's refusals — no `undefined`, no non-finite numbers, no invalid dates — so a snapshot cannot
 * be sealed around a value that has no stable representation.
 *
 * The encoding version travels on the reference. A future encoder is a different address space, and
 * a reference that did not say which encoding produced it could be resolved against the wrong one.
 */

export interface SnapshotRef {
  /** SHA-256 of the canonical encoding of the content. Lowercase hex. */
  readonly snapshotId: string;
  /** The encoding that produced `snapshotId`. Part of the identity, not metadata. */
  readonly encodingVersion: string;
}

export const SNAPSHOT_ID_PATTERN = /^[a-f0-9]{64}$/;

/** Derives the reference for a value. Pure: same content, same reference, forever. */
export function snapshotRefFor(content: unknown): SnapshotRef {
  return Object.freeze({
    snapshotId: sha256CanonicalJson(content),
    encodingVersion: researchIdentityEncodingVersion,
  });
}

/** The exact bytes a reference addresses. What an immutable store must persist and return. */
export function snapshotBytesFor(content: unknown): string {
  return canonicalJson(content);
}

export function assertSnapshotRef(ref: SnapshotRef): void {
  if (!SNAPSHOT_ID_PATTERN.test(ref.snapshotId)) {
    throw new Error(`A snapshot id must be a lowercase SHA-256 digest; got "${ref.snapshotId}".`);
  }
  if (ref.encodingVersion !== researchIdentityEncodingVersion) {
    throw new Error(
      `Snapshot ${ref.snapshotId} was sealed under encoding "${ref.encodingVersion}", `
      + `which this registry cannot resolve (it speaks "${researchIdentityEncodingVersion}"). `
      + "A different encoding is a different address space, not a format detail.",
    );
  }
}

export function sameSnapshotRef(left: SnapshotRef, right: SnapshotRef): boolean {
  return left.snapshotId === right.snapshotId && left.encodingVersion === right.encodingVersion;
}
