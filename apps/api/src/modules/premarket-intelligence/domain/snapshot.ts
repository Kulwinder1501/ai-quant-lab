import { classifyReturn, TARGET_THRESHOLD_PCT, PREMARKET_INSTRUMENTS, type MeasuredOutcome, type PremarketInstrument, type PremarketTarget } from "./targets.js";

export type EvidenceCategory = "GIFT_NIFTY" | "ASIAN_INDEX" | "GLOBAL_CUE" | "NSE_PREOPEN";

/** One numeric fact the model may cite. The model sees only these; it has no other market data. */
export interface EvidenceItem {
  id: string;
  category: EvidenceCategory;
  label: string;
  value: number | null;
  unit: "PERCENT_CHANGE" | "PRICE";
  /** When the source says the value was observed; null when it publishes no timestamp. */
  observedAt: string | null;
  source: string;
}

export type LevelRole = "SUPPORT" | "RESISTANCE";

/** A price level computed by the system from stored bars. The model selects among these; it never invents one. */
export interface CandidateLevel {
  id: string;
  instrument: PremarketInstrument;
  label: string;
  price: number;
}

export interface MarketSnapshot {
  sessionDate: string;
  runSlot: string;
  capturedAt: string;
  evidence: EvidenceItem[];
  candidateLevels: CandidateLevel[];
}

export type BaselineName = "GIFT_THRESHOLD" | "FOLLOW_GAP" | "ALWAYS_FLAT";

/** baselines[instrument][target][baselineName] -> predicted outcome, or null when it cannot predict. */
export type DeterministicBaselines = Record<
  PremarketInstrument,
  Record<PremarketTarget, Partial<Record<BaselineName, MeasuredOutcome | null>>>
>;

export function evidenceId(index: number): string {
  return `market-evidence-${String(index + 1).padStart(3, "0")}`;
}

/**
 * The deterministic benchmark the model must beat -- computed from the snapshot alone, so it is
 * available even when the LLM is not.
 *
 * - OPENING_GAP: GIFT Nifty's own change against the target's threshold.
 * - FIRST_60_MINUTES / FULL_SESSION: `FOLLOW_GAP` repeats the gap call on the gap thresholds, and
 *   `ALWAYS_FLAT` never calls a move. The model is pre-registered to need to beat BOTH; judging it
 *   only against the weaker one would let a coin-flip look like skill.
 */
export function buildDeterministicBaselines(giftChangePct: number | null): DeterministicBaselines {
  const result = {} as DeterministicBaselines;
  for (const instrument of PREMARKET_INSTRUMENTS) {
    const gap = giftChangePct === null
      ? null
      : classifyReturn(giftChangePct, TARGET_THRESHOLD_PCT.OPENING_GAP[instrument]);
    result[instrument] = {
      OPENING_GAP: { GIFT_THRESHOLD: gap },
      FIRST_60_MINUTES: { FOLLOW_GAP: gap, ALWAYS_FLAT: "FLAT" },
      FULL_SESSION: { FOLLOW_GAP: gap, ALWAYS_FLAT: "FLAT" },
    };
  }
  return result;
}

/** A snapshot with no GIFT Nifty reading is not enough to assess anything: it is the plan's primary driver. */
export function snapshotHasPrimaryDriver(snapshot: MarketSnapshot): boolean {
  return snapshot.evidence.some((item) => item.category === "GIFT_NIFTY" && item.unit === "PERCENT_CHANGE" && item.value !== null);
}

export function giftChangeFrom(snapshot: MarketSnapshot): number | null {
  const item = snapshot.evidence.find((e) => e.category === "GIFT_NIFTY" && e.unit === "PERCENT_CHANGE" && e.value !== null);
  return item?.value ?? null;
}
