/**
 * Normalises a depth frame's ladders and rules on whether they form a real book.
 *
 * ## Why this exists
 *
 * The vendor SDK maintains one `Depth` object per symbol and mutates it in place on every message
 * (`fyers-api-v3/tbtsocket/models.js`): each array is created once as `new Array(50).fill(0)` and a
 * slot is written only when that level is present in the current message. There is no clear, no
 * reset -- `snapshot` is recorded as a flag and does not empty the arrays -- and no removal path for
 * a level that leaves the book. A slot untouched by the current message therefore keeps whatever
 * price it last held, so an emitted frame is a mixture of current and stale levels.
 *
 * Measured on 307k BANKNIFTY futures frames (2026-09-04): only 1.6% carried a spread a front-month
 * future could plausibly trade, 93.1% were 15 points or wider, ladders were price-ordered in just
 * 77% (bid) and 85% (ask) of frames, and `bidPrice[0]` was the best bid only 89.9% of the time.
 * Everything downstream that indexes level 0 -- `microprice` included -- silently read a stale
 * price on roughly one frame in ten.
 *
 * ## What this does, and what it deliberately does not do
 *
 * Sorting repairs *ordering*. It cannot repair *staleness*: a stale level sorted into position is
 * still stale. So this module's real product is the verdict, not the sorted arrays. A caller stores
 * the verdict alongside the frame so that corruption is visible and filterable instead of silent,
 * and so any future capture mode can be validated against the same gate before it is trusted.
 */

export type BookCoherenceVerdict =
  | "COHERENT"
  /** One or both sides carry no positively priced level; a one-sided book has no spread. */
  | "EMPTY_SIDE"
  /** Best bid is at or above best ask. Never a real book; always a capture or staleness defect. */
  | "CROSSED"
  /** Wider than the instrument could plausibly trade, which is the staleness signature. */
  | "SPREAD_IMPLAUSIBLE";

export interface BookSide {
  readonly price: readonly number[];
  readonly qty: readonly number[];
  readonly orders: readonly number[];
}

export interface NormalizedBook {
  readonly bid: { price: number[]; qty: number[]; orders: number[] };
  readonly ask: { price: number[]; qty: number[]; orders: number[] };
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly spread: number | null;
  readonly verdict: BookCoherenceVerdict;
  /**
   * True when the input ladders were not already price-ordered. Diagnostic rather than cosmetic: a
   * feed that delivers an ordered book should never set this, so a non-zero rate is direct evidence
   * that slots are being written out of order.
   */
  readonly wasReordered: boolean;
}

export interface AssessBookInput {
  readonly bid: BookSide;
  readonly ask: BookSide;
  /**
   * Widest spread this instrument could plausibly trade, as a fraction of the best bid.
   *
   * Required, with no default, because the honest value is instrument-specific and a default would
   * silently re-admit the corruption this gate exists to catch: a front-month index future trades
   * under a basis point while a far strike legitimately trades percent-wide. The same reasoning as
   * `predictionHorizonYears` on the straddle proposer -- a default here would be quietly wrong.
   */
  readonly maximumSpreadFraction: number;
}

/** One (price, qty, orders) triple, kept together so sorting cannot separate a price from its size. */
interface Level {
  readonly price: number;
  readonly qty: number;
  readonly orders: number;
}

function levelsOf(side: BookSide): Level[] {
  const levels: Level[] = [];
  for (let i = 0; i < side.price.length; i += 1) {
    const price = side.price[i];
    // A zero or negative price is an unpopulated slot, not a level at zero. Dropping it is the
    // difference between a thin book and a book with a phantom level at the bottom.
    if (!Number.isFinite(price) || price <= 0) continue;
    const qty = side.qty[i];
    const orders = side.orders[i];
    levels.push({
      price,
      qty: Number.isFinite(qty) && qty > 0 ? qty : 0,
      orders: Number.isFinite(orders) && orders > 0 ? orders : 0,
    });
  }
  return levels;
}

function isOrdered(levels: readonly Level[], direction: "DESC" | "ASC"): boolean {
  for (let i = 1; i < levels.length; i += 1) {
    const previous = levels[i - 1].price;
    const current = levels[i].price;
    if (direction === "DESC" ? current > previous : current < previous) return false;
  }
  return true;
}

function unzip(levels: readonly Level[]): { price: number[]; qty: number[]; orders: number[] } {
  return {
    price: levels.map((l) => l.price),
    qty: levels.map((l) => l.qty),
    orders: levels.map((l) => l.orders),
  };
}

/**
 * Sorts both ladders into book order and rules on whether the result is a usable book.
 *
 * Bids descend and asks ascend, so index 0 is the touch on both sides after normalisation -- which
 * is what every level-indexed consumer already assumes and what the raw feed does not guarantee.
 */
export function assessBook(input: AssessBookInput): NormalizedBook {
  if (!Number.isFinite(input.maximumSpreadFraction) || input.maximumSpreadFraction <= 0) {
    throw new Error("maximumSpreadFraction must be a positive fraction of price.");
  }

  const rawBid = levelsOf(input.bid);
  const rawAsk = levelsOf(input.ask);
  const wasReordered = !isOrdered(rawBid, "DESC") || !isOrdered(rawAsk, "ASC");

  const bid = [...rawBid].sort((a, b) => b.price - a.price);
  const ask = [...rawAsk].sort((a, b) => a.price - b.price);

  const bestBid = bid[0]?.price ?? null;
  const bestAsk = ask[0]?.price ?? null;

  if (bestBid === null || bestAsk === null) {
    return {
      bid: unzip(bid), ask: unzip(ask),
      bestBid, bestAsk, spread: null, verdict: "EMPTY_SIDE", wasReordered,
    };
  }

  const spread = bestAsk - bestBid;
  // Equality counts as crossed: a zero spread on a limit book means the two sides would have traded.
  const verdict: BookCoherenceVerdict = spread <= 0
    ? "CROSSED"
    : spread > bestBid * input.maximumSpreadFraction
      ? "SPREAD_IMPLAUSIBLE"
      : "COHERENT";

  return { bid: unzip(bid), ask: unzip(ask), bestBid, bestAsk, spread, verdict, wasReordered };
}
