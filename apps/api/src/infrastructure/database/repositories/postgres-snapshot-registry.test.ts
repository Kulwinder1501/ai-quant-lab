import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresSnapshotRegistry } from "./postgres-snapshot-registry.js";
import { runSnapshotRegistryContract } from "../../../modules/platform/snapshot/testing/snapshot-registry-contract.js";
import { snapshotRefFor } from "../../../modules/platform/snapshot/snapshot-ref.js";
import type { DatabasePool } from "../database.js";

/**
 * The production registry, held to the same invariants as the in-memory reference.
 *
 * This is why `snapshot-registry-contract.ts` lives in a non-test file: two implementations of an
 * invariant that protects replay must be checked against one suite, not two copies that drift. The
 * suite's centre is `resolves identically after the source data has been healed` -- a registry that
 * resolved by re-querying its source passes nine of its ten tests and fails only that one.
 *
 * Skipped unless `DATABASE_URL` is set, following `scalp-research-isolation.test.ts`: the default unit
 * run and CI stay hermetic. A skipped suite is honest about proving nothing; one that silently
 * substituted the in-memory store would be worse than absent, because it would report the production
 * path as verified.
 *
 * ## Every test runs inside a transaction that is rolled back
 *
 * Learned the hard way. The first version of this file ran against the pool directly and wrote **9
 * rows into the production table** -- and because `decision_snapshots` refuses DELETE by trigger, it
 * could not clean up after itself. A test suite that permanently pollutes the store it is testing, and
 * whose pollution is by design irreversible, is not a test suite anyone can run twice.
 *
 * A rolled-back transaction still exercises the real DDL: the `CHECK` constraints and the append-only
 * trigger fire against uncommitted rows exactly as they do against committed ones. So the guarantees
 * are genuinely verified while the table stays empty of probes.
 *
 * Expected failures use `SAVEPOINT`, because a statement error aborts the surrounding transaction and
 * every later query in it fails with "current transaction is aborted" -- which would look like a
 * second passing assertion while actually testing nothing.
 */
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("PostgresSnapshotRegistry (live DB)", () => {
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

  /** The transaction-scoped client, shaped as the pool the repository expects. */
  const scoped = (): DatabasePool => client as unknown as DatabasePool;

  runSnapshotRegistryContract("PostgresSnapshotRegistry", () => new PostgresSnapshotRegistry(scoped()));

  it("deduplicates by content address rather than inserting a second row", async () => {
    /*
     * The property that makes copy-on-seal affordable: a 1-minute grid produces hundreds of decisions
     * a session over heavily overlapping bar sets, and without dedup the design collapses back to
     * storing queries -- which cannot satisfy I21 against the nightly gap heal.
     */
    const registry = new PostgresSnapshotRegistry(scoped());
    const content = { probe: "dedup", bars: [1, 2, 3], at: new Date("2026-08-31T09:46:00.000Z") };

    const first = await registry.seal(content);
    const second = await registry.seal({ ...content });

    expect(second.snapshotId).toBe(first.snapshotId);
    const rows = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM decision_snapshots WHERE encoding_version = $1 AND snapshot_id = $2",
      [first.encodingVersion, first.snapshotId],
    );
    expect(rows.rows[0]!.n).toBe(1);
  });

  it("refuses an UPDATE and a DELETE at the database, not only in the write path", async () => {
    /*
     * Content addressing makes an UPDATE a contradiction: if the bytes changed, the address changed, so
     * an edited row is lying about its own identity and every reference already written into a decision
     * record would resolve to something never sealed.
     *
     * A DELETE is refused for replay's sake -- a decision that cannot resolve its sealed context is
     * unreplayable (I20). Asserted rather than assumed, because the trigger is the only thing between a
     * well-meant cleanup script and an unreplayable decision.
     */
    const registry = new PostgresSnapshotRegistry(scoped());
    const ref = await registry.seal({ probe: "immutability", at: new Date("2026-08-31T09:47:00.000Z") });

    await client.query("SAVEPOINT before_update");
    await expect(client.query(
      "UPDATE decision_snapshots SET bytes = 'tampered' WHERE snapshot_id = $1", [ref.snapshotId],
    )).rejects.toThrow(/append-only/);
    await client.query("ROLLBACK TO SAVEPOINT before_update");

    await client.query("SAVEPOINT before_delete");
    await expect(client.query(
      "DELETE FROM decision_snapshots WHERE snapshot_id = $1", [ref.snapshotId],
    )).rejects.toThrow(/append-only/);
    await client.query("ROLLBACK TO SAVEPOINT before_delete");

    // And the bytes are still the sealed ones after both attempts.
    expect(await registry.resolve(ref)).toContain("immutability");
  });

  it("records a byte length that matches the stored bytes", async () => {
    // The CHECK turns a truncated write into a refused insert rather than a surprise at resolution.
    const registry = new PostgresSnapshotRegistry(scoped());
    const ref = await registry.seal({ probe: "length", padding: "x".repeat(500) });

    const rows = await client.query<{ byte_length: number; actual: number }>(
      "SELECT byte_length, length(bytes) AS actual FROM decision_snapshots WHERE snapshot_id = $1",
      [ref.snapshotId],
    );
    expect(rows.rows[0]!.byte_length).toBe(rows.rows[0]!.actual);

    await client.query("SAVEPOINT before_bad_length");
    await expect(client.query(`
      INSERT INTO decision_snapshots (encoding_version, snapshot_id, bytes, byte_length)
      VALUES ($1, $2, 'abc', 99)
    `, [ref.encodingVersion, "f".repeat(64)])).rejects.toThrow(/length_matches/);
    await client.query("ROLLBACK TO SAVEPOINT before_bad_length");
  });

  it("will not resolve a digest recorded under another encoding", async () => {
    /*
     * A different canonical encoding is a different address space, not a format detail -- the doctrine
     * D1 established when it kept `sha256CanonicalJson` and `sha256CanonicalBytes` separate. The row
     * exists and the digest matches, so only the encoding check refuses it.
     */
    const registry = new PostgresSnapshotRegistry(scoped());
    const ref = await registry.seal({ probe: "encoding", at: new Date("2026-08-31T09:48:00.000Z") });

    await expect(registry.resolve({ snapshotId: ref.snapshotId, encodingVersion: "some-future-encoding-v9" }))
      .rejects.toThrow(/different address space|cannot resolve/);
  });

  it("throws rather than returning empty for a snapshot it never held", async () => {
    // A lost snapshot must not read as an empty context: a decision replayed against nothing looks
    // like a legitimate no-op.
    const registry = new PostgresSnapshotRegistry(scoped());
    const unknown = snapshotRefFor({ never: "sealed in postgres", nonce: "086" });

    expect(await registry.has(unknown)).toBe(false);
    await expect(registry.resolve(unknown)).rejects.toThrow(/not in this registry/);
  });

  it("leaves the table exactly as it found it", async () => {
    /*
     * The guard on the guard above. Every other test here writes rows, and the whole rollback design is
     * worthless if one of them escapes -- which is not recoverable, because the trigger refuses DELETE.
     *
     * Counted on a separate connection deliberately: inside this transaction the earlier tests' writes
     * are invisible anyway, so counting on `client` would pass whether or not the rollbacks worked.
     */
    const outside = await pool.connect();
    try {
      const rows = await outside.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM decision_snapshots WHERE bytes LIKE '%probe%'",
      );
      expect(rows.rows[0]!.n).toBe(0);
    } finally {
      outside.release();
    }
  });
});
