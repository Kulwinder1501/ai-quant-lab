import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool, type DatabasePool } from "../../infrastructure/database/database.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresStrategyMarketContextRepository } from "../../infrastructure/database/repositories/postgres-strategy-market-context-repository.js";
import {
  controlIneligibleReason,
  researchScalpStrategies,
} from "../../modules/research/scalp-harness/domain/research-strategies.js";
import { resolveTapeLiveness } from "../../modules/research/scalp-harness/application/resolve-tape-liveness.js";
import {
  checkCoverageOrdering,
  compareConsumedState,
  summariseParity,
  LIVE_BACKFILL_PARITY_VERSION,
  type ParityConsumedState,
  type ParityMismatch,
  type ParitySampleResult,
} from "../../modules/research/scalp-harness/domain/live-backfill-parity.js";
import type { StrategyMarketContext } from "../../modules/strategy-engine/domain/strategy.js";
import { getOption, requireOption } from "./arguments.js";
import { requireIsolatedResearchDatabaseUrl } from "./scalp-research-database.js";

/**
 * LIVE_BACKFILL_FEATURE_PARITY_V1 — acceptance test for the feature-coverage gate.
 *
 * Replays a completed session against the *same* code that captured it live — same strategy
 * versions, same `featureSchemaVersion`, same algorithm versions, same `controlPolicyVersion`, same
 * source candles — and asks one question: for every sample live capture marked eligible, did it
 * consume the state an after-the-fact reconstruction sees?
 *
 * ## This tool writes nothing, ever
 *
 * It opens no write port, calls no repository `save*`, and touches no settlement table. The backfill
 * must not overwrite live proposals, controls, cohorts or outcomes -- a diagnostic that mutates the
 * cohort it is diagnosing destroys the evidence. Read-only is the safety property, so it is enforced
 * by construction rather than by care.
 *
 * ## It stops before outcomes, deliberately
 *
 * No label, forward path, settlement or P&L is read or compared. The moment this becomes "live P&L
 * vs backfill P&L" it is a backtest of a session we already have, and the question it was built to
 * answer is gone. Hence the name: it is a parity test, not a backtest.
 *
 * ## Known limitation, stated rather than hidden
 *
 * A bar that produced no proposal stores no feature vector -- `raw_context` exists only on
 * proposals, and control points carry eligibility but not the consumed indicators or events. So
 * feature-vector parity is checkable only where at least one side proposed. Eligibility, the
 * eligibility reason, coverage ordering and proposal presence are checkable on every eligible bar,
 * and proposal presence is what would catch a silent under-read on a non-firing bar. The artifact
 * reports both counts so a reader is never left assuming the stronger coverage.
 */

const DEFAULT_OUTPUT_DIR = fileURLToPath(new URL("../../../../../logs/scalp-research/", import.meta.url));

/** Must match the gate in `run-scalp-research-harness.ts`; parity is meaningless against a different rule. */
const REQUIRED_COVERAGE = [
  { layer: "CANDLESTICK_PATTERN", algorithmVersion: "candlestick-v1" },
  { layer: "PRICE_ACTION", algorithmVersion: "price-action-v2" },
] as const;

interface EligibleControlRow {
  source_candle_id: string;
  decision_at: Date;
  created_at: Date;
  sample_eligible: boolean;
  ineligible_reason: string | null;
}

interface LiveProposalRow {
  strategy_key: string;
  timeframe: string;
  direction: string;
  raw_context: Record<string, unknown>;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) : [];
}

function parityIndicators(raw: unknown): ParityConsumedState["indicators"] {
  return asRecordArray(raw).map((item) => ({
    code: String(item.code ?? ""),
    algorithmVersion: String(item.algorithmVersion ?? ""),
    parameters: (item.parameters as Record<string, unknown>) ?? {},
    values: (item.values as Record<string, unknown>) ?? {},
  }));
}

function parityPatterns(raw: unknown): ParityConsumedState["patterns"] {
  return asRecordArray(raw).map((item) => ({
    code: String(item.code ?? ""),
    algorithmVersion: String(item.algorithmVersion ?? ""),
    direction: String(item.direction ?? ""),
    confidence: Number(item.confidence ?? 0),
  }));
}

function parityEvents(raw: unknown): ParityConsumedState["priceActionEvents"] {
  return asRecordArray(raw).map((item) => ({
    eventCode: String(item.eventCode ?? ""),
    algorithmVersion: String(item.algorithmVersion ?? ""),
    direction: String(item.direction ?? ""),
    level: item.level === null || item.level === undefined ? null : Number(item.level),
    confidence: Number(item.confidence ?? 0),
  }));
}

