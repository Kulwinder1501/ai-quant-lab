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
import {
  comparableAction,
  runShadowDecision,
} from "../../modules/autonomous-v2/application/shadow-decision.js";
import { evaluateDifferentialRun } from "../../modules/autonomous-v2/domain/differential-testing.js";
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
// V1's real context type, not an approximation of it. This CLI is the layer §6 allows to see both
// sides, and a structural shim here would only invite drift from the type it stands in for.
import type { StrategyMarketContext } from "../../modules/strategy-engine/domain/strategy.js";
import { PostgresDifferentialObservations } from "../../infrastructure/database/repositories/postgres-differential-observations.js";
import {
  legacyThesisComparison,
  thesisComparisonVersion,
} from "../../modules/autonomous-v2/application/thesis-adapter.js";
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
const DEFAULT_MAX_BAR_AGE_MS = 3 * 60_000;

/**
 * `--max-bar-age-seconds` raises that ceiling for one run.
 *
 * A real operational need -- catching up after an outage means deciding on a bar older than three
 * minutes -- and a footgun if it were implicit. So it is never defaulted upwards: an operator types a
 * number, and every record carries `barAgeSeconds` so the resulting decisions can be found and judged
 * by how stale their bar was.
 *
 * It does not weaken any gate. A stale bar still passes through the frozen-tape and coverage checks,
 * and the decision is still recorded as what it is.
 */
function maxBarAgeMs(args: string[]): number {
  const raw = getOption(args, "max-bar-age-seconds");
  if (raw === undefined) return DEFAULT_MAX_BAR_AGE_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("--max-bar-age-seconds must be a positive number of seconds.");
  }
  return seconds * 1_000;
}

/**
 * V1's canonical outcome for this bar, evaluated on the SAME context object V2.2 read.
 *
 * This is what makes P13's shared-snapshot requirement honest. V1 never reads a sealed snapshot, so
 * pairing on "the same bar" would have been the weaker claim -- contexts are enriched over time as
 * pattern layers backfill, and two reads of one bar are not always equal. Both outcomes here come
 * from one in-memory context, read once, which the sealed ref then describes truthfully.
 *
 * `strategy.evaluate` is pure: it returns proposals and persists nothing, so running V1 here creates
 * no trade idea and no trade. This is §6's sanctioned use of the thesis comparison -- differential
 * analysis, never a live decision.
 *
 * ## Several strategies may propose, and none is picked
 *
 * The outcome is the **sorted set** of every proposal, not a winner. Choosing one would be
 * `patterns[0]` in another costume, and the quarantine exists because that arbitrariness was never
 * visible. Sorting makes the string order-independent, so two runs of the same proposals compare
 * equal rather than diverging on evaluation order.
 *
 * A bar where V1 proposes nothing is `NO_ACTION NO_PROPOSAL` -- distinct from V2.2's
 * `NO_ACTION NO_ESTABLISHED_ENTRY_RULE`, because "my rules did not fire" and "I have no rules" are
 * different statements and P13 must not read them as agreement.
 */
function legacyOutcomeFor(input: {
  readonly context: StrategyMarketContext;
  readonly instrumentSymbol: string;
  readonly decisionAt: Date;
}): string {
  const proposals: string[] = [];
  for (const strategy of registeredStrategies) {
    if (!strategySupportsTimeframe(strategy, input.context.candle.timeframe)) continue;
    const executable = strategyExecutableSides(strategy);
    const evaluator = new strategy.StrategyClass();
    for (const proposal of evaluator.evaluate(input.context, strategy.registration.configuration)) {
      // The measured side restrictions apply: a proposal V1 would not have traded must not appear as
      // one V1 made, or the comparison reports a decision that could never have happened.
      if (!executable.includes(proposal.side)) continue;
      proposals.push(legacyThesisComparison({
        instrumentSymbol: input.instrumentSymbol,
        decisionAt: input.decisionAt,
        verdict: "APPROVED",
        geometry: {
          side: proposal.side,
          entryPrice: proposal.entryPrice,
          stopLoss: proposal.stopLoss,
          targetPrice: proposal.targetPrice,
        },
      }).canonicalOutcome);
    }
  }
  if (proposals.length === 0) return "NO_ACTION NO_PROPOSAL";
  return [...new Set(proposals)].sort().join(" | ");
}

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

/**
 * Whether each feature layer was actually computed for this bar, from `candle_feature_coverage`.
 *
 * The right source, and the second one I tried. The first version read
 * `patternObservationCoverage`, which belongs to **Pattern Intelligence V1.0.1** (`pattern_observations_v2`)
 * -- a different subsystem from the legacy candlestick detections on `context.patterns`. Using one
 * layer's coverage to describe another's is exactly the conflation the coverage distinction exists to
 * prevent, and the adapter refused it rather than resolving it: *"1 row(s) supplied but the layer is
 * declared not computed"*.
 *
 * Matched at exact algorithm versions for the reason the scalp harness's gate is: ignoring the
 * version would let a different variant of a layer open the gate for consumers of this one.
 */
