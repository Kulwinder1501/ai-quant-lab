/**
 * One stored order-book frame, turned into a ladder with its liquidity metrics and an honest account of
 * what it can and cannot tell you. Pure: no clock of its own, no database.
 *
 * Resting quantity is not traded quantity. Nothing here is executed volume, and the metrics describe
 * displayed liquidity at one instant: a large resting order can be pulled before it trades, and a positive
 * imbalance is a description of the book, not a forecast of price.
 *
 * Four measured facts about `depth_frames` shape the rules below (BANKNIFTY futures, 2026-10-22 session):
 *
 * 1. **Only the top 10 of the feed's 50 levels are stored, and they are shallow.** They reach a median 5.4
 *    points from the touch (95th percentile 24) and hold about 2.4% of the whole book's resting quantity.
 *    A "book imbalance" over them is a top-of-book measure, so it is never called the book's imbalance.
 *    The feed's own `total_buy_qty` / `total_sell_qty` cover the whole book and are order-independent, so the
 *    whole-book figure comes from those, labelled separately.
 * 2. **Two capture regimes.** Before 2026-09-07T04:29:11Z the stored levels sit at arrival index, not at the
 *    level's own number, so a level-indexed feature is a different quantity there and the data cannot be
 *    repaired. Level-based metrics are refused for such a frame; the whole-book totals stay valid in both.
 * 3. **A book can fail its own invariants.** Bids must strictly fall and asks strictly rise away from the
 *    touch, and the touch must not be crossed. A frame that fails is reported with the reason and its
 *    level-based metrics withheld, rather than computed from a book that cannot exist.
 * 4. **`is_regression` is not a usable signal** (it flagged 42% of frames against a 0.3% true rate), so it is
 *    not read or exposed here.
 *
 * Quantities are underlying units (contracts x lot size), not lots; a level of 60 on BANKNIFTY is two lots.
 */

/** First instant of the capture regime whose stored levels are keyed by each level's own number. */
export const DEPTH_REGIME_B_START = new Date("2026-09-07T04:29:11.000Z");
/** The vendor's first frames after the restart that installed the assembler are not yet clean. */
const REGIME_B_SETTLE_MS = 20_000;

/** In session, a frame older than this is not "live". The feed delivers about two frames a second. */
export const DEPTH_STALE_AFTER_SECONDS = 10;

export interface StoredDepthFrame {
  providerSymbol: string;
  sequenceNo: number | null;
  /** The feed's clock, in seconds: second-granularity, so never a basis for sub-second claims. */
  exchangeFeedTime: number | null;
  /** Our own millisecond clock, stamped at the socket boundary. */
  receivedAt: Date;
  isSnapshot: boolean;
  levelsStored: number;
  levelsAvailable: number;
  bidPrice: readonly number[];
  bidQty: readonly number[];
  bidOrders: readonly number[];
  askPrice: readonly number[];
  askQty: readonly number[];
  askOrders: readonly number[];
  totalBuyQty: number | null;
  totalSellQty: number | null;
  gapBefore: number | null;
  isDuplicate: boolean;
  captureSessionId: string | null;
}

export interface LadderLevel {
  /** 1 is the touch. */
  level: number;
  price: number;
  qty: number;
  orders: number | null;
  /** Quantity from the touch through this level, inclusive. */
  cumulativeQty: number;
}

export type CaptureRegime = "KEYED_BY_LEVEL_NUMBER" | "ARRIVAL_INDEX";
export type DepthStatus = "LIVE" | "STALE" | "OUT_OF_SESSION" | "HISTORICAL";

export interface DepthImbalance {
  /** (bid - ask) / (bid + ask) over the first k stored levels of each side; null if either side is short. */
  topOfBook: { l1: number | null; l3: number | null; l5: number | null; l10: number | null };
  /** The same ratio with each level weighted 1/rank, so the touch counts most. Null when not computable. */
  rankWeighted: number | null;
  /**
   * (total bid - total ask) / (total bid + total ask) from the feed's own whole-book totals, which cover all
   * levels the feed carries (50), not only the stored ten. Null when the feed gave no totals.
   */
  wholeBook: number | null;
}

