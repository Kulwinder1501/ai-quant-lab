import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import {
  PostgresCandidateLedgerRepository,
  type UnsettledCandidate,
} from "../../infrastructure/database/repositories/postgres-candidate-ledger-repository.js";
import { settleCandidate } from "../../modules/paper-trading/domain/candidate-settlement.js";
import type { CompletedPriceCandle } from "../../modules/paper-trading/domain/paper-trade-exit-policy.js";

/**
 * Settles every candidate whose horizon has elapsed, recording what it would have done.
 *
 * The same command serves the scheduled sweep and the historical backfill: a backfill is only this
 * sweep with a larger `--limit`, because the selection is "horizon elapsed and not yet settled" and
 * that is true of history as much as of the last five minutes. Two commands would be two behaviours
 * to keep in step.
 *
 * Bars are loaded once per series rather than once per candidate. With thousands of candidates over
 * one instrument and timeframe that is the difference between a few queries and a few thousand.
 *
 * Usage: settle-candidates [--limit N] [--as-of ISO]
 */

const DEFAULT_LIMIT = 500;

/**
 * A candidate's horizon can close on the exact same tick the sweep runs on -- 5m candidates with a
 * 15-minute horizon land on :15/:45, which is also the sweep's own schedule. Ingestion takes a few
 * seconds to persist that closing bar (observed p50 ~6s, p95 ~15s for on-time bars), so without this
 * the sweep always wins that race and marks a fully-available horizon UNSETTLEABLE before the last
 * bar exists. This only delays when a candidate becomes *eligible*; it does not wait once picked up,
 * so a genuine multi-minute gap still resolves as UNSETTLEABLE rather than being masked.
 */
const INGESTION_GRACE_MS = 60_000;

function parseArguments(argv: readonly string[]): { limit: number; asOf: Date } {
  let limit = DEFAULT_LIMIT;
  let asOf = new Date();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--limit" && argv[index + 1]) {
      const parsed = Number(argv[index + 1]);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--limit must be a positive number.");
      limit = Math.floor(parsed);
      index += 1;
    }
    if (argv[index] === "--as-of" && argv[index + 1]) {
      asOf = new Date(argv[index + 1]!);
      if (Number.isNaN(asOf.getTime())) throw new Error("--as-of must be an ISO timestamp.");
      index += 1;
    }
  }
  return { limit, asOf };
}

function seriesKey(candidate: UnsettledCandidate): string {
  return `${candidate.instrumentId}|${candidate.timeframe}`;
}

async function main(): Promise<void> {
  const { limit, asOf } = parseArguments(process.argv.slice(2));
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  try {
    const ledger = new PostgresCandidateLedgerRepository(database);
    const candidates = await ledger.listUnsettledCandidates({
      settledBefore: new Date(asOf.getTime() - INGESTION_GRACE_MS),
      limit,
    });

    const outcomes: Record<string, number> = {};
    let written = 0;
    let alreadySettled = 0;
    let failures = 0;

    // One bar load per series, covering the union of every candidate's window in that series.
    const bySeries = new Map<string, UnsettledCandidate[]>();
    for (const candidate of candidates) {
      const key = seriesKey(candidate);
      const bucket = bySeries.get(key);
      if (bucket) bucket.push(candidate);
      else bySeries.set(key, [candidate]);
    }

    for (const group of bySeries.values()) {
      const first = group[0]!;
      const earliestAnchor = new Date(Math.min(...group.map((c) => c.signalBarCloseTime.getTime())));
      const latestHorizon = new Date(Math.max(...group.map((c) => c.horizonEnd.getTime())));
      let bars: CompletedPriceCandle[] = [];
      try {
        bars = await ledger.listForwardBars({
          instrumentId: first.instrumentId,
          timeframe: first.timeframe,
          after: earliestAnchor,
          through: latestHorizon,
        });
      } catch (error) {
        // One unreadable series must not abandon the others; the rest of the sweep is still useful.
        failures += group.length;
        console.error(JSON.stringify({
          level: "error",
          message: "Could not load bars for a series; its candidates stay unsettled.",
          instrumentId: first.instrumentId,
          timeframe: first.timeframe,
          reason: error instanceof Error ? error.message : String(error),
        }));
        continue;
      }

      for (const candidate of group) {
        try {
          const forwardCandles = bars.filter(
            (bar) => bar.closeTime.getTime() > candidate.signalBarCloseTime.getTime()
              && bar.closeTime.getTime() <= candidate.horizonEnd.getTime(),
          );
          const settlement = settleCandidate({
            side: candidate.side,
            entryPrice: candidate.entryPrice,
            stopLoss: candidate.stopLoss,
            targetPrice: candidate.targetPrice,
            horizonEnd: candidate.horizonEnd,
            resolvedTimeframe: candidate.timeframe,
            forwardCandles,
          });
          const inserted = await ledger.recordSettlement(candidate.tradeIdeaId, settlement);
          if (inserted) {
            written += 1;
            outcomes[settlement.outcome] = (outcomes[settlement.outcome] ?? 0) + 1;
          } else {
            alreadySettled += 1;
          }
        } catch (error) {
          failures += 1;
          console.error(JSON.stringify({
            level: "error",
            message: "Could not settle a candidate.",
            tradeIdeaId: candidate.tradeIdeaId,
            reason: error instanceof Error ? error.message : String(error),
          }));
        }
      }
    }

    console.info(JSON.stringify({
      level: "info",
      message: "Candidate settlement sweep complete",
      asOf: asOf.toISOString(),
      candidatesRead: candidates.length,
      seriesLoaded: bySeries.size,
      settlementsWritten: written,
      alreadySettled,
      failures,
      outcomes,
      // Stated rather than left to be inferred from the count: a sweep that hits its limit has left
      // work behind, and reading it as "everything is settled" is the trap.
      moreLikelyRemaining: candidates.length === limit,
    }, null, 2));

    if (failures > 0) {
      throw new Error(`${failures} candidate(s) could not be settled; see the errors above.`);
    }
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error("Candidate settlement failed:", error);
  process.exitCode = 1;
});
