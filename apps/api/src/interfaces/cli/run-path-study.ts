import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import {
  PostgresPathStudyRepository,
  type PathStudyBar,
  type PathStudyDecision,
  type PathStudySubject,
  type TrialDeclaration,
} from "../../infrastructure/database/repositories/postgres-path-study-repository.js";
import {
  isCommonEligible,
  walkBarrierFreePath,
  type BarrierFreePathResult,
} from "../../modules/research/scalp-harness/domain/barrier-free-path.js";
import {
  degenerateIntervalSessionCeiling,
  directionalInformationCurve,
  pathStudyVerdict,
  type PathContrastUnit,
  type PathMetric,
} from "../../modules/research/scalp-harness/domain/directional-information-curve.js";
import { cohortKeyOf } from "../../modules/research/scalp-harness/domain/estimators.js";
import { logicalKey } from "../../modules/research/scalp-harness/domain/identity.js";
import { studyCodeVersion } from "../../modules/research/scalp-harness/domain/study-code-version.js";
import {
  decisionGradeSessionMinimum,
  evidenceState,
  registeredStudies,
  studyDefinitionHash,
} from "../../modules/research/scalp-harness/domain/study-registry.js";
import { getOption } from "./arguments.js";
import { requireIsolatedResearchDatabaseUrl } from "./scalp-research-database.js";

/**
 * Runs PATH_STUDY_V1 — the stage G1 Directional Information Curve — and records every cell it examines.
 *
 * ## Order of operations, and why it is not negotiable
 *
 *   verify the registration → enumerate cells → DECLARE every trial → compute → record results
 *
 * The declaration comes before the computation so that a crash, a kill, or a thrown error cannot leave
 * an examined configuration unrecorded. The alternative ordering — compute, then log — silently
 * undercounts the search by exactly the trials that failed, and the trial count is the one input the
 * deflated-Sharpe and overfitting corrections cannot do without. A declaration that cannot be written
 * aborts the run before a single path is walked.
 *
 * Because `research_scalp` is append-only there is no status to update, so an unfinished trial is a
 * declaration with no result row. That state is reported at the end of every run rather than being
 * invisible.
 *
 * ## The unit of a trial
 *
 * One row per (cohort, instrument, timeframe, direction). G1 has no free parameter — the horizon ladder
 * is frozen at registration — but looking at twenty curves and reporting the one that peaks most
 * cleanly is twenty configurations examined. Counting invocations instead would undercount by the
 * factor that matters.
 *
 * Usage: run-path-study [--from ISO] [--through ISO] [--metric DIRECTIONAL_RETURN_BPS] [--replicates 2000]
 */

const STUDY_KEY = "PATH_STUDY_V1";
const PARAMETER_FAMILY = "HORIZON_LADDER";

function dateOption(args: string[], name: string, fallback: Date): Date {
  const value = new Date(getOption(args, name) ?? fallback);
  if (Number.isNaN(value.getTime())) throw new Error(`--${name} must be an ISO-8601 timestamp.`);
  return value;
}

/** The grouping cell a subject belongs to. Every element of it is a registered `groupBy` key. */
function cellKeyOf(subject: PathStudySubject): string {
  return [
    cohortKeyOf(subject),
    subject.instrumentSymbol,
    subject.timeframeKey,
    subject.direction,
  ].join("|");
}