export interface DepthLadder {
  providerSymbol: string;
  receivedAt: string;
  ageSeconds: number;
  status: DepthStatus;
  captureRegime: CaptureRegime;
  coherent: boolean;
  /** Why the book failed its invariants, or why level metrics were withheld. Empty when all is well. */
  issues: string[];
  bids: LadderLevel[];
  asks: LadderLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: { points: number; basisPoints: number } | null;
  imbalance: DepthImbalance;
  coverage: {
    levelsStored: number;
    levelsAvailable: number;
    /** Price distance from the touch to the deepest stored level on each side. */
    reachPoints: { bid: number | null; ask: number | null };
    /** Stored quantity as a share of the feed's whole-book total for that side; null without totals. */
    storedShareOfWholeBook: { bid: number | null; ask: number | null };
    wholeBookTotals: { bid: number | null; ask: number | null };
  };
  provenance: {
    sequenceNo: number | null;
    exchangeFeedTime: number | null;
    isSnapshot: boolean;
    isDuplicate: boolean;
    gapBefore: number | null;
    captureSessionId: string | null;
  };
  quantityUnit: string;
}

export const DEPTH_QUANTITY_UNIT = "units (contracts x lot size), not lots";

const MS_PER_MINUTE = 60_000;
const IST_OFFSET_MS = 330 * MS_PER_MINUTE;
/** Futures pre-open starts 09:00 and the session ends 15:30 IST; a frame outside it is a reconnect snapshot. */
const SESSION_OPEN_MINUTE = 9 * 60;
const SESSION_CLOSE_MINUTE = 15 * 60 + 30;

/** Mon-Fri 09:00-15:30 IST. Holidays are not detected: no calendar is available here. */
export function isDepthSession(instant: Date): boolean {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MS);
  const weekday = shifted.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const minute = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  return minute >= SESSION_OPEN_MINUTE && minute < SESSION_CLOSE_MINUTE;
}

export function captureRegimeOf(receivedAt: Date): CaptureRegime {
  return receivedAt.getTime() >= DEPTH_REGIME_B_START.getTime() + REGIME_B_SETTLE_MS
    ? "KEYED_BY_LEVEL_NUMBER"
    : "ARRIVAL_INDEX";
}

/** The populated levels of one side, in stored order. A zero price or a non-positive quantity is padding. */
function populatedLevels(
  prices: readonly number[],
  qtys: readonly number[],
  orders: readonly number[],
): LadderLevel[] {
  const levels: LadderLevel[] = [];
  let cumulative = 0;
  const count = Math.min(prices.length, qtys.length);
  for (let i = 0; i < count; i += 1) {
    const price = prices[i]!;
    const qty = qtys[i]!;
    if (!(price > 0) || !Number.isFinite(price) || !(qty > 0) || !Number.isFinite(qty)) continue;
    cumulative += qty;
    const order = orders[i];
    levels.push({
      level: levels.length + 1,
      price,
      qty,
      orders: order !== undefined && Number.isFinite(order) ? order : null,
      cumulativeQty: cumulative,
    });
  }
  return levels;
}

function ratio(bid: number, ask: number): number | null {
  const total = bid + ask;
  return total > 0 ? (bid - ask) / total : null;
}

function topOfBook(bids: readonly LadderLevel[], asks: readonly LadderLevel[], k: number): number | null {
  if (bids.length < k || asks.length < k) return null;
  return ratio(bids[k - 1]!.cumulativeQty, asks[k - 1]!.cumulativeQty);
}

function rankWeighted(bids: readonly LadderLevel[], asks: readonly LadderLevel[]): number | null {
  if (bids.length === 0 || asks.length === 0) return null;
  let bid = 0;
  let ask = 0;
  bids.forEach((level, index) => { bid += level.qty / (index + 1); });
  asks.forEach((level, index) => { ask += level.qty / (index + 1); });
  return ratio(bid, ask);
}

/** The reasons a book cannot be a real book; empty when it is coherent. */
function invariantIssues(bids: readonly LadderLevel[], asks: readonly LadderLevel[]): string[] {
  const issues: string[] = [];
  for (let i = 1; i < bids.length; i += 1) {
    if (!(bids[i]!.price < bids[i - 1]!.price)) { issues.push("Bid prices do not fall strictly away from the touch."); break; }
  }
  for (let i = 1; i < asks.length; i += 1) {
    if (!(asks[i]!.price > asks[i - 1]!.price)) { issues.push("Ask prices do not rise strictly away from the touch."); break; }
  }
  if (bids.length > 0 && asks.length > 0 && !(bids[0]!.price < asks[0]!.price)) {
    issues.push("The book is crossed: the best bid is not below the best ask.");
  }
  return issues;
}

