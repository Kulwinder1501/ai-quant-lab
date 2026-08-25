import type { DatabasePool, DatabaseQueryable } from "../database.js";
import { matchingPolicyVersion } from "../../../modules/research/scalp-harness/domain/contracts.js";
import { sha256Canonical } from "../../../modules/research/scalp-harness/domain/identity.js";

/**
 * Reads the subjects a path study walks, and writes its two-phase execution ledger.
 *
 * The write half is the part with a rule attached. A trial is *declared* before anything is computed and
 * its result is a separate row written afterwards, because `research_scalp` forbids UPDATE and so a
 * mutable status column is impossible. That constraint produces the property the design wants: a trial
 * with no result is a visible record of an execution that did not finish, where a compute-then-log
 * design would leave an examined configuration with no record at all.
 */

/** One 1m bar, in the shape the barrier-free walker consumes. */
export interface PathStudyBar {
  readonly openTime: Date;
  readonly closeTime: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export interface PathStudyDecision {
  readonly decisionAt: Date;
  readonly sessionCloseAt: Date;
  readonly referencePrice: number;
  readonly atr: number | null;
}

export interface PathStudySubject {
  readonly opportunityId: string;
  readonly sessionId: string;
  readonly instrumentId: string;
  readonly instrumentSymbol: string;
  readonly direction: "LONG" | "SHORT";
  /** Definition hashes of every proposal in the opportunity, order-independent. */
  readonly strategyDefinitionHashes: readonly string[];
  /** Timeframes those proposals fired on, joined — part of the grouping cell. */
  readonly timeframeKey: string;
  readonly selected: PathStudyDecision;
  readonly controls: readonly PathStudyDecision[];
}

export interface TrialDeclaration {
  readonly trialKey: string;
  readonly runKey: string;
  readonly studyKey: string;
  readonly studyDefinitionHash: string;
  readonly codeVersion: string;
  readonly cohortKey: string;
  readonly instrumentSymbol: string;
  readonly timeframe: string;
  readonly direction: "LONG" | "SHORT";
  readonly parameterFamily: string;
  readonly parameterValues: Readonly<Record<string, unknown>>;
  readonly datasetCutoff: Date;
  readonly sessionRangeStart: string;
  readonly sessionRangeEnd: string;
  readonly sessionCount: number;
  readonly evidenceState: string;
  readonly subjectsDeclared: number;
}

export interface TrialResult {
  readonly trialKey: string;
  readonly subjectsExamined: number;
  readonly curve: unknown[];
  readonly commonEligibleCurve: unknown[];
  readonly verdict: string;
}

const atrSubquery = (candleColumn: string): string => `
  (SELECT snapshot.values->>'value'
   FROM indicator_snapshots snapshot
   INNER JOIN indicator_definitions definition ON definition.id = snapshot.indicator_definition_id
   WHERE snapshot.candle_id = ${candleColumn}
     AND definition.indicator_code = 'ATR'
     AND definition.algorithm_version = 'ta-v1'
     AND definition.parameters->>'period' = '14'
     AND definition.parameters->>'smoothing' = 'WILDER'
   ORDER BY definition.parameters_hash ASC LIMIT 1)`;

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class PostgresPathStudyRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  /**
   * The study's registration as stored, so the runner can refuse a definition the code has since
   * changed.
   *
   * The stored row is the authority: it is what was predeclared, and a code-side edit is a new study
   * rather than a correction to this one.
   */
  async findRegisteredStudy(studyKey: string): Promise<{ studyDefinitionHash: string } | null> {
    const result = await this.database.query<{ study_definition_hash: string }>(
      "SELECT study_definition_hash FROM research_scalp.study_registrations WHERE study_key = $1",
      [studyKey],
    );
    const row = result.rows[0];
    return row ? { studyDefinitionHash: row.study_definition_hash } : null;
  }

