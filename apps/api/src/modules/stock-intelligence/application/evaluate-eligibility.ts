import { DEFAULT_FUNDAMENTAL_COMPLETENESS_MIN, fundamentalCompleteness, isStaleData, type StaleDataThresholds, type StockIntelligenceHorizon } from "../domain/data-quality.js";
import type { StockIntelligenceStore } from "../domain/store.js";
import { isEligibleAt, type EligibilityDecision, type StockIntelligenceUniverse } from "../domain/universe.js";

export class EvaluateInstrumentEligibility {
  constructor(private readonly store: StockIntelligenceStore) {}

  async execute(input: {
    instrumentId: string;
    asOf: Date;
    universe?: StockIntelligenceUniverse;
  }): Promise<EligibilityDecision> {
    const [memberships, existence] = await Promise.all([
      this.store.listMemberships(input.instrumentId),
      this.store.findExistenceAsOf(input.instrumentId, input.asOf),
    ]);
    return isEligibleAt({
      asOf: input.asOf,
      memberships,
      existence,
      universe: input.universe,
    });
  }
}

export class ScoreFundamentalCompleteness {
  constructor(private readonly store: StockIntelligenceStore) {}

  async execute(instrumentId: string, asOf: Date): Promise<number> {
    const snapshots = await this.store.listFundamentalsAsOf(instrumentId, asOf);
    return fundamentalCompleteness(
      asOf,
      snapshots.map((snapshot) => ({ field: snapshot.field, availableAt: snapshot.availableAt })),
    );
  }
}

export function investorFacingBlockedReason(input: {
  eligibility: EligibilityDecision;
  fundamentalCompleteness: number;
  marketDataAgeDays: number;
  horizon: StockIntelligenceHorizon;
  staleThresholds: StaleDataThresholds;
  completenessFloor?: number;
}): "INSUFFICIENT_DATA" | "STALE_DATA" | null {
  if (!input.eligibility.eligible) return "INSUFFICIENT_DATA";
  const floor = input.completenessFloor ?? DEFAULT_FUNDAMENTAL_COMPLETENESS_MIN;
  if (input.fundamentalCompleteness < floor) return "INSUFFICIENT_DATA";
  if (isStaleData(input.marketDataAgeDays, input.horizon, input.staleThresholds)) return "STALE_DATA";
  return null;
}
