import type { IndicatorCode, IndicatorValues } from "../../technical-analysis/domain/technical-indicator.js";
import type { HistoricalTimeframe } from "../../market-data/domain/historical-data-provider.js";
import type {
  CandlestickPatternCode,
  PatternDirection,
  PriceActionEventCode,
} from "../../pattern-recognition/domain/market-pattern.js";

import type {
  PatternObservationCoverageState,
  PatternObservationSummary,
} from "../../pattern-intelligence/domain/observation-summary.js";
import type { RegimeContext } from "./regime.js";
import type { HigherTimeframeContext } from "./multi-timeframe-confluence.js";

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
  /**
   * Pattern Intelligence V1.0.1 observations for this bar, when a caller has loaded them.
   *
   * Optional and additive: the incumbent strategies never read it, so their behaviour and their
   * captured `rawContext` are unchanged and their frozen definition hashes do not move. `undefined`
   * means "not loaded", which `patternObservationCoverage` distinguishes from "loaded and empty" —
   * absence of observations is only information when the detector is known to have run.
   */
  patternObservations?: readonly PatternObservationSummary[];
  patternObservationCoverage?: PatternObservationCoverageState;
  regime?: RegimeContext;
  /**
   * Trend and level context from slower timeframes, for confluence scoring.
   *
   * Optional because absence is a legitimate state, not an error: `calculateHtfTrendAlignment`
   * and `calculateHtfSrConfluence` both return 0 -- neutral, no bonus and no penalty -- when this
   * is missing, so a strategy that reads it degrades to its single-timeframe behaviour rather
   * than refusing. Making it required would also break every context producer at once, including
   * the backtest engine, for a field none of them can supply yet.
   *
   * **Nothing populates this today.** No resolver for `ResolveHtfInput` exists and no repository
   * sets the field, so every confluence score is currently 0 and the HTF terms contribute
   * nothing. That has to be built before any result is read as evidence about confluence -- the
   * same trap as a pattern strategy scoring against an empty `pattern_detections` table, which
   * looked for a full session like a strategy finding no setups. Populating it needs the
   * anti-lookahead rule in `ResolveHtfInput`: the higher-timeframe candle must have
   * `closeTime <= asOf`, or a 60m bar that has not closed leaks the future into a 5m signal.
   */
  higherTimeframes?: readonly HigherTimeframeContext[];
  /**
   * Raw higher-timeframe contexts keyed by timeframe, when a caller has loaded them.
   *
   * Distinct from `higherTimeframes` above, and additive on purpose. That field carries a
   * pre-digested trend summary (`trendBias`, S/R levels) for the confluence scorers; this one
   * carries the *full* `StrategyMarketContext` of a slower bar -- its candle, indicators, patterns
   * -- with no information loss, so a research strategy can record slower-timeframe covariates
   * without a digest deciding in advance which of them matter.
   *
   * Optional and additive: the incumbent strategies and every existing `rawContext` never read it,
   * so their behaviour and their frozen definition hashes are unchanged. The producer must honour
   * the same anti-lookahead rule as everything else -- an attached bar must have
   * `closeTime <= decisionAt` -- which `findCompletedBefore` enforces in SQL.
   */
  higherTimeframeContexts?: Partial<Record<HistoricalTimeframe, StrategyMarketContext>>;
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
