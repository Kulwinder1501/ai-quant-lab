/**
 * Types and pure presentation rules for the order-book ladder. No React.
 *
 * The API (`/api/v1/depth/ladder`) does the market-data work: it resolves the contract, refuses level-indexed
 * figures for a book that fails its own invariants, and says whether the frame is live. This module only turns
 * that into wording and bar widths, and keeps three promises the screen must not break:
 *
 * - **Resting quantity is not traded quantity.** Nothing here is called volume or flow.
 * - **Direction never rests on colour.** An imbalance carries its sign and a word ("bid-heavy"), because a
 *   reader cannot be asked to tell two shades of green and red apart.
 * - **A top-of-book figure is not the book's.** Only ten of the feed's fifty levels are stored, so the
 *   coverage sentence states how far they reach and what share of the whole book they hold, and the whole-book
 *   imbalance (from the feed's own totals) is kept apart from the level-based ones.
 */

export type DepthStatus = "LIVE" | "STALE" | "OUT_OF_SESSION" | "HISTORICAL";

export interface DepthLevelView {
  level: number;
  price: number;
  qty: number;
  orders: number | null;
  cumulativeQty: number;
}

export interface DepthCoverageView {
  levelsStored: number;
  levelsAvailable: number;
  reachPoints: { bid: number | null; ask: number | null };
  storedShareOfWholeBook: { bid: number | null; ask: number | null };
  wholeBookTotals: { bid: number | null; ask: number | null };
}

export interface DepthLadderView {
  providerSymbol: string;
  receivedAt: string;
  ageSeconds: number;
  status: DepthStatus;
  captureRegime: "KEYED_BY_LEVEL_NUMBER" | "ARRIVAL_INDEX";
  coherent: boolean;
  issues: string[];
  bids: DepthLevelView[];
  asks: DepthLevelView[];
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: { points: number; basisPoints: number } | null;
  imbalance: {
    topOfBook: { l1: number | null; l3: number | null; l5: number | null; l10: number | null };
    rankWeighted: number | null;
    wholeBook: number | null;
  };
  coverage: DepthCoverageView;
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

export interface DepthAvailable {
  available: true;
  underlying: string;
  contract: { providerSymbol: string; expiryDate: string; lotSize: number };
  requestedAsOf: string | null;
  ladder: DepthLadderView;
  definitions: Record<string, string>;
  source: string;
}

export interface DepthUnavailable {
  available: false;
  underlying: string;
  reason: string;
  contractsTried?: string[];
}

export type DepthPayload = DepthAvailable | DepthUnavailable;

/** Underlyings the depth endpoint resolves a contract for. Others never reach the network. */
export const DEPTH_UNDERLYINGS: readonly string[] = ["NIFTY50", "BANKNIFTY"];

/** Within this band an imbalance reads as balanced: a few percent of resting quantity is noise at one instant. */
export const BALANCED_BAND = 0.05;

export interface ImbalanceText {
  /** Signed, two decimals, or an em dash. */
  text: string;
  /** What the sign means in words, so direction does not depend on colour. */
  word: "bid-heavy" | "ask-heavy" | "balanced" | "not available";
}

export function describeImbalance(value: number | null): ImbalanceText {
  if (value === null || !Number.isFinite(value)) return { text: "—", word: "not available" };
  const word = Math.abs(value) < BALANCED_BAND ? "balanced" : value > 0 ? "bid-heavy" : "ask-heavy";
  // A value that rounds to zero is written 0.00, never -0.00 or +0.00.
  const rounded = Number(value.toFixed(2));
  const text = rounded === 0 ? "0.00" : `${rounded > 0 ? "+" : ""}${rounded.toFixed(2)}`;
  return { text, word };
}

export interface LadderRowView {
  side: "ask" | "bid";
  level: number;
  price: number;
  qty: number;
  lots: number | null;
  orders: number | null;
  cumulativeQty: number;
  /** 0..1, against the largest single level on either side of this frame. */
  barFraction: number;
}

/**
 * Rows in ladder order: asks from the deepest down to the touch, then bids from the touch down.
 *
 * The bar scale is the largest single level in *this* frame, shared by both sides so an ask and a bid are
 * comparable at a glance. It is relative to this book only (a bar is not a quantity), which the screen says;
 * the number beside it is the quantity.
 */
export function buildLadderRows(
  ladder: Pick<DepthLadderView, "bids" | "asks">,
  lotSize: number | null,
): LadderRowView[] {
  const maxQty = Math.max(0, ...ladder.bids.map((l) => l.qty), ...ladder.asks.map((l) => l.qty));
  const toRow = (side: "ask" | "bid") => (level: DepthLevelView): LadderRowView => ({
    side,
    level: level.level,
    price: level.price,
    qty: level.qty,
    lots: lotSize !== null && lotSize > 0 ? level.qty / lotSize : null,
    orders: level.orders,
    cumulativeQty: level.cumulativeQty,
    barFraction: maxQty > 0 ? level.qty / maxQty : 0,
  });
  return [...[...ladder.asks].reverse().map(toRow("ask")), ...ladder.bids.map(toRow("bid"))];
}

/**
 * How old the book on screen is: the server's age at response time plus the time since the response arrived.
 * If the API stops answering, the second term keeps growing, so an old book never reads as current.
 */
export function bookAgeSeconds(serverAgeSeconds: number, fetchedAtMs: number, nowMs: number): number {
  return serverAgeSeconds + Math.max(0, (nowMs - fetchedAtMs) / 1000);
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function points(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)} pts`;
}

/**
 * The sentence that stops a top-of-book figure being read as the book's. A frame stored at every level the feed carried
 * says so; one stored at ten of fifty says it holds only the top.
 */
export function coverageSentence(coverage: DepthCoverageView): string {
  const scope = coverage.levelsStored >= coverage.levelsAvailable
    ? `All ${coverage.levelsStored} levels the feed carried are stored: they reach `
    : `Top ${coverage.levelsStored} of ${coverage.levelsAvailable} levels only: they reach `;
  return `${scope}`
    + `${points(coverage.reachPoints.bid)} on the bid and ${points(coverage.reachPoints.ask)} on the ask, and hold `
    + `${percent(coverage.storedShareOfWholeBook.bid)} of the whole book's resting bid quantity and `
    + `${percent(coverage.storedShareOfWholeBook.ask)} of its ask.`;
}

