/**
 * The pre-open levels sheet: price levels traders commonly watch, computed from stored data, grouped into zones.
 *
 * Written to the protocol in docs/2026-11-02-daily-levels-sheet-and-reaction-protocol.md. Everything here is arithmetic on completed
 * daily bars, the previous session's last option-chain observation and the reference price. Nothing is predicted, and nothing is
 * supplied by a language model. These are context, not signals: whether they behave differently from arbitrary lines is a separate
 * measured question (`reaction-study.ts`), shown beside the sheet.
 */

export type DailyLevelsInstrument = "NIFTY50" | "BANKNIFTY";

export type LevelFamily = "PRIOR_DAY" | "PIVOT" | "RANGE_5D" | "RANGE_WEEK" | "ROUND_NUMBER" | "OI_WALL";

/** Families derived from daily bars alone, which is what the reaction study can replay over years. */
export const DAILY_BAR_FAMILIES: readonly LevelFamily[] = ["PRIOR_DAY", "PIVOT", "RANGE_5D", "RANGE_WEEK", "ROUND_NUMBER"];

/** One completed trading day. `date` is the IST calendar date, `YYYY-MM-DD`. */
export interface DailyBar {
  readonly date: string;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export interface Level {
  readonly family: LevelFamily;
  /** Stable machine key, e.g. `pdh`, `r2`, `call-oi-wall`. */
  readonly key: string;
  readonly label: string;
  readonly price: number;
  /** Extra context shown next to the line, e.g. the open interest behind a wall. */
  readonly note?: string;
}

/** Open interest at one strike, both sides, from one option-chain observation of one expiry. */
export interface OiStrike {
  readonly strike: number;
  readonly callOi: number;
  readonly putOi: number;
}

/** Levels within this fraction of the first level of a group share a zone (0.10%). */
export const ZONE_TOLERANCE_FRACTION = 0.001;

/** The round-number step per index, in index points. */
export const ROUND_NUMBER_STEP: Readonly<Record<DailyLevelsInstrument, number>> = { NIFTY50: 100, BANKNIFTY: 500 };

/** Sessions feeding the multi-day range. */
export const RANGE_SESSIONS = 5;

const round2 = (value: number): number => Number(value.toFixed(2));

/** Previous day's high, low and close. */
export function priorDayLevels(previous: DailyBar): Level[] {
  return [
    { family: "PRIOR_DAY", key: "pdh", label: "Previous day high", price: round2(previous.high) },
    { family: "PRIOR_DAY", key: "pdl", label: "Previous day low", price: round2(previous.low) },
    { family: "PRIOR_DAY", key: "pdc", label: "Previous day close", price: round2(previous.close) },
  ];
}

/** Classic floor-trader pivots from the previous day: P, R1-R3, S1-S3. */
export function pivotLevels(previous: DailyBar): Level[] {
  const { high, low, close } = previous;
  const pivot = (high + low + close) / 3;
  const range = high - low;
  const entries: Array<[string, string, number]> = [
    ["pivot", "Pivot", pivot],
    ["r1", "R1", 2 * pivot - low],
    ["r2", "R2", pivot + range],
    ["r3", "R3", high + 2 * (pivot - low)],
    ["s1", "S1", 2 * pivot - high],
    ["s2", "S2", pivot - range],
    ["s3", "S3", low - 2 * (high - pivot)],
  ];
  return entries.map(([key, label, price]) => ({ family: "PIVOT" as const, key, label, price: round2(price) }));
}

/** High and low of the last `RANGE_SESSIONS` completed sessions (needs at least two). */
export function rangeLevels(priorSessions: readonly DailyBar[]): Level[] {
  const recent = priorSessions.slice(-RANGE_SESSIONS);
  if (recent.length < 2) return [];
  return [
    { family: "RANGE_5D", key: "range-high", label: `${recent.length}-session high`, price: round2(Math.max(...recent.map((bar) => bar.high))) },
    { family: "RANGE_5D", key: "range-low", label: `${recent.length}-session low`, price: round2(Math.min(...recent.map((bar) => bar.low))) },
  ];
}

/** ISO year-week key of an IST calendar date, e.g. `2026-W44`. Dates are calendar dates, so this is done in UTC. */
export function isoWeekKey(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const instant = new Date(Date.UTC(year, month - 1, day));
  const dayNumber = (instant.getUTCDay() + 6) % 7; // Monday = 0
  instant.setUTCDate(instant.getUTCDate() - dayNumber + 3); // Thursday of this week decides the ISO year
  const isoYear = instant.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstWeekStart = new Date(firstThursday.getTime() - ((firstThursday.getUTCDay() + 6) % 7) * 86_400_000);
  const week = Math.floor((instant.getTime() - firstWeekStart.getTime()) / (7 * 86_400_000)) + 1;
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** High and low of the ISO week before the one containing `sessionDate`. Empty when no stored bar falls in that week. */
export function weekLevels(priorSessions: readonly DailyBar[], sessionDate: string): Level[] {
  const [year, month, day] = sessionDate.split("-").map(Number);
  const weekAgo = new Date(Date.UTC(year, month - 1, day) - 7 * 86_400_000).toISOString().slice(0, 10);
  const previousWeek = isoWeekKey(weekAgo);
  const bars = priorSessions.filter((bar) => isoWeekKey(bar.date) === previousWeek);
  if (bars.length === 0) return [];
  return [
    { family: "RANGE_WEEK", key: "week-high", label: "Previous week high", price: round2(Math.max(...bars.map((bar) => bar.high))) },
    { family: "RANGE_WEEK", key: "week-low", label: "Previous week low", price: round2(Math.min(...bars.map((bar) => bar.low))) },
  ];
}

/** The two multiples of `step` at or below the reference price and the two above it. */
export function roundNumberLevels(referencePrice: number, step: number): Level[] {
  const base = Math.floor(referencePrice / step);
  const multiples = [base - 1, base, base + 1, base + 2].map((k) => k * step);
  return multiples.map((price) => ({
    family: "ROUND_NUMBER" as const,
    key: `round-${price}`,
    label: `Round ${price}`,
    price,
  }));
}

const formatLakh = (oi: number): string => `${(oi / 100_000).toFixed(1)}L`;

/**
 * The strike with the most call open interest above the reference price (a resistance "wall") and the strike with the most put open
 * interest below it (a support "wall"). Ties go to the strike nearer the price. A side with no open interest gives no wall.
 */
export function oiWallLevels(strikes: readonly OiStrike[], referencePrice: number): Level[] {
  const pick = (candidates: readonly OiStrike[], oi: (strike: OiStrike) => number): OiStrike | null => {
    let best: OiStrike | null = null;
    for (const candidate of candidates) {
      if (oi(candidate) <= 0) continue;
      if (best === null) best = candidate;
      else if (oi(candidate) > oi(best)) best = candidate;
      else if (oi(candidate) === oi(best) && Math.abs(candidate.strike - referencePrice) < Math.abs(best.strike - referencePrice)) best = candidate;
    }
    return best;
  };
  const call = pick(strikes.filter((strike) => strike.strike > referencePrice), (strike) => strike.callOi);
  const put = pick(strikes.filter((strike) => strike.strike < referencePrice), (strike) => strike.putOi);
  const levels: Level[] = [];
  if (call) levels.push({ family: "OI_WALL", key: "call-oi-wall", label: "Highest call open interest", price: call.strike, note: `call OI ${formatLakh(call.callOi)}` });
  if (put) levels.push({ family: "OI_WALL", key: "put-oi-wall", label: "Highest put open interest", price: put.strike, note: `put OI ${formatLakh(put.putOi)}` });
  return levels;
}

export interface LevelZone {
  readonly low: number;
  readonly high: number;
  /** Mean of the member prices. */
  readonly centre: number;
  readonly levels: readonly Level[];
  /** Distinct families in the zone, sorted. */
  readonly families: readonly LevelFamily[];
  /** Number of distinct families. Two lines from one bar (a pivot and the previous high) are two families but not independent. */
  readonly confluence: number;
  /** Where the centre sits against the reference price; `AT` when the zone contains it. */
  readonly position: "ABOVE" | "BELOW" | "AT";
  readonly distancePoints: number;
  readonly distancePct: number;
}

/** Sorts the levels by price and groups them greedily: a group starts at its lowest level and takes every level within the tolerance of it. */
export function buildZones(levels: readonly Level[], referencePrice: number, toleranceFraction = ZONE_TOLERANCE_FRACTION): LevelZone[] {
  const sorted = [...levels].filter((level) => Number.isFinite(level.price) && level.price > 0).sort((a, b) => a.price - b.price || a.key.localeCompare(b.key));
  const tolerance = referencePrice * toleranceFraction;
  const groups: Level[][] = [];
  for (const level of sorted) {
    const current = groups.at(-1);
    if (current && level.price - current[0].price <= tolerance) current.push(level);
    else groups.push([level]);
  }
  return groups.map((members) => {
    const prices = members.map((level) => level.price);
    const low = Math.min(...prices);
    const high = Math.max(...prices);
    const centre = round2(prices.reduce((sum, price) => sum + price, 0) / prices.length);
    const families = [...new Set(members.map((level) => level.family))].sort();
    const position = low <= referencePrice && referencePrice <= high ? "AT" : centre > referencePrice ? "ABOVE" : "BELOW";
    return {
      low, high, centre, levels: members, families, confluence: families.length, position,
      distancePoints: round2(centre - referencePrice),
      distancePct: round2(((centre - referencePrice) / referencePrice) * 100),
    };
  });
}

export interface LevelSheetInput {
  readonly underlying: DailyLevelsInstrument;
  /** The session the sheet is for, `YYYY-MM-DD`. Bars on or after it are ignored: nothing from the day itself may be used. */
  readonly sessionDate: string;
  /** Completed daily bars, any order. */
  readonly dailyBars: readonly DailyBar[];
  /** The previous session's last option-chain observation for the nearest expiry, or null when there is none. */
  readonly oiStrikes: readonly OiStrike[] | null;
  readonly oiObservedAt?: string | null;
  readonly oiExpiry?: string | null;
}

export interface LevelSheet {
  readonly underlying: DailyLevelsInstrument;
  readonly sessionDate: string;
  readonly referenceDate: string;
  readonly referencePrice: number;
  readonly zones: readonly LevelZone[];
  readonly levelCount: number;
  /** Families that could not be built, with the reason, so a missing source is visible instead of silent. */
  readonly unavailable: ReadonlyArray<{ readonly family: LevelFamily; readonly reason: string }>;
  readonly oi: { readonly observedAt: string | null; readonly expiry: string | null } | null;
}

interface DailyBarLevels {
  readonly referenceDate: string;
  readonly referencePrice: number;
  readonly levels: Level[];
  readonly unavailable: Array<{ family: LevelFamily; reason: string }>;
}

/**
 * Every level that daily bars and the reference price give, from bars strictly before the session. The one construction shared by the
 * sheet and the reaction study, so what is measured is what is shown. Null when there is no completed bar before the session.
 */
export function dailyBarLevels(underlying: DailyLevelsInstrument, sessionDate: string, dailyBars: readonly DailyBar[]): DailyBarLevels | null {
  const prior = dailyBars.filter((bar) => bar.date < sessionDate).sort((a, b) => a.date.localeCompare(b.date));
  const previous = prior.at(-1);
  if (!previous) return null;
  const referencePrice = previous.close;
  const unavailable: Array<{ family: LevelFamily; reason: string }> = [];

  const range = rangeLevels(prior);
  if (range.length === 0) unavailable.push({ family: "RANGE_5D", reason: "fewer than two completed sessions" });
  const week = weekLevels(prior, sessionDate);
  if (week.length === 0) unavailable.push({ family: "RANGE_WEEK", reason: "no stored bar in the previous week" });

  return {
    referenceDate: previous.date,
    referencePrice,
    levels: [...priorDayLevels(previous), ...pivotLevels(previous), ...range, ...week, ...roundNumberLevels(referencePrice, ROUND_NUMBER_STEP[underlying])],
    unavailable,
  };
}

/** Null when there is no completed daily bar before the session. */
export function buildLevelSheet(input: LevelSheetInput): LevelSheet | null {
  const base = dailyBarLevels(input.underlying, input.sessionDate, input.dailyBars);
  if (base === null) return null;
  const levels: Level[] = [...base.levels];
  const unavailable = [...base.unavailable];

  if (input.oiStrikes === null || input.oiStrikes.length === 0) {
    unavailable.push({ family: "OI_WALL", reason: "no option-chain observation before the open" });
  } else {
    const walls = oiWallLevels(input.oiStrikes, base.referencePrice);
    if (walls.length === 0) unavailable.push({ family: "OI_WALL", reason: "no open interest on either side of the price" });
    levels.push(...walls);
  }

  return {
    underlying: input.underlying,
    sessionDate: input.sessionDate,
    referenceDate: base.referenceDate,
    referencePrice: base.referencePrice,
    zones: buildZones(levels, base.referencePrice),
    levelCount: levels.length,
    unavailable,
    oi: input.oiStrikes && input.oiStrikes.length > 0 ? { observedAt: input.oiObservedAt ?? null, expiry: input.oiExpiry ?? null } : null,
  };
}