/** Builds one side's consumed state from a set of proposals plus the eligibility the control recorded. */
function consumedStateFrom(input: {
  sampleEligible: boolean;
  ineligibleReason: string | null;
  proposals: readonly { strategyKey: string; timeframe: string; direction: string; rawContext: Record<string, unknown> }[];
}): ParityConsumedState {
  // Any proposal on the bar carries the same context arrays for its timeframe; the 1m reference is
  // preferred so both sides describe the same series when a 5m proposal is also present.
  const representative = [...input.proposals].sort((left, right) => left.timeframe.localeCompare(right.timeframe))[0];
  const nativeConfidenceByStrategy: Record<string, number | null> = {};
  const legacyScoreGateByStrategy: Record<string, unknown> = {};
  const proposalDirections: Record<string, string> = {};
  for (const proposal of input.proposals) {
    const key = `${proposal.strategyKey}:${proposal.timeframe}`;
    const confidence = proposal.rawContext.nativeConfidence;
    nativeConfidenceByStrategy[key] = typeof confidence === "number" ? confidence : null;
    legacyScoreGateByStrategy[key] = proposal.rawContext.legacyScoreGate ?? null;
    proposalDirections[key] = proposal.direction;
  }
  return {
    sampleEligible: input.sampleEligible,
    ineligibleReason: input.ineligibleReason,
    indicators: parityIndicators(representative?.rawContext.indicators),
    patterns: parityPatterns(representative?.rawContext.patterns),
    priceActionEvents: parityEvents(representative?.rawContext.priceActionEvents),
    nativeConfidenceByStrategy,
    legacyScoreGateByStrategy,
    proposalDirections,
  };
}

async function loadEligibleControls(
  database: DatabasePool, instrumentId: string, sessionDate: string,
): Promise<EligibleControlRow[]> {
  // One row per decision minute: controls are written per direction, and both share the eligibility
  // and capture timestamp, so DISTINCT ON collapses them without losing anything compared here.
  const result = await database.query<EligibleControlRow>(`
    SELECT DISTINCT ON (source_candle_id)
      source_candle_id, decision_at, created_at, sample_eligible, ineligible_reason
    FROM research_scalp.control_points
    WHERE instrument_id = $1 AND session_id = $2 AND sample_eligible = TRUE
    ORDER BY source_candle_id, created_at ASC
  `, [instrumentId, sessionDate]);
  return result.rows;
}

async function loadLiveProposals(
  database: DatabasePool, instrumentId: string, sessionDate: string,
): Promise<Map<string, LiveProposalRow[]>> {
  const result = await database.query<LiveProposalRow & { source_candle_id: string }>(`
    SELECT source_candle_id, strategy_key, timeframe, direction, raw_context
    FROM research_scalp.proposals
    WHERE instrument_id = $1
      AND (decision_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
  `, [instrumentId, sessionDate]);
  const byCandle = new Map<string, LiveProposalRow[]>();
  for (const row of result.rows) {
    byCandle.set(row.source_candle_id, [...(byCandle.get(row.source_candle_id) ?? []), row]);
  }
  return byCandle;
}

/**
 * When every required layer for every sibling this minute reads was first covered.
 *
 * `MAX` because coverage is satisfied only once the last required layer lands, and `computed_at` is
 * a first-cover time -- migration 079 inserts `ON CONFLICT DO NOTHING`, so a later recompute never
 * restamps it. Returns null when any required pair is missing, which on an eligible sample is itself
 * a failure rather than an absence to shrug at.
 */
async function loadCoverageSatisfiedAt(
  database: DatabasePool, instrumentId: string, decisionAt: Date,
): Promise<Date | null> {
  const result = await database.query<{ satisfied_at: Date | null; missing: string | null }>(`
    WITH wanted AS (
      SELECT sibling.id AS candle_id, layer.feature_layer, layer.algorithm_version
      FROM (VALUES ('1m', INTERVAL '1 minute'), ('3m', INTERVAL '3 minutes'), ('5m', INTERVAL '5 minutes')) AS tf(timeframe, span)
      JOIN candles sibling
        ON sibling.instrument_id = $1 AND sibling.timeframe = tf.timeframe
       AND sibling.open_time = $2::timestamptz - tf.span AND sibling.is_complete = TRUE
      CROSS JOIN (VALUES ('CANDLESTICK_PATTERN', 'candlestick-v1'), ('PRICE_ACTION', 'price-action-v2')) AS layer(feature_layer, algorithm_version)
    )
    SELECT max(coverage.computed_at) AS satisfied_at,
           count(*) FILTER (WHERE coverage.computed_at IS NULL)::text AS missing
    FROM wanted
    LEFT JOIN candle_feature_coverage coverage
      ON coverage.candle_id = wanted.candle_id
     AND coverage.feature_layer = wanted.feature_layer
     AND coverage.algorithm_version = wanted.algorithm_version
  `, [instrumentId, decisionAt]);
  const row = result.rows[0];
  if (!row || Number(row.missing ?? "0") > 0) return null;
  return row.satisfied_at;
}

