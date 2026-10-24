/**
 * What the ATM options price as a move, next to what the index future has actually moved. Pure, no React.
 *
 * Three kinds of number, kept apart on the screen:
 *
 * 1. **Observed prices.** The ATM straddle (call mid + put mid) is two market prices added up. Its breakevens at expiry are the
 *    strike plus and minus that premium. Needs both legs two-sided; a one-sided quote is unknown, not cheap.
 * 2. **Model-derived from the implied volatility.** The ATM IV is solved from mids (Black-Scholes), and a typical (1 sigma) move
 *    over a period is `spot x IV x sqrt(time)`. Assuming a normal distribution of the move, its expected ABSOLUTE size is
 *    `sqrt(2/pi)` (about 0.798) of that. These are model readings of the price, not forecasts and not measurements of the market's
 *    belief.
 * 3. **Observed history.** The mean absolute close-to-close move of the futures over recent sessions, from `/api/v1/realized-moves`.
 *
 * ## The day-count convention is a band, not a number
 * IV is quoted per year, and this codebase prices on calendar time (`days / 365`). A daily move from it depends on whether a day
 * is a calendar day or a trading day: `IV / sqrt(365)` per calendar day, `IV / sqrt(252)` per trading day, 20% apart. The
 * realized close-to-close move spans a trading day (it includes the overnight gap, and a weekend counts once). Neither convention
 * is right for every tenor, so the implied daily figure and every ratio against it are shown as a range between the two.
 *
 * ## What the comparison cannot say
 * Realized looks back; implied looks forward over the days to expiry and includes event risk in them. A realized move below the
 * implied one is the usual case and is not by itself a reason to sell options, nor the reverse a reason to buy them. The page says so.
 */

export interface QuoteSide {
  bid: number | null;
  ask: number | null;
}

export interface ImpliedMoveInput {
  spot: number | null;
  atmStrike: number | null;
  atmCall: QuoteSide | null;
  atmPut: QuoteSide | null;
  /** Absolute annualised volatility (0.155 = 15.5%); null when it could not be solved. */
  atmIv: number | null;
  /** Calendar days to the expiry the ATM legs belong to. */
  daysToExpiry: number | null;
}

export interface RealizedStatsInput {
  sessionsInWindow: number;
  closeToCloseCount: number;
  rangeCount: number;
  meanAbsCloseToClosePoints: number | null;
  meanAbsCloseToClosePercent: number | null;
  meanRangePoints: number | null;
  meanRangePercentOfOpen: number | null;
  fromDate: string | null;
  toDate: string | null;
}

/** Calendar days in the year the pricing convention uses, and trading days in the year the other convention uses. */
export const CALENDAR_DAYS_PER_YEAR = 365;
export const TRADING_DAYS_PER_YEAR = 252;
/** Expected absolute value of a normal variable, in standard deviations: sqrt(2 / pi). */
export const NORMAL_MEAN_ABSOLUTE = Math.sqrt(2 / Math.PI);

export interface Straddle {
  callMid: number;
  putMid: number;
  /** Call mid plus put mid, in index points. */
  points: number;
  percentOfSpot: number;
  lowerBreakeven: number;
  upperBreakeven: number;
}

export interface DailyBand {
  /** The same quantity on the calendar-day and the trading-day convention; `low` is the calendar-day one. */
  low: number;
  high: number;
}

export interface ImpliedMove {
  /** Null when either leg is not two-sided, or there is no ATM strike. */
  straddle: Straddle | null;
  /** One standard deviation of the move to expiry, in points: `spot x IV x sqrt(days / 365)`. Null without IV, days or spot. */
  oneSigmaToExpiryPoints: number | null;
  /** One standard deviation of a one-day move, in points, on each day-count convention. */
  oneSigmaDailyPoints: DailyBand | null;
  /** Expected absolute one-day move (normal assumption), in points. */
  expectedAbsDailyPoints: DailyBand | null;
  expectedAbsDailyPercent: DailyBand | null;
}

function mid(side: QuoteSide | null): number | null {
  if (!side || side.bid === null || side.ask === null) return null;
  // A zero bid is nobody bidding, not a price of zero: the mid of a one-sided quote is not a price.
  if (!Number.isFinite(side.bid) || !Number.isFinite(side.ask) || !(side.bid > 0) || side.ask < side.bid) return null;
  const value = (side.bid + side.ask) / 2;
  return value > 0 ? value : null;
}

export function buildImpliedMove(input: ImpliedMoveInput): ImpliedMove {
  const { spot, atmStrike, atmIv, daysToExpiry } = input;
  const callMid = mid(input.atmCall);
  const putMid = mid(input.atmPut);
  const straddle: Straddle | null = callMid !== null && putMid !== null && atmStrike !== null && spot !== null && spot > 0
    ? {
      callMid,
      putMid,
      points: callMid + putMid,
      percentOfSpot: ((callMid + putMid) / spot) * 100,
      lowerBreakeven: atmStrike - (callMid + putMid),
      upperBreakeven: atmStrike + (callMid + putMid),
    }
    : null;

  const haveVol = spot !== null && spot > 0 && atmIv !== null && atmIv > 0;
  const daily = (days: number): number | null => (haveVol ? spot! * atmIv! / Math.sqrt(days) : null);
  const sigmaCalendar = daily(CALENDAR_DAYS_PER_YEAR);
  const sigmaTrading = daily(TRADING_DAYS_PER_YEAR);
  const oneSigmaDailyPoints: DailyBand | null = sigmaCalendar !== null && sigmaTrading !== null ? { low: sigmaCalendar, high: sigmaTrading } : null;
  const scaled = (band: DailyBand | null, factor: number): DailyBand | null => (band ? { low: band.low * factor, high: band.high * factor } : null);

  return {
    straddle,
    oneSigmaToExpiryPoints: haveVol && daysToExpiry !== null && daysToExpiry > 0 ? spot! * atmIv! * Math.sqrt(daysToExpiry / CALENDAR_DAYS_PER_YEAR) : null,
    oneSigmaDailyPoints,
    expectedAbsDailyPoints: scaled(oneSigmaDailyPoints, NORMAL_MEAN_ABSOLUTE),
    expectedAbsDailyPercent: haveVol && oneSigmaDailyPoints
      ? scaled({ low: (oneSigmaDailyPoints.low / spot!) * 100, high: (oneSigmaDailyPoints.high / spot!) * 100 }, NORMAL_MEAN_ABSOLUTE)
      : null,
  };
}

