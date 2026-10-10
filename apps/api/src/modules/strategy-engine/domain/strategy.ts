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
import type { IctStateCompositeSnapshot } from "../../technical-analysis/domain/ict/config.js";
import type { OPTION_CHAIN_PCR_SCOPE, OptionChainPcrUnavailableReason } from "./option-chain-signal.js";

/** The ORDERBOOK-01 gate's verdict on direction; `NO_ACTION` when depth is missing or di_tilde <= 0. */
export type ConfluenceGateAction = "BUY_CALL_OR_LONG" | "BUY_PUT_OR_SHORT" | "NO_ACTION";
export type ConfluenceDirectionalBias =
  | "BULLISH_REJECTION"
  | "BEARISH_REJECTION"
  | "BEARISH_SWEEP"
  | "BULLISH_SWEEP"
  | "NONE";
/** `NO_DEPTH`: no usable front-month futures depth frame at the decision time (raw_di / di_tilde are null). */
export type ConfluenceDepthState = "NO_DEPTH";
/** Why `di_tilde` is (or is not) available; see `causalStandardiseDi`. */
export type ConfluenceDiStatus = "OK" | "UNAVAILABLE_DEPTH" | "UNAVAILABLE_HISTORY";

/**
 * Structural-level + order-book depth signal attached to a strategy context.
 *
 * `raw_di` / `di_tilde` are `null` (never 0) when unavailable. `di_tilde` is the causally
 * standardised DI: `-(raw_di - trailing same-session mean of prior-minute DI)`.
 */
export interface ConfluenceSignal {
  is_level_proximate?: boolean;
  nearest_level_type?: string | null;
  nearest_level_price?: number | null;
  distance_bps?: number | null;
  raw_di?: number | null;
  decaying_di?: number | null;
  di_tilde?: number | null;
  di_z_score?: number | null;
  di_status?: ConfluenceDiStatus;
  /** Number of prior complete-minute DI samples behind `di_tilde` (0 when none were available). */
  di_history_count?: number;
  directional_bias?: ConfluenceDirectionalBias;
  gate_action?: ConfluenceGateAction;
  /** Present (as `NO_DEPTH`) only when no usable depth frame was found. */
  depth_state?: ConfluenceDepthState;
  /** Front-month futures ticker the depth lookup used; null when no contract could be resolved. */
  depth_symbol?: string | null;
  depth_max_age_ms?: number;
}

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
  confluenceSignal?: ConfluenceSignal | null;
  /**
   * Whole-chain put/call ratio (put OI / call OI, nearest un-expired expiry) resolved as-of this
   * candle's close, for strategies that gate on an option-chain OI wall (e.g.
   * `hybrid-liquidity-confluence-v1` Pillar C).
   *
   * `pcr: null` means "not measurable right now" -- either no snapshot has been observed yet
   * (`option_chain_snapshots` is forward-accumulating from 2026-08-04, see migration 037) or the
   * nearest one is older than `PCR_MAX_SNAPSHOT_AGE_MINUTES`. A consumer must treat null as "the
   * wall cannot be confirmed", never as a default pass -- the same rule
   * `apps/ml/oi_pcr_signal_check.py` uses for its as-of join, so the live gate and the offline
   * gap-analysis check can't silently drift onto two different "unmeasured" conventions.
   */
  optionChainSignal?: {
    pcr: number | null;
    callOpenInterest: number | null;
    putOpenInterest: number | null;
    observedAt: Date | null;
    ageMinutes: number | null;
    /**
     * Optional diagnostics carried by the resolved `OptionChainSignal` (see `option-chain-signal.ts`).
     * Declared here so consumers read them without casting; a producer that only knows the five
     * fields above simply omits them.
     */
    pcrWindowed?: number | null;
    pcrScope?: typeof OPTION_CHAIN_PCR_SCOPE;
    expiryDate?: string | null;
    unavailableReason?: OptionChainPcrUnavailableReason | null;
    unavailableMessage?: string | null;
  };
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
   * Versioned ICT Composite Snapshot (Pillars 1-4: Structure, Bias, Zones, Liquidity).
   * Populated per closed bar strictly causally without lookahead.
   */
  ictSnapshot?: IctStateCompositeSnapshot;
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
  /**
   * The most recent completed context whose candle closed at or before `asOf`.
   *
   * The anti-lookahead fetch for higher-timeframe context. At a 1m decision instant the relevant
   * 5m context is the last 5m bar to have *closed*; an exact close-time match lands one only on a
   * 5m boundary and misses at every 1m bar in between. The implementation's `close_time <= $asOf`
   * guard is what makes a slower bar unable to leak into a faster signal.
   *
   * Optional because it is additive: a caller that does not supply it simply gets no
   * higher-timeframe context, which every strategy already treats as a legitimate state rather
   * than an error. Making it required would break every existing stub at once for a capability
   * only the momentum path reads.
   */
  findCompletedBefore?(input: { instrumentId: string; timeframe: string; asOf: Date }): Promise<StrategyMarketContext | null>;
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

export interface ActiveDuplicateQuery {
  strategyVersionId: string;
  instrumentId: string;
  side: TradeSide;
  targetPrice: number;
  /** Only a still-live idea counts as a duplicate -- one whose own horizon has already elapsed is not. */
  asOf: Date;
}

export type ActiveSideQuery = Omit<ActiveDuplicateQuery, "targetPrice">;

/** Saves one idempotent proposal and its ordered, human-readable evidence atomically. */
export interface TradeIdeaRepository {
  saveProposal(input: SaveTradeIdeaProposalInput): Promise<TradeIdea>;
  /**
   * An already-PROPOSED, not-yet-expired idea for the same strategy/instrument/side whose target is
   * within 0.1% of this one -- i.e. the same structural level still being evaluated bar after bar,
   * not a genuinely new setup. `saveProposal`'s own idempotency key is (strategy_version_id,
   * source_candle_id, side), which only catches a retried save of the *same* candle; a slower
   * timeframe's structure can stay valid across many new candles, each of which is a legitimately
   * different `source_candle_id` and so sails past that key and inserts again.
   */
  findActiveDuplicate(query: ActiveDuplicateQuery): Promise<TradeIdea | null>;
  /**
   * Any already-PROPOSED, not-yet-expired idea for the same strategy/instrument/side, regardless of
   * target price. Optional and additive -- only `momentum-scalp-gold` reads it (see its call site in
   * generate-trade-ideas.ts). That strategy re-anchors its stop/target to the current price every
   * candle, so a persisting trend produces a chain of genuinely different (not within 0.1% of each
   * other) targets every ~5 minutes, which `findActiveDuplicate` correctly does not treat as
   * duplicates -- measured live 2026-10-07 as repeated overlapping SHORT scalps stacking on top of
   * each other while a down-move continued. This is the broader check for strategies where "already
   * has an unresolved idea in this direction" should itself block a new one, independent of price.
   */
  findActiveIdeaForSide?(query: ActiveSideQuery): Promise<TradeIdea | null>;
}
