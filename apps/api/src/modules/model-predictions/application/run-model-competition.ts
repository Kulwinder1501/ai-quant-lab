import {
  computeSettledMetrics,
  decideCompetition,
  DEFAULT_COMPETITION_RULES,
  type CompetitionRules,
  type ConfusionCell,
  type PoolMemberStanding,
  type PromotionDecision,
  type RoleAssignment,
} from "../domain/model-competition.js";

export interface CompetitionPoolRow {
  modelVersionId: string;
  competitionGroup: string;
  role: "PRIMARY" | "SECONDARY" | "COMPETITOR";
}

export interface ModelCompetitionRepository {
  /** PRODUCTION models whose key has no competition state yet (bootstrap as PRIMARY). */
  listUnenrolledProductionModels(): Promise<Array<{ modelVersionId: string; modelKey: string }>>;
  /**
   * Model keys with recent qualifying CANDIDATEs but no competition group and
   * no PRODUCTION version — families that must form a group without a champion
   * and earn their first PRIMARY on live evidence.
   */
  listGrouplessCandidateModelKeys(input: {
    trainedAfter: Date;
    minimumHoldoutMacroF1: number;
  }): Promise<string[]>;
  enrollMember(modelVersionId: string, competitionGroup: string, role: "PRIMARY" | "COMPETITOR"): Promise<void>;
  /**
   * Un-enroll COMPETITORs that produced no settled evidence for the whole
   * enrollment lookback (for example, artifacts on a stale feature schema that
   * fail every inference). Leaving the pool also lifts their prune protection.
   * Eviction uses the same age boundary as enrollment eligibility, so an
   * evicted model is never immediately re-enrolled.
   */
  removeStaleUnscoredMembers(input: { enrolledBefore: Date }): Promise<number>;
  listPool(): Promise<CompetitionPoolRow[]>;
  /**
   * Recent CANDIDATE versions of this key, not yet enrolled, whose holdout
   * macro-F1 clears the entry floor — newest first.
   */
  listEnrollableCandidates(input: {
    competitionGroup: string;
    trainedAfter: Date;
    minimumHoldoutMacroF1: number;
    limit: number;
  }): Promise<string[]>;
  /** Most recent IST dates with settled scores for any pool member, newest first. */
  listScoredDates(modelVersionIds: string[], limit: number): Promise<string[]>;
  /** Confusion counts of settled predictions per model over the given dates. */
  settledConfusionForDates(modelVersionId: string, scoreDates: string[]): Promise<ConfusionCell[]>;
  /** Per-day macro F1 from model_daily_scores for the given models and dates. */
  listDailyMacroF1(modelVersionIds: string[], scoreDates: string[]): Promise<
    Array<{ modelVersionId: string; scoreDate: string; macroF1: number | null }>
  >;
  /**
   * Atomically persist role assignments (and, on promotion, swap PRODUCTION /
   * CANDIDATE stages and append the model_promotions audit row).
   */
  applyDecision(input: {
    competitionGroup: string;
    assignments: RoleAssignment[];
    promotion: PromotionDecision | null;
  }): Promise<void>;
}

export interface RunModelCompetitionOptions {
  rules?: CompetitionRules;
  /** Holdout macro-F1 floor a fresh candidate must clear to enter the pool. */
  entryFloorMacroF1?: number;
  /** How far back to look for enrollable candidates. */
  enrollmentLookbackDays?: number;
  /** Maximum pool size per competition group. */
  maximumPoolSize?: number;
}

export interface GroupCompetitionSummary {
  competitionGroup: string;
  poolSize: number;
  enrolled: string[];
  primaryId: string | null;
  secondaryId: string | null;
  promotion: PromotionDecision | null;
  headToHead: { challengerId: string; winsInWindow: number; comparedDays: number } | null;
}

export interface RunModelCompetitionResult {
  groupsEvaluated: number;
  bootstrappedPrimaries: number;
  competitorsEnrolled: number;
  staleMembersRemoved: number;
  promotions: number;
  groups: GroupCompetitionSummary[];
}

const DEFAULT_ENTRY_FLOOR_MACRO_F1 = 0.38;
const DEFAULT_ENROLLMENT_LOOKBACK_DAYS = 14;
const DEFAULT_MAXIMUM_POOL_SIZE = 8;

/**
 * The daily competition: enroll fresh qualifying candidates, score every pool
 * member on its rolling settled record, and let the champion–challenger rules
 * decide roles. Training-time holdout is only the entry gate; the title is won
 * on live outcomes.
 */
export class RunModelCompetition {
  constructor(private readonly repository: ModelCompetitionRepository) {}

