import { createDatabasePool } from "../../infrastructure/database/database.js";
import { loadEnvironment } from "../../config/environment.js";
import { PostgresDifferentialClassifications } from "../../infrastructure/database/repositories/postgres-differential-classifications.js";
import { getOption, requireOption } from "./arguments.js";
import { divergenceEvidenceFromOptions, formatEvidenceUsage } from "./divergence-evidence.js";

/**
 * Attaches a classification to one P13 divergence.
 *
 * ## Why this exists
 *
 * `run-shadow-decisions` hardcoded every divergence as `UNKNOWN`, and `UNKNOWN` blocks promotion by
 * design, so P13 could never pass -- not for want of evidence but for want of a mechanism. This is
 * the write path.
 *
 * ## One divergence at a time, deliberately
 *
 * No bulk mode and no pattern matching. A classification is a claim about a specific pair of
 * decisions, and the classifications that matter most -- `BUG`, and `UNKNOWN` after a real attempt --
 * are exactly the ones a bulk tool would encourage applying by the hundred. §6 makes an unresolved
 * `BUG` a promotion blocker; a flag that stamped fifty of them would defeat the gate while appearing
 * to satisfy it.
 *
 * ```bash
 * npm run classify:divergence -- \
 *   --comparison-key='NIFTY50@5m@2026-09-08T04:00:00.000Z' \
 *   --producer=structural-gate-v1 \
 *   --kind=EXPECTED_ARCHITECTURAL_CHANGE --design-decision=D3 \
 *   --by='ks' --rationale='V1 proposed on a republished close; V2.2 refused on tape liveness.'
 * ```
 *
 * The database refuses evidence that does not match the kind, a classification on an observation
 * whose sides agreed, and one on an observation that does not exist. This tool does not re-check any
 * of that -- see the repository note on why duplicating a constraint is worse than trusting it.
 */

const COMPARISON_VERSION_DEFAULT = "THESIS_COMPARISON_V1";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const comparisonKey = requireOption(args, "comparison-key");
  const producerId = requireOption(args, "producer");
  const classifiedBy = requireOption(args, "by");
  const rationale = requireOption(args, "rationale");
  const comparisonVersion = getOption(args, "comparison-version")?.trim()
    || COMPARISON_VERSION_DEFAULT;

  /*
   * The rationale is required and must say something. It does not substitute for the evidence -- the
   * per-kind CHECK is what makes a classification a claim -- but a classification nobody explained
   * is one the next reader cannot audit, and this record is what a promotion decision rests on.
   */
  if (rationale.trim().length < 20) {
    throw new Error(
      "--rationale must be a real sentence. A classification is read later by someone deciding "
      + "whether V1 can be retired, and \"expected\" tells them nothing.",
    );
  }

  const evidence = divergenceEvidenceFromOptions(args);

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const classifications = new PostgresDifferentialClassifications(database);
    const revision = await classifications.record({
      comparisonKey,
      comparisonVersion,
      producerId,
      evidence,
      classifiedBy,
      rationale,
    });

    console.log(JSON.stringify({
      level: "info",
      message: "Divergence classified",
      comparisonKey,
      comparisonVersion,
      producerId,
      kind: evidence.kind,
      // Above 1 means this corrected an earlier classification rather than making a first one.
      revision,
      supersededEarlier: revision > 1,
    }));
  } finally {
    await database.end();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    level: "error",
    message: "Could not classify the divergence",
    error: error instanceof Error ? error.message : String(error),
    usage: formatEvidenceUsage(),
  }));
  process.exit(1);
});
