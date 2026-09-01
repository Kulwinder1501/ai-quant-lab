import "dotenv/config";
import { randomUUID } from "node:crypto";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import {
  LedgerVersionConflictError,
  PostgresDecisionLedger,
} from "../../infrastructure/database/repositories/postgres-decision-ledger.js";
import { PostgresSnapshotRegistry } from "../../infrastructure/database/repositories/postgres-snapshot-registry.js";
import type { DecisionLedgerEvent } from "../../modules/autonomous-v2/domain/decision-ledger.js";

/**
 * Closes I23, which the unit and live suites structurally cannot.
 *
 * I23 -- "ledger append must enforce `expectedVersion` atomically" -- is a claim about two *genuinely
 * concurrent* transactions resolving to exactly one winner. `postgres-decision-ledger.test.ts` runs
 * every case inside a transaction it rolls back, which is right for the other guarantees and useless
 * for this one: an uncommitted row is invisible to the other connection, so there is no race to
 * observe. Proving it needs one writer to commit.
 *
 * A faked client proves less still. It can show that the INSERT targets `expectedVersion + 1`, which
 * is the ordering assertion the unit tests already make; it cannot show that
 * `decision_ledger_aggregate_version_key` actually arbitrates two simultaneous attempts. So this runs
 * the real repository against the live database with each attempt on its own connection.
 *
 * ## Footprint, and why it is not cleaned up
 *
 * Each run leaves one `decision_snapshots` row and one `decision_ledger` row, under a fresh UUID
 * aggregate id prefixed `__VERIFY_LEDGER__`.
 *
 * They are not deleted, and that is the guarantee working rather than an oversight: both tables refuse
 * DELETE by trigger, because a decision that cannot resolve its context is unreplayable (I20) and
 * history is never rewritten (I15). A harness that could tidy up after itself would be proof the
 * immutability is not real. The alternative -- disabling the trigger to clean up -- would put a script
 * that switches off the ledger's immutability into the repository, which is a worse thing to own than a
 * few labelled rows.
 *
 * Usage: verify-ledger-concurrency
 */

const SENTINEL = "__VERIFY_LEDGER__";

function eventFor(input: {
  readonly aggregateId: string;
  readonly eventId: string;
  readonly contextSnapshotId: string;
}): DecisionLedgerEvent {
  return {
    eventId: input.eventId,
    decisionId: input.aggregateId,
    aggregateId: input.aggregateId,
    aggregateVersion: 1,
    occurredAt: new Date(),
    eventType: "STAGE_COMPLETED",
    schemaVersion: 1,
    stateFrom: "CANDIDATE_RESOLVED",
    stateTo: "CANDIDATE_RESOLVED",
    contextSnapshotId: input.contextSnapshotId,
    policyVersions: { GRID: "GRID_POLICY_V1", TAPE: "TAPE_LIVENESS_V1" },
    correlationId: `${input.aggregateId}-correlation`,
    causationId: null,
    payloadSnapshotId: null,
    previousEventHash: null,
    producer: { service: "verify-ledger-concurrency", version: "1.0.0", instanceId: randomUUID() },
  };
}

async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  const checks: Record<string, unknown>[] = [];
  try {
    const aggregateId = `${SENTINEL}${randomUUID()}`;
    const registry = new PostgresSnapshotRegistry(database);
    const context = await registry.seal({ probe: SENTINEL, aggregateId });

    /*
     * Item 1: two concurrent appends at expectedVersion 0, different event ids, one aggregate.
     *
     * Both target version 1. Each `append` gets its own connection from the pool, and neither reads a
     * head first (expectedVersion 0 needs no read), so there is no application-level ordering to hide
     * behind -- the constraint is the only arbiter.
     */
    const eventA = eventFor({ aggregateId, eventId: `${aggregateId}-A`, contextSnapshotId: context.snapshotId });
    const eventB = eventFor({ aggregateId, eventId: `${aggregateId}-B`, contextSnapshotId: context.snapshotId });

    const attempts = await Promise.allSettled([
      new PostgresDecisionLedger(database).append({ aggregateId, expectedVersion: 0, event: eventA }),
      new PostgresDecisionLedger(database).append({ aggregateId, expectedVersion: 0, event: eventB }),
    ]);

    const winners = attempts.filter((attempt) => attempt.status === "fulfilled");
    const losers = attempts.filter((attempt) => attempt.status === "rejected");
    const loserIsVersionConflict = losers.every(
      (attempt) => (attempt as PromiseRejectedResult).reason instanceof LedgerVersionConflictError,
    );
    const stored = await database.query<{ n: string }>(
      "SELECT count(*) AS n FROM decision_ledger WHERE aggregate_id = $1", [aggregateId],
    );
    const rowsForAggregate = Number(stored.rows[0]!.n);

    checks.push({
      item: 1,
      description: "Two concurrent appends at the same expectedVersion: exactly one succeeds (I23)",
      passed: winners.length === 1 && losers.length === 1 && loserIsVersionConflict && rowsForAggregate === 1,
      detail: `winners=${winners.length} losers=${losers.length} `
        + `loserIsVersionConflict=${loserIsVersionConflict} rowsForAggregate=${rowsForAggregate}`,
      loserMessage: losers.length === 1
        ? String((losers[0] as PromiseRejectedResult).reason).slice(0, 120)
        : null,
    });

    /*
     * Item 2: the winning event re-appended from a fresh connection is a retry, not a conflict.
     *
     * The *same event object* is resent, not a rebuilt one. `eventFor` stamps a fresh `occurredAt` and
     * `producer.instanceId` on every call, so a rebuilt event has a different hash and would correctly
     * be reported as a content conflict -- which would test the opposite of what this item is about.
     * That is the realistic failure too: a producer that reconstructs an event on retry instead of
     * resending it is not retrying, it is writing a different event under the same id.
     */
    const winningEventId = (await database.query<{ event_id: string }>(
      "SELECT event_id FROM decision_ledger WHERE aggregate_id = $1", [aggregateId],
    )).rows[0]!.event_id;
    const winningEvent = winningEventId === eventA.eventId ? eventA : eventB;

    const retry = await new PostgresDecisionLedger(database).append({
      aggregateId, expectedVersion: 0, event: winningEvent,
    });
    const afterRetry = Number((await database.query<{ n: string }>(
      "SELECT count(*) AS n FROM decision_ledger WHERE aggregate_id = $1", [aggregateId],
    )).rows[0]!.n);

    checks.push({
      item: 2,
      description: "An identical re-append is deduplicated and inserts no second row",
      passed: retry.deduplicated === true && afterRetry === 1,
      detail: `deduplicated=${retry.deduplicated} sequence=${retry.sequence} rowsAfterRetry=${afterRetry}`,
    });

    const allPassed = checks.every((check) => check.passed === true);
    console.info(JSON.stringify({
      gate: "I23 ledger append atomicity (live, two connections)",
      aggregateId,
      checks,
      footprint: {
        decisionSnapshotRows: 1,
        decisionLedgerRows: rowsForAggregate,
        note: "Not deleted: both tables refuse DELETE by trigger (I15, I20). A harness that could tidy "
          + "up would prove the immutability is not real.",
      },
      verdict: allPassed ? "PASS" : "FAIL",
    }, null, 2));
    if (!allPassed) process.exitCode = 1;
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
