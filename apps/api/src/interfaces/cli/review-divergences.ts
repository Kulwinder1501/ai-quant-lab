import { createDatabasePool } from "../../infrastructure/database/database.js";
import { loadEnvironment } from "../../config/environment.js";
import { PostgresDifferentialObservations } from "../../infrastructure/database/repositories/postgres-differential-observations.js";
import { getOption } from "./arguments.js";
import { classifyCommandFor, reviewRow } from "./divergence-review.js";

/**
 * Lists the P13 divergences waiting to be classified.
 *
 * ## Why this is a separate tool
 *
 * `classify:divergence` requires `--comparison-key`, and until this existed nothing produced one. The
 * shadow pass reported counts per producer -- `divergences: 47, unclassified: 47` -- so classifying a
 * single row meant hand-querying Postgres for the keys and then again for the reasons. A write path
 * whose input cannot be obtained is not a write path.
 *
 * It also reads `legacy_detail` and `v2_detail`, which migration 093 added so that "a reviewer
 * classifying a divergence needs the reason", and which nothing read until now.
 *
 * ```bash
 * npm run review:divergences -- --producer=structural-gate-v1
 * npm run review:divergences -- --producer=structural-gate-v1 --all --limit=100
 * ```
 *
 * ## It refuses to suggest a classification
 *
 * The copy-ready command it prints leaves `--kind` and the evidence flags as placeholders. Filling
 * them in from the reason strings would be a guessing classifier by another route, and §6's whole
 * point is that a classification is a human claim carrying its own evidence. The one thing that is
 * filled in is the comparison key, because typing an instant by hand is how the wrong bar gets
 * classified.
 */

const DEFAULT_LIMIT = 25;
const COMPARISON_VERSION_DEFAULT = "THESIS_COMPARISON_V1";

function positiveInteger(args: string[], name: string, fallback: number): number {
  const raw = getOption(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive whole number.`);
  }
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const producerId = getOption(args, "producer")?.trim();
  if (producerId === undefined || producerId === "") {
    throw new Error(
      "--producer is required. Native and ported are separate populations graded separately, so a "
      + "list spanning both would mix two systems' divergences into one review queue.",
    );
  }
  const comparisonVersion = getOption(args, "comparison-version")?.trim()
    || COMPARISON_VERSION_DEFAULT;
  // Default is the working queue. `--all` includes rows already classified, for re-review.
  const unclassifiedOnly = !args.includes("--all");
  const limit = positiveInteger(args, "limit", DEFAULT_LIMIT);

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const observations = new PostgresDifferentialObservations(database);
    const divergences = await observations.listDivergences({
      comparisonVersion,
      producerId,
      unclassifiedOnly,
      limit,
    });

    const rows = divergences.map((row) => reviewRow(row));
    console.log(JSON.stringify({
      level: "info",
      message: "P13 divergence review",
      comparisonVersion,
      producerId,
      scope: unclassifiedOnly ? "UNCLASSIFIED_ONLY" : "ALL_DIVERGENCES",
      returned: rows.length,
      /*
       * Reported so a full page is never mistaken for a complete queue -- the count is capped by
       * --limit, and a reviewer who works through 25 rows should know whether that was all of them.
       */
      mayBeTruncated: rows.length === limit,
      blocking: rows.filter((row) => row.blocker !== null).length,
      divergences: rows,
      // Printed once rather than per row: the same shape applies to every one of them.
      classifyWith: divergences.length === 0 ? null : classifyCommandFor(divergences[0]!),
    }, null, 2));
  } finally {
    await database.end();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    level: "error",
    message: "Could not review divergences",
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exit(1);
});
