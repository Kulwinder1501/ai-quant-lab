import type { TradeSide } from "../../strategy-engine/domain/strategy.js";
import type { MarketQuoteReader } from "../../market-data/domain/market-quote.js";

/** The freshest a quote may be to fill against it. Matches the option path's own bound in spirit. */
export const MAXIMUM_EXECUTABLE_QUOTE_AGE_MS = 5 * 60 * 1000;

export interface PreparedDirectEntry {
  tradeIdeaId: string;
  side: TradeSide;
  quantity: number;
  fillPrice: number;
  stopLossOverride: number;
  targetPriceOverride: number;
  entryFees: number;
  feeBreakdown: Record<string, unknown>;
  requiredMargin?: number;
  leverage?: number;
  observedBid: number;
  observedAsk: number;
}

export type PrepareDirectEntryResult =
  | { approved: true; entry: PreparedDirectEntry }
  | {
    approved: false;
    reason: "IDEA_NOT_FOUND" | "NO_FRESH_QUOTE" | "INVALID_GEOMETRY" | "INSUFFICIENT_MARGIN";
    explanation: string;
  };

export interface PrepareDirectEntryInput {
  tradeIdeaId: string;
  lots?: number;
  quantity?: number;
  now?: Date;
  leverage?: number;
  availableMargin?: number;
  accountEquity?: number;
  riskPercent?: number;
  dynamicSizing?: boolean;
}

interface QueryableDatabase {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
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
  tick_size: string;
}

function roundToTick(value: number, tickSize: number): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) return value;
  return Math.round(value / tickSize) * tickSize;
}

/**
 * Everything that has to be true before a directional idea becomes a bare, non-option position.
 *
 * `PrepareOptionEntry` resolves a strike/expiry and prices an options contract against a chain;
 * this is the direct-fill analogue for an instrument with no option chain at all -- XAU_USD via
 * Twelve Data is the first. No chain, no strike, no Zerodha F&O fee schedule: none of those
 * concepts exist for this instrument, so none are fabricated here.
 *
 * Two lessons already paid for on the option path apply just as directly here (see that file's
 * own header comment for the incidents that established them):
 *
 * - **The fill must be the market's, not the model's.** The idea's `entry_price` is the candle
 *   close at the instant the strategy last evaluated, which can be stale by the time this runs.
 *   A live quote is fetched and used as the fill instead, and the idea is refused rather than
 *   filled at its own (possibly stale) price if no fresh quote is available.
 * - **Stop and target travel with the fill, not with the model's entry.** They are re-derived by
 *   applying the idea's own risk/reward *distances* to the live fill price, rather than reusing
 *   its absolute stop/target levels, which were anchored to a different, earlier entry.
 */
export class PrepareDirectEntry {
  constructor(
    private readonly database: QueryableDatabase,
    private readonly quoteReader: MarketQuoteReader,
  ) {}

