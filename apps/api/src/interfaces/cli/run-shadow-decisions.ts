import "dotenv/config";
import { randomUUID } from "node:crypto";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresStrategyMarketContextRepository } from "../../infrastructure/database/repositories/postgres-strategy-market-context-repository.js";
import { PostgresSnapshotRegistry } from "../../infrastructure/database/repositories/postgres-snapshot-registry.js";
import { PostgresShadowLedger } from "../../infrastructure/database/repositories/postgres-shadow-ledger.js";
import {
  marketSnapshotContent,
  marketSnapshotFromLegacyContext,
} from "../../modules/autonomous-v2/application/market-context-adapter.js";
import { runShadowDecision } from "../../modules/autonomous-v2/application/shadow-decision.js";
import {
  structuralGateThesisProducer,
  type ThesisSide,
} from "../../modules/autonomous-v2/domain/thesis-producer.js";
import {
  assessTapeLiveness,
  frozenTapeThresholdFor,
  tapeLivenessPolicyVersion,
} from "../../modules/market-data/domain/tape-liveness.js";
import { NseMarketSession } from "../../modules/market-data/domain/nse-market-session.js";
import {
  registeredStrategies,
  strategyExecutableSides,
  strategySupportsTimeframe,
} from "../../modules/strategy-engine/domain/strategy-registry.js";
import { getOption } from "./arguments.js";

/**
 * Runs one pass of V2.2's shadow decision path. Records decisions; executes nothing.
 *
 * This is step 2 of retiring V1. It puts the whole V2.2 chain on the live tape — sealed snapshot,
 * thesis producer, recorded decision — while V1 keeps trading, so the new system accumulates a real
 * decision record without holding authority.
 *
 * ## Why a CLI wires this and the V2.2 modules do not
 *
 * The gate needs facts from both sides: a market context and executable sides from V1, tape liveness
 * from `market-data`, session windows from the calendar. `autonomous-v2` may import none of that —
 * the quarantine guard forbids the V1 half — so the composition happens here, in an interface, which
 * is the "caller which may see both" pattern every adapter in this ladder relies on.
 *
 * ## What it can and cannot do
 *
 * It holds no execution port. `runShadowDecision` takes a ledger and nothing else, so this process
 * cannot open a position however it is invoked or misconfigured. That is the property, not a mode.
 *
 * ## What it will report today, and why that is correct
 *
 * `structuralGateThesisProducer` can never approve, so every record will be a refusal, a deferral, or
 * `NO_ACTION NO_ESTABLISHED_ENTRY_RULE`. A long run of that last one is a **healthy** V2.2 with no
 * strategy — the machinery ran clean and had nothing to propose. It is not a failure, and it is not
 * evidence to retire V1: P13 treats V2 abstaining where V1 approved as a divergence that blocks
 * promotion until explained.
 */

const IST = "Asia/Kolkata";

/**
 * How stale the latest bar may be before this pass declines to decide on it.
 *
 * Three minutes on a 1m series: enough slack for collection and indicator lag, short enough that a
 * closed market is recognised on the next tick.
 *
 * Without this the cron would re-decide the same bar. The window runs to 15:55 while the market
 * closes at 15:30, so the 15:29 bar would be the "latest completed" for five more runs and each
 * would record a fresh decision on it -- duplicate rows in the record P13 counts as comparisons,
 * which is coverage that does not exist. Same failure on a weekend or a holiday, indefinitely.
 */
const MAX_BAR_AGE_MS = 3 * 60_000;

/**
 * The sides V2.2 may consider for this instrument and timeframe.
 *
 * The union across registered strategies that own the timeframe, because a side disabled on one
 * strategy is not disabled on the instrument. Read from V1's registry deliberately: the restriction
 * is a *measurement* about the instrument (-Rs 13,414 over 62 long trades on the index scalp), not V1
 * decision logic, and §6's KEEP AS PRINCIPLE bucket names empirical side restrictions as a rule to
 * carry forward rather than quarantine.
 *
 * A native thesis will eventually declare its own side and this input disappears with V1.
 */
