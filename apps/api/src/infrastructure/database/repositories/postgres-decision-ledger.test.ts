import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LedgerEventConflictError,
  LedgerVersionConflictError,
  PostgresDecisionLedger,
} from "./postgres-decision-ledger.js";
import { PostgresSnapshotRegistry } from "./postgres-snapshot-registry.js";
import { decisionEventHash, type DecisionLedgerEvent } from "../../../modules/autonomous-v2/domain/decision-ledger.js";
import type { DatabasePool } from "../database.js";

/**
 * The ledger's persistence guarantees, against a real database.
 *
 * Every test runs inside a transaction that is rolled back, following
 * `postgres-snapshot-registry.test.ts`: `decision_ledger` refuses DELETE by trigger, so a suite that
 * committed could not clean up after itself and could not be run twice. Constraints, the foreign key
 * and the trigger all fire against uncommitted rows exactly as against committed ones.
 *
 * ## What is deliberately *not* here
 *
 * The concurrency proof. I23 is a claim about two genuinely concurrent transactions resolving to
 * exactly one winner, and that needs one of them to *commit* -- which a rolled-back test cannot do.
 * It lives in `interfaces/cli/verify-ledger-concurrency.ts`, following the precedent of
 * `verify-cap-concurrency.ts`, which exists for the same reason.
 *
 * A suite that faked the race here would be worse than one that omits it: it would report I23 as
 * verified while proving only that the code paths run.
 */
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("PostgresDecisionLedger (live DB)", () => {
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

  /** Seals a context so the foreign key can be satisfied, and returns its digest. */
  async function sealedContext(nonce: string): Promise<string> {
    const ref = await new PostgresSnapshotRegistry(scoped()).seal({ probe: "ledger-context", nonce });
    return ref.snapshotId;
  }

  function opening(aggregateId: string, contextSnapshotId: string): DecisionLedgerEvent {
    return {
      eventId: `${aggregateId}-event-1`,
      decisionId: aggregateId,
      aggregateId,
      aggregateVersion: 1,
      occurredAt: new Date("2026-08-31T09:46:00.000Z"),
      eventType: "STAGE_COMPLETED",
      schemaVersion: 1,
      stateFrom: "CANDIDATE_RESOLVED",
      stateTo: "CANDIDATE_RESOLVED",
      contextSnapshotId,
      policyVersions: { GRID: "GRID_POLICY_V1" },
      correlationId: `${aggregateId}-correlation`,
      causationId: null,
      payloadSnapshotId: null,
      previousEventHash: null,
      producer: { service: "brain", version: "2.2.0", instanceId: "test-instance" },
    };
  }

  it("appends an opening event at version 1 and assigns a global sequence", async () => {
    const ledger = new PostgresDecisionLedger(scoped());
    const contextSnapshotId = await sealedContext("open");
    const aggregateId = "agg-open";

    const result = await ledger.append({
      aggregateId, expectedVersion: 0, event: opening(aggregateId, contextSnapshotId),
    });

    expect(result.aggregateVersion).toBe(1);
    expect(result.sequence).toBeGreaterThan(0);
    expect(result.deduplicated).toBe(false);
  });

  it("chains a second event and reads the aggregate back in order", async () => {
    const ledger = new PostgresDecisionLedger(scoped());
    const contextSnapshotId = await sealedContext("chain");
    const aggregateId = "agg-chain";
    const first = opening(aggregateId, contextSnapshotId);
    await ledger.append({ aggregateId, expectedVersion: 0, event: first });

    await ledger.append({
      aggregateId, expectedVersion: 1,
      event: {
        ...first, eventId: `${aggregateId}-event-2`, aggregateVersion: 2,
        stateFrom: "CANDIDATE_RESOLVED", stateTo: "MARKET_STATE_INTERPRETED",
        previousEventHash: decisionEventHash(first),
      },
    });

    const events = await ledger.readAggregate(aggregateId);
    expect(events.map((event) => event.aggregateVersion)).toEqual([1, 2]);
    expect(events[1]!.previousEventHash).toBe(decisionEventHash(first));
  });

  it("rejects an append whose expectedVersion has been overtaken", async () => {
    /*
     * The single-connection face of I23. `decision_ledger_aggregate_version_key` refuses the second
     * write at the same version, and the append path turns that into a named conflict by *constraint
     * name* -- which is why the migration names it explicitly rather than letting Postgres generate one.
     */
    const ledger = new PostgresDecisionLedger(scoped());
    const contextSnapshotId = await sealedContext("stale");
    const aggregateId = "agg-stale";
    const first = opening(aggregateId, contextSnapshotId);
    await ledger.append({ aggregateId, expectedVersion: 0, event: first });

    await client.query("SAVEPOINT before_conflict");
    await expect(ledger.append({
      aggregateId, expectedVersion: 0,
      event: { ...first, eventId: `${aggregateId}-event-1b` },
    })).rejects.toThrow(LedgerVersionConflictError);
    await client.query("ROLLBACK TO SAVEPOINT before_conflict");
  });

  it("treats an identical re-append as a retry rather than a failure", async () => {
    /*
     * A producer that retries after a network blip resends the same event. Failing that would make the
     * ledger hostile to the ordinary conditions it runs under.
     */
    const ledger = new PostgresDecisionLedger(scoped());
    const contextSnapshotId = await sealedContext("retry");
    const aggregateId = "agg-retry";
    const event = opening(aggregateId, contextSnapshotId);

    const first = await ledger.append({ aggregateId, expectedVersion: 0, event });
    await client.query("SAVEPOINT before_retry");
    const retry = await ledger.append({ aggregateId, expectedVersion: 0, event });

    expect(retry.deduplicated).toBe(true);
    expect(retry.sequence).toBe(first.sequence);
    await client.query("ROLLBACK TO SAVEPOINT before_retry");
  });

  it("refuses a repeated event id carrying different facts", async () => {
    // A retry resends the same event; a repeated id with different content is a producer defect, and
    // accepting it would make the ledger disagree with itself.
    const ledger = new PostgresDecisionLedger(scoped());
    const contextSnapshotId = await sealedContext("conflict");
    const aggregateId = "agg-conflict";
    const event = opening(aggregateId, contextSnapshotId);
    await ledger.append({ aggregateId, expectedVersion: 0, event });

    await client.query("SAVEPOINT before_event_conflict");
    await expect(ledger.append({
      aggregateId, expectedVersion: 0,
      event: { ...event, correlationId: "different-correlation" },
    })).rejects.toThrow(LedgerEventConflictError);
    await client.query("ROLLBACK TO SAVEPOINT before_event_conflict");
  });

  it("refuses an event whose context was never sealed (I20)", async () => {
    /*
     * The foreign key is the replayability guarantee. Without it an event could reference a snapshot
     * that was never stored, and the decision would be unreplayable -- discovered at replay, when the
     * session is long gone.
     */
    const ledger = new PostgresDecisionLedger(scoped());
    const aggregateId = "agg-no-context";

    await client.query("SAVEPOINT before_fk");
    await expect(ledger.append({
      aggregateId, expectedVersion: 0, event: opening(aggregateId, "e".repeat(64)),
    })).rejects.toThrow(/decision_ledger_context_resolvable|foreign key/i);
    await client.query("ROLLBACK TO SAVEPOINT before_fk");
  });

  it("refuses an UPDATE and a DELETE at the database (I15)", async () => {
    /*
     * An UPDATE would break the hash chain silently for anyone not re-verifying it; a DELETE would make
     * a decision unreplayable. The chain makes tampering evident, the trigger makes the easy path
     * unavailable.
     */
    const ledger = new PostgresDecisionLedger(scoped());
    const contextSnapshotId = await sealedContext("immutable");
    const aggregateId = "agg-immutable";
    await ledger.append({ aggregateId, expectedVersion: 0, event: opening(aggregateId, contextSnapshotId) });

    await client.query("SAVEPOINT before_update");
    await expect(client.query(
      "UPDATE decision_ledger SET state_to = 'EXECUTED' WHERE aggregate_id = $1", [aggregateId],
    )).rejects.toThrow(/append-only/);
    await client.query("ROLLBACK TO SAVEPOINT before_update");

    await client.query("SAVEPOINT before_delete");
    await expect(client.query(
      "DELETE FROM decision_ledger WHERE aggregate_id = $1", [aggregateId],
    )).rejects.toThrow(/append-only/);
    await client.query("ROLLBACK TO SAVEPOINT before_delete");
  });

  it("refuses an append that skips a stage, before it reaches the database", async () => {
    // The transition table owns legality; persistence cannot express it, so the domain check runs
    // first and this proves it is actually wired into the append path.
    const ledger = new PostgresDecisionLedger(scoped());
    const contextSnapshotId = await sealedContext("skip");
    const aggregateId = "agg-skip";
    const first = opening(aggregateId, contextSnapshotId);
    await ledger.append({ aggregateId, expectedVersion: 0, event: first });

    await expect(ledger.append({
      aggregateId, expectedVersion: 1,
      event: {
        ...first, eventId: `${aggregateId}-event-2`, aggregateVersion: 2,
        stateFrom: "CANDIDATE_RESOLVED", stateTo: "RISK_APPROVED",
        previousEventHash: decisionEventHash(first),
      },
    })).rejects.toThrow(/skips MARKET_STATE_INTERPRETED/);
  });

  it("leaves both tables exactly as it found them", async () => {
    // Counted on a separate connection: inside this transaction the other tests' writes are invisible
    // anyway, so counting on `client` would pass whether or not the rollbacks worked.
    const outside = await pool.connect();
    try {
      const ledgerRows = await outside.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM decision_ledger WHERE aggregate_id LIKE 'agg-%'",
      );
      const snapshotRows = await outside.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM decision_snapshots WHERE bytes LIKE '%ledger-context%'",
      );
      expect(ledgerRows.rows[0]!.n).toBe(0);
      expect(snapshotRows.rows[0]!.n).toBe(0);
    } finally {
      outside.release();
    }
  });
});
