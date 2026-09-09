import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresShadowLedger } from "./postgres-shadow-ledger.js";
import { PostgresSnapshotRegistry } from "./postgres-snapshot-registry.js";
import type { DatabasePool } from "../database.js";

/**
 * Live-DB coverage for the shadow ledger, which had none.
 *
 * Two properties are worth a live test rather than a stubbed one, because both are properties of the
 * database and not of the code shape: that the terminal event references a snapshot holding the
 * refusal reason, and that a failure between the two events leaves nothing behind.
 *
 * ## Why the pool is stubbed onto a savepoint
 *
 * `decision_ledger` refuses DELETE by trigger, so a suite that wrote real rows could never clean up
 * after itself. The sibling suite solves that by running each test inside a transaction it rolls
 * back — but `PostgresShadowLedger.append` calls `connect()` and opens its own transaction, which
 * would take a different pooled connection, commit outside the test's rollback, and leave
 * undeletable rows behind for ever.
 *
 * So the stub hands back the test's own client and maps the inner transaction onto a SAVEPOINT:
 * BEGIN becomes SAVEPOINT, COMMIT becomes RELEASE, ROLLBACK becomes ROLLBACK TO. That is the real
 * transactional semantics, nested inside the outer transaction the test discards — the rollback
 * being tested genuinely happens, and none of it survives the suite.
 */

const databaseUrl = process.env.DATABASE_URL;
const SAVEPOINT = "shadow_ledger_test_sp";

describe.skipIf(!databaseUrl)("PostgresShadowLedger (live DB)", () => {
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

  /** A pool whose `connect` yields the test's client, with the nested transaction on a savepoint. */
  function savepointPool(): DatabasePool {
    const nested = {
      query: async (text: string, values?: unknown[]) => {
        if (text === "BEGIN") return client.query(`SAVEPOINT ${SAVEPOINT}`);
        if (text === "COMMIT") return client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
        if (text === "ROLLBACK") return client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
        return client.query(text, values as never);
      },
      release: () => undefined,
    };
    return { connect: async () => nested } as unknown as DatabasePool;
  }

  /** Returns the whole ref: the foreign key is composite, so the encoding version is not guessable. */
  async function sealedContext(nonce: string) {
    return new PostgresSnapshotRegistry(scoped()).seal({ probe: "shadow-context", nonce });
  }

  function ledgerFor(): PostgresShadowLedger {
    // The registry is scoped to the test client too, so the reason snapshot is discarded with it.
    return new PostgresShadowLedger(savepointPool(), "test-instance", new PostgresSnapshotRegistry(scoped()));
  }

  async function eventsFor(decisionId: string) {
    const result = await client.query<{
      aggregate_version: number;
      event_type: string;
      state_to: string;
      payload_snapshot_id: string | null;
    }>(
      `SELECT aggregate_version, event_type, state_to, payload_snapshot_id
       FROM decision_ledger WHERE decision_id = $1 ORDER BY aggregate_version`,
      [decisionId],
    );
    return result.rows;
  }

  it("records the refusal reason on the terminal event", async () => {
    /*
     * `detail` used to be accepted by `append` and never referenced, with both events hardcoding a
     * null payload — so 2,204 terminal events across three weeks could say a decision refused and
     * never why, which is the only question the shadow phase exists to answer.
     */
    const decisionId = randomUUID();
    const context = await sealedContext(decisionId);
    const contextSnapshotId = context.snapshotId;

    await ledgerFor().append({
      decisionId,
      contextSnapshotId,
      policyVersions: { thesis: "test" },
      outcome: "DEFERRED",
      detail: "OUTSIDE_EXECUTABLE_WINDOW",
    });

    const events = await eventsFor(decisionId);
    expect(events).toHaveLength(2);
    expect(events[0].payload_snapshot_id).toBeNull();
    expect(events[1].event_type).toBe("DECISION_DEFERRED");

    const payloadId = events[1].payload_snapshot_id;
    expect(payloadId).not.toBeNull();

    const snapshot = await client.query<{ bytes: string }>(
      "SELECT bytes FROM decision_snapshots WHERE snapshot_id = $1",
      [payloadId],
    );
    const stored = JSON.parse(snapshot.rows[0].bytes) as Record<string, unknown>;
    expect(stored.outcome).toBe("DEFERRED");
    expect(stored.detail).toBe("OUTSIDE_EXECUTABLE_WINDOW");
  });

  it("distinguishes two refusals that share an event type", async () => {
    // The point of keeping the reason: `terminalFor` collapses every outcome into four event types,
    // so without the payload these two rows would be indistinguishable.
    const first = randomUUID();
    const second = randomUUID();
    for (const [decisionId, detail] of [[first, "OUTSIDE_EXECUTABLE_WINDOW"], [second, "TAPE_NOT_LIVE"]] as const) {
      await ledgerFor().append({
        decisionId,
        contextSnapshotId: (await sealedContext(decisionId)).snapshotId,
        policyVersions: { thesis: "test" },
        outcome: "DEFERRED",
        detail,
      });
    }

    const reasonOf = async (decisionId: string) => {
      const events = await eventsFor(decisionId);
      const snapshot = await client.query<{ bytes: string }>(
        "SELECT bytes FROM decision_snapshots WHERE snapshot_id = $1",
        [events[1].payload_snapshot_id],
      );
      return (JSON.parse(snapshot.rows[0].bytes) as { detail: string }).detail;
    };

    expect(await reasonOf(first)).toBe("OUTSIDE_EXECUTABLE_WINDOW");
    expect(await reasonOf(second)).toBe("TAPE_NOT_LIVE");
  });

  it("leaves no opening event behind when the terminal one cannot be written", async () => {
    /*
     * The two appends used to run on separate pooled connections, so a throw in between left an
     * aggregate stranded at CANDIDATE_RESOLVED — which reads as a decision still live, not as a
     * partial record. It happened: SHADOW_DECISION failed 12 times on 2026-09-03 and left exactly
     * 12 such aggregates, still there today.
     *
     * Version 2 is occupied up front, so the opening append succeeds and the terminal one loses the
     * version arbitration.
     */
    const decisionId = randomUUID();
    const context = await sealedContext(decisionId);
    const contextSnapshotId = context.snapshotId;
    await client.query(
      `INSERT INTO decision_ledger (
         event_id, decision_id, aggregate_id, aggregate_version, occurred_at, event_type,
         schema_version, state_from, state_to, context_encoding_version, context_snapshot_id,
         policy_versions, correlation_id, event_hash, producer_service, producer_version,
         producer_instance_id
       ) VALUES ($1,$2,$2,2,now(),'DECISION_REJECTED',1,'CANDIDATE_RESOLVED','REJECTED',
                 $5,$3,'{}'::jsonb,$2,$4,'squatter','1','squatter')`,
      [randomUUID(), decisionId, contextSnapshotId, "f".repeat(64), context.encodingVersion],
    );

    await expect(ledgerFor().append({
      decisionId,
      contextSnapshotId,
      policyVersions: { thesis: "test" },
      outcome: "DEFERRED",
      detail: "OUTSIDE_EXECUTABLE_WINDOW",
    })).rejects.toThrow();

    const versions = (await eventsFor(decisionId)).map((row) => row.aggregate_version);
    expect(versions).toEqual([2]); // the squatter only: version 1 was rolled back
  });
});
