import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresCandidateDataset } from "./postgres-candidate-dataset.js";
import { PostgresSnapshotRegistry } from "./postgres-snapshot-registry.js";
import { toCandidateDatasetEntry, type CandidateDatasetEntry } from "../../../modules/autonomous-v2/domain/thesis-builder.js";
import type { SnapshotRef } from "../../../modules/platform/snapshot/snapshot-ref.js";
import type { DatabasePool } from "../database.js";

/**
 * The Candidate Dataset store's persistence guarantees, against a real database.
 *
 * Every test runs inside a transaction that is rolled back, following
 * `postgres-decision-ledger.test.ts`: `candidate_dataset_entries` refuses DELETE by trigger, so a
 * suite that committed could not clean up after itself and could not be run twice.
 */
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("PostgresCandidateDataset (live DB)", () => {
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

  const scoped = (): DatabasePool => client as unknown as DatabasePool;

  async function sealedContext(nonce: string): Promise<SnapshotRef> {
    return new PostgresSnapshotRegistry(scoped()).seal({ probe: "candidate-dataset-context", nonce });
  }

  function entryFor(observedIn: SnapshotRef, overrides: {
    readonly instrumentSymbol?: string;
    readonly decisionAt?: Date;
    readonly side?: "LONG" | "SHORT";
  } = {}): CandidateDatasetEntry {
    return toCandidateDatasetEntry({
      instrumentSymbol: overrides.instrumentSymbol ?? "NIFTY50",
      decisionAt: overrides.decisionAt ?? new Date("2026-09-14T09:25:00.000Z"),
      observedIn,
      side: overrides.side ?? "LONG",
      rejected: { outcome: "REJECTED", reasons: ["NO_ORIENTATION_EVIDENCE"] },
    });
  }

  it("records an entry and reads it back unchanged", async () => {
    const observedIn = await sealedContext("record-and-read");
    const entry = entryFor(observedIn);
    const store = new PostgresCandidateDataset(scoped());

    const inserted = await store.record(entry);
    expect(inserted).toBe(true);

    const rows = await store.listFor({ instrumentSymbol: entry.instrumentSymbol, limit: 10 });
    expect(rows).toEqual([entry]);
  });

  it("is idempotent by primary key: recording the same entry twice does not duplicate it", async () => {
    const observedIn = await sealedContext("idempotent");
    const entry = entryFor(observedIn);
    const store = new PostgresCandidateDataset(scoped());

    expect(await store.record(entry)).toBe(true);
    expect(await store.record(entry)).toBe(false);

    const rows = await store.listFor({ instrumentSymbol: entry.instrumentSymbol, limit: 10 });
    expect(rows).toHaveLength(1);
  });

  it("scopes listFor by instrument and orders newest decision first", async () => {
    const observedInA = await sealedContext("scope-a");
    const observedInB = await sealedContext("scope-b");
    const store = new PostgresCandidateDataset(scoped());

    const older = entryFor(observedInA, {
      instrumentSymbol: "NIFTY50",
      decisionAt: new Date("2026-09-14T09:25:00.000Z"),
      side: "LONG",
    });
    const newer = entryFor(observedInA, {
      instrumentSymbol: "NIFTY50",
      decisionAt: new Date("2026-09-14T09:26:00.000Z"),
      side: "SHORT",
    });
    const otherInstrument = entryFor(observedInB, { instrumentSymbol: "BANKNIFTY" });

    await store.record(older);
    await store.record(newer);
    await store.record(otherInstrument);

    const rows = await store.listFor({ instrumentSymbol: "NIFTY50", limit: 10 });
    expect(rows.map((row) => row.entryId)).toEqual([newer.entryId, older.entryId]);
  });

  it("refuses an entry whose snapshot was never sealed (FK violation)", async () => {
    const store = new PostgresCandidateDataset(scoped());
    const entry = entryFor({ snapshotId: "f".repeat(64), encodingVersion: "canonical-json-sha256-v1" });

    await expect(store.record(entry)).rejects.toThrow();
  });

  it("refuses UPDATE and DELETE on a stored entry (append-only trigger)", async () => {
    const observedIn = await sealedContext("append-only");
    const entry = entryFor(observedIn);
    const store = new PostgresCandidateDataset(scoped());
    await store.record(entry);

    await expect(
      client.query("UPDATE candidate_dataset_entries SET refusal = 'DEGENERATE_GEOMETRY' WHERE entry_id = $1", [entry.entryId]),
    ).rejects.toThrow();
    await expect(
      client.query("DELETE FROM candidate_dataset_entries WHERE entry_id = $1", [entry.entryId]),
    ).rejects.toThrow();
  });
});
