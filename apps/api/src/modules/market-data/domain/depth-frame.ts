import { createHash } from "node:crypto";

/**
 * Normalises one vendor depth frame into a storable event, or refuses it.
 *
 * The vendor socket is untyped and its `Depth` object is mutable and reused: the SDK maintains one
 * `Depth` instance per symbol and hands the *same object* to the callback on every update when
 * running in accumulate mode. Anything held past the callback must therefore be copied, not
 * referenced — a buffer of references would end a session holding N pointers to one object showing
 * only the final book. Every array here is copied for that reason, not out of caution.
 *
 * ## What is refused, and why refusal is better than a default
 *
 * A frame with no usable book at all — no bid and no ask level with a positive price — produces
 * `null`. Storing it would add a row that contributes nothing to a reconstruction while counting
 * toward every rate computed over the table. The one thing not refused is a *thin* book: fewer
 * populated levels than requested is real market information (an illiquid strike genuinely has a
 * shallow book), and `levelsAvailable` records it.
 *
 * ## Truncation is explicit and recorded
 *
 * The caller asks for N levels; the frame may carry up to 50. Both numbers are stored, because a
 * depth-weighted feature computed over 10 stored levels of a 50-level book is a different quantity
 * from the same feature over a genuinely 10-level book, and nothing downstream can tell them apart
 * without `levelsAvailable`.
 */

/** The shape the vendor SDK's `Depth` object presents. All arrays are 50 long, zero-padded. */
export interface VendorDepthFrame {
  readonly tbq?: unknown;
  readonly tsq?: unknown;
  readonly bidprice?: unknown;
  readonly askprice?: unknown;
  readonly bidqty?: unknown;
  readonly askqty?: unknown;
  readonly bidordn?: unknown;
  readonly askordn?: unknown;
  readonly snapshot?: unknown;
  readonly timestamp?: unknown;
  readonly sendtime?: unknown;
  readonly seqNo?: unknown;
}

export interface DepthFrame {
  readonly providerSymbol: string;
  readonly sequenceNo: number | null;
  /** Feed clock, as delivered. Second-granularity; see the migration comment. */
  readonly exchangeFeedTime: number | null;
  readonly vendorSendTime: number | null;
  /** Our millisecond clock, stamped at the socket boundary. */
  readonly receivedAt: Date;
  readonly isSnapshot: boolean;
  readonly levelsStored: number;
  readonly levelsAvailable: number;
  readonly bidPrice: number[];
  readonly bidQty: number[];
  readonly bidOrders: number[];
  readonly askPrice: number[];
  readonly askQty: number[];
  readonly askOrders: number[];
  readonly totalBuyQty: number | null;
  readonly totalSellQty: number | null;
  /** SHA-256 of the decoded frame. Detects a replay, not a transport corruption. */
  readonly payloadDigest: string;
}

