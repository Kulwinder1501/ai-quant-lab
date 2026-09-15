/**
 * Assembles a depth book from vendor tick-by-tick messages, keyed by the level's own index.
 *
 * ## The defect this replaces
 *
 * The vendor SDK (`fyers-api-v3/tbtsocket/models.js`) keeps one `Depth` object per symbol, creates
 * each array once as `new Array(50).fill(0)`, and in `_addDepth` writes every level at its
 * **arrival index** `i`:
 *
 *     currdata.depth.bids.forEach((bid, i) => { if (bid.price != null) this.bidprice[i] = ... })
 *
 * The protobuf `MarketLevel` carries `price`, `qty`, `nord` **and `num`**, and the SDK never
 * references `num` at all. There is also no clear and no removal path -- `snapshot` is recorded as a
 * flag and does not empty the arrays -- so a slot untouched by the current message keeps a stale
 * price indefinitely.
 *
 * Measured live on 2026-09-07 over 119 delta messages of BANKNIFTY futures: updates are **sparse**
 * (as few as 7 levels on the bid side against the snapshot's uniform 50) and `num` equals the array
 * index only **22.3%** of the time on bids and **33.1%** on asks. So roughly three levels in four
 * were being written to the wrong slot. The result was that only 1.6% of stored frames carried a
 * spread a front-month future could plausibly trade, and `bidPrice[0]` was the best bid just 89.9%
 * of the time.
 *
 * Note that `diffOnly: true` on the socket does **not** fix this: that mode emits a fresh `Depth`
 * per message, but `_addDepth` still writes at `i` and still discards `num`.
 *
 * ## What this does instead
 *
 * One book per symbol, each level written at **`num`**, and a snapshot clears the book before it is
 * applied so a re-base actually re-bases. The output is the same shape the vendor object presents,
 * so `parseDepthFrame` downstream is unchanged.
 */

/** The vendor's fixed book depth. Both sides are always this many slots, zero where unpopulated. */
export const DEPTH_BOOK_LEVELS = 50;

/** One protobuf `MarketLevel`, whose scalars arrive inside wrapper objects. */
export interface VendorMarketLevel {
  readonly price?: unknown;
  readonly qty?: unknown;
  readonly nord?: unknown;
  readonly num?: unknown;
}

export interface AssembledBook {
  readonly bidPrice: number[];
  readonly bidQty: number[];
  readonly bidOrders: number[];
  readonly askPrice: number[];
  readonly askQty: number[];
  readonly askOrders: number[];
  /** Levels this message actually carried, per side. Sparse updates are normal and expected. */
  readonly appliedBidLevels: number;
  readonly appliedAskLevels: number;
  /** True when a level arrived with an unusable `num` and had to be dropped rather than guessed at. */
  readonly droppedLevels: number;
}

interface Side {
  price: number[];
  qty: number[];
  orders: number[];
}

function emptySide(): Side {
  return {
    price: new Array<number>(DEPTH_BOOK_LEVELS).fill(0),
    qty: new Array<number>(DEPTH_BOOK_LEVELS).fill(0),
    orders: new Array<number>(DEPTH_BOOK_LEVELS).fill(0),
  };
}

/**
 * Reads one protobuf-wrapped scalar, or null when the field was not sent at all.
 *
 * Two vendor encodings make this fiddly, and both were observed live on 2026-09-07:
 *
 * * A wrapper whose value is the type default arrives as an **empty object**: `num: {}` means level
 *   0, not "no level". Protobuf omits a default-valued field, so an absent `value` inside a present
 *   wrapper reads as 0. Returning null there dropped every top-of-book update.
 * * `price` is an `Int64Value`, and protobuf.js decodes 64-bit integers to a **Long object**, not a
 *   number or a string. It *renders* as `"5744000"` under `JSON.stringify`, which is exactly why it
 *   looks like a string in a log and is not one. `qty` and `nord` are `UInt32Value` and do arrive as
 *   plain numbers, so a coercion that only handled those silently produced an all-zero book.
 *
 * The distinction that matters downstream: a *missing field* (`undefined`) is "unchanged", while a
 * *present field* carrying 0 is a real zero. Only the caller can act on that difference, so this
 * returns null exclusively for the former.
 */