  /**
   * Every matched opportunity in the window, with its matched controls.
   *
   * Only opportunities that achieved full common support appear: a control set that never matched
   * cannot form a contrast, and including a partly matched one would measure it against a smaller
   * baseline than its peers. Control points are ordered deterministically so two runs over identical
   * rows assemble identical units.
   */
  async listSubjects(input: { from: Date; through: Date }): Promise<PathStudySubject[]> {
    const result = await this.database.query<{
      opportunity_id: string; session_id: string; instrument_id: string; instrument_symbol: string;
      direction: "LONG" | "SHORT"; strategy_definition_hashes: string[] | null;
      timeframes: string[] | null;
      decision_at: Date; session_close_at: Date; reference_price: string; atr: string | null;
      controls: Array<{
        decisionAt: string; sessionCloseAt: string; referencePrice: string; atr: string | null;
      }> | null;
    }>(`
      SELECT
        opportunity.id AS opportunity_id,
        opportunity.session_id,
        opportunity.instrument_id,
        instrument.symbol AS instrument_symbol,
        opportunity.direction,
        opportunity.canonical_decision_at AS decision_at,
        opportunity.session_close_at,
        opportunity.reference_price,
        ${atrSubquery("opportunity.reference_candle_id")} AS atr,
        (SELECT array_agg(DISTINCT member.strategy_definition_hash)
         FROM research_scalp.opportunity_memberships membership
         JOIN research_scalp.proposals member ON member.id = membership.proposal_id
         WHERE membership.opportunity_id = opportunity.id) AS strategy_definition_hashes,
        (SELECT array_agg(DISTINCT member.timeframe)
         FROM research_scalp.opportunity_memberships membership
         JOIN research_scalp.proposals member ON member.id = membership.proposal_id
         WHERE membership.opportunity_id = opportunity.id) AS timeframes,
        (SELECT json_agg(json_build_object(
                  'decisionAt', control_point.decision_at,
                  'sessionCloseAt', control_point.session_close_at,
                  'referencePrice', control_point.reference_price,
                  'atr', ${atrSubquery("control_point.source_candle_id")}
                ) ORDER BY control_point.decision_at, control_point.id)
         FROM research_scalp.control_matches match
         JOIN research_scalp.control_points control_point ON control_point.id = match.control_point_id
         WHERE match.opportunity_id = opportunity.id
           AND match.matching_policy_version = $3) AS controls
      FROM research_scalp.opportunities opportunity
      JOIN instruments instrument ON instrument.id = opportunity.instrument_id
      WHERE opportunity.canonical_decision_at >= $1 AND opportunity.canonical_decision_at < $2
        AND EXISTS (SELECT 1 FROM research_scalp.control_matches match
                    WHERE match.opportunity_id = opportunity.id
                      AND match.matching_policy_version = $3)
      ORDER BY opportunity.canonical_decision_at ASC, opportunity.id ASC
    `, [input.from, input.through, matchingPolicyVersion]);

    return result.rows.map((row) => ({
      opportunityId: row.opportunity_id,
      sessionId: row.session_id,
      instrumentId: row.instrument_id,
      instrumentSymbol: row.instrument_symbol,
      direction: row.direction,
      strategyDefinitionHashes: row.strategy_definition_hashes ?? [],
      timeframeKey: [...new Set(row.timeframes ?? [])].sort().join("+") || "UNKNOWN",
      selected: {
        decisionAt: row.decision_at,
        sessionCloseAt: row.session_close_at,
        referencePrice: Number(row.reference_price),
        atr: numberOrNull(row.atr),
      },
      controls: (row.controls ?? []).map((control) => ({
        decisionAt: new Date(control.decisionAt),
        sessionCloseAt: new Date(control.sessionCloseAt),
        referencePrice: Number(control.referencePrice),
        atr: numberOrNull(control.atr),
      })),
    }));
  }

