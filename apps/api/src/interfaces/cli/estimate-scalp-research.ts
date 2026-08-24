import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresScalpResearchEstimandRepository } from "../../infrastructure/database/repositories/postgres-scalp-research-estimand-repository.js";
import {
  estimateAbsoluteExpectancy,
  estimateGateValue,
  estimateNativePolicyEdge,
  estimateSignalEdge,
  partitionByCohort,
  type AbsoluteExpectancyUnit,
} from "../../modules/research/scalp-harness/domain/estimators.js";
import {
  canonicalFrictionModel,
  canonicalFrictionPolicyVersion,
  canonicalFrictionRungsBps,
  netBps,
} from "../../modules/research/scalp-harness/domain/canonical-friction.js";
import type {
  AbsoluteExpectancyRow,
} from "../../infrastructure/database/repositories/postgres-scalp-research-estimand-repository.js";
import { matchedControlCount } from "../../modules/research/scalp-harness/domain/matched-controls.js";
import { settlementPolicyVersion } from "../../modules/research/scalp-harness/domain/contracts.js";
import { getOption } from "./arguments.js";
import { requireIsolatedResearchDatabaseUrl } from "./scalp-research-database.js";

/**
 * Produces the three Section-4 estimands from settled research rows.
 *
 * Until this existed the harness could capture, match and settle but could not answer its own
 * question — the rows were evidence of lineage, not of edge. This is the layer that turns them into an
 * estimate, and just as importantly into a day-clustered interval.
 *
 * ## Read the interval, not the point estimate
 *
 * Every summary reports `meanPerDay` with a 95% percentile interval from a trading-day block bootstrap.
 * The per-day statistic is the one the interval belongs to: intraday scalp outcomes within a session
 * share regime and overlapping windows, so treating trades as independent understates variance and
 * manufactures significance. An interval containing zero establishes nothing, however large the point
 * estimate looks — that is the discipline this project has already paid for several times.
 *
 * The gate-value block is observational by construction and carries that label in its own output; it is
 * a negative screen, never evidence that gating causes the difference.
 *
 * Usage: estimate-scalp-research [--from ISO] [--through ISO] [--replicates 2000]
 */

function dateOption(args: string[], name: string, fallback: Date): Date {
  const value = new Date(getOption(args, name) ?? fallback);
  if (Number.isNaN(value.getTime())) throw new Error(`--${name} must be an ISO-8601 timestamp.`);
  return value;
}

/** The three settled populations, reported separately because they answer different questions. */
const subjectTypes = ["NATIVE_PROPOSAL", "CANONICAL_OPPORTUNITY", "CONTROL_POINT"] as const;

