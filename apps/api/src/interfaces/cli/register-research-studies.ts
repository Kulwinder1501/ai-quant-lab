import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresScalpResearchStudyRepository } from "../../infrastructure/database/repositories/postgres-scalp-research-study-repository.js";
import {
  decisionGradeSessionMinimum,
  registeredStudies,
  studyDefinitionHash,
  studyRegistryEncodingVersion,
} from "../../modules/research/scalp-harness/domain/study-registry.js";
import { requireIsolatedResearchDatabaseUrl } from "./scalp-research-database.js";

/**
 * Registers the pre-declared exit-geometry studies. Gate 0 of the falsification program.
 *
 * Run before any of these studies produces a figure, and safe to re-run: an unchanged definition is a
 * no-op, and a key whose definition has changed is *refused* rather than updated. That refusal is the
 * point — the stored specification is what the deflated-Sharpe and overfitting corrections count, so a
 * search space that grew after registration has to surface as an error rather than as a wider grid
 * nobody recorded.
 *
 * Usage: register-research-studies [--dry-run]
 */
async function main(): Promise<void> {
  const dryRun = process.argv.slice(2).includes("--dry-run");

  const planned = registeredStudies.map((study) => ({
    studyKey: study.studyKey,
    studyDefinitionHash: studyDefinitionHash(study),
    provenance: study.provenance,
    question: study.question,
  }));

  if (dryRun) {
    console.info(JSON.stringify({
      level: "info",
      message: "Study registration plan (dry run — nothing written)",
      studyRegistryEncodingVersion,
      decisionGradeSessionMinimum,
      planned,
    }, null, 2));
    return;
  }

  const environment = loadEnvironment();
  const database = createDatabasePool(requireIsolatedResearchDatabaseUrl(
    environment.DATABASE_URL, environment.SCALP_RESEARCH_DATABASE_URL,
  ));

  try {
    const repository = new PostgresScalpResearchStudyRepository(database);
    const results = [];
    for (const study of registeredStudies) {
      results.push(await repository.register(study));
    }

    console.info(JSON.stringify({
      level: "info",
      message: "Research studies registered",
      studyRegistryEncodingVersion,
      // Stated beside the registration because it is the number a later gate decision has to cite: an
      // interval is mechanically possible at two trading days and is not a verdict until far more.
      decisionGradeSessionMinimum,
      registered: results.filter((item) => item.outcome === "REGISTERED").length,
      alreadyRegistered: results.filter((item) => item.outcome === "ALREADY_REGISTERED").length,
      results,
      // A study whose candidate values were chosen after seeing outcomes cannot be pooled with a
      // pre-specified grid when the multiplicity correction runs. Surfaced here so the split is visible
      // at registration time rather than rediscovered at analysis time.
      provenanceSplit: Object.fromEntries(
        ["PRE_SPECIFIED", "DATA_INSPECTED"].map((provenance) => [
          provenance,
          registeredStudies.filter((study) => study.provenance === provenance).map((study) => study.studyKey),
        ]),
      ),
      allRegistered: await repository.listRegistered(),
    }, null, 2));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
