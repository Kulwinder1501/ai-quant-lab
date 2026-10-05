import {
  impliedVolatilityFromPremium,
  midPriceForIv,
  nearestStrike,
  RISK_FREE_RATE,
  yearsToExpiry,
} from "@ai-quant-lab/pricing";
import { solveContractGreeksFromChain } from "../../market-data/domain/chain-greeks.js";
import type { OptionChainSnapshot } from "../../market-data/domain/option-chain.js";
import {
  resolveListedExpiry,
  selectNearestListedExpiry,
  type OptionExpiryCalendar,
} from "../../market-data/domain/option-expiry-calendar.js";
import { regimeSourceInstrumentSymbol } from "../../strategy-engine/domain/regime.js";
import type { TradeSide } from "../../strategy-engine/domain/strategy.js";
import { validateOptionsEntry } from "../../strategy-engine/domain/options-entry-validator.js";
import { calculateEntryFees } from "../domain/brokerage-calculator.js";
import { lotsToQuantity } from "../domain/lot-size-validator.js";
import { mapIdeaToOptionBuyerFill, resolveOptionExpiryInstant } from "../domain/option-buyer-fill.js";

/**
 * Everything that has to be true before a directional idea becomes an option position.
 *
 * This was the body of `POST /paper-trades/open`, and it stayed there while the paper-trading
 * bot was signal-only. The moment the bot opens positions there are two callers, and the
 * cost of the copy is not duplication -- it is that the copy is where the gates get left
 * out. Each of the three below was added in response to a defect that had already been paid
 * for, and each is invisible when missing: the trade prices cleanly and books.
 *
 * - **The expiry must be one the provider lists.** Two trades were booked on a BANKNIFTY
 *   2026-08-04 expiry; BANKNIFTY has no weekly series, so the contract never traded. Both
 *   priced against a 1-day tenor when the real contract had 22 days, and the account reported
 *   a 212% return. An automated caller picks from the calendar rather than deriving a date,
 *   so a phantom cannot be constructed in the first place.
 * - **The entry premium must be the book's, not the model's.** On a live BANKNIFTY 57700 CE
 *   the model said 770.22 against a quoted mid of 748.25 -- Rs 329 a lot of pure model error,
 *   before any market cost. A model mark once reported +Rs 2,032 on a position down Rs 651.
 * - **The pre-trade checklist must actually run.** `mapIdeaToOptionBuyerFill` throws on a
 *   failed `validationResult`, but only if one is supplied; omit it and the gate silently
 *   ceases to exist while every number still looks right.
 *
 * A refusal carries `unchecked` as well as `reasons`, because "passed" and "never evaluated"
 * must never read the same.
 */

/** The gate refuses sub-1-DTE at anything short of top confidence, so do not choose one. */
export const MINIMUM_DAYS_TO_EXPIRY = 2;

/** Chain context may be older because it supplies OI and paired strikes, not the execution. */
const MAXIMUM_CHAIN_AGE_MINUTES = 40;
/**
 * An unattended market entry may only cross an ask observed in the last two minutes.
 *
 * This is the ceiling for every idea whose source candle is *not* 1-minute: `ict-structure-v1`
 * (5m/15m), `trend-breakout` (15m/30m/60m/1d), and any `momentum-scalp-*` idea that happened to
 * fire off a slower bar it also supports. Two minutes between an observed ask and a market order
 * is a reasonable bound for those cadences, because the strategy itself only re-evaluates every
 * several minutes -- the premium cannot have moved as far from a two-minute-old ask as it could
 * from a sixty-second-old one on a contract re-priced every minute.
 */
export const MAXIMUM_EXECUTABLE_QUOTE_AGE_MS = 2 * 60 * 1000;
/**
 * The tighter ceiling for an idea raised off a 1-minute candle -- `momentum-scalp` and any
 * `momentum-scalp-*` sibling (index/pattern/gold) when it fires on 1m, which is the entire set
 * `strategy-registry.ts` lists as supporting that timeframe.
 *
 * Trade `535e5951-56e3-4323-b8af-f47e5f6812c5` (AutoBot-Scalp1m, BANKNIFTY 54900 CE) filled
 * against a quote that was 60.27 seconds stale by the time the trade actually opened; a
 * materially worse tick had already arrived live, so the position was underwater the instant it
 * opened. Measured across 58 similar Scalp1m trades: median quote lag 2.27s, ~10% of trades run
 * past 20s. 25 seconds sits inside the peer-recommended 20-30s band: comfortably above the
 * ~2.27s median so ordinary operation is unaffected, but far enough under the 60s+ staleness that
 * actually produced the bad fill -- and under the bulk of the 20s+ tail -- that the race between
 * the once-a-minute scan cadence and the once-a-minute option-premium-tick collector can no
 * longer land a fill on a quote describing a materially different market.
 */