  async execute(options: RunModelCompetitionOptions = {}): Promise<RunModelCompetitionResult> {
    const rules = options.rules ?? DEFAULT_COMPETITION_RULES;
    const entryFloor = options.entryFloorMacroF1 ?? DEFAULT_ENTRY_FLOOR_MACRO_F1;
    const lookbackDays = options.enrollmentLookbackDays ?? DEFAULT_ENROLLMENT_LOOKBACK_DAYS;
    const maximumPoolSize = options.maximumPoolSize ?? DEFAULT_MAXIMUM_POOL_SIZE;

    let bootstrappedPrimaries = 0;
    let competitorsEnrolled = 0;
    for (const production of await this.repository.listUnenrolledProductionModels()) {
      await this.repository.enrollMember(production.modelVersionId, production.modelKey, "PRIMARY");
      bootstrappedPrimaries += 1;
    }

    const trainedAfter = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

    const staleMembersRemoved = await this.repository.removeStaleUnscoredMembers({
      enrolledBefore: trainedAfter,
    });

    // Families that only ever produced CANDIDATEs (nothing was hand-promoted)
    // still deserve a competition: they start without a champion and the best
    // live record wins the first crown.
    const grouplessKeys = await this.repository.listGrouplessCandidateModelKeys({
      trainedAfter,
      minimumHoldoutMacroF1: entryFloor,
    });
    for (const modelKey of grouplessKeys) {
      const candidates = await this.repository.listEnrollableCandidates({
        competitionGroup: modelKey,
        trainedAfter,
        minimumHoldoutMacroF1: entryFloor,
        limit: maximumPoolSize,
      });
      for (const candidateId of candidates) {
        await this.repository.enrollMember(candidateId, modelKey, "COMPETITOR");
        competitorsEnrolled += 1;
      }
    }

    const pool = await this.repository.listPool();
    const groups = new Map<string, CompetitionPoolRow[]>();
    for (const row of pool) {
      const members = groups.get(row.competitionGroup) ?? [];
      members.push(row);
      groups.set(row.competitionGroup, members);
    }

    let promotions = 0;
    const summaries: GroupCompetitionSummary[] = [];

    for (const [competitionGroup, members] of groups) {
      const openSlots = maximumPoolSize - members.length;
      const enrolled: string[] = [];
      if (openSlots > 0) {
        const candidates = await this.repository.listEnrollableCandidates({
          competitionGroup,
          trainedAfter,
          minimumHoldoutMacroF1: entryFloor,
          limit: openSlots,
        });
        for (const candidateId of candidates) {
          await this.repository.enrollMember(candidateId, competitionGroup, "COMPETITOR");
          members.push({ modelVersionId: candidateId, competitionGroup, role: "COMPETITOR" });
          enrolled.push(candidateId);
          competitorsEnrolled += 1;
        }
      }

      const memberIds = members.map((member) => member.modelVersionId);
      const windowDates = await this.repository.listScoredDates(memberIds, rules.rollingWindowDays);
      const dailyRows = windowDates.length === 0
        ? []
        : await this.repository.listDailyMacroF1(memberIds, windowDates);
      const dailyByModel = new Map<string, Record<string, number>>();
      for (const row of dailyRows) {
        if (row.macroF1 === null) continue;
        const byDate = dailyByModel.get(row.modelVersionId) ?? {};
        byDate[row.scoreDate] = row.macroF1;
        dailyByModel.set(row.modelVersionId, byDate);
      }

      const standings: PoolMemberStanding[] = [];
      for (const member of members) {
        const cells = windowDates.length === 0
          ? []
          : await this.repository.settledConfusionForDates(member.modelVersionId, windowDates);
        standings.push({
          modelVersionId: member.modelVersionId,
          role: member.role,
          rolling: computeSettledMetrics(cells),
          dailyMacroF1: dailyByModel.get(member.modelVersionId) ?? {},
        });
      }

      const decision = decideCompetition(standings, rules);
      await this.repository.applyDecision({
        competitionGroup,
        assignments: decision.assignments,
        promotion: decision.promotion,
      });
      if (decision.promotion) promotions += 1;

      summaries.push({
        competitionGroup,
        poolSize: members.length,
        enrolled,
        primaryId: decision.assignments.find((entry) => entry.role === "PRIMARY")?.modelVersionId ?? null,
        secondaryId: decision.assignments.find((entry) => entry.role === "SECONDARY")?.modelVersionId ?? null,
        promotion: decision.promotion,
        headToHead: decision.headToHead,
      });
    }

    return {
      groupsEvaluated: groups.size,
      bootstrappedPrimaries,
      competitorsEnrolled,
      staleMembersRemoved,
      promotions,
      groups: summaries,
    };
  }
}
