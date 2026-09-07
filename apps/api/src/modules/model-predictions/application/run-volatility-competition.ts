import {
  DEFAULT_VOLATILITY_COMPETITION_RULES,
  computeVolatilitySettledMetrics,
  decideVolatilityCompetition,
  type VolatilityCompetitionDecision,
  type VolatilityCompetitionRules,
  type VolatilityConfusionCell,
  type VolatilityRole,
  type VolatilityStanding,
} from "../domain/volatility-competition.js";

/**
 * Ranks volatility models on settled live outcomes and assigns roles.
 *
 * Every input is a settled outcome. Nothing here reads a training or holdout score, which
 * is what makes this the gate Phase 25's invariant 9 asks for: a model that trained well
 * has earned a place in this ranking and nothing more.
 */

export interface VolatilityCandidate {
  modelVersionId: string;
  modelKey: string;
  role: VolatilityRole | null;
  /** Settled confusion counts inside the rolling window. */
  cells: VolatilityConfusionCell[];
  scoredDays: number;
  lastScoredDate: string | null;
}

export interface VolatilityRoleAssignment {
  modelVersionId: string;
  role: VolatilityRole;
  becamePrimary: boolean;
  reason: string;
}

export interface VolatilityCompetitionRepository {
  /**
   * Every volatility model with its current role and its settled confusion counts over
   * the rolling window.
   */
  listCandidates(rollingWindowDays: number): Promise<VolatilityCandidate[]>;
  /** Replaces all role rows for the scheme atomically. */
  applyRoles(input: {
    labelScheme: string;
    assignments: VolatilityRoleAssignment[];
    decisionReason: string;
  }): Promise<void>;
}

export interface RunVolatilityCompetitionResult {
  candidatesExamined: number;
  qualifying: number;
  excludedForSample: number;
  excludedBelowTrivial: number;
  decision: VolatilityCompetitionDecision["reason"];
  primaryModelKey: string | null;
  challengerModelKey: string | null;
  explanation: string;
}

const VOLATILITY_SCHEME = "volatility-expansion-v1";
const ROLLING_WINDOW_DAYS = 30;

export class RunVolatilityCompetition {
  constructor(
    private readonly repository: VolatilityCompetitionRepository,
    private readonly rules: VolatilityCompetitionRules = DEFAULT_VOLATILITY_COMPETITION_RULES,
    private readonly today: () => string = () => new Date().toISOString().slice(0, 10),
  ) {}

  async execute(): Promise<RunVolatilityCompetitionResult> {
    const candidates = await this.repository.listCandidates(ROLLING_WINDOW_DAYS);
    const standings: VolatilityStanding[] = candidates.map((candidate) => ({
      modelVersionId: candidate.modelVersionId,
      modelKey: candidate.modelKey,
      role: candidate.role,
      metrics: computeVolatilitySettledMetrics(candidate.cells),
      scoredDays: candidate.scoredDays,
      lastScoredDate: candidate.lastScoredDate,
    }));

    const decision = decideVolatilityCompetition({
      standings,
      asOfDate: this.today(),
      rules: this.rules,
    });

    const keyById = new Map(standings.map((standing) => [standing.modelVersionId, standing.modelKey]));
    const assignments: VolatilityRoleAssignment[] = [];
    if (decision.primaryModelVersionId !== null) {
      const wasPrimary = standings.some(
        (standing) => standing.modelVersionId === decision.primaryModelVersionId && standing.role === "PRIMARY",
      );
      assignments.push({
        modelVersionId: decision.primaryModelVersionId,
        role: "PRIMARY",
        becamePrimary: !wasPrimary,
        reason: decision.reason,
      });
    }
    if (
      decision.challengerModelVersionId !== null
      && decision.challengerModelVersionId !== decision.primaryModelVersionId
    ) {
      assignments.push({
        modelVersionId: decision.challengerModelVersionId,
        role: "CHALLENGER",
        becamePrimary: false,
        reason: decision.reason,
      });
    }

    // Written even when the assignment list is empty: a quarantine that vacates the
    // PRIMARY must actually clear the row, or a demoted model keeps its authority.
    await this.repository.applyRoles({
      labelScheme: VOLATILITY_SCHEME,
      assignments,
      decisionReason: decision.reason,
    });

    return {
      candidatesExamined: candidates.length,
      qualifying: decision.ranking.length,
      excludedForSample: decision.excludedForSample,
      excludedBelowTrivial: decision.excludedBelowTrivial,
      decision: decision.reason,
      primaryModelKey: decision.primaryModelVersionId === null
        ? null
        : keyById.get(decision.primaryModelVersionId) ?? null,
      challengerModelKey: decision.challengerModelVersionId === null
        ? null
        : keyById.get(decision.challengerModelVersionId) ?? null,
      explanation: decision.explanation,
    };
  }
}