export const MAXIMUM_EXECUTABLE_QUOTE_AGE_MS_SCALP_CADENCE = 25 * 1000;

export interface PreparedOptionEntry {
  tradeIdeaId: string;
  underlyingSymbol: string;
  side: "LONG";
  /**
   * The underlying thesis direction: LONG for a CE (bullish idea), SHORT for a PE (bearish
   * idea). Distinct from `side` above, which is always `"LONG"` (you are long the option
   * contract itself). This is what the O1 exit state machine's `UNDERLYING_INVALIDATION`
   * check needs, and must never be confused with `side` -- conflating the two made every
   * position read as bullish regardless of whether a CE or PE was actually bought.
   */
  underlyingDirection: "LONG" | "SHORT";
  quantity: number;
  lotSize: number;
  fillPrice: number;
  stopLossOverride: number;
  targetPriceOverride: number;
  optionContract: {
    optionStrike: number;
    optionExpiry: Date;
    optionType: "CE" | "PE";
    underlyingSymbol: string;
    underlyingEntryPrice: number;
    /** The underlying's real observed level at the fill instant, or null. See migration 120. */
    underlyingFillPrice: number | null;
    underlyingFillPriceSource: "OPTION_CHAIN_QUOTE" | "OPTION_PREMIUM_TICK_ASK" | null;
    invalidationLevelAtEntry?: number | null;
    entryIv: number;
  };
  feeBreakdown: Record<string, unknown>;
  entryFees: number;
  /** Factors the gate could not evaluate. Never empty in practice; surfaced, not swallowed. */
  unchecked: string[];
}

export type PrepareOptionEntryResult =
  | { approved: true; entry: PreparedOptionEntry }
  | {
    approved: false;
    /** Machine-readable, and mapped to an HTTP status by the route. */
    reason:
      | "IDEA_NOT_FOUND"
      | "NO_STRIKE_STEP"
      | "MISSING_INVALIDATION_LEVEL"
      | "EXPIRY_REQUIRED"
      | "EXPIRY_INVALID"
      | "EXPIRY_PASSED"
      | "NO_CALENDAR"
      | "EXPIRY_NOT_LISTED"
      | "NO_EXPIRY_FAR_ENOUGH_OUT"
      | "NO_OPTION_ENTRY"
      | "NO_FRESH_EXECUTABLE_QUOTE"
      | "FILL_NOT_DERIVABLE"
      | "OPTIONS_ENTRY_REJECTED";
    explanation: string;
    reasons?: string[];
    unchecked?: string[];
  };

export interface PrepareOptionEntryInput {
  tradeIdeaId: string;
  /**
   * The contract to price. Omit to take the nearest listed expiry at least
   * `MINIMUM_DAYS_TO_EXPIRY` out -- which is what an unattended caller must do, because it
   * has nobody to ask.
   */
  expiryDate?: string;
  impliedVolatility?: number;
  lots?: number;
  quantity?: number;
  now?: Date;
}

interface QueryableDatabase {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

interface ChainReader {
  latestExpiryCalendar(underlyingSymbol: string, asOf?: Date): Promise<OptionExpiryCalendar | null>;
  latestSnapshot(input: {
    underlyingSymbol: string;
    expiryDate?: string;
    asOf?: Date;
  }): Promise<OptionChainSnapshot | null>;
}

interface PremiumTickReader {
  latestForContract(
    contract: {
      underlyingSymbol: string;
      expiryDate: Date;
      strikePrice: number;
      optionType: "CE" | "PE";
    },
    maxAgeMs?: number,
    now?: Date,
  ): Promise<{
    observedAt: Date;
    bid: number | null;
    ask: number | null;
    lastPrice: number | null;
    underlyingValue: number | null;
  } | null>;
}

interface IdeaRow {
  id: string;
  side: TradeSide;
  entry_price: string;
  stop_loss: string;
  target_price: string;
  instrument_id: string;
  lot_size: number;
  symbol: string;
  strike_step: string | null;
  confidence: string | number | null;
  reasoning: unknown;
  source_candle_id: string | null;
  /** The source candle's bar size, or null when the idea records no source candle. */
  source_candle_timeframe: string | null;
}

export class PrepareOptionEntry {
  constructor(
    private readonly database: QueryableDatabase,
    private readonly optionChainRepository: ChainReader,
    private readonly premiumTicks?: PremiumTickReader,
  ) {}