/** Levels shown a side before "show all": the book the day's first screens were designed around, and a readable height. */
export const DEFAULT_VISIBLE_LEVELS = 10;

/** The first `count` levels of each side. Bars are then scaled against what is shown, not against a far deeper level. */
export function topLevels<T extends Pick<DepthLadderView, "bids" | "asks">>(ladder: T, count: number): Pick<DepthLadderView, "bids" | "asks"> {
  return { bids: ladder.bids.slice(0, count), asks: ladder.asks.slice(0, count) };
}

/** The same ten seconds the API uses to call an in-session frame stale (`DEPTH_STALE_AFTER_SECONDS`). */
export const DEPTH_STALE_AFTER_SECONDS = 10;

/**
 * The status to show, given how old the book is *now*.
 *
 * The server's status describes the frame at the moment it answered. If the API then goes quiet, the page
 * keeps that book and its age keeps growing, but a badge copied from the old response would still read LIVE.
 * Found by stopping the API under the running page: the age reached 11 seconds under a LIVE badge. A LIVE
 * verdict therefore lapses to STALE once the effective age passes the threshold. The other statuses are
 * already statements that the book is not live, so they stand.
 */
export function effectiveStatus(serverStatus: DepthStatus, effectiveAgeSeconds: number): DepthStatus {
  return serverStatus === "LIVE" && effectiveAgeSeconds > DEPTH_STALE_AFTER_SECONDS ? "STALE" : serverStatus;
}

export interface StatusPresentation {
  label: string;
  tone: "ok" | "warn" | "idle";
  detail: string;
}

export function presentStatus(status: DepthStatus): StatusPresentation {
  switch (status) {
    case "LIVE":
      return { label: "LIVE", tone: "ok", detail: "Newest stored frame, received within the last ten seconds." };
    case "STALE":
      return { label: "STALE", tone: "warn", detail: "In session, but the newest stored frame is older than ten seconds. The collector or the feed may have stopped." };
    case "OUT_OF_SESSION":
      return { label: "OUT OF SESSION", tone: "idle", detail: "Outside Mon-Fri 09:00-15:30 IST (holidays are not detected). This is the last book stored, not a live one." };
    case "HISTORICAL":
      return { label: "HISTORICAL", tone: "idle", detail: "A past instant, not the current book." };
  }
}
