import type { IndicatorCode, IndicatorValues } from "../../technical-analysis/domain/technical-indicator.js";
import type {
  CandlestickPatternCode,
  PatternDirection,
  PriceActionEventCode,
} from "../../pattern-recognition/domain/market-pattern.js";

import type { RegimeContext } from "./regime.js";

export type TradeSide = "LONG" | "SHORT";
export type TradeIdeaStatus = "PROPOSED" | "ACCEPTED" | "EXPIRED" | "REJECTED";
export type TradeIdeaEvidenceSource = "INDICATOR" | "PATTERN" | "PRICE_ACTION" | "MODEL" | "STRATEGY" | "REGIME";

export interface StrategyVersion {
  id: string;
  strategyId: string;
  strategyKey: string;
  name: string;
  description: string;
  version: number;
  configuration: Record<string, unknown>;
  isActive: boolean;
  isArchived: boolean;
}

export interface EnsureStrategyVersionInput {
  strategyKey: string;
  name: string;
  description: string;
  version: number;
  configuration: Record<string, unknown>;
}

export interface StrategyVersionRepository {
  ensure(input: EnsureStrategyVersionInput): Promise<StrategyVersion>;
}

/** The latest completed candle and its already-persisted analytical evidence. */
export interface StrategyMarketContext {
  candle: {
    id: string;
    instrumentId: string;
    timeframe: string;
    openTime: Date;
    closeTime: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    tickSize: number;
  };
  indicators: Array<{
    code: IndicatorCode;
    algorithmVersion: string;
    parameters: Record<string, unknown>;
    values: IndicatorValues;
  }>;
  patterns: Array<{
    code: CandlestickPatternCode;
    algorithmVersion: string;
    direction: PatternDirection;
    confidence: number;
    contextCandleIds: string[];
    details: Record<string, unknown>;
  }>;
  priceActionEvents: Array<{
    eventCode: PriceActionEventCode;
    algorithmVersion: string;
    direction: PatternDirection;
    level: number | null;
    confidence: number;
    details: Record<string, unknown>;
  }>;
  regime?: RegimeContext;
}

export interface StrategyMarketContextRepository {
  findLatestCompleted(input: { instrumentId: string; timeframe: string }): Promise<StrategyMarketContext | null>;
  /**
   * The most recent `limit` completed contexts in chronological order (oldest
   * first). Used by the historical-scan path of idea generation, which evaluates
   * a window of past bars rather than only the latest one, so bearish setups that
   * have already closed still surface as SHORT proposals.
   */
  listCompletedContexts(input: { instrumentId: string; timeframe: string; limit: number }): Promise<StrategyMarketContext[]>;
}

export interface TradeIdeaEvidence {
  sourceType: TradeIdeaEvidenceSource;
  sourceReference: string | null;
  label: string;
  contribution: number | null;
  details: Record<string, unknown>;
}

export interface ProposedTradeIdea {
  side: TradeSide;
  entryPrice: number;
  stopLoss: number;
  targetPrice: number;
  riskReward: number;
  confidence: number;
  reasoning: string[];
  evidence: Record<string, unknown>;
  expiresAt: Date | null;
  evidenceItems: TradeIdeaEvidence[];
}

export interface TradeIdea {
  id: string;
  instrumentId: string;
  strategyVersionId: string | null;
  sourceCandleId: string | null;
  side: TradeSide;
  status: TradeIdeaStatus;
  entryPrice: number;
  stopLoss: number;
  targetPrice: number;
  riskReward: number;
  confidence: number;
  expiresAt: Date | null;
}

export interface SaveTradeIdeaProposalInput extends ProposedTradeIdea {
  instrumentId: string;
  strategyVersionId: string;
  sourceCandleId: string;
}

/** Saves one idempotent proposal and its ordered, human-readable evidence atomically. */
export interface TradeIdeaRepository {
  saveProposal(input: SaveTradeIdeaProposalInput): Promise<TradeIdea>;
}