export interface MoveComparison {
  /** Realized mean absolute close-to-close move over the implied expected absolute daily move: a range, from the convention. */
  ratio: DailyBand | null;
  /** The realized figure on its own, in points and in percent of the previous close. */
  realizedPoints: number | null;
  realizedPercent: number | null;
}

/** The realized mean absolute daily move against the implied expected absolute daily move, as a range over the day-count convention. */
export function compareMoves(implied: ImpliedMove, realized: RealizedStatsInput | null): MoveComparison {
  const realizedPoints = realized?.meanAbsCloseToClosePoints ?? null;
  const realizedPercent = realized?.meanAbsCloseToClosePercent ?? null;
  if (realizedPoints === null || implied.expectedAbsDailyPoints === null) return { ratio: null, realizedPoints, realizedPercent };
  // Dividing by the larger implied figure gives the smaller ratio.
  return {
    ratio: { low: realizedPoints / implied.expectedAbsDailyPoints.high, high: realizedPoints / implied.expectedAbsDailyPoints.low },
    realizedPoints,
    realizedPercent,
  };
}

function points(value: number): string {
  return Math.round(value).toLocaleString("en-IN");
}

function times(value: number): string {
  return `${value.toFixed(2)}×`;
}

/** The band as `low–high`, collapsing to one figure when the two agree at the displayed precision. */
export function bandText(band: DailyBand, format: (value: number) => string = points): string {
  const low = format(band.low);
  const high = format(band.high);
  return low === high ? low : `${low}–${high}`;
}

/** What the comparison says, in a sentence, with its basis. Null when either side is missing. */
export function comparisonSentence(implied: ImpliedMove, realized: RealizedStatsInput | null): string | null {
  const comparison = compareMoves(implied, realized);
  if (comparison.ratio === null || comparison.realizedPoints === null || implied.expectedAbsDailyPoints === null || realized === null) return null;
  const sessions = `${realized.closeToCloseCount} session${realized.closeToCloseCount === 1 ? "" : "s"}`;
  const relation = comparison.ratio.high < 1
    ? "below"
    : comparison.ratio.low > 1
      ? "above"
      : "around";
  return `Over the last ${sessions} (${realized.fromDate} to ${realized.toDate}) the future moved ${points(comparison.realizedPoints)} points on average from one close to the next, `
    + `${relation} the ${bandText(implied.expectedAbsDailyPoints)} points the ATM implied volatility implies for a typical day (${bandText(comparison.ratio, times)} of it, over the two day-count conventions).`;
}

export interface MoveNote {
  tone: "info" | "warn";
  text: string;
}

/**
 * What the figures stand on, in words. `realizedExpected` is false while the realized moves are still loading, after a failed
 * request (which has its own message) and for an underlying that has no futures: absent data is only a warning when it was due.
 */
export function impliedMoveNotes(
  implied: ImpliedMove,
  input: ImpliedMoveInput,
  realized: RealizedStatsInput | null,
  realizedExpected = true,
): MoveNote[] {
  const notes: MoveNote[] = [];
  if (implied.straddle === null) {
    notes.push({ tone: "warn", text: "The ATM straddle is not shown: one of the ATM legs has no two-sided quote (an unquoted leg is unknown, not cheap)." });
  }
  if (input.atmIv === null || !(input.atmIv > 0)) {
    notes.push({ tone: "warn", text: "No implied volatility could be solved at the money, so no implied daily move is shown." });
  }
  if (realized === null) {
    if (realizedExpected) notes.push({ tone: "warn", text: "No realized moves are available: no finished futures session is stored." });
  } else if (realized.closeToCloseCount < realized.sessionsInWindow) {
    notes.push({
      tone: "info",
      text: `${realized.closeToCloseCount} of the ${realized.sessionsInWindow} sessions in the window have a close-to-close move (the others follow a contract roll or an incomplete session) and are left out of that average, not counted as zero.`,
    });
  }
  return notes;
}

export const IMPLIED_MOVE_DEFINITIONS = {
  straddle: "Observed: the ATM call mid plus the ATM put mid, in index points. At expiry the holder breaks even at the strike plus or minus that premium. Needs both legs two-sided.",
  iv: "Model-derived: the ATM implied volatility, solved from the option mids (Black-Scholes, on the put-call-parity forward). Not published by the exchange.",
  sigma: "A typical (one standard deviation) move over a period is spot x IV x sqrt(time). Assuming a normal distribution, the expected absolute move is about 0.8 of that.",
  convention: "IV is per year. Per calendar day it is IV / sqrt(365) (the convention this app prices on); per trading day IV / sqrt(252), 20% larger. The daily figures and ratios are shown as a range between the two, because neither is right for every tenor.",
  realized: "Observed: the mean absolute close-to-close move of the front-month index future over the newest sessions, including the overnight gap. Not computed across a contract roll or from a session that stops early.",
  notSignal: "Realized looks back and implied looks forward over the days to expiry, event risk included. A gap between them is not by itself a reason to buy or sell options, and past moves do not say what the next ones will be.",
} as const;
