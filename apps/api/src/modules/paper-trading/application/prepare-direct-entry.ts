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
}

export type PrepareDirectEntryResult =
  | { approved: true; entry: PreparedDirectEntry }
  | {
    approved: false;
    reason: "IDEA_NOT_FOUND" | "NO_FRESH_QUOTE" | "INVALID_GEOMETRY";
    explanation: string;
  };

export interface PrepareDirectEntryInput {
  tradeIdeaId: string;
  lots?: number;
  quantity?: number;
  now?: Date;
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
    const quantity = typeof input.quantity === "number" && input.quantity > 0
      ? input.quantity
      : Math.max(1, Math.round(input.lots ?? 1)) * lotSize;
    const tickSize = Number(idea.tick_size);

    const quote = await this.quoteReader.quoteSymbol(symbol).catch(() => null);
    const quoteAgeMs = quote?.regularMarketTime ? now.getTime() - quote.regularMarketTime.getTime() : null;
    const observedPrice = quote?.regularMarketPrice ?? null;
    const fresh = observedPrice !== null && observedPrice > 0
      && quoteAgeMs !== null && quoteAgeMs >= 0 && quoteAgeMs <= MAXIMUM_EXECUTABLE_QUOTE_AGE_MS;
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
    const entry = roundToTick(observedPrice, tickSize);
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

    return {
      approved: true,
      entry: {
        tradeIdeaId: idea.id,
        side,
        quantity,
        fillPrice: entry,
        stopLossOverride: stopLoss,
        targetPriceOverride: targetPrice,
        // No Zerodha-style cost schedule exists for a USD spot instrument with no local broker of
        // record -- brokerage-calculator.ts is an Indian F&O schedule end to end and does not
        // apply here. Left at zero and documented rather than fabricated.
        entryFees: 0,
        feeBreakdown: {
          entryChecks: {
            fillSource: "TWELVEDATA_QUOTE",
            observedPrice,
            quoteObservedAt: quote?.regularMarketTime?.toISOString() ?? null,
            costModel: "NONE_MODELLED",
          },
        },
      },
    };
  }
}
