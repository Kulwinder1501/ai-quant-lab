import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresScalpResearchEstimandRepository } from "../../infrastructure/database/repositories/postgres-scalp-research-estimand-repository.js";
import {
  estimateGateValue,
  estimateNativePolicyEdge,
  estimateSignalEdge,
  partitionByCohort,
} from "../../modules/research/scalp-harness/domain/estimators.js";
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
    const [signalUnits, policyUnits, gateUnits] = await Promise.all([
      repository.listSignalEdgeUnits({ from, through }),
      repository.listPolicyEdgeUnits({ from, through }),
      repository.listGateValueUnits({ from, through }),
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
    ])].sort();

    const signalByCohort = partitionByCohort(signalUnits);
    const policyByCohort = partitionByCohort(policyUnits);
    const gateByCohort = partitionByCohort(gateUnits);

    const reports = cohorts.map((cohort) => {
      const signalEdge = estimateSignalEdge(signalByCohort.get(cohort) ?? [], options);
      const nativePolicyEdge = estimateNativePolicyEdge(policyByCohort.get(cohort) ?? [], options);
      const gateValue = estimateGateValue(gateByCohort.get(cohort) ?? [], options);
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
        // Stated rather than implied: an interval spanning zero is not a small edge, it is no evidence.
        verdict: signalEdge.ci95 === null
          ? "INSUFFICIENT_DAYS — at least two trading days are needed before an interval is even mechanically possible"
          : signalEdge.ci95.lower > 0
            ? "SIGNAL_EDGE_INTERVAL_ABOVE_ZERO — exploratory; confirm on data this estimate never saw"
            : "NO_SIGNAL_EDGE — the 95% interval includes zero",
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
