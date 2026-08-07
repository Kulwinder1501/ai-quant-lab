import { nearestStrike } from "@ai-quant-lab/pricing";
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

/** Below this the entry falls back to the model, and the trade records that it did. */
const MAXIMUM_CHAIN_AGE_MINUTES = 40;

export interface PreparedOptionEntry {
  tradeIdeaId: string;
  underlyingSymbol: string;
  side: "LONG";
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
      | "EXPIRY_REQUIRED"
      | "EXPIRY_INVALID"
      | "EXPIRY_PASSED"
      | "NO_CALENDAR"
      | "EXPIRY_NOT_LISTED"
      | "NO_EXPIRY_FAR_ENOUGH_OUT"
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
  latestExpiryCalendar(underlyingSymbol: string): Promise<OptionExpiryCalendar | null>;
  latestSnapshot(input: { underlyingSymbol: string; expiryDate?: string }): Promise<OptionChainSnapshot | null>;
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
}

export class PrepareOptionEntry {
  constructor(
    private readonly database: QueryableDatabase,
    private readonly optionChainRepository: ChainReader,
  ) {}

  async execute(input: PrepareOptionEntryInput): Promise<PrepareOptionEntryResult> {
    const now = input.now ?? new Date();

    const ideaResult = await this.database.query<IdeaRow>(`
      SELECT ti.id, ti.side, ti.entry_price, ti.stop_loss, ti.target_price,
             ti.instrument_id, ti.confidence, ti.reasoning, ti.source_candle_id,
             i.lot_size, i.symbol, i.strike_step
      FROM trade_ideas ti
      INNER JOIN instruments i ON i.id = ti.instrument_id
      WHERE ti.id = $1
    `, [input.tradeIdeaId]);
    const idea = ideaResult.rows[0];
    if (!idea) {
      return { approved: false, reason: "IDEA_NOT_FOUND", explanation: "Trade idea not found." };
    }

    const underlyingSymbol = String(idea.symbol).toUpperCase();
    const lotSize = Number(idea.lot_size);
    // Lot-correct by construction. `quantity: 1` against a lot of 75 is not a small
    // position, it is one that cannot be placed.
    const quantity = typeof input.quantity === "number" && input.quantity > 0
      ? input.quantity
      : lotsToQuantity(Math.max(1, Math.floor(input.lots ?? 1)), lotSize);

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

    const calendar = await this.optionChainRepository.latestExpiryCalendar(underlyingSymbol);
    const chosen = this.resolveExpiry(calendar, input.expiryDate, underlyingSymbol, now);
    if (!chosen.ok) return chosen.refusal;
    const settlementExpiry = chosen.expiryDate;

    const impliedVolatility = await this.resolveImpliedVolatility(input.impliedVolatility);

    // The chain is read before the fill is mapped, because the entry premium should be the
    // market's. The strike does not depend on the mapping -- it is nearestStrike(entry, step)
    // -- so it can be derived here and looked up.
    const intendedStrike = nearestStrike(Number(idea.entry_price), strikeStep);
    const intendedOptionType = idea.side === "LONG" ? "CE" : "PE";
    const entryChain = await this.optionChainRepository
      .latestSnapshot({
        underlyingSymbol,
        expiryDate: settlementExpiry.toISOString().slice(0, 10),
      })
      .catch(() => null);
    // A snapshot older than the gap between collections describes a book that has moved.
    // Falling back to the model is worse than filling at a stale ask but better than
    // filling at a price nothing was offering; either way the trade records which it was.
    const chainAgeMinutes = entryChain === null
      ? null
      : (now.getTime() - entryChain.observedAt.getTime()) / 60_000;
    const usableChain = entryChain !== null && chainAgeMinutes !== null
      && chainAgeMinutes >= 0 && chainAgeMinutes <= MAXIMUM_CHAIN_AGE_MINUTES
      ? entryChain
      : null;

    const solvedGreeks = usableChain === null ? null : solveContractGreeksFromChain({
      snapshot: usableChain,
      strikePrice: intendedStrike,
      optionType: intendedOptionType,
    });
    // A buyer pays the ask, not the mid. Filling at the mid understates the entry by half
    // the spread on every trade, and spread is the cost that decides whether an options edge
    // survives at all.
    const intendedQuote = usableChain?.quotes.find(
      (quote) => quote.strikePrice === intendedStrike && quote.optionType === intendedOptionType,
    );
    const observedFill = solvedGreeks !== null && intendedQuote?.ask != null && intendedQuote.ask > 0
      ? { premium: intendedQuote.ask, impliedVolatility: solvedGreeks.impliedVolatility }
      : undefined;

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

    const volume = await this.readSourceBarVolume(idea.source_candle_id, idea.symbol);
    const entryCheck = validateOptionsEntry({
      proposedIdea: {
        side: idea.side,
        confidence: Number(idea.confidence ?? 0),
        reasoning: Array.isArray(idea.reasoning) ? (idea.reasoning as unknown[]).map(String) : [],
      },
      candleVolume: volume.candleVolume,
      volumeAbsenceReason: volume.absenceReason,
      optionChain: usableChain ?? undefined,
      intendedStrike,
      intendedContractDelta: solvedGreeks?.delta ?? null,
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
          entryIv: impliedVolatility,
        },
        entryFees: entryFees.total,
        unchecked: entryCheck.unchecked,
        feeBreakdown: {
          entry: entryFees,
          option: {
            optionType: mapped.optionType,
            strike: mapped.strike,
            impliedVolatility,
            expiryDate: settlementExpiry.toISOString(),
            greeks: mapped.entryGreeks,
            underlyingEntry: Number(idea.entry_price),
          },
          entryChecks: {
            fillSource: mapped.fillSource,
            sourceCandleVolume: volume.candleVolume,
            observedAsk: intendedQuote?.ask ?? null,
            reasons: entryCheck.reasons,
            unchecked: entryCheck.unchecked,
            solvedDelta: solvedGreeks?.delta ?? null,
            solvedImpliedVolatility: solvedGreeks?.impliedVolatility ?? null,
            chainObservedAt: entryChain?.observedAt.toISOString() ?? null,
            chainAgeMinutes: chainAgeMinutes === null ? null : Number(chainAgeMinutes.toFixed(2)),
            chainUsable: usableChain !== null,
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
        volume: string | null; timeframe: string; nearby_volume_bars: string;
      }>(`
        SELECT c.volume, c.timeframe,
               (SELECT count(*) FROM candles peer
                 WHERE peer.instrument_id = c.instrument_id
                   AND peer.timeframe = c.timeframe
                   AND peer.volume > 0
                   AND peer.open_time BETWEEN c.open_time - INTERVAL '7 days'
                                          AND c.open_time + INTERVAL '7 days') AS nearby_volume_bars
        FROM candles c WHERE c.id = $1
      `, [sourceCandleId]);
      const bar = result.rows[0];
      if (!bar) {
        return { candleVolume: null, absenceReason: "the idea's source candle is no longer stored" };
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
