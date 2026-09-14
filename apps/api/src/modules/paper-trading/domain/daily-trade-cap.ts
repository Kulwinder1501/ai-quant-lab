/**
 * A per-account cap on trades opened in one trading day.
 *
 * ## What this is, and what it is not
 *
 * A **throughput** cap, not an exposure cap. Concurrent exposure is already limited by
 * `defaultRiskPolicy.maxConcurrentPositions`, which `evaluateRisk` applies before an idea ever
 * reaches the repository. Conflating the two was the defect in the plan this replaces: portfolio
 * risk is about how much is open at once, churn is about how often, and a control named for one
 * while measuring the other cannot be reasoned about.
 *
 * It is deliberately keyed on the account and the calendar day rather than on a strategist
 * decision. A decision-scoped window made the decision's own time-to-live the real rate limiter,
 * because every refresh restored capacity; a trading day cannot expire mid-session.
 *
 * ## Per-account, and that is the point
 *
 * The scalp bots run as separate accounts, so each carries its own capacity. A cap shared across
 * them would let whichever bot fired first starve the other, which turns a controlled comparison
 * between two strategy arms into a race for slots. Independent capacity keeps the arms independent.
 *
 * ## Closed trades still count
 *
 * A scalp opened and closed inside two minutes has consumed capacity. Counting only open trades
 * would make the cap trivially evadable by churning, which is the behaviour it exists to bound.
 */

/** Indian market time. NSE trades 09:15-15:30 IST, so a session never crosses local midnight. */
const IST_OFFSET_MINUTES = 5 * 60 + 30;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export interface TradingDayWindow {
  /** Inclusive UTC start of the IST calendar day. */
  start: Date;
  /** Exclusive UTC end. Half-open so a trade at the boundary belongs to exactly one day. */
  end: Date;
  /** The IST calendar date, `YYYY-MM-DD`, for logging and for keying anything derived. */
  istDate: string;
}

/**
 * The IST calendar day containing `at`, as a half-open UTC range.
 *
 * Returned as a range rather than a date expression because the count that uses it must be
 * index-scannable: `opened_at >= start AND opened_at < end` can use a btree index on
 * `(account_id, opened_at)`, while `(opened_at AT TIME ZONE 'Asia/Kolkata')::date = $2` cannot use
 * one without a matching expression index.
 *
 * India has had no daylight saving since 1945 and a single zone, so a fixed +05:30 offset is exact
 * here. It is not a general-purpose timezone conversion and must not be reused as one.
 */
export function istTradingDayWindow(at: Date): TradingDayWindow {
  const time = at.getTime();
  if (!Number.isFinite(time)) {
    throw new Error("A trading-day window needs a valid instant.");
  }
  const shifted = time + IST_OFFSET_MINUTES * MINUTE_MS;
  const dayIndex = Math.floor(shifted / DAY_MS);
  const startShifted = dayIndex * DAY_MS;
  return {
    start: new Date(startShifted - IST_OFFSET_MINUTES * MINUTE_MS),
    end: new Date(startShifted + DAY_MS - IST_OFFSET_MINUTES * MINUTE_MS),
    istDate: new Date(startShifted).toISOString().slice(0, 10),
  };
}

export type DailyTradeCapDecision =
  | { allowed: true; reason: "NO_CAP" | "WITHIN_CAP"; openedToday: number; cap: number | null }
  | { allowed: false; reason: "DAILY_TRADE_CAP_REACHED"; openedToday: number; cap: number };

/**
 * Whether one more trade may be opened today.
 *
 * A null cap means uncapped, which is the state every existing account starts in: the column is
 * added nullable so deploying this changes no behaviour until a cap is set deliberately. "Not
 * configured" and "configured as zero" must not read the same, and zero is a real setting that
 * blocks every open.
 */
export function decideDailyTradeCap(input: {
  openedToday: number;
  cap: number | null;
}): DailyTradeCapDecision {
  const { openedToday, cap } = input;
  if (!Number.isInteger(openedToday) || openedToday < 0) {
    throw new Error(`Trades opened today must be a non-negative integer, received ${openedToday}.`);
  }
  if (cap === null) return { allowed: true, reason: "NO_CAP", openedToday, cap };
  if (!Number.isInteger(cap) || cap < 0) {
    throw new Error(`A daily trade cap must be a non-negative integer, received ${cap}.`);
  }
  if (openedToday >= cap) {
    return { allowed: false, reason: "DAILY_TRADE_CAP_REACHED", openedToday, cap };
  }
  return { allowed: true, reason: "WITHIN_CAP", openedToday, cap };
}