  /**
   * Every complete 1m bar for one instrument across the window, loaded once.
   *
   * Per-subject candle queries would mean thousands of round trips for a single session; the walker
   * slices this series in memory instead. The window must already include the furthest horizon past the
   * last decision, which is the caller's responsibility.
   */
  async listOneMinuteSeries(input: {
    instrumentId: string; from: Date; through: Date;
  }): Promise<PathStudyBar[]> {
    const result = await this.database.query<{
      open_time: Date; close_time: Date; open: string; high: string; low: string; close: string;
    }>(`
      SELECT open_time, close_time, open, high, low, close
      FROM candles
      WHERE instrument_id = $1 AND timeframe = '1m' AND is_complete = TRUE
        AND close_time > $2 AND close_time <= $3
      ORDER BY close_time ASC
    `, [input.instrumentId, input.from, input.through]);

    return result.rows.map((row) => ({
      openTime: row.open_time,
      closeTime: row.close_time,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
    }));
  }

  /**
   * Declares every cell of a run in one transaction, before any of them is computed.
   *
   * All-or-nothing on purpose. A partial declaration would leave some cells accountable and others not,
   * and the runner would have no way to tell which — so a failure here must stop the run rather than
   * degrade it. The caller treats a throw as fatal.
   */
  async declareTrials(pool: DatabasePool, declarations: readonly TrialDeclaration[]): Promise<void> {
    if (declarations.length === 0) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const declaration of declarations) {
        await client.query(`
          INSERT INTO research_scalp.study_trials (
            trial_key, run_key, study_key, study_definition_hash, code_version, cohort_key,
            instrument_symbol, timeframe, direction, parameter_family, parameter_values,
            dataset_cutoff, session_range_start, session_range_end, session_count, evidence_state,
            subjects_declared
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17)
          ON CONFLICT (trial_key) DO NOTHING
        `, [
          declaration.trialKey, declaration.runKey, declaration.studyKey,
          declaration.studyDefinitionHash, declaration.codeVersion, declaration.cohortKey,
          declaration.instrumentSymbol, declaration.timeframe, declaration.direction,
          declaration.parameterFamily, JSON.stringify(declaration.parameterValues),
          declaration.datasetCutoff, declaration.sessionRangeStart, declaration.sessionRangeEnd,
          declaration.sessionCount, declaration.evidenceState, declaration.subjectsDeclared,
        ]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Writes one trial's result. A trial whose result never arrives stays visible as unfinished. */
  async recordResult(result: TrialResult): Promise<void> {
    const payloadHash = sha256Canonical({
      trialKey: result.trialKey,
      subjectsExamined: result.subjectsExamined,
      curve: result.curve,
      commonEligibleCurve: result.commonEligibleCurve,
      verdict: result.verdict,
    });
    await this.database.query(`
      INSERT INTO research_scalp.study_trial_results (
        result_key, trial_key, payload_hash, subjects_examined, curve, common_eligible_curve, verdict
      ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)
      ON CONFLICT (trial_key) DO NOTHING
    `, [
      sha256Canonical({ namespace: "study-trial-result", trialKey: result.trialKey }),
      result.trialKey,
      payloadHash,
      result.subjectsExamined,
      JSON.stringify(result.curve),
      JSON.stringify(result.commonEligibleCurve),
      result.verdict,
    ]);
  }

  /**
   * Trials with no result row — executions that were declared and did not finish.
   *
   * Reported at the end of every run, because the point of declaring first is that this set is
   * observable. An unfinished trial still counts as a configuration examined.
   */
  async listUnfinishedTrials(studyKey: string): Promise<Array<{ trialKey: string; runKey: string; declaredAt: Date }>> {
    const result = await this.database.query<{ trial_key: string; run_key: string; declared_at: Date }>(`
      SELECT trial.trial_key, trial.run_key, trial.declared_at
      FROM research_scalp.study_trials trial
      LEFT JOIN research_scalp.study_trial_results result ON result.trial_key = trial.trial_key
      WHERE trial.study_key = $1 AND result.trial_key IS NULL
      ORDER BY trial.declared_at ASC
    `, [studyKey]);
    return result.rows.map((row) => ({
      trialKey: row.trial_key, runKey: row.run_key, declaredAt: row.declared_at,
    }));
  }
}