/** Price distances are sums of 0.05-0.2 ticks; four decimals removes float noise (9.599999999998545) and nothing real. */
function roundPoints(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * A whole-book total, or null when the feed did not give a usable one.
 *
 * Zero counts as missing, not as an empty side: a 50-level book cannot be empty on one side in session, and the
 * feed does drop a total to zero for a single frame between readings of ~42,000 (567 of 42,943 BANKNIFTY frames
 * on 2026-10-22, 1.3%). Read as a measurement, one such frame gives a whole-book imbalance of exactly -1 or +1.
 */
export function usableTotal(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function buildDepthLadder(
  frame: StoredDepthFrame,
  options: { now: Date; historical?: boolean },
): DepthLadder {
  const ageSeconds = Math.max(0, (options.now.getTime() - frame.receivedAt.getTime()) / 1000);
  const status: DepthStatus = options.historical
    ? "HISTORICAL"
    : !isDepthSession(options.now)
      ? "OUT_OF_SESSION"
      : ageSeconds > DEPTH_STALE_AFTER_SECONDS
        ? "STALE"
        : "LIVE";

  const regime = captureRegimeOf(frame.receivedAt);
  const bids = populatedLevels(frame.bidPrice, frame.bidQty, frame.bidOrders);
  const asks = populatedLevels(frame.askPrice, frame.askQty, frame.askOrders);

  const issues = invariantIssues(bids, asks);
  const coherent = issues.length === 0;
  if (regime === "ARRIVAL_INDEX") {
    issues.push(
      "Captured before 2026-09-07: stored levels sit at arrival index, so level-based figures are not comparable and are withheld.",
    );
  }
  // Everything indexed by level is withheld together: the touch, the mid and the spread are level-indexed
  // too, and a best bid that is not the best bid is worse than none.
  const levelMetricsAllowed = coherent && regime === "KEYED_BY_LEVEL_NUMBER";

  const totalBuy = usableTotal(frame.totalBuyQty);
  const totalSell = usableTotal(frame.totalSellQty);
  const wholeBook = totalBuy !== null && totalSell !== null ? ratio(totalBuy, totalSell) : null;

  const bestBid = levelMetricsAllowed ? bids[0]?.price ?? null : null;
  const bestAsk = levelMetricsAllowed ? asks[0]?.price ?? null : null;
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  const spreadPoints = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;

  const storedBid = bids.length > 0 ? bids[bids.length - 1]!.cumulativeQty : 0;
  const storedAsk = asks.length > 0 ? asks[asks.length - 1]!.cumulativeQty : 0;

  return {
    providerSymbol: frame.providerSymbol,
    receivedAt: frame.receivedAt.toISOString(),
    ageSeconds,
    status,
    captureRegime: regime,
    coherent,
    issues,
    bids,
    asks,
    bestBid,
    bestAsk,
    mid,
    spread: spreadPoints !== null && mid !== null && mid > 0
      ? { points: roundPoints(spreadPoints), basisPoints: (spreadPoints / mid) * 10_000 }
      : null,
    imbalance: {
      topOfBook: levelMetricsAllowed
        ? { l1: topOfBook(bids, asks, 1), l3: topOfBook(bids, asks, 3), l5: topOfBook(bids, asks, 5), l10: topOfBook(bids, asks, 10) }
        : { l1: null, l3: null, l5: null, l10: null },
      rankWeighted: levelMetricsAllowed ? rankWeighted(bids, asks) : null,
      wholeBook,
    },
    coverage: {
      levelsStored: frame.levelsStored,
      levelsAvailable: frame.levelsAvailable,
      reachPoints: {
        bid: bids.length > 0 ? roundPoints(bids[0]!.price - bids[bids.length - 1]!.price) : null,
        ask: asks.length > 0 ? roundPoints(asks[asks.length - 1]!.price - asks[0]!.price) : null,
      },
      storedShareOfWholeBook: {
        bid: totalBuy !== null && totalBuy > 0 ? storedBid / totalBuy : null,
        ask: totalSell !== null && totalSell > 0 ? storedAsk / totalSell : null,
      },
      wholeBookTotals: { bid: totalBuy, ask: totalSell },
    },
    provenance: {
      sequenceNo: frame.sequenceNo,
      exchangeFeedTime: frame.exchangeFeedTime,
      isSnapshot: frame.isSnapshot,
      isDuplicate: frame.isDuplicate,
      gapBefore: frame.gapBefore,
      captureSessionId: frame.captureSessionId,
    },
    quantityUnit: DEPTH_QUANTITY_UNIT,
  };
}

export const IMBALANCE_DEFINITIONS = {
  topOfBook: "(bid - ask) / (bid + ask) over the first k stored levels of each side, at one instant. Top of the book only.",
  rankWeighted: "The same ratio with level i weighted 1/i over the stored levels (at most 10), so the touch counts most.",
  wholeBook: "(total bid - total ask) / (total bid + total ask) from the feed's own whole-book totals, covering all levels the feed carries (50), not only the ten stored.",
} as const;