function unitsFrom(
  rows: readonly AbsoluteExpectancyRow[],
  value: (row: AbsoluteExpectancyRow) => number | null,
): AbsoluteExpectancyUnit[] {
  return rows.map((row) => ({
    subjectId: row.subjectId,
    sessionId: row.sessionId,
    strategyDefinitionHashes: row.strategyDefinitionHashes,
    outcomeR: value(row),
  }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const through = dateOption(args, "through", new Date());
  const from = dateOption(args, "from", new Date(through.getTime() - 30 * 24 * 60 * 60 * 1_000));
  const replicatesRaw = getOption(args, "replicates");
  const replicates = replicatesRaw === undefined ? undefined : Number(replicatesRaw);
  if (replicates !== undefined && (!Number.isInteger(replicates) || replicates < 200)) {
    throw new Error("--replicates must be an integer of at least 200 for a stable 95% interval.");
  }

  const environment = loadEnvironment();
  const database = createDatabasePool(requireIsolatedResearchDatabaseUrl(
    environment.DATABASE_URL, environment.SCALP_RESEARCH_DATABASE_URL,
  ));

  try {
    const repository = new PostgresScalpResearchEstimandRepository(database);
    const [signalUnits, policyUnits, gateUnits, expectancyRows, outcomeCounts] = await Promise.all([
      repository.listSignalEdgeUnits({ from, through }),
      repository.listPolicyEdgeUnits({ from, through }),
      repository.listGateValueUnits({ from, through }),
      repository.listAbsoluteExpectancyUnits({ from, through }),
      repository.countOutcomesBySubjectType({ from, through }),
    ]);

    const options = replicates === undefined ? {} : { replicates };

    /*
     * One report per strategy-definition cohort, never a pooled average.
     *
     * Storage-level version immutability is defeated the moment two definitions are averaged into one
     * number: a gated population and an ungated one are different selection rules answering different
     * questions, and their mean describes a strategy that never ran. Partitioning here makes that
     * impossible by construction rather than by remembering to filter.
     */
    const cohorts = [...new Set([
      ...partitionByCohort(signalUnits).keys(),
      ...partitionByCohort(policyUnits).keys(),
      ...partitionByCohort(gateUnits).keys(),
      ...partitionByCohort(expectancyRows).keys(),
    ])].sort();

    const signalByCohort = partitionByCohort(signalUnits);
    const policyByCohort = partitionByCohort(policyUnits);
    const gateByCohort = partitionByCohort(gateUnits);
    const expectancyByCohort = partitionByCohort(expectancyRows);

    const reports = cohorts.map((cohort) => {
      const signalEdge = estimateSignalEdge(signalByCohort.get(cohort) ?? [], options);
      const nativePolicyEdge = estimateNativePolicyEdge(policyByCohort.get(cohort) ?? [], options);
      const gateValue = estimateGateValue(gateByCohort.get(cohort) ?? [], options);
      const cohortRows = expectancyByCohort.get(cohort) ?? [];

      /*
       * The level, per population — the early-stopping gate.
       *
       * Signal Edge is a contrast and friction largely cancels inside it, so it can look healthy while
       * the population it describes returns nothing. That combination is not tradeable, and sweeping
       * TP/SL over it would eventually surface a profitable-looking cell by chance. So the level is
       * reported next to the contrast and the gate reads both.
       */
      const absoluteExpectancy = Object.fromEntries(subjectTypes.map((subjectType) => {
        const rows = cohortRows.filter((row) => row.subjectType === subjectType);
        return [subjectType, {
          grossR: estimateAbsoluteExpectancy(unitsFrom(rows, (row) => row.grossR), options),
          grossBps: estimateAbsoluteExpectancy(unitsFrom(rows, (row) => row.grossBps), options),
          // Friction is applied in basis points because that is exact for every stored row and is
          // comparable across instruments; an R multiple is denominated in its own stop distance.
          netBpsByRung: Object.fromEntries(canonicalFrictionRungsBps.map((rung) => [
            String(rung),
            estimateAbsoluteExpectancy(unitsFrom(rows, (row) => netBps(row.grossBps, rung)), options),
          ])),
        }];
      }));

      const nativeGross = absoluteExpectancy.NATIVE_PROPOSAL!.grossBps;
      /*
       * STAGE 1 — does this population have anywhere to go, before exits are searched at all?
       *
       * Both conditions must hold. A positive level with no contrast means the market paid everyone
       * and the signal added nothing; a positive contrast with a non-positive level means the signal
       * picks better-than-random moments in a market that pays nothing. Neither is worth a sweep.
       */
      const grossEdgeGate = nativeGross.ci95 === null || signalEdge.ci95 === null
        ? "INSUFFICIENT_DAYS — two trading days are the mechanical minimum for an interval; this gate needs far more"
        : signalEdge.ci95.lower > 0 && nativeGross.ci95.lower > 0
          ? "PROCEED_TO_FRICTION — gross level and gross contrast are both above zero"
          : nativeGross.ci95.upper <= 0
            ? "STOP_NO_GROSS_EDGE — gross expectancy is negative before any cost; no exit policy recovers this, investigate the entry"
            : "STOP_GROSS_EDGE_INDISTINGUISHABLE — the interval includes zero; a TP/SL sweep here would be parameter mining";

      return {
        strategyDefinitionCohort: cohort,
        signalEdge: {
          definition: "selectedCanonicalOutcome_i - mean(matchedControlOutcomes_i)",
          ...signalEdge,
        },
        nativeExecutionPolicyEdge: {
          definition: "paired nativeOutcome - canonicalOutcome (INTENT_TO_TRADE reading)",
          ...nativePolicyEdge,
        },
        gateValue,
        absoluteExpectancy,
        grossEdgeGate,
        // Stated rather than implied: an interval spanning zero is not a small edge, it is no evidence.
        verdict: signalEdge.ci95 === null
          ? "INSUFFICIENT_DAYS — at least two trading days are needed before an interval is even mechanically possible"
          : signalEdge.ci95.lower > 0
            ? "SIGNAL_EDGE_INTERVAL_ABOVE_ZERO — exploratory; confirm on data this estimate never saw"
            : "NO_SIGNAL_EDGE — the 95% interval includes zero",
      };
    });

    /*
     * The ambiguous share, reported beside the estimates rather than buried.
     *
     * It is the fraction the settlement policy could not resolve, and it is not a constant: it rises
     * as brackets tighten toward the bar range. At the current geometry it is negligible, which is
     * itself worth seeing — it says the pessimistic/optimistic bracket is currently near-free, and
     * that a finer-resolution re-walk would buy almost nothing.
     */
    const outcomeAudit = subjectTypes.map((subjectType) => {
      const rows = outcomeCounts.filter((row) => row.subjectType === subjectType);
      const settled = rows.reduce((sum, row) => sum + row.subjects, 0);
      const ambiguous = rows.find((row) => row.outcome === "AMBIGUOUS")?.subjects ?? 0;
      return {
        subjectType,
        settled,
        byOutcome: Object.fromEntries(rows.map((row) => [row.outcome, row.subjects])),
        // Null rather than zero on an empty population: no rows is not a zero rate.
        ambiguousShare: settled === 0 ? null : Number((ambiguous / settled).toFixed(6)),
      };
    });

    console.info(JSON.stringify({
      level: "info",
      message: "Scalp research estimands computed",
      window: { from, through },
      settlementPolicyVersion,
      matchedControlCount,
      inference: "TRADING_DAY_BLOCK_BOOTSTRAP — days are the resampling cluster; ci95 is a percentile "
        + "interval on the mean of per-day means.",
      // Required beside every net figure. Without it a reader reasonably assumes these are the costs
      // we actually pay to trade, and they are not — that is Track B and it has its own machinery.
      costModel: canonicalFrictionModel,
      canonicalFrictionPolicyVersion,
      canonicalFrictionRungsBps,
      outcomeAudit,
      // Acceptance invariant: every reported estimate belongs to exactly one definition cohort.
      mixedStrategyDefinitionCount: 0,
      cohortCount: cohorts.length,
      // A mechanical minimum, not a sufficiency test. Clearing two days lets the bootstrap run; a
      // research verdict additionally needs many independent days, stability across regimes, agreement
      // between instruments, and untouched out-of-sample evidence.
      sufficiencyNote: "MINIMUM_DAYS enables an interval; SUFFICIENT_EVIDENCE is a separate judgement.",
      reports,
    }, null, 2));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