function walkDecision(
  decision: PathStudyDecision,
  direction: "LONG" | "SHORT",
  horizons: readonly number[],
  series: readonly PathStudyBar[],
  furthestMinutes: number,
): BarrierFreePathResult {
  // Slice rather than query: the whole instrument series is already in memory, and a bounded window
  // keeps the walker's map small.
  const from = decision.decisionAt.getTime();
  const to = from + furthestMinutes * 60_000;
  const forwardCandles = series.filter(
    (bar) => bar.closeTime.getTime() > from && bar.closeTime.getTime() <= to,
  );
  return walkBarrierFreePath({
    direction,
    decisionAt: decision.decisionAt,
    referencePrice: decision.referencePrice,
    sessionCloseAt: decision.sessionCloseAt,
    horizonsMinutes: horizons,
    atr: decision.atr,
    forwardCandles,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const through = dateOption(args, "through", new Date());
  const from = dateOption(args, "from", new Date(through.getTime() - 30 * 24 * 60 * 60 * 1_000));
  const metric = (getOption(args, "metric") ?? "DIRECTIONAL_RETURN_BPS") as PathMetric;
  const replicatesRaw = getOption(args, "replicates");
  const replicates = replicatesRaw === undefined ? 2_000 : Number(replicatesRaw);
  if (!Number.isInteger(replicates) || replicates < 200) {
    throw new Error("--replicates must be an integer of at least 200 for a stable 95% interval.");
  }

  const definition = registeredStudies.find((study) => study.studyKey === STUDY_KEY);
  if (!definition) throw new Error(`${STUDY_KEY} is not declared in the study registry.`);
  const horizons = definition.specification.horizonsMinutes as number[];
  const furthestMinutes = Math.max(...horizons);
  const codeVersion = studyCodeVersion();
  const declaredHash = studyDefinitionHash(definition);

  const environment = loadEnvironment();
  const database = createDatabasePool(requireIsolatedResearchDatabaseUrl(
    environment.DATABASE_URL, environment.SCALP_RESEARCH_DATABASE_URL,
  ));

  try {
    const repository = new PostgresPathStudyRepository(database);

    /*
     * The registration is the authority, not the code.
     *
     * If the code's definition has drifted from what was predeclared, this is a different study and
     * must be registered as a new version rather than run under the old key. Refusing here is what
     * stops a quietly edited specification from producing results filed against the original.
     */
    const registered = await repository.findRegisteredStudy(STUDY_KEY);
    if (!registered) {
      throw new Error(
        `${STUDY_KEY} has not been registered. Run \`npm run research:studies:register\` first — a `
        + "study must be predeclared before it produces a figure.",
      );
    }
    if (registered.studyDefinitionHash !== declaredHash) {
      throw new Error(
        `${STUDY_KEY} in code (${declaredHash.slice(0, 12)}…) does not match the registration `
        + `(${registered.studyDefinitionHash.slice(0, 12)}…). The registration is what the multiplicity `
        + "correction counts, so this is a new study: register it under a new versioned key rather than "
        + "running an edited specification against the old one.",
      );
    }

    const subjects = await repository.listSubjects({ from, through });
    if (subjects.length === 0) {
      console.info(JSON.stringify({
        level: "info",
        message: "Path study found no matched opportunities in the window",
        studyKey: STUDY_KEY, window: { from, through },
      }, null, 2));
      return;
    }

    // Cells are derived from the data, which is a read rather than a computation — the study itself has
    // not started until a path is walked.
    const cells = new Map<string, PathStudySubject[]>();
    for (const subject of subjects) {
      const key = cellKeyOf(subject);
      const bucket = cells.get(key);
      if (bucket) bucket.push(subject);
      else cells.set(key, [subject]);
    }

    const runKey = logicalKey("path-study-run", [
      STUDY_KEY, declaredHash, codeVersion, metric, from, through,
    ]);

    const declarations: TrialDeclaration[] = [...cells.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([cellKey, cellSubjects]) => {
        const sessions = [...new Set(cellSubjects.map((subject) => subject.sessionId))].sort();
        const [cohortKey, instrumentSymbol, timeframe, direction] = cellKey.split("|");
        return {
          trialKey: logicalKey("path-study-trial", [runKey, cellKey, metric]),
          runKey,
          studyKey: STUDY_KEY,
          studyDefinitionHash: declaredHash,
          codeVersion,
          cohortKey: cohortKey!,
          instrumentSymbol: instrumentSymbol!,
          timeframe: timeframe!,
          direction: direction as "LONG" | "SHORT",
          parameterFamily: PARAMETER_FAMILY,
          parameterValues: { horizonsMinutes: horizons, metric, replicates },
          datasetCutoff: through,
          sessionRangeStart: sessions[0]!,
          sessionRangeEnd: sessions[sessions.length - 1]!,
          sessionCount: sessions.length,
          // Frozen pre-computation so the governance label cannot be picked after seeing the result.
          evidenceState: evidenceState(sessions.length),
          subjectsDeclared: cellSubjects.length,
        };
      });

    // Fail closed. Nothing is computed until every cell of this run is accountable.
    await repository.declareTrials(database, declarations);

    const seriesByInstrument = new Map<string, PathStudyBar[]>();
    for (const instrumentId of new Set(subjects.map((subject) => subject.instrumentId))) {
      seriesByInstrument.set(instrumentId, await repository.listOneMinuteSeries({
        instrumentId,
        from,
        // The window has to reach past the last decision by the furthest horizon, or the tail of the
        // curve would read as missing data rather than as the path it actually was.
        through: new Date(through.getTime() + furthestMinutes * 60_000),
      }));
    }

    const reports = [];
    for (const declaration of declarations) {
      const cellKey = [
        declaration.cohortKey, declaration.instrumentSymbol, declaration.timeframe, declaration.direction,
      ].join("|");
      const cellSubjects = cells.get(cellKey)!;

      const units: PathContrastUnit[] = cellSubjects.map((subject) => {
        const series = seriesByInstrument.get(subject.instrumentId) ?? [];
        return {
          subjectId: subject.opportunityId,
          sessionId: subject.sessionId,
          strategyDefinitionHashes: subject.strategyDefinitionHashes,
          selected: walkDecision(subject.selected, subject.direction, horizons, series, furthestMinutes),
          controls: subject.controls.map((control) =>
            walkDecision(control, subject.direction, horizons, series, furthestMinutes)),
        };
      });

      /*
       * Both curves, always.
       *
       * Horizon eligibility falls through a session, so the population contributing at +60m is
       * systematically earlier-in-session than the one at +1m. Read alone, an available-case curve can
       * show apparent decay that is purely session composition. Agreement between the two makes the
       * decay reading credible; divergence is a time-of-day finding rather than an error to correct.
       */
      const available = directionalInformationCurve(units, horizons, metric, { replicates });
      const commonEligible = directionalInformationCurve(
        units.filter((item) => isCommonEligible(item.selected)
          && item.controls.every((control) => isCommonEligible(control))),
        horizons, metric, { replicates },
      );
      const verdict = pathStudyVerdict(
        available, declaration.sessionCount, decisionGradeSessionMinimum,
      );

      await repository.recordResult({
        trialKey: declaration.trialKey,
        subjectsExamined: units.length,
        curve: available.rows as unknown[],
        commonEligibleCurve: commonEligible.rows as unknown[],
        verdict,
      });

      reports.push({
        trialKey: declaration.trialKey.slice(0, 12),
        cohort: declaration.cohortKey.slice(0, 12),
        instrument: declaration.instrumentSymbol,
        timeframe: declaration.timeframe,
        direction: declaration.direction,
        sessions: declaration.sessionCount,
        evidenceState: declaration.evidenceState,
        subjects: units.length,
        available: {
          peakHorizonMinutes: available.peakHorizonMinutes,
          halfDecayHorizonMinutes: available.halfDecayHorizonMinutes,
          zeroCrossHorizonMinutes: available.zeroCrossHorizonMinutes,
          rows: available.rows.map((row) => ({
            h: row.horizonMinutes,
            selected: row.selected.meanPerDay,
            controls: row.controls.meanPerDay,
            incremental: row.incremental.meanPerDay,
            ci95: row.incremental.ci95,
            eligibleSubjects: row.eligibility.eligibleSubjects,
            eligibleSessions: row.eligibility.eligibleSessions,
          })),
        },
        commonEligible: {
          peakHorizonMinutes: commonEligible.peakHorizonMinutes,
          rows: commonEligible.rows.map((row) => ({
            h: row.horizonMinutes,
            incremental: row.incremental.meanPerDay,
            eligibleSubjects: row.eligibility.eligibleSubjects,
          })),
        },
        verdict,
      });
    }

    const unfinished = await repository.listUnfinishedTrials(STUDY_KEY);
    console.info(JSON.stringify({
      level: "info",
      message: "Path study complete",
      studyKey: STUDY_KEY,
      studyDefinitionHash: declaredHash,
      codeVersion,
      runKey,
      metric,
      horizonsMinutes: horizons,
      window: { from, through },
      datasetCutoff: through,
      trialsDeclared: declarations.length,
      resultsRecorded: reports.length,
      decisionGradeSessionMinimum,
      degenerateIntervalSessionCeiling,
      /*
       * The multiplicity surface of this run, stated rather than left for the reader to multiply out.
       *
       * Cells times horizons is the number of interval tests examined. Below the degenerate ceiling the
       * per-test false-positive rate is roughly a quarter rather than 2.5%, so this figure is what any
       * apparent hit count has to be read against.
       */
      intervalTestsExamined: declarations.length * horizons.length,
      // Declared but never completed, across every run of this study. Visible by construction: an
      // unfinished trial still counts as a configuration examined.
      unfinishedTrials: unfinished.length,
      unfinished: unfinished.slice(0, 10),
      inference: "TRADING_DAY_BLOCK_BOOTSTRAP — days are the resampling cluster; ci95 is a percentile "
        + "interval on the mean of per-day means.",
      barrierPolicy: "NONE — stops, targets and expiries are absent from the walker's input",
      reports,
    }, null, 2));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
