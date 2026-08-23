import type { DatabaseQueryable } from "../database.js";
import {
  matchingPolicyVersion,
  settlementPolicyVersion,
} from "../../../modules/research/scalp-harness/domain/contracts.js";
import type {
  GateValueUnit,
  PolicyEdgeUnit,
  SignalEdgeUnit,
} from "../../../modules/research/scalp-harness/domain/estimators.js";

/**
 * Assembles the settled rows the Section-4 estimators consume.
 *
 * Read-only and deliberately dumb: it selects and pairs, it never decides what counts as an outcome.
 * The economic gradeability rules (which terminal outcomes yield a null, how a non-triggered native
 * entry is treated) live in the settlement domain, and the exclusion rules live in the estimators —
 * keeping them out of SQL means one definition of "gradeable" rather than one per query.
 *
 * Every query is scoped to the frozen `settlementPolicyVersion`, so rows settled under a different
 * policy can never be silently pooled into one estimate.
 */

/** Terminal outcomes that carry no economic reading; mirrors `canonicalOutcomeR` in the domain. */
const ungradeableOutcomes = "('AMBIGUOUS', 'DATA_INCOMPLETE', 'POLICY_INVALID', 'ENTRY_NOT_TRIGGERED')";

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class PostgresScalpResearchEstimandRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  /**
   * Treated canonical outcomes with their matched control outcomes, one row per opportunity.
   *
   * Only opportunities that actually matched are returned: a common-support failure never produced
   * control matches, so it cannot appear here, and the estimator's exclusion counts stay about
   * gradeability rather than double-counting the matcher's own decision.
   */
  async listSignalEdgeUnits(input: { from: Date; through: Date }): Promise<SignalEdgeUnit[]> {
    const result = await this.database.query<{
      opportunity_id: string;
      session_id: string;
      selected_r: string | null;
      selected_outcome: string;
      strategy_definition_hashes: string[] | null;
      control_rows: Array<{ r: string | null; outcome: string }>;
    }>(`
      SELECT
        opportunity.id AS opportunity_id,
        opportunity.session_id,
        treated.r_multiple AS selected_r,
        treated.outcome AS selected_outcome,
        -- Provenance of the selection rule. An opportunity groups whichever proposals fired at that
        -- decision point, so the definition set is what distinguishes a gated cohort from an ungated
        -- one; the estimators partition on it rather than averaging across both.
        (SELECT array_agg(DISTINCT member_proposal.strategy_definition_hash)
         FROM research_scalp.opportunity_memberships membership
         JOIN research_scalp.proposals member_proposal ON member_proposal.id = membership.proposal_id
         WHERE membership.opportunity_id = opportunity.id) AS strategy_definition_hashes,
        COALESCE(
          (SELECT json_agg(json_build_object('r', control_terminal.r_multiple, 'outcome', control_terminal.outcome)
                           ORDER BY control_point.decision_at)
           FROM research_scalp.control_matches match
           JOIN research_scalp.control_points control_point ON control_point.id = match.control_point_id
           LEFT JOIN research_scalp.terminal_settlements control_terminal
             ON control_terminal.subject_type = 'CONTROL_POINT'
            AND control_terminal.subject_id = control_point.id
            AND control_terminal.settlement_policy_version = $3
           WHERE match.opportunity_id = opportunity.id
             AND match.matching_policy_version = $4),
          '[]'::json
        ) AS control_rows
      FROM research_scalp.opportunities opportunity
      JOIN research_scalp.risk_subjects subject
        ON subject.subject_type = 'CANONICAL_OPPORTUNITY' AND subject.subject_id = opportunity.id
      JOIN research_scalp.terminal_settlements treated
        ON treated.subject_type = 'CANONICAL_OPPORTUNITY' AND treated.subject_id = opportunity.id
       AND treated.settlement_policy_version = $3
      WHERE opportunity.canonical_decision_at >= $1 AND opportunity.canonical_decision_at < $2
        AND EXISTS (SELECT 1 FROM research_scalp.control_matches match
                    WHERE match.opportunity_id = opportunity.id AND match.matching_policy_version = $4)
      ORDER BY opportunity.canonical_decision_at ASC
    `, [input.from, input.through, settlementPolicyVersion, matchingPolicyVersion]);

    return result.rows.map((row) => ({
      opportunityId: row.opportunity_id,
      sessionId: row.session_id,
      strategyDefinitionHashes: row.strategy_definition_hashes ?? [],
      selectedOutcomeR: gradeable(row.selected_outcome) ? numberOrNull(row.selected_r) : null,
      controlOutcomesR: (row.control_rows ?? []).map((control) =>
        gradeable(control.outcome) ? numberOrNull(control.r) : null),
    }));
  }

  /** Native-proposal outcomes paired with the canonical outcome of the opportunity they belong to. */
  async listPolicyEdgeUnits(input: { from: Date; through: Date }): Promise<PolicyEdgeUnit[]> {
    const result = await this.database.query<{
      subject_id: string; session_id: string; strategy_definition_hash: string;
      native_r: string | null; native_outcome: string;
      canonical_r: string | null; canonical_outcome: string;
    }>(`
      SELECT
        proposal.id AS subject_id,
        opportunity.session_id,
        proposal.strategy_definition_hash,
        native.r_multiple AS native_r, native.outcome AS native_outcome,
        canonical.r_multiple AS canonical_r, canonical.outcome AS canonical_outcome
      FROM research_scalp.opportunity_memberships membership
      JOIN research_scalp.proposals proposal ON proposal.id = membership.proposal_id
      JOIN research_scalp.opportunities opportunity ON opportunity.id = membership.opportunity_id
      JOIN research_scalp.terminal_settlements native
        ON native.subject_type = 'NATIVE_PROPOSAL' AND native.subject_id = proposal.id
       AND native.settlement_policy_version = $3
      JOIN research_scalp.terminal_settlements canonical
        ON canonical.subject_type = 'CANONICAL_OPPORTUNITY' AND canonical.subject_id = opportunity.id
       AND canonical.settlement_policy_version = $3
      WHERE opportunity.canonical_decision_at >= $1 AND opportunity.canonical_decision_at < $2
      ORDER BY opportunity.canonical_decision_at ASC
    `, [input.from, input.through, settlementPolicyVersion]);

    return result.rows.map((row) => ({
      subjectId: row.subject_id,
      sessionId: row.session_id,
      strategyDefinitionHashes: [row.strategy_definition_hash],
      // INTENT_TO_TRADE: a native order that never triggered is a real zero-return decision, not a
      // missing observation. The canonical side has no entry condition, so it is graded normally.
      nativeOutcomeR: row.native_outcome === "ENTRY_NOT_TRIGGERED"
        ? 0
        : gradeable(row.native_outcome) ? numberOrNull(row.native_r) : null,
      canonicalOutcomeR: gradeable(row.canonical_outcome) ? numberOrNull(row.canonical_r) : null,
    }));
  }

  /** Settled outcomes tagged with the observational ALLOW/REJECT verdict recorded at decision time. */
  async listGateValueUnits(input: { from: Date; through: Date }): Promise<GateValueUnit[]> {
    const result = await this.database.query<{
      subject_id: string; session_id: string; r_multiple: string | null; outcome: string; decision: string;
      strategy_definition_hashes: string[] | null;
    }>(`
      SELECT
        subject.subject_id,
        -- A risk subject is either a canonical opportunity or a single native proposal, so provenance
        -- comes from whichever side it is; without it an ALLOW/REJECT split could straddle cohorts.
        COALESCE(
          (SELECT array_agg(DISTINCT member_proposal.strategy_definition_hash)
           FROM research_scalp.opportunity_memberships membership
           JOIN research_scalp.proposals member_proposal ON member_proposal.id = membership.proposal_id
           WHERE subject.subject_type = 'CANONICAL_OPPORTUNITY'
             AND membership.opportunity_id = subject.subject_id),
          (SELECT ARRAY[native_proposal.strategy_definition_hash]
           FROM research_scalp.proposals native_proposal
           WHERE subject.subject_type = 'NATIVE_PROPOSAL' AND native_proposal.id = subject.subject_id)
        ) AS strategy_definition_hashes,
        COALESCE(opportunity.session_id, to_char(subject.decision_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD'))
          AS session_id,
        terminal.r_multiple, terminal.outcome,
        -- The recorded verdict is the boolean "approved", not a decision string. Reading a
        -- nonexistent decision field matched zero rows and made Gate Value report "no data"
        -- against thousands of real decisions -- a silent empty result rather than an error.
        CASE WHEN (decision.decision->>'approved')::boolean THEN 'ALLOW' ELSE 'REJECT' END AS decision
      FROM research_scalp.risk_decisions decision
      JOIN research_scalp.risk_subjects subject ON subject.id = decision.risk_subject_id
      JOIN research_scalp.terminal_settlements terminal
        ON terminal.subject_type = subject.subject_type AND terminal.subject_id = subject.subject_id
       AND terminal.settlement_policy_version = $3
      LEFT JOIN research_scalp.opportunities opportunity
        ON subject.subject_type = 'CANONICAL_OPPORTUNITY' AND opportunity.id = subject.subject_id
      WHERE subject.decision_at >= $1 AND subject.decision_at < $2
        AND decision.decision->>'approved' IS NOT NULL
      ORDER BY subject.decision_at ASC
    `, [input.from, input.through, settlementPolicyVersion]);

    return result.rows.map((row) => ({
      subjectId: row.subject_id,
      sessionId: row.session_id,
      strategyDefinitionHashes: row.strategy_definition_hashes ?? [],
      outcomeR: gradeable(row.outcome) ? numberOrNull(row.r_multiple) : null,
      decision: row.decision === "ALLOW" ? "ALLOW" as const : "REJECT" as const,
    }));
  }
}

/** Mirrors the domain's gradeability rule so SQL and estimator never disagree about a null. */
function gradeable(outcome: string | null): boolean {
  return outcome !== null && !ungradeableOutcomes.includes(`'${outcome}'`);
}