function coerce(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof raw === "object" && raw !== null) {
    // A protobuf.js Long stringifies to its decimal value. A plain object gives
    // "[object Object]", which is not finite, so this cannot mistake one for the other.
    const parsed = Number(String(raw));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function unwrap(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "object" && "value" in (value as object)) {
    const inner = (value as { value?: unknown }).value;
    // A present wrapper with no value is the protobuf default, which for these fields is 0.
    if (inner === undefined || inner === null) return 0;
    return coerce(inner);
  }
  // A present wrapper with no `value` property at all is likewise the default.
  if (typeof value === "object") return 0;
  return coerce(value);
}

export class DepthBookAssembler {
  private readonly bids = new Map<string, Side>();
  private readonly asks = new Map<string, Side>();

  /** Drops a symbol entirely, so a resubscribe cannot inherit the previous contract's book. */
  reset(symbol: string): void {
    this.bids.delete(symbol);
    this.asks.delete(symbol);
  }

  /**
   * Applies one message and returns the resulting full book.
   *
   * `isSnapshot` clears both sides first. That is the half the SDK omits: without it a re-base
   * leaves every slot the snapshot happens not to mention holding its previous price.
   */
  apply(
    symbol: string,
    message: { bids?: unknown; asks?: unknown },
    isSnapshot: boolean,
  ): AssembledBook {
    if (isSnapshot || !this.bids.has(symbol)) this.bids.set(symbol, emptySide());
    if (isSnapshot || !this.asks.has(symbol)) this.asks.set(symbol, emptySide());
    const bid = this.bids.get(symbol)!;
    const ask = this.asks.get(symbol)!;

    let dropped = 0;
    const applySide = (side: Side, levels: unknown): number => {
      if (!Array.isArray(levels)) return 0;
      let applied = 0;
      for (const entry of levels as VendorMarketLevel[]) {
        const index = unwrap(entry?.num);
        // A level whose own index is missing or out of range cannot be placed. Dropping it is the
        // point of this module: the arrival position is precisely the wrong answer, and writing it
        // there is the defect being fixed.
        if (index === null || !Number.isInteger(index) || index < 0 || index >= DEPTH_BOOK_LEVELS) {
          dropped += 1;
          continue;
        }
        const price = unwrap(entry?.price);
        const qty = unwrap(entry?.qty);
        const orders = unwrap(entry?.nord);

        /*
         * A delta may carry size without price. Measured live: many updates arrive as
         * `{ qty, nord, num }` with no `price` field at all -- a size change on a level that is
         * already there. Treating that as an empty slot wiped the price and left the book all
         * zeros, which is the first version of this module's own bug.
         *
         * So: price absent means unchanged; price present and non-positive is a genuine deletion;
         * price present and positive replaces it. Size and order count follow the same rule
         * independently, since either can arrive alone.
         */
        if (price !== null && price <= 0) {
          side.price[index] = 0;
          side.qty[index] = 0;
          side.orders[index] = 0;
        } else {
          // Prices are stored in whatever unit the caller passes, so the paise-to-rupees
          // conversion lives in exactly one place upstream.
          if (price !== null) side.price[index] = price;
          if (qty !== null) side.qty[index] = qty;
          if (orders !== null) side.orders[index] = orders;
        }
        applied += 1;
      }
      return applied;
    };

    const appliedBidLevels = applySide(bid, message.bids);
    const appliedAskLevels = applySide(ask, message.asks);

    return {
      // Copied, never referenced: these arrays are mutated in place on the next message, and
      // handing out a reference is the bug the vendor object has.
      bidPrice: [...bid.price],
      bidQty: [...bid.qty],
      bidOrders: [...bid.orders],
      askPrice: [...ask.price],
      askQty: [...ask.qty],
      askOrders: [...ask.orders],
      appliedBidLevels,
      appliedAskLevels,
      droppedLevels: dropped,
    };
  }
}