async function featureCoverageFor(
  database: ReturnType<typeof createDatabasePool>,
  candleId: string,
): Promise<{ readonly patternsComputed: boolean; readonly priceActionComputed: boolean }> {
  const result = await database.query<{ feature_layer: string }>(`
    SELECT feature_layer FROM candle_feature_coverage
    WHERE candle_id = $1
      AND (feature_layer, algorithm_version) IN (
        ('CANDLESTICK_PATTERN', 'candlestick-v1'),
        ('PRICE_ACTION', 'price-action-v2')
      )
  `, [candleId]);
  const layers = new Set(result.rows.map((row) => row.feature_layer));
  return {
    patternsComputed: layers.has("CANDLESTICK_PATTERN"),
    priceActionComputed: layers.has("PRICE_ACTION"),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const symbols = (getOption(args, "instruments") ?? "NIFTY50,BANKNIFTY")
    .split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
  if (symbols.length === 0) throw new Error("--instruments must contain at least one NSE symbol.");
  const barAgeCeilingMs = maxBarAgeMs(args);

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  const instanceId = randomUUID();

  try {
    const instrumentRepository = new PostgresInstrumentRepository(database);
    const contextRepository = new PostgresStrategyMarketContextRepository(database);
    const registry = new PostgresSnapshotRegistry(database);
    const ledger = new PostgresShadowLedger(database, instanceId);
    const observations = new PostgresDifferentialObservations(database);
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
      if (barAgeMs > barAgeCeilingMs) {
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

      const coverage = await featureCoverageFor(database, latest.candle.id);
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
          // From `candle_feature_coverage`, per layer. See `featureCoverageFor` for the two wrong
          // sources this replaced.
          patternsComputed: coverage.patternsComputed,
          priceActionComputed: coverage.priceActionComputed,
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

      /*
       * P13's pair. V1's side is evaluated on the same `latest` context the snapshot was sealed from,
       * so citing one snapshot ref for both is a fact rather than an assumption -- which is what
       * `assertComparable` demands and what makes the stored row re-derivable.
       */
      const legacyOutcome = legacyOutcomeFor({
        context: latest,
        instrumentSymbol: symbol,
        decisionAt: latest.candle.closeTime,
      });
      /*
       * The action is compared; the reason is recorded beside it. One implementation for both sides,
       * because a drift between two would read as the systems disagreeing rather than the formatters.
       */
      const legacy = comparableAction(legacyOutcome);
      const v2 = comparableAction(record.v2Outcome);
      const recorded = await observations.record({
        observation: {
          comparisonKey: record.comparisonKey,
          legacySnapshotRef: record.contextSnapshotId,
          v2SnapshotRef: record.contextSnapshotId,
          legacyOutcome: legacy.action,
          v2Outcome: v2.action,
        },
        comparisonVersion: thesisComparisonVersion,
        legacyDetail: legacy.detail,
        v2Detail: v2.detail,
      });

      records.push({
        symbol,
        decisionId: record.decisionId,
        legacyAction: legacy.action,
        legacyReason: legacy.detail || null,
        agreed: legacy.action === v2.action,
        observationRecorded: recorded,
        barCloseAt: latest.candle.closeTime.toLocaleTimeString("en-GB", { timeZone: IST }),
        outcome: record.v2Outcome,
        abstained: record.abstained,
        contextSnapshotId: record.contextSnapshotId.slice(0, 12),
        sealedMatchesSnapshot: sealed.snapshotId === record.contextSnapshotId,
        tapeLiveness: tape.liveness,
      });
    }

    /*
     * The accumulated P13 verdict, not just this pass's.
     *
     * `evaluateDifferentialRun` refuses to call an empty run promotable, and it will report
     * `promotable: false` for a long time yet -- every divergence starts UNKNOWN until a human
     * attaches evidence, and UNKNOWN blocks. That is the gate working, not a fault: V2.2 abstaining
     * where V1 proposes is a real difference and must be explained before V1 can be retired.
     */
    const stored = await observations.listForVersion(thesisComparisonVersion);
    const verdict = evaluateDifferentialRun({
      observations: stored.map((row) => ({
        comparisonKey: row.comparisonKey,
        legacySnapshotRef: row.contextSnapshotId,
        v2SnapshotRef: row.contextSnapshotId,
        legacyOutcome: row.legacyOutcome,
        v2Outcome: row.v2Outcome,
      })),
      // Unclassified until a human attaches evidence, so every divergence is a blocker today.
      divergences: stored.filter((row) => !row.agreed).map((row) => ({
        observation: {
          comparisonKey: row.comparisonKey,
          legacySnapshotRef: row.contextSnapshotId,
          v2SnapshotRef: row.contextSnapshotId,
          legacyOutcome: row.legacyOutcome,
          v2Outcome: row.v2Outcome,
        },
        evidence: { kind: "UNKNOWN" as const },
      })),
    });

    console.log(JSON.stringify({
      level: "info",
      message: "V2.2 shadow decision pass completed",
      executesNothing: true,
      records,
      p13: {
        comparisonVersion: thesisComparisonVersion,
        comparisons: verdict.comparisons,
        agreements: verdict.agreements,
        divergences: verdict.divergences,
        unclassified: verdict.byClassification.UNKNOWN,
        promotable: verdict.promotable,
        blockers: verdict.blockers.length,
      },
    }));
  } finally {
    await database.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