function executableSidesFor(timeframe: string): readonly ThesisSide[] {
  const sides = new Set<ThesisSide>();
  for (const strategy of registeredStrategies) {
    if (!strategySupportsTimeframe(strategy, timeframe)) continue;
    for (const side of strategyExecutableSides(strategy)) sides.add(side as ThesisSide);
  }
  return [...sides];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const symbols = (getOption(args, "instruments") ?? "NIFTY50,BANKNIFTY")
    .split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
  if (symbols.length === 0) throw new Error("--instruments must contain at least one NSE symbol.");

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  const instanceId = randomUUID();

  try {
    const instrumentRepository = new PostgresInstrumentRepository(database);
    const contextRepository = new PostgresStrategyMarketContextRepository(database);
    const registry = new PostgresSnapshotRegistry(database);
    const ledger = new PostgresShadowLedger(database, instanceId);
    const session = new NseMarketSession();
    const records: Record<string, unknown>[] = [];

    for (const symbol of [...new Set(symbols)]) {
      const instrument = await instrumentRepository.findByExchangeAndSymbol("NSE", symbol);
      if (!instrument) {
        records.push({ symbol, skipped: "INSTRUMENT_NOT_REGISTERED" });
        continue;
      }
      const latest = await contextRepository.findLatestCompleted({
        instrumentId: instrument.id, timeframe: "1m",
      });
      if (!latest) {
        records.push({ symbol, skipped: "NO_COMPLETED_1M_CONTEXT" });
        continue;
      }

      const barAgeMs = Date.now() - latest.candle.closeTime.getTime();
      if (barAgeMs > MAX_BAR_AGE_MS) {
        /*
         * Nothing new to decide. Reported rather than silent, because "no records" has two very
         * different causes -- a closed market and a dead job -- and the liveness expectation on
         * SHADOW_DECISION cannot tell them apart on its own.
         */
        records.push({
          symbol,
          skipped: "BAR_TOO_STALE",
          latestBarCloseAt: latest.candle.closeTime.toLocaleTimeString("en-GB", { timeZone: IST }),
          barAgeSeconds: Math.round(barAgeMs / 1000),
        });
        continue;
      }

      /*
       * The predecessor bar, for tape liveness. Read here rather than inside the producer because
       * liveness is a fact about the bar *series*, which a single context cannot carry -- the same
       * reason the scalp harness resolves it in its runner.
       */
      const threshold = frozenTapeThresholdFor(symbol);
      const predecessors = [];
      for (let step = 1; step < threshold; step += 1) {
        const closeTime = new Date(latest.candle.closeTime.getTime() - step * 60_000);
        const previous = await contextRepository.findCompletedAt({
          instrumentId: instrument.id, timeframe: "1m", closeTime,
        });
        if (!previous) break;
        predecessors.unshift(previous.candle);
      }
      const tape = assessTapeLiveness({
        bars: [...predecessors, latest.candle],
        intervalMs: 60_000,
        threshold,
      });

      const knownAt = new Date();
      const snapshot = marketSnapshotFromLegacyContext({
        context: {
          candle: {
            instrumentId: instrument.id,
            timeframe: latest.candle.timeframe,
            openTime: latest.candle.openTime,
            closeTime: latest.candle.closeTime,
            open: latest.candle.open,
            high: latest.candle.high,
            low: latest.candle.low,
            close: latest.candle.close,
            volume: latest.candle.volume,
            tickSize: latest.candle.tickSize,
          },
          indicators: latest.indicators.map((indicator) => ({
            code: indicator.code,
            algorithmVersion: indicator.algorithmVersion,
            parameters: indicator.parameters,
            values: indicator.values as Record<string, unknown>,
          })),
          patterns: latest.patterns.map((pattern) => ({
            code: pattern.code,
            algorithmVersion: pattern.algorithmVersion,
            direction: pattern.direction,
            confidence: pattern.confidence,
          })),
          priceActionEvents: latest.priceActionEvents.map((event) => ({
            eventCode: event.eventCode,
            algorithmVersion: event.algorithmVersion,
            direction: event.direction,
            level: event.level,
          })),
          /*
           * `COMPLETE` and nothing else.
           *
           * The three states are three different facts, and only `COMPLETE` licenses treating absence
           * as information: `NOT_COVERED` means the detector has not reached this bar, and `UNKNOWN`
           * means the consumer did not check. Accepting either would report an unevaluated bar as
           * evaluated-and-empty -- the distinction migration 079 exists to preserve, and the one that
           * cost a 93% firing-rate drop on 2026-08-24 when it was lost.
           *
           * The first version of this line read `=== "LOADED" || patternObservations !== undefined`,
           * which was wrong twice: that state does not exist, and the fallback would have counted
           * `UNKNOWN` as computed. `tsc` refused the comparison, which is the only reason it was
           * caught before this ran against live bars.
           */
          patternsComputed: latest.patternObservationCoverage === "COMPLETE",
          priceActionComputed: true,
        },
        instants: {
          eventAt: latest.candle.closeTime,
          knownAt,
          dataThrough: latest.candle.closeTime,
          dataThroughConvention: "CLOSE_LABELLED",
          // One second after knowing, which `sealPitInstants` requires: a decision acting at the
          // instant it learned something acted on information it did not yet have.
          earliestExecutionAt: new Date(knownAt.getTime() + 1_000),
          referenceAt: new Date(knownAt.getTime() + 1_000),
        },
        labelConvention: "CLOSE_LABELLED",
      });

      /*
       * Seal the *content* the ref was computed over, not the finished snapshot object.
       *
       * Found by running this: sealing `snapshot` hashes a different structure -- it contains its own
       * `ref` -- so the two ids disagreed and `decision_ledger_context_resolvable` rejected the write
       * with the snapshot id absent from `decision_snapshots`. The FK caught it, which is what it is
       * for. `marketSnapshotContent` is now the single definition of what the address covers.
       */
      const sealed = await registry.seal(marketSnapshotContent({
        bar: snapshot.bar,
        labelConvention: snapshot.labelConvention,
        indicators: snapshot.indicators,
        patterns: snapshot.patterns,
        patternCoverage: snapshot.patternCoverage,
        priceActionEvents: snapshot.priceActionEvents,
        priceActionCoverage: snapshot.priceActionCoverage,
        higherTimeframeCoverage: snapshot.higherTimeframeCoverage,
        instants: snapshot.instants,
      }));
      if (sealed.snapshotId !== snapshot.ref.snapshotId) {
        // Belt and braces: the FK would catch it, but only after a partial write. Better to refuse
        // before the ledger is touched than to leave an opening event with no terminal.
        throw new Error(
          `Sealed snapshot ${sealed.snapshotId} does not match the snapshot's own ref `
          + `${snapshot.ref.snapshotId}. The content address and what was stored have diverged.`,
        );
      }

      const record = await runShadowDecision({
        decisionId: randomUUID(),
        gate: {
          snapshot,
          tapeLiveness: tape.liveness,
          executableSides: executableSidesFor(latest.candle.timeframe),
          insideExecutableWindow: session.isOpen(latest.candle.closeTime),
          instrumentSymbol: symbol,
        },
        produce: structuralGateThesisProducer,
        ledger,
        additionalPolicyVersions: { tapeLiveness: tapeLivenessPolicyVersion },
      });

      records.push({
        symbol,
        decisionId: record.decisionId,
        barCloseAt: latest.candle.closeTime.toLocaleTimeString("en-GB", { timeZone: IST }),
        outcome: record.v2Outcome,
        abstained: record.abstained,
        contextSnapshotId: record.contextSnapshotId.slice(0, 12),
        sealedMatchesSnapshot: sealed.snapshotId === record.contextSnapshotId,
        tapeLiveness: tape.liveness,
      });
    }

    console.log(JSON.stringify({
      level: "info",
      message: "V2.2 shadow decision pass completed",
      executesNothing: true,
      records,
    }));
  } finally {
    await database.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