  async execute(input: PrepareOptionEntryInput): Promise<PrepareOptionEntryResult> {
    const now = input.now ?? new Date();

    const ideaResult = await this.database.query<IdeaRow>(`
      SELECT ti.id, ti.side, ti.entry_price, ti.stop_loss, ti.target_price,
             ti.instrument_id, ti.confidence, ti.reasoning, ti.source_candle_id,
             i.lot_size, i.symbol, i.strike_step,
             c.timeframe AS source_candle_timeframe
      FROM trade_ideas ti
      INNER JOIN instruments i ON i.id = ti.instrument_id
      LEFT JOIN candles c ON c.id = ti.source_candle_id
      WHERE ti.id = $1
    `, [input.tradeIdeaId]);
    const idea = ideaResult.rows[0];
    if (!idea) {
      return { approved: false, reason: "IDEA_NOT_FOUND", explanation: "Trade idea not found." };
    }

    const underlyingSymbol = String(idea.symbol).toUpperCase();
    const lotSize = Number(idea.lot_size);
    // Lot-correct by construction. `quantity: 1` against a lot of 75 is not a small
    // position, it is one that cannot be placed. Rounded rather than floored: a
    // risk-adjusted lot count like 1.25 (1 base lot x a 1.25 EXPANSION multiplier)
    // must round to its nearest integer, not always down — flooring silently
    // discarded every sizing-up multiplier below 2x.
    const quantity = typeof input.quantity === "number" && input.quantity > 0
      ? input.quantity
      : lotsToQuantity(Math.max(1, Math.round(input.lots ?? 1)), lotSize);

    const strikeStep = idea.strike_step === null ? null : Number(idea.strike_step);
    if (strikeStep === null || !Number.isFinite(strikeStep) || strikeStep <= 0) {
      return {
        approved: false,
        reason: "NO_STRIKE_STEP",
        explanation: `Instrument ${idea.symbol} has no strike_step configured, so an option strike `
          + "cannot be chosen. A step guessed from price level gave BANKNIFTY 50-point strikes "
          + "that do not exist.",
      };
    }

    const invalidationLevelAtEntry = idea.stop_loss === null ? null : Number(idea.stop_loss);
    if (invalidationLevelAtEntry === null || !Number.isFinite(invalidationLevelAtEntry) || invalidationLevelAtEntry <= 0) {
      return {
        approved: false,
        reason: "MISSING_INVALIDATION_LEVEL",
        explanation: `Trade idea ${idea.id} has invalid or missing stop_loss (${idea.stop_loss}); O1 invalidation level cannot be populated.`,
      };
    }

    const calendar = await this.optionChainRepository.latestExpiryCalendar(underlyingSymbol, now);
    const chosen = this.resolveExpiry(calendar, input.expiryDate, underlyingSymbol, now);
    if (!chosen.ok) return chosen.refusal;
    const settlementExpiry = chosen.expiryDate;

    const impliedVolatility = await this.resolveImpliedVolatility(input.impliedVolatility);

    // The chain is read before the fill is mapped, because the entry premium should be the
    // market's. The strike does not depend on the mapping -- it is nearestStrike(entry, step)
    // -- so it can be derived here and looked up.
    const intendedOptionType = idea.side === "LONG" ? "CE" : "PE";
    const entryChain = await this.optionChainRepository
      .latestSnapshot({
        underlyingSymbol,
        expiryDate: settlementExpiry.toISOString().slice(0, 10),
        asOf: now,
      })
      .catch(() => null);
    // The chain supplies OI, paired strikes and a liquidity screen. It is not necessarily the
    // execution source: the chain is collected every 15 minutes, while dense contract ticks are
    // collected roughly twice a minute.
    const chainAgeMinutes = entryChain === null
      ? null
      : (now.getTime() - entryChain.observedAt.getTime()) / 60_000;
    const usableChain = entryChain !== null && chainAgeMinutes !== null
      && chainAgeMinutes >= 0 && chainAgeMinutes <= MAXIMUM_CHAIN_AGE_MINUTES
      ? entryChain
      : null;

    if (usableChain === null || usableChain.quotes.length === 0) {
      return {
        approved: false,
        reason: "NO_OPTION_ENTRY",
        explanation:
          `No usable option chain found for ${underlyingSymbol} ${settlementExpiry.toISOString().slice(0, 10)} `
          + `within maximum age of ${MAXIMUM_CHAIN_AGE_MINUTES} minutes.`,
      };
    }

    const MIN_ENTRY_DELTA = 0.75;
    const TARGET_DELTA = 0.75;
    const matchingQuotes = usableChain.quotes.filter((q) => q.optionType === intendedOptionType);
    const eligible: Array<{
      quote: typeof matchingQuotes[0];
      greeks: NonNullable<ReturnType<typeof solveContractGreeksFromChain>>;
    }> = [];

    for (const q of matchingQuotes) {
      if (
        q.bid === null
        || q.ask === null
        || !Number.isFinite(q.bid)
        || !Number.isFinite(q.ask)
        || !(q.ask > q.bid)
      ) {
        continue;
      }
      const greeks = solveContractGreeksFromChain({
        snapshot: usableChain,
        strikePrice: q.strikePrice,
        optionType: intendedOptionType,
      });
      if (
        greeks !== null
        && Number.isFinite(greeks.delta)
        && Math.abs(greeks.delta) >= MIN_ENTRY_DELTA
      ) {
        eligible.push({ quote: q, greeks });
      }
    }

    if (eligible.length === 0) {
      return {
        approved: false,
        reason: "NO_OPTION_ENTRY",
        explanation:
          `No eligible contract found for ${underlyingSymbol} ${settlementExpiry.toISOString().slice(0, 10)} `
          + `${intendedOptionType}: no contract satisfied abs(delta) >= ${MIN_ENTRY_DELTA} with valid two-sided quotes.`,
      };
    }

    // Rank eligible contracts:
    // 1. Min distance |abs(delta) - 0.75|
    // 2. Min bid-ask spread (ask - bid)
    // 3. Strike ASC
    eligible.sort((a, b) => {
      const deltaDiffA = Math.abs(Math.abs(a.greeks.delta) - TARGET_DELTA);
      const deltaDiffB = Math.abs(Math.abs(b.greeks.delta) - TARGET_DELTA);
      if (Math.abs(deltaDiffA - deltaDiffB) > 1e-6) {
        return deltaDiffA - deltaDiffB;
      }
      const spreadA = a.quote.ask! - a.quote.bid!;
      const spreadB = b.quote.ask! - b.quote.bid!;
      if (Math.abs(spreadA - spreadB) > 1e-6) {
        return spreadA - spreadB;
      }
      return a.quote.strikePrice - b.quote.strikePrice;
    });

    // Cadence is read off the idea's own source candle, not off the strategy's name. A single
    // strategy key can fire on more than one bar size (momentum-scalp-index, -pattern and -gold
    // all list "1m" alongside slower timeframes in strategy-registry.ts), so the candle actually
    // behind *this* idea is the real signal of how fast the bot that raised it re-evaluates --
    // not a guess from a hardcoded strategy-key list. An idea with no source candle on record
    // gets the looser, conservative default rather than the tighter one.
    const quoteStalenessToleranceMs = idea.source_candle_timeframe === "1m"
      ? MAXIMUM_EXECUTABLE_QUOTE_AGE_MS_SCALP_CADENCE
      : MAXIMUM_EXECUTABLE_QUOTE_AGE_MS;

    const chosenCandidate = eligible[0]!;
    const intendedStrike = chosenCandidate.quote.strikePrice;
    const chainGreeks = chosenCandidate.greeks;
    const deltaAtEntry = chainGreeks.delta;
    const thetaAtEntry = chainGreeks.theta;
    const vegaAtEntry = chainGreeks.vega;

    // A buyer pays the ask, not the mid. Filling at the mid understates the entry by half
    // the spread on every trade, and spread is the cost that decides whether an options edge
    // survives at all.
    const intendedQuote = chosenCandidate.quote;
    const denseQuote = await this.premiumTicks?.latestForContract({
      underlyingSymbol,
      expiryDate: settlementExpiry,
      strikePrice: intendedStrike,
      optionType: intendedOptionType,
    }, quoteStalenessToleranceMs, now).catch(() => null) ?? null;

    const freshChainQuote = entryChain !== null
      && chainAgeMinutes !== null
      && chainAgeMinutes >= 0
      && chainAgeMinutes * 60_000 <= quoteStalenessToleranceMs
      && intendedQuote.ask !== null
      && intendedQuote.ask > 0
      ? {
        premium: intendedQuote.ask!,
        bid: intendedQuote.bid,
        impliedVolatility: chainGreeks.impliedVolatility,
        source: "OPTION_CHAIN_QUOTE" as const,
        observedAt: entryChain.observedAt,
        underlyingValue: entryChain.underlyingValue,
      }
      : null;

    const denseMid = denseQuote === null ? null : midPriceForIv(denseQuote.bid, denseQuote.ask);
    const denseSpot = denseQuote?.underlyingValue;
    const denseIv = denseQuote !== null && denseMid !== null && denseSpot !== null
      && denseSpot !== undefined && Number.isFinite(denseSpot) && denseSpot > 0
      ? impliedVolatilityFromPremium({
        spot: denseSpot,
        strike: intendedStrike,
        timeToExpiryYears: yearsToExpiry(denseQuote.observedAt, settlementExpiry),
        riskFreeRate: RISK_FREE_RATE,
        optionType: intendedOptionType,
        premium: denseMid,
      })
      : null;
    const freshDenseQuote = denseQuote?.ask != null && denseQuote.ask > 0
      && denseIv?.measurable === true
      ? {
        premium: denseQuote.ask,
        bid: denseQuote.bid,
        impliedVolatility: denseIv.impliedVolatility,
        source: "OPTION_PREMIUM_TICK_ASK" as const,
        observedAt: denseQuote.observedAt,
        underlyingValue: denseQuote.underlyingValue,
      }
      : null;

    const observedFill = freshDenseQuote ?? freshChainQuote;
    if (observedFill === null) {
      return {
        approved: false,
        reason: "NO_FRESH_EXECUTABLE_QUOTE",
        explanation: `No executable ${underlyingSymbol} ${settlementExpiry.toISOString().slice(0, 10)} `
          + `${intendedStrike} ${intendedOptionType} ask `
          + `at or before ${now.toISOString()} was available inside the `
          + `${quoteStalenessToleranceMs / 1000}-second freshness window. `
          + "The position was not opened; theoretical premiums are not executable fills.",
      };
    }

    let mapped: ReturnType<typeof mapIdeaToOptionBuyerFill>;
    try {
      mapped = mapIdeaToOptionBuyerFill({
        ideaSide: idea.side,
        underlyingEntry: Number(idea.entry_price),
        underlyingStop: Number(idea.stop_loss),
        underlyingTarget: Number(idea.target_price),
        impliedVolatility,
        expiryDate: settlementExpiry,
        strikeStep,
        strikeOverride: intendedStrike,
        observedFill,
        now,
      });
    } catch (error) {
      return {
        approved: false,
        reason: "FILL_NOT_DERIVABLE",
        explanation: error instanceof Error ? error.message : "Option fill could not be derived.",
      };
    }

    const validationChain = usableChain === null ? undefined : freshDenseQuote === null ? usableChain : {
      ...usableChain,
      observedAt: freshDenseQuote.observedAt,
      underlyingValue: denseQuote?.underlyingValue ?? usableChain.underlyingValue,
      quotes: usableChain.quotes.map((quote) => (
        quote.strikePrice === intendedStrike && quote.optionType === intendedOptionType
          ? {
            ...quote,
            bid: denseQuote?.bid ?? quote.bid,
            ask: denseQuote?.ask ?? quote.ask,
            lastPrice: denseQuote?.lastPrice ?? quote.lastPrice,
          }
          : quote
      )),
    };

    const volume = await this.readSourceBarVolume(idea.source_candle_id, idea.symbol);
    const scheduledMacro = await this.hasScheduledMacroEventToday(now);
    const entryCheck = validateOptionsEntry({
      proposedIdea: {
        side: idea.side,
        confidence: Number(idea.confidence ?? 0),
        reasoning: Array.isArray(idea.reasoning) ? (idea.reasoning as unknown[]).map(String) : [],
      },
      candleVolume: volume.candleVolume,
      volumeAbsenceReason: volume.absenceReason,
      optionChain: validationChain,
      intendedStrike,
      intendedContractDelta: mapped.entryGreeks.delta,
      ...(scheduledMacro === undefined ? {} : { hasMacroEvent: scheduledMacro }),
    });
    if (!entryCheck.isValid) {
      return {
        approved: false,
        reason: "OPTIONS_ENTRY_REJECTED",
        explanation: `Options pre-trade checks refused this entry: ${entryCheck.reasons.join(" ")}`,
        reasons: entryCheck.reasons,
        unchecked: entryCheck.unchecked,
      };
    }

    const entryFees = calculateEntryFees(mapped.fillPremium, quantity);
    return {
      approved: true,
      entry: {
        tradeIdeaId: idea.id,
        underlyingSymbol,
        side: mapped.side,
        underlyingDirection: mapped.underlyingDirection,
        quantity,
        lotSize,
        fillPrice: mapped.fillPremium,
        stopLossOverride: mapped.stopPremium,
        targetPriceOverride: mapped.targetPremium,
        optionContract: {
          optionStrike: mapped.strike,
          optionExpiry: settlementExpiry,
          optionType: mapped.optionType,
          underlyingSymbol: idea.symbol,
          underlyingEntryPrice: mapped.underlyingEntryPrice,
          underlyingFillPrice: mapped.underlyingFillPrice,
          underlyingFillPriceSource: mapped.underlyingFillPriceSource,
          invalidationLevelAtEntry,
          entryIv: mapped.impliedVolatility,
        },
        entryFees: entryFees.total,
        unchecked: entryCheck.unchecked,
        feeBreakdown: {
          entry: entryFees,
          option: {
            optionType: mapped.optionType,
            strike: mapped.strike,
            impliedVolatility: mapped.impliedVolatility,
            expiryDate: settlementExpiry.toISOString(),
            greeks: mapped.entryGreeks,
            underlyingEntry: Number(idea.entry_price),
          },
          entryChecks: {
            fillSource: mapped.fillSource,
            sourceCandleVolume: volume.candleVolume,
            observedAsk: observedFill.premium,
            quoteObservedAt: observedFill.observedAt.toISOString(),
            reasons: entryCheck.reasons,
            unchecked: entryCheck.unchecked,
            solvedDelta: mapped.entryGreeks.delta,
            solvedImpliedVolatility: mapped.impliedVolatility,
            chainObservedAt: entryChain?.observedAt.toISOString() ?? null,
            chainAgeMinutes: chainAgeMinutes === null ? null : Number(chainAgeMinutes.toFixed(2)),
            chainUsable: usableChain !== null,
            quoteStalenessToleranceMs,
          },
          entryProvenance: {
            selectionMode: "O2_CHAIN_ENUMERATION",
            targetDelta: 0.75,
            eligibleContractCount: eligible.length,
            chainObservedAt: usableChain.observedAt.toISOString(),
            deltaAtEntry,
            thetaAtEntry,
            vegaAtEntry,
            IVAtEntry: mapped.impliedVolatility,
            DTE: (settlementExpiry.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
            optionSpread: observedFill.bid != null && Number.isFinite(observedFill.bid)
              ? Number((observedFill.premium - observedFill.bid).toFixed(4))
              : null,
            strike: mapped.strike,
            optionType: mapped.optionType,
            expiryDate: settlementExpiry.toISOString(),
          },
        },
      },
    };
  }

  /**
   * A caller-supplied expiry is checked against the calendar; an absent one is chosen from
   * it. Both routes end at a contract the provider lists -- there is no path that derives a
   * date from a weekday rule, which is how the phantom got in.
   */
  private resolveExpiry(
    calendar: OptionExpiryCalendar | null,
    requested: string | undefined,
    underlyingSymbol: string,
    now: Date,
  ): { ok: true; expiryDate: Date } | { ok: false; refusal: Extract<PrepareOptionEntryResult, { approved: false }> } {
    if (typeof requested !== "string" || requested.trim() === "") {
      const selection = selectNearestListedExpiry(calendar, now, MINIMUM_DAYS_TO_EXPIRY);
      if (!selection.usable) {
        return { ok: false, refusal: { approved: false, reason: selection.reason, explanation: selection.explanation } };
      }
      return { ok: true, expiryDate: selection.expiryDate };
    }

    // A date-only expiry means that day's 15:30 IST settlement, not midnight UTC, which had
    // force-settled positions at the pre-open of expiry day against the prior session's spot.
    const expiry = resolveOptionExpiryInstant(requested);
    if (Number.isNaN(expiry.getTime())) {
      return {
        ok: false,
        refusal: { approved: false, reason: "EXPIRY_INVALID", explanation: `expiryDate "${requested}" is not a valid date.` },
      };
    }
    if (expiry.getTime() <= now.getTime()) {
      return {
        ok: false,
        refusal: {
          approved: false,
          reason: "EXPIRY_PASSED",
          explanation: `expiryDate ${expiry.toISOString()} has already passed; an expired contract cannot be priced.`,
        },
      };
    }
    const listed = resolveListedExpiry(calendar, expiry, underlyingSymbol);
    if (!listed.usable) {
      return { ok: false, refusal: { approved: false, reason: listed.reason, explanation: listed.explanation } };
    }
    // The calendar's own instant, so a caller who passed a bare date does not end up with a
    // settlement time that disagrees with the contract.
    return { ok: true, expiryDate: listed.expiryDate };
  }

  private async resolveImpliedVolatility(supplied: number | undefined): Promise<number> {
    let iv = typeof supplied === "number" ? supplied : undefined;
    if (iv === undefined) {
      const vixClose = await this.database.query<{ close: string }>(`
        SELECT c.close
        FROM candles c
        INNER JOIN instruments i ON i.id = c.instrument_id
        WHERE i.symbol = $1 AND c.timeframe = '1d' AND c.is_complete = TRUE
          AND c.close_time <= CURRENT_TIMESTAMP
        ORDER BY c.close_time DESC
        LIMIT 1
      `, [regimeSourceInstrumentSymbol]);
      if (vixClose.rows[0]) iv = Number(vixClose.rows[0].close) / 100;
    }
    if (iv === undefined || !Number.isFinite(iv) || iv <= 0) iv = 0.12;
    if (iv > 1) iv /= 100;
    return iv;
  }

  private async hasScheduledMacroEventToday(now: Date): Promise<boolean | undefined> {
    const IST = "Asia/Kolkata";
    const todayIst = new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(now);
    const [y, m, d] = todayIst.split("-").map(Number);
    const tomorrowUtc = new Date(Date.UTC(y!, m! - 1, d! + 1));
    const tomorrowIst = tomorrowUtc.toISOString().slice(0, 10);
    try {
      const result = await this.database.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM scheduled_macro_events
        WHERE event_date IN ($1::date, $2::date)
          AND verified = TRUE
      `, [todayIst, tomorrowIst]);
      return Number(result.rows[0]?.count ?? 0) > 0;
    } catch {
      // Omit the field so the validator reports unchecked rather than inventing a clear.
      return undefined;
    }
  }

  /**
   * Volume of the bar the idea was actually raised on, via `source_candle_id`. The latest bar
   * is deliberately not substituted: validating an older idea against a later bar would judge
   * it on information it never had.
   *
   * A zero counts as "nobody traded" only where the series reports volume **around that bar**.
   * The window is the correction: the check used to ask whether the series had *ever* carried
   * volume, which sorts a series into "always reports" or "never reports" and has no answer
   * for one that reported and stopped. Both live cases are that third kind:
   *
   * - Yahoo stopped supplying index 1d volume on 2026-08-01. June and July were ~100%
   *   populated; all 8 August bars are zero. Every idea raised on one was refused with "low
   *   volume moves are weak or false" -- a data outage reported as a market observation.
   * - The Fyers quotes endpoint returns `volume: 0` for an index, so every live-collected
   *   intraday bar carries a zero into a series whose history bars carry real volume.
   *
   * Neither is nobody trading. A window of peers around the bar answers the question that was
   * actually being asked, and still refuses a genuinely quiet bar sitting among active ones.
   */
  private async readSourceBarVolume(
    sourceCandleId: string | null,
    symbol: string,
  ): Promise<{ candleVolume: number | null; absenceReason: string }> {
    if (!sourceCandleId) {
      return {
        candleVolume: null,
        absenceReason: "the idea records no source candle, so its bar volume cannot be read",
      };
    }
    try {
      const result = await this.database.query<{
        volume: string | null;
        timeframe: string;
        instrument_type: string;
        nearby_volume_bars: string;
        proxy_volume: string | null;
        proxy_symbol: string | null;
      }>(`
        SELECT c.volume, c.timeframe, i.instrument_type,
               (SELECT count(*) FROM candles peer
                 WHERE peer.instrument_id = c.instrument_id
                   AND peer.timeframe = c.timeframe
                   AND peer.volume > 0
                   AND peer.open_time BETWEEN c.open_time - INTERVAL '7 days'
                                          AND c.open_time + INTERVAL '7 days') AS nearby_volume_bars,
               proxy.volume AS proxy_volume,
               proxy.symbol AS proxy_symbol
        FROM candles c
        JOIN instruments i ON i.id = c.instrument_id
        LEFT JOIN LATERAL (
          SELECT pc.volume, pi.symbol
          FROM instruments pi
          JOIN candles pc ON pc.instrument_id = pi.id
            AND pc.timeframe = c.timeframe
            AND pc.open_time = c.open_time
            AND pc.is_complete = TRUE
          WHERE pi.instrument_type = 'ETF'
            AND pi.metadata ->> 'purpose' = 'tradable-index-proxy'
            AND upper(pi.metadata ->> 'tracks') = upper(i.symbol)
          ORDER BY pc.received_at DESC, pc.id DESC
          LIMIT 1
        ) proxy ON TRUE
        WHERE c.id = $1
      `, [sourceCandleId]);
      const bar = result.rows[0];
      if (!bar) {
        return { candleVolume: null, absenceReason: "the idea's source candle is no longer stored" };
      }
      /*
       * An index has no volume to confirm with, whatever a particular bar happens to store.
       *
       * The peer window below exists to tell "absent feed" from "absent participation", and it
       * cannot separate them here: NSE publishes no traded volume for an index, and Fyers' history
       * endpoint reports 0% non-zero through 2025 and then 100% from 2026 -- a structural break
       * migration 030 records, and the reason the tradable ETF proxies were registered at all.
       * Measured 2026-08-10, NIFTY50 15m carries volume on 6,827 of 22,221 bars (31%) while
       * NIFTYBEES carries it on 9,829 of 9,830 (99.99%).
       *
       * So within 2026 the peers say "this series reports volume" while the live collector, which
       * writes the bars nearest the present, cannot report it for an index -- the quotes endpoint
       * returns 0. Every one of 2026-08-10's NIFTY50 15m bars stored 0. The gate then read a
       * missing measurement as a failed one and refused every index entry near the live edge: the
       * agent qualified setups at 80% confidence and was rejected on
       * "Low-volume moves are weak or false" it could never satisfy.
       *
       * Reported as unchecked rather than passed. The distinction is the whole point -- a factor
       * that could not be evaluated must never read like one that was.
       */
      if (bar.instrument_type === "INDEX") {
        const proxyVolume = bar.proxy_volume === null ? Number.NaN : Number(bar.proxy_volume);
        if (bar.timeframe === "5m" && Number.isFinite(proxyVolume) && proxyVolume > 0) {
          return {
            candleVolume: proxyVolume,
            absenceReason: "",
          };
        }
        return {
          candleVolume: null,
          absenceReason: bar.timeframe === "5m"
            ? `${symbol} is an INDEX and its point-in-time ETF proxy `
              + `(${bar.proxy_symbol ?? "not found"}) has no positive 5m volume for the source bar`
            : `${symbol} is an INDEX, so ${bar.timeframe} index volume is not usable; only an exact `
              + "5m ETF-proxy bar may confirm participation",
        };
      }
      if (Number(bar.nearby_volume_bars) === 0) {
        return {
          candleVolume: null,
          absenceReason: `${symbol} ${bar.timeframe} reported no volume on any bar within a week `
            + "of this one, so a zero here is an absent feed rather than absent participation",
        };
      }
      const parsed = bar.volume === null ? Number.NaN : Number(bar.volume);
      return Number.isFinite(parsed)
        ? { candleVolume: parsed, absenceReason: "" }
        : { candleVolume: null, absenceReason: "the source candle stores no volume" };
    } catch {
      // A volume lookup failure must not block an entry; it is reported as unchecked.
      return { candleVolume: null, absenceReason: "the source candle's volume could not be read" };
    }
  }
}
