import type { PaperTradeHistoryRecord, ListPaperTradeHistoryInput } from "./paper-trade-history.js";

/**
 * The measured "why" for a closed trade, when one has been computed.
 *
 * A subset of `TradeReview` (`trade-review.ts`): `tradeId`/`exitReason`/`realizedPnl`/
 * `riskPerUnit` are dropped because they duplicate fields already on `JournalTradeRecord` itself,
 * and carrying them twice invites the two copies to disagree.
 */
export interface JournalTradeReview {
  outcome: "WIN" | "LOSS" | "BREAKEVEN";
  realizedR: number;
  maximumAdverseExcursionR: number | null;
  maximumFavourableExcursionR: number | null;
  candlesObserved: number;
  observedTimeframe: string | null;
  /** Human-readable statements derived from the measured numbers. No inferred causation. */
  observations: string[];
  /** Short machine tags for aggregation (e.g. `GAVE_BACK_FAVOURABLE_MOVE`). */
  proposedResearchTags: string[];
}

/**
 * One Journal row: a closed-or-open trade plus the thesis it was opened under and, once
 * reviewed, the measured account of how it actually played out.
 */
export interface JournalTradeRecord extends PaperTradeHistoryRecord {
  /** The strategy's own stated reasoning at signal time (`trade_ideas.reasoning`). */
  reasoning: string[];
  /** `trade_ideas.evidence->>'strategy'`, the strategy label strategies write at signal time. */
  evidenceStrategy: string | null;
  /** Null until `trade_reviews` has a row for this trade (written when AI_AGENT_TICK reviews a close). */
  review: JournalTradeReview | null;
}

export interface JournalQueryRepository {
  list(input: ListPaperTradeHistoryInput): Promise<JournalTradeRecord[]>;
  listAccountNames(): Promise<Array<{ id: string; name: string }>>;
}