  async execute(input: PrepareDirectEntryInput): Promise<PrepareDirectEntryResult> {
    const now = input.now ?? new Date();

    const ideaResult = await this.database.query<IdeaRow>(`
      SELECT ti.id, ti.side, ti.entry_price, ti.stop_loss, ti.target_price, ti.instrument_id,
             i.lot_size, i.symbol, i.tick_size
      FROM trade_ideas ti
      INNER JOIN instruments i ON i.id = ti.instrument_id
      WHERE ti.id = $1
    `, [input.tradeIdeaId]);
    const idea = ideaResult.rows[0];
    if (!idea) {
      return { approved: false, reason: "IDEA_NOT_FOUND", explanation: "Trade idea not found." };
    }

    const symbol = String(idea.symbol).toUpperCase();
    const lotSize = Number(idea.lot_size) > 0 ? Number(idea.lot_size) : 1;
    const tickSize = Number(idea.tick_size);

    const quote = await this.quoteReader.quoteSymbol(symbol).catch(() => null);
    const quoteAgeMs = quote?.regularMarketTime ? now.getTime() - quote.regularMarketTime.getTime() : null;
    const observedPrice = quote?.regularMarketPrice ?? null;
    const observedBid = quote?.bid ?? observedPrice;
    const observedAsk = quote?.ask ?? observedPrice;

    const fresh = observedPrice !== null && observedPrice > 0
      && quoteAgeMs !== null && quoteAgeMs >= 0 && quoteAgeMs <= MAXIMUM_EXECUTABLE_QUOTE_AGE_MS
      && observedBid !== undefined && observedAsk !== undefined && observedAsk >= observedBid;
      
    if (!fresh) {
      return {
        approved: false,
        reason: "NO_FRESH_QUOTE",
        explanation: `No executable ${symbol} quote at or before ${now.toISOString()} was available `
          + `inside the ${MAXIMUM_EXECUTABLE_QUOTE_AGE_MS / 1000}-second freshness window. The `
          + "position was not opened; the idea's own (possibly stale) entry price is not executable.",
      };
    }

    const ideaEntry = Number(idea.entry_price);
    const ideaStop = Number(idea.stop_loss);
    const ideaTarget = Number(idea.target_price);
    const riskDistance = Math.abs(ideaEntry - ideaStop);
    const rewardDistance = Math.abs(ideaTarget - ideaEntry);

    const side = idea.side;
    const entry = roundToTick(side === "LONG" ? observedAsk! : observedBid!, tickSize);
    
    // The stop/target levels travel with the fill. 
    // For LONG: entry is at ASK, SL/TP trigger at BID. 
    // The SL threshold should be set relative to the entry price to maintain risk distance.
    const stopLoss = roundToTick(side === "LONG" ? entry - riskDistance : entry + riskDistance, tickSize);
    const targetPrice = roundToTick(side === "LONG" ? entry + rewardDistance : entry - rewardDistance, tickSize);

    if (stopLoss <= 0 || targetPrice <= 0
      || (side === "LONG" && (stopLoss >= entry || targetPrice <= entry))
      || (side === "SHORT" && (stopLoss <= entry || targetPrice >= entry))) {
      return {
        approved: false,
        reason: "INVALID_GEOMETRY",
        explanation: "Stop/target re-derived from the live fill did not leave a valid bracket "
          + `(entry ${entry}, stop ${stopLoss}, target ${targetPrice}).`,
      };
    }

    const leverage = typeof input.leverage === "number" && input.leverage > 0 ? input.leverage : undefined;
    let finalQuantity = typeof input.quantity === "number" && input.quantity > 0
      ? input.quantity
      : Math.max(1, Math.round(input.lots ?? 1)) * lotSize;

    if (input.dynamicSizing && typeof input.accountEquity === "number" && input.accountEquity > 0) {
      const riskPercent = typeof input.riskPercent === "number" && input.riskPercent > 0 ? input.riskPercent : 1.0;
      const riskBudget = input.accountEquity * (riskPercent / 100);
      const desiredQty = riskDistance > 0 ? riskBudget / riskDistance : lotSize;

      let maxLeverageQty = Infinity;
      if (typeof input.availableMargin === "number" && input.availableMargin > 0 && leverage) {
        maxLeverageQty = (input.availableMargin * leverage) / entry;
      }

      const rawQty = Math.min(desiredQty, maxLeverageQty);
      const calculatedLots = Math.max(1, Math.floor(rawQty / lotSize));
      finalQuantity = calculatedLots * lotSize;
    }

    let requiredMargin: number | undefined;
    if (leverage && leverage > 0) {
      requiredMargin = (entry * finalQuantity) / leverage;
      if (typeof input.availableMargin === "number" && requiredMargin > input.availableMargin) {
        return {
          approved: false,
          reason: "INSUFFICIENT_MARGIN",
          explanation: `Required margin of $${requiredMargin.toFixed(2)} (${finalQuantity} unit(s) at ${leverage}x leverage) `
            + `exceeds available free margin of $${input.availableMargin.toFixed(2)}.`,
        };
      }
    }

    return {
      approved: true,
      entry: {
        tradeIdeaId: idea.id,
        side,
        quantity: finalQuantity,
        fillPrice: entry,
        stopLossOverride: stopLoss,
        targetPriceOverride: targetPrice,
        entryFees: 0,
        requiredMargin,
        leverage,
        observedBid: observedBid!,
        observedAsk: observedAsk!,
        feeBreakdown: {
          entryChecks: {
            fillSource: "OANDA_QUOTE",
            observedPrice,
            quoteObservedAt: quote?.regularMarketTime?.toISOString() ?? null,
            costModel: "NONE_MODELLED",
            leverage: leverage ?? null,
            requiredMargin: requiredMargin ?? null,
          },
        },
      },
    };
  }
}