function finiteOrNull(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeOrNull(value: unknown): number | null {
  const parsed = finiteOrNull(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

/** Numbers from an untyped array, non-finite entries becoming 0 so array lengths stay aligned. */
function numericArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => finiteOrNull(entry) ?? 0);
}

/** How many leading levels carry a positive price. Trailing zeros are padding, not a book. */
function populatedLevels(prices: readonly number[]): number {
  let count = 0;
  for (const price of prices) {
    if (price > 0) count += 1;
    else break;
  }
  return count;
}

export interface ParseDepthFrameInput {
  readonly providerSymbol: string;
  readonly raw: unknown;
  readonly receivedAt: Date;
  /** Levels to keep per side. */
  readonly levelsToStore: number;
}

export function parseDepthFrame(input: ParseDepthFrameInput): DepthFrame | null {
  const symbol = typeof input.providerSymbol === "string" ? input.providerSymbol.trim() : "";
  if (symbol === "") return null;
  if (typeof input.raw !== "object" || input.raw === null) return null;
  if (!(input.receivedAt instanceof Date) || Number.isNaN(input.receivedAt.getTime())) return null;
  if (!Number.isInteger(input.levelsToStore) || input.levelsToStore < 1) {
    throw new Error("levelsToStore must be a positive integer.");
  }

  const frame = input.raw as VendorDepthFrame;

  // Copied, never referenced: the SDK reuses one Depth object per symbol. See the header.
  const allBidPrice = numericArray(frame.bidprice);
  const allAskPrice = numericArray(frame.askprice);
  const allBidQty = numericArray(frame.bidqty);
  const allAskQty = numericArray(frame.askqty);
  const allBidOrders = numericArray(frame.bidordn);
  const allAskOrders = numericArray(frame.askordn);

  const bidLevels = populatedLevels(allBidPrice);
  const askLevels = populatedLevels(allAskPrice);
  // A frame with no priced level on either side cannot contribute to a reconstruction.
  if (bidLevels === 0 && askLevels === 0) return null;

  const levelsAvailable = Math.max(bidLevels, askLevels);
  // Both sides are stored to the same depth so level-wise features never read across a ragged edge;
  // the alignment CHECK in migration 070 enforces the same invariant at rest.
  const levelsStored = Math.min(input.levelsToStore, levelsAvailable);

  const take = (values: readonly number[]): number[] => {
    const slice = values.slice(0, levelsStored);
    // Pad rather than return short: a side thinner than the other must not shorten the arrays.
    while (slice.length < levelsStored) slice.push(0);
    return slice;
  };

  const bidPrice = take(allBidPrice);
  const bidQty = take(allBidQty);
  const bidOrders = take(allBidOrders);
  const askPrice = take(allAskPrice);
  const askQty = take(allAskQty);
  const askOrders = take(allAskOrders);

  const sequenceNo = nonNegativeOrNull(frame.seqNo);
  const exchangeFeedTime = nonNegativeOrNull(frame.timestamp);
  const vendorSendTime = nonNegativeOrNull(frame.sendtime);
  const isSnapshot = frame.snapshot === true;

  // The digest covers the book and its sequencing, deliberately excluding receivedAt: two identical
  // frames arriving at different instants must hash the same, or replay detection never fires.
  const payloadDigest = createHash("sha256")
    .update(JSON.stringify([
      symbol, sequenceNo, exchangeFeedTime, vendorSendTime, isSnapshot,
      bidPrice, bidQty, bidOrders, askPrice, askQty, askOrders,
      nonNegativeOrNull(frame.tbq), nonNegativeOrNull(frame.tsq),
    ]))
    .digest("hex");

  return {
    providerSymbol: symbol.toUpperCase(),
    sequenceNo,
    exchangeFeedTime,
    vendorSendTime,
    receivedAt: input.receivedAt,
    isSnapshot,
    levelsStored,
    levelsAvailable,
    bidPrice,
    bidQty,
    bidOrders,
    askPrice,
    askQty,
    askOrders,
    totalBuyQty: nonNegativeOrNull(frame.tbq),
    totalSellQty: nonNegativeOrNull(frame.tsq),
    payloadDigest,
  };
}

/**
 * Best bid/ask sizes and the microprice, from a stored frame.
 *
 * Included here rather than in a feature module because it is the cheapest possible proof that the
 * captured data supports what Phase 3 needs: microprice is the size-weighted mid, and it was
 * uncomputable from anything this system stored before Phase 1. Returns null when either side is
 * absent — a one-sided book has no mid, and substituting the traded price would invent one.
 */
export function microprice(frame: {
  readonly bidPrice: readonly number[];
  readonly bidQty: readonly number[];
  readonly askPrice: readonly number[];
  readonly askQty: readonly number[];
}): number | null {
  const bidPrice = frame.bidPrice[0] ?? 0;
  const askPrice = frame.askPrice[0] ?? 0;
  const bidQty = frame.bidQty[0] ?? 0;
  const askQty = frame.askQty[0] ?? 0;
  if (bidPrice <= 0 || askPrice <= 0) return null;
  const totalQty = bidQty + askQty;
  // With no size on either side the size weighting is undefined; the plain mid is the honest answer.
  if (totalQty <= 0) return (bidPrice + askPrice) / 2;
  // Weighted toward the side with *less* size: heavy bid size means the price is likelier to lift
  // the ask. This is the standard construction and the reason sizes were the blocking requirement.
  return ((bidPrice * askQty) + (askPrice * bidQty)) / totalQty;
}