async function reconstructContexts(
  contextRepository: PostgresStrategyMarketContextRepository, instrumentId: string, closeTime: Date,
): Promise<{ reference: StrategyMarketContext | null; contexts: StrategyMarketContext[] }> {
  const reference = await contextRepository.findCompletedAt({ instrumentId, timeframe: "1m", closeTime });
  if (!reference) return { reference: null, contexts: [] };
  const contexts = [reference];
  for (const timeframe of ["3m", "5m"] as const) {
    const context = await contextRepository.findCompletedAt({ instrumentId, timeframe, closeTime });
    if (context) contexts.push(context);
  }
  return { reference, contexts };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sessionDate = requireOption(args, "session");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) throw new Error("--session must be YYYY-MM-DD.");
  const symbols = (getOption(args, "instruments") ?? "NIFTY50,BANKNIFTY")
    .split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
  const outputDir = getOption(args, "output-dir") ?? DEFAULT_OUTPUT_DIR;

  const environment = loadEnvironment();
  const database = createDatabasePool(requireIsolatedResearchDatabaseUrl(
    environment.DATABASE_URL, environment.SCALP_RESEARCH_DATABASE_URL,
  ));
  try {
    const instrumentRepository = new PostgresInstrumentRepository(database);
    const contextRepository = new PostgresStrategyMarketContextRepository(database);
    const samples: ParitySampleResult[] = [];
    const coverageLags: number[] = [];
    let featureVectorComparedCount = 0;

    for (const symbol of symbols) {
      const instrument = await instrumentRepository.findByExchangeAndSymbol("NSE", symbol);
      if (!instrument) throw new Error(`NSE instrument ${symbol} is not registered.`);

      const controls = await loadEligibleControls(database, instrument.id, sessionDate);
      const liveProposals = await loadLiveProposals(database, instrument.id, sessionDate);

      for (const control of controls) {
        const mismatches: ParityMismatch[] = [];

        const coverageSatisfiedAt = await loadCoverageSatisfiedAt(database, instrument.id, control.decision_at);
        const ordering = checkCoverageOrdering({
          decisionAt: control.decision_at,
          coverageSatisfiedAt,
          sampleCapturedAt: control.created_at,
        });
        if (ordering.mismatch) mismatches.push(ordering.mismatch);
        if (ordering.coverageLagMs !== null) coverageLags.push(ordering.coverageLagMs);

        const { reference, contexts } = await reconstructContexts(contextRepository, instrument.id, control.decision_at);
        if (!reference) {
          mismatches.push({
            field: "sampleEligible",
            detail: "the 1m context could not be reconstructed",
            live: "eligible",
            reconstructed: "(no context)",
          });
          samples.push({
            sessionDate, instrumentSymbol: symbol,
            decisionAt: control.decision_at.toISOString(), comparable: false, mismatches,
            coverageLagMs: ordering.coverageLagMs,
          });
          continue;
        }

        // Reconstruction runs the same frozen adapters over the completed session. Coverage is
        // COMPLETE by construction here: the session is closed and every feature job has finished.
        const rebuilt = researchScalpStrategies.flatMap((strategy) => contexts
          .filter((context) => strategy.supportedTimeframes.includes(context.candle.timeframe))
          .flatMap((context) => strategy.evaluate(context, reference)));

        const liveRows = liveProposals.get(control.source_candle_id) ?? [];
        const liveState = consumedStateFrom({
          sampleEligible: control.sample_eligible,
          ineligibleReason: control.ineligible_reason,
          proposals: liveRows.map((row) => ({
            strategyKey: row.strategy_key, timeframe: row.timeframe,
            direction: row.direction, rawContext: row.raw_context,
          })),
        });
        /*
         * Liveness is recomputed, not assumed.
         *
         * Coverage is COMPLETE by construction here -- the session is closed and every feature job
         * has finished -- but the tape test has no such shortcut: it is a fact about the stored bars,
         * and those are unchanged by the session ending. Passing "LIVE" would make reconstruction
         * disagree with the live capture on every bar in the 15:16 close freeze, roughly 28 a session
         * across the two indices, and report each as a mismatch. Same resolver as the capture path.
         */
        const rebuiltTape = await resolveTapeLiveness({
          reader: contextRepository,
          instrumentId: instrument.id,
          timeframe: "1m",
          referenceBar: reference.candle,
          referenceCloseTime: reference.candle.closeTime,
          intervalMs: 60_000,
        });
        const rebuiltReason = controlIneligibleReason(reference, "COMPLETE", rebuiltTape.liveness);
        const rebuiltState = consumedStateFrom({
          sampleEligible: rebuiltReason === null,
          ineligibleReason: rebuiltReason,
          proposals: rebuilt.map((proposal) => ({
            strategyKey: proposal.strategyKey, timeframe: proposal.timeframe,
            direction: proposal.direction, rawContext: proposal.rawContext,
          })),
        });

        // Both sides must carry a feature vector for that half of the comparison to mean anything;
        // `raw_context` lives only on proposals, so one side proposing and the other not leaves the
        // silent side with empty arrays. See `compareConsumedState`.
        const compareFeatureVectors = liveRows.length > 0 && rebuilt.length > 0;
        if (compareFeatureVectors) featureVectorComparedCount += 1;
        mismatches.push(...compareConsumedState(liveState, rebuiltState, { compareFeatureVectors }));

        samples.push({
          sessionDate, instrumentSymbol: symbol,
          decisionAt: control.decision_at.toISOString(), comparable: true, mismatches,
          coverageLagMs: ordering.coverageLagMs,
        });
      }
    }

    const report = summariseParity({ sessionDate, samples, coverageLags });
    await mkdir(outputDir, { recursive: true });
    const outputPath = resolve(outputDir, `parity-${LIVE_BACKFILL_PARITY_VERSION}-${sessionDate}.json`);
    await writeFile(outputPath, JSON.stringify({ ...report, featureVectorComparedCount, symbols }, null, 2), "utf8");

    console.info("==========================================================================");
    console.info(`${LIVE_BACKFILL_PARITY_VERSION} — ${sessionDate} — ${symbols.join(", ")}`);
    console.info("==========================================================================");
    console.info(`Eligible samples compared : ${report.eligibleSampleCount}`);
    console.info(`Comparable                : ${report.comparableSampleCount}`);
    console.info(`With a feature vector     : ${featureVectorComparedCount} (a non-firing bar stores none)`);
    console.info(`Coverage lag ms           : ${report.coverageLagMs ? `min ${report.coverageLagMs.min}, median ${report.coverageLagMs.median}, max ${report.coverageLagMs.max}` : "unavailable"}`);
    console.info(`Mismatches by field       : ${Object.keys(report.mismatchCountsByField).length === 0 ? "none" : JSON.stringify(report.mismatchCountsByField)}`);
    // Split by capture regime. A recovered sample was captured after an outage, once every feature
    // job had finished, so it passes by construction; blending it into one number lets a long outage
    // read as a clean session. The live cohort is the one that tests anything.
    const share = (cohort: { sampleCount: number; cleanSampleCount: number }): string => (
      cohort.sampleCount === 0 ? "n/a"
        : `${cohort.cleanSampleCount}/${cohort.sampleCount} clean (${((100 * cohort.cleanSampleCount) / cohort.sampleCount).toFixed(1)}%)`
    );
    console.info(`  live captures           : ${share(report.liveCohort)}  <- the cohort under test`);
    console.info(`  recovered after outage  : ${share(report.recoveredCohort)}  (passes by construction; not evidence)`);
    if (report.recoveredCohort.sampleCount > 0) {
      const recoveredShare = (100 * report.recoveredCohort.sampleCount) / Math.max(1, report.eligibleSampleCount);
      console.info(`  NOTE: ${recoveredShare.toFixed(1)}% of this session was recovered rather than captured live.`);
    }
    console.info(`VERDICT                   : ${report.passed ? "PARITY" : "NO_PARITY"}`);
    for (const sample of report.samples.filter((item) => item.mismatches.length > 0).slice(0, 20)) {
      for (const mismatch of sample.mismatches) {
        console.info(`  ${sample.instrumentSymbol} ${sample.decisionAt} ${mismatch.field}: ${mismatch.detail} (live ${mismatch.live} / rebuilt ${mismatch.reconstructed})`);
      }
    }
    console.info(`Artifact: ${outputPath}`);
    if (!report.passed) process.exitCode = 1;
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
